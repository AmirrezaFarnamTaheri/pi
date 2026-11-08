// What happens between a Discord channel and its linked session (server): a mention by someone allowed to wake Pi, seen
// by the link's bot, delivers the messages since the link's cursor (a thread's: to its forked subagent) as one input; a
// pending reply is posted once its turn ended. Plain logic over ports, so tests run it with fake bots and sessions.
import type { SessionLock } from "@p2/app/v1";
import { replyNonce } from "./reply-nonce.ts";
import { type Binding, COMMANDS, type Command, type OfferedFile, type Pending, type Wake } from "./contract.ts";

/** A Discord message as the relay reads it. */
export type DiscordMessage = {
	id: string;
	channelId: string;
	author: { id: string; name: string; bot: boolean };
	roles: readonly string[];
	text: string;
	mentionsBot: boolean;
	attachments: readonly { name: string; url: string; size: number }[];
};

/** A channel or a thread of one. */
export type DiscordChannel = {
	id: string;
	name: string;
	guildId: string;
	guildName: string;
	/**
	 * A thread's parent channel, when it was created, and a snowflake of its creation (its ID): the parent's messages up
	 * to it came before the thread.
	 */
	thread?: { parentId: string; createdAt: number; createdId: string };
	lastMessageId: string | null;
};

/** What the relay needs of Discord. */
export type DiscordPort = {
	readonly botId: string;
	channel(id: string): Promise<DiscordChannel>;
	/** A page before or after a snowflake, always returned oldest first. */
	messages(channelId: string, query: { after?: string; before?: string; limit: number }): Promise<DiscordMessage[]>;
	/**
	 * Posts `text` (at most 2000 characters; may be empty with files) with `files` attached (at most 10, together within
	 * `uploadLimit`), as a reply to `messageId` when given.
	 */
	reply(
		channelId: string,
		messageId: string | undefined,
		text: string,
		files?: readonly { name: string; data: Uint8Array }[],
		nonce?: string,
	): Promise<void>;
	/** The bytes one message's attachments may have in `channelId` (its server's limit). */
	uploadLimit(channelId: string): Promise<number>;
	typing(channelId: string): Promise<void>;
};

export type TurnState =
	| { state: "pending" }
	| { state: "answered"; text: string; files: OfferedFile[] }
	| { state: "stopped" }
	| { state: "unanswered"; reason: string; files: OfferedFile[] };

/** What the relay needs of a session (its worker's `DiscordIngress`, the catalog). */
export type SessionPort = {
	/** Whether the session exists, is not archived and works in a sandbox; why not otherwise. */
	usable(session: string): Promise<string | undefined>;
	lock(session: string): SessionLock | null;
	deliver(
		session: string,
		input: {
			conversation?: number;
			requestId: string;
			author: { id: string; name: string };
			text: string;
			context: { channel: string; guild: string; messages: number; thread?: string };
			files: { url: string; name: string; size: number; key: string; ref: string }[];
			lock: SessionLock | null;
		},
	): Promise<{ conversation: number; submissionId: number }>;
	turn(session: string, submissionId: number): Promise<TurnState>;
	thread(session: string, name: string, before: number): Promise<{ conversation: number }>;
	/** `length` bytes (at most 4 MiB) of offered file `id` from `offset`. */
	read(session: string, id: string, offset: number, length: number): Promise<Uint8Array>;
	/** Runs channel command `command` on `conversation` (default: the main one): the reply's text. */
	command(session: string, input: { conversation?: number; command: Command }): Promise<{ text: string }>;
};

/** The relay's persisted state: bindings by channel, pending replies by the Discord message that woke Pi. */
export type RelayState = { bindings: Record<string, Binding>; pending: Record<string, Pending> };

export type StatePort = {
	value(): RelayState;
	change(update: (draft: RelayState) => void): Promise<void>;
};

/** Messages one history request asks for (Discord's maximum). */
export const PAGE = 100;
/** Messages one batch puts into the input at most: the newest; the header counts the earlier ones left out. */
export const BATCH_CAP = 200;
/** Maximum Discord history API pages examined in one catch-up invocation, across all links. */
export const CATCH_UP_PAGES = 4;
/** Maximum forward history pages per delivery before switching to newest-message pagination. */
export const DELIVERY_HISTORY_PAGES = 32;
/** Discord's limit for one message's text. */
export const MESSAGE_LIMIT = 2000;
/** Attachments up to this size are downloaded into the session; larger ones are listed as links. */
export const MAX_ATTACHMENT = 25 * 1024 * 1024;
const MAX_FILES = 20;

/** A pending reply older than this is dropped with a notice: its turn is not going to end on its own. */
export const PENDING_TIMEOUT_MS = 6 * 60 * 60 * 1000;

export class Relay {
	readonly #discord: (bot: string) => DiscordPort | undefined;
	/** Pending replies being checked: two checks at once would post one reply twice. */
	readonly #checking = new Set<string>();
	/**
	 * Each channel's and thread's delivery under way, the next one chained after it: two mentions in quick succession
	 * would otherwise both read from the same cursor and deliver overlapping batches.
	 */
	readonly #lanes = new Map<string, Promise<void>>();
	/** Channels and threads with deliveries under way (how many), and their bots: "typing" from the first moment. */
	readonly #delivering = new Map<string, { bot: string; count: number }>();
	readonly #sessions: SessionPort;
	readonly #state: StatePort;
	readonly #resumeCatchUp: ((bot: string) => void) | undefined;
	/** Submission work pinned to its session until it has finished, including worker RPC. */
	readonly #inFlight = new Map<string, Set<Promise<unknown>>>();

	#trackSession<T>(session: string, task: Promise<T>): Promise<T> {
		let active = this.#inFlight.get(session);
		if (!active) {
			active = new Set();
			this.#inFlight.set(session, active);
		}
		active.add(task);
		const done = () => {
			active!.delete(task);
			if (active!.size === 0 && this.#inFlight.get(session) === active) this.#inFlight.delete(session);
		};
		void task.then(done, done);
		return task;
	}

	/** Unlink must revoke binding and await all worker submissions before removing its lock. */
	async waitForSession(session: string): Promise<void> {
		for (;;) {
			const active = this.#inFlight.get(session);
			if (!active?.size) return;
			await Promise.allSettled([...active]);
		}
	}


	/** `discord`: bot `bot` while it is connected. */
	constructor(
		discord: (bot: string) => DiscordPort | undefined,
		sessions: SessionPort,
		state: StatePort,
		resumeCatchUp?: (bot: string) => void,
	) {
		this.#discord = discord;
		this.#sessions = sessions;
		this.#state = state;
		this.#resumeCatchUp = resumeCatchUp;
	}

	#port(bot: string): DiscordPort {
		const port = this.#discord(bot);
		if (!port) throw new Error("The Discord bot is not connected");
		return port;
	}

	/**
	 * A message bot `bot` received: a mention of it by someone allowed to wake Pi, in a channel linked through it (or a
	 * thread of one), delivers.
	 */
	async onMessage(bot: string, message: DiscordMessage): Promise<void> {
		if (message.author.bot || !message.mentionsBot) return;
		const port = this.#port(bot);
		const { bindings } = this.#state.value();
		let binding = bindings[message.channelId];
		let thread: DiscordChannel | undefined;
		if (!binding) {
			const channel = await port.channel(message.channelId);
			if (!channel.thread) return;
			binding = bindings[channel.thread.parentId];
			if (!binding) return;
			thread = channel;
		}
		// Another bot in the channel may be mentioned too: only the link's own bot listens.
		if (binding.botId !== bot || !mayWake(binding.wake, message.author.id, message.roles)) return;
		// Invalidate an in-flight channel lookup if unlink/relink completed during that await.
		const current = this.#state.value().bindings[binding.channelId];
		if (!current || current.session !== binding.session || current.generation !== binding.generation) return;
		// A command runs now, never behind the delivery under way (a stop must reach the running turn).
		const command = commandOf(message.text, port.botId);
		if (command) await this.#trackSession(binding.session, this.#command(binding, thread, message, command));
		else await this.deliver(binding.channelId, message, thread);
	}

	/** Runs channel command `command` of `message` on the channel's main conversation or the thread's subagent. */
	async #command(
		binding: Binding,
		thread: DiscordChannel | undefined,
		message: DiscordMessage,
		command: Command,
	): Promise<void> {
		const port = this.#port(binding.botId);
		const where = thread?.id ?? binding.channelId;
		const refusal = await this.#sessions.usable(binding.session);
		if (refusal) return port.reply(where, message.id, `Pi is not listening here right now: ${refusal}`);
		const conversation = thread ? binding.threads[thread.id]?.conversation : undefined;
		if (thread && conversation === undefined)
			return port.reply(
				where,
				message.id,
				command === "stop" ? "Nothing is running." : "This thread has no agent yet: mention the bot to start one.",
			);
		let text: string;
		try {
			({ text } = await this.#sessions.command(binding.session, {
				...(conversation === undefined ? {} : { conversation }),
				command,
			}));
		} catch (error) {
			text = `Could not reach Pi: ${error instanceof Error ? error.message : String(error)}`;
		}
		await port.reply(where, message.id, text);
	}

	/** Whether `message` is a channel command of `binding` (never delivered to the agent, nor caught up on). */
	#isCommand(binding: Binding, message: DiscordMessage, botId: string): boolean {
		return (
			message.mentionsBot &&
			mayWake(binding.wake, message.author.id, message.roles) &&
			commandOf(message.text, botId) !== undefined
		);
	}

	/**
	 * Delivers the batch ending at `trigger` to the binding's session (a thread's subagent for a message in a thread),
	 * then advances the cursor and records the pending reply. A session that cannot take it gets a notice instead. One
	 * delivery at a time per channel or thread: a later one starts from the cursor the earlier one left.
	 */
	deliver(channelId: string, trigger: DiscordMessage, thread: DiscordChannel | undefined): Promise<void> {
		const session = this.#state.value().bindings[channelId]?.session;
		const task = this.#deliverQueued(channelId, trigger, thread);
		return session ? this.#trackSession(session, task) : task;
	}

	private async #deliverQueued(channelId: string, trigger: DiscordMessage, thread: DiscordChannel | undefined): Promise<void> {
		const target = thread?.id ?? channelId;
		// "Typing" at once, before the wait for an earlier delivery and the history's pages: `typing()` refreshes it
		// until the delivery ends, then the pending reply keeps it on.
		const stopTyping = this.#typingWhile(channelId, target, trigger);
		const run = (this.#lanes.get(target) ?? Promise.resolve()).then(() => this.#deliver(channelId, trigger, thread));
		// The lane goes on whether this delivery failed or not; the caller still learns it failed.
		const lane = run.catch(() => {});
		this.#lanes.set(target, lane);
		try {
			await run;
		} finally {
			if (this.#lanes.get(target) === lane) this.#lanes.delete(target);
			stopTyping();
		}
	}

	/** Shows "typing" in `target` while a delivery of `trigger` is under way (none for one delivered already): its end. */
	#typingWhile(channelId: string, target: string, trigger: DiscordMessage): () => void {
		const binding = this.#state.value().bindings[channelId];
		const cursor = target === channelId ? binding?.cursor : binding?.threads[target]?.cursor;
		if (!binding || (cursor && BigInt(trigger.id) <= BigInt(cursor))) return () => {};
		const bot = binding.botId;
		const active = this.#delivering.get(target) ?? { bot, count: 0 };
		active.count++;
		this.#delivering.set(target, active);
		void this.#discord(bot)
			?.typing(target)
			.catch(() => {});
		return () => {
			active.count--;
			if (active.count === 0 && this.#delivering.get(target) === active) this.#delivering.delete(target);
		};
	}

	async #deliver(channelId: string, trigger: DiscordMessage, thread: DiscordChannel | undefined): Promise<void> {
		const binding = this.#state.value().bindings[channelId];
		if (!binding) return;
		const port = this.#port(binding.botId);
		const where = thread?.id ?? channelId;
		const refusal = await this.#sessions.usable(binding.session);
		if (refusal) return port.reply(where, trigger.id, `Pi is not listening here right now: ${refusal}`);
		let conversation: number | undefined;
		let cursor = binding.cursor;
		if (thread) {
			let known = binding.threads[thread.id];
			if (!known) {
				const created = await this.#sessions.thread(
					binding.session,
					thread.name,
					thread.thread?.createdAt ?? Date.now(),
				);
				known = { conversation: created.conversation, name: thread.name, cursor: null };
				const value = known;
				await this.#state.change((draft) => {
					const current = draft.bindings[channelId];
					if (current) current.threads[thread.id] = value;
				});
			}
			conversation = known.conversation;
			cursor = known.cursor;
		}
		// Delivered already (a catch-up, then the same mention replayed by a resumed gateway).
		if (cursor !== null && BigInt(trigger.id) <= BigInt(cursor)) return;
		// Everything since the cursor, page by page; only the newest BATCH_CAP go into the input. A thread's first
		// batch starts with what its channel said after the channel's cursor until the thread was made: its subagent
		// is forked from before that and never saw it (the channel's cursor stays: the main agent gets it too).
		let window = new BatchWindow(BATCH_CAP);
		const before = thread?.thread && cursor === null ? thread.thread.createdId : undefined;
		let truncated = false;
		const markTruncated = () => { truncated = true; };
		if (before !== undefined)
			for await (const message of history(port, channelId, binding.cursor, before, markTruncated))
				if (!message.author.bot && !this.#isCommand(binding, message, port.botId)) window.add("channel", message);
		for await (const message of history(port, where, cursor, trigger.id, markTruncated))
			if (!message.author.bot && !this.#isCommand(binding, message, port.botId)) window.add("here", message);
		if (truncated) {
			// The prompt already keeps only BATCH_CAP messages. Do not scan a giant backlog:
			// fetch recent pages backwards from the trigger instead of unbounded older pages.
			window = new BatchWindow(BATCH_CAP);
			if (before !== undefined)
				for (const message of await recentHistory(port, channelId, binding.cursor, before, true))
					if (!message.author.bot && !this.#isCommand(binding, message, port.botId)) window.add("channel", message);
			for (const message of await recentHistory(port, where, cursor, trigger.id, false))
				if (!message.author.bot && !this.#isCommand(binding, message, port.botId)) window.add("here", message);
		}
		if (!window.has(trigger.id)) window.add("here", trigger);
		const plural = (count: number) => `${count} message${count === 1 ? "" : "s"}`;
		const left = truncated
			? `; deep Discord history truncated after ${DELIVERY_HISTORY_PAGES} API pages; newest ${window.kept} messages shown`
			: window.omitted
				? `; the ${window.omitted} earliest are left out, the newest ${window.kept} follow`
				: "";
		const channelName = `#${binding.channelName}`;
		const header = !thread
			? `[Discord ${channelName} (${binding.guildName}): ${plural(window.total)} since the last delivery${left}]`
			: before === undefined
				? `[Discord thread "${thread.name}" in ${channelName} (${binding.guildName}): ${plural(window.total)} since the last delivery${left}]`
				: `[Discord thread "${thread.name}" in ${channelName} (${binding.guildName}), its first delivery: ${window.count("channel") ? `${plural(window.count("channel"))} of ${channelName} before the thread, then ` : ""}${plural(window.count("here"))} of the thread${left}]`;
		const batch = batchOf(
			window.sections({
				channel: `[${channelName}, before the thread]`,
				here: before !== undefined && window.count("channel") ? "[The thread]" : undefined,
			}),
			port.botId,
			header,
		);
		let delivered: { conversation: number; submissionId: number };
		try {
			// A channel may be unlinked while its history is being fetched.
			const latest = this.#state.value().bindings[channelId];
			if (!latest || latest.session !== binding.session || latest.generation !== binding.generation) return;
			delivered = await this.#sessions.deliver(binding.session, {
				...(conversation === undefined ? {} : { conversation }),
				requestId: `discord:${trigger.id}`,
				author: { id: trigger.author.id, name: trigger.author.name },
				text: batch.text,
				context: {
					channel: binding.channelName,
					guild: binding.guildName,
					messages: truncated ? Math.max(window.total, DELIVERY_HISTORY_PAGES * PAGE) : window.total,
					...(thread ? { thread: thread.name } : {}),
				},
				files: batch.files,
				lock: this.#sessions.lock(binding.session),
			});
		} catch (error) {
			await port.reply(
				where,
				trigger.id,
				`Could not reach Pi: ${error instanceof Error ? error.message : String(error)}`,
			);
			return;
		}
		await this.#state.change((draft) => {
			const current = draft.bindings[channelId];
			if (!current || current.session !== binding.session || current.generation !== binding.generation) return;
			if (thread) {
				const known = current.threads[thread.id];
				if (known) known.cursor = trigger.id;
			} else current.cursor = trigger.id;
			draft.pending[trigger.id] = {
				botId: binding.botId,
				session: binding.session,
				channelId,
				replyChannelId: where,
				messageId: trigger.id,
				submissionId: delivered.submissionId,
				since: Date.now(),
				...(binding.generation === undefined ? {} : { linkGeneration: binding.generation }),
			};
		});
	}

	/**
	 * Bot `bot` (re)connected: what it missed. For each of its links and their threads, the newest mention since the
	 * cursor by someone allowed to wake Pi delivers, as if it had just arrived (one delivery each, the messages before it
	 * included).
	 */
	async catchUp(bot: string): Promise<void> {
		const port = this.#port(bot);
		let remaining = CATCH_UP_PAGES;
		let continuation = false;
		links: for (const binding of Object.values(this.#state.value().bindings)) {
			if (binding.botId !== bot) continue;
			const places: { id: string; cursor: string | null; scan?: string; thread: boolean }[] = [
				{ id: binding.channelId, cursor: binding.cursor, scan: binding.catchUpScan, thread: false },
				...Object.entries(binding.threads).map(([id, known]) => ({
					id, cursor: known.cursor, scan: known.catchUpScan, thread: true,
				})),
			];
			for (const place of places) {
				if (remaining === 0) {
					continuation = true;
					break links;
				}
				try {
					// Scanning has its own persisted checkpoint; delivery still starts at the last
					// delivered cursor so chatter before a later mention is not lost.
					let after = place.scan && (place.cursor === null || BigInt(place.scan) > BigInt(place.cursor))
						? place.scan : place.cursor ?? "0";
					let newest: DiscordMessage | undefined;
					let more = false;
					let scanned = false;
					do {
						const page = await port.messages(place.id, { after, limit: PAGE });
						remaining--;
						if (!page.length) {
							more = false;
							break;
						}
						scanned = true;
						for (const message of page)
							if (
								!message.author.bot &&
								message.mentionsBot &&
								mayWake(binding.wake, message.author.id, message.roles) &&
								!this.#isCommand(binding, message, port.botId)
							)
								newest = message;
						after = page.at(-1)!.id;
						more = page.length === PAGE;
					} while (more && remaining > 0);
					if (newest) {
						const thread = place.thread ? await port.channel(place.id) : undefined;
						await this.deliver(binding.channelId, newest, thread);
					}
					if (scanned) await this.#state.change((draft) => {
						const current = draft.bindings[binding.channelId];
						if (!current || current.session !== binding.session || current.generation !== binding.generation) return;
						const target = place.thread ? current.threads[place.id] : current;
						if (!target) return;
						if (target.cursor !== null && BigInt(after) <= BigInt(target.cursor))
							delete target.catchUpScan;
						else target.catchUpScan = after;
					});
					if (more) continuation = true;
					if (remaining === 0) {
						continuation = true;
						break links;
					}
				} catch (error) {
					// A channel or thread that went away (or a session that cannot take it) skips only itself.
					console.error("p2 discord: catching up failed:", error instanceof Error ? error.message : error);
				}
			}
		}
		if (continuation) this.#resumeCatchUp?.(bot);
	}

	/** Posts the replies of the turns that ended (`sessions`: only those, when given); answers split at 2000. */
	async checkPending(sessions?: ReadonlySet<string>): Promise<void> {
		const now = Date.now();
		for (const pending of Object.values(this.#state.value().pending)) {
			if ((sessions && !sessions.has(pending.session)) || this.#checking.has(pending.messageId)) continue;
			if ((pending.retryAt ?? 0) > now) continue;
			// Losing the connection never means discarding a completed response, even after a long outage.
			const port = this.#discord(pending.botId);
			if (!port) continue;
			this.#checking.add(pending.messageId);
			try {
				await this.#check(port, pending, now);
			} finally {
				this.#checking.delete(pending.messageId);
			}
		}
	}

	/** Ensure a pending reply still belongs to the exact live channel link. */
	#pendingMatches(current: Pending | undefined, pending: Pending): boolean {
		return current !== undefined && current.messageId === pending.messageId &&
			current.submissionId === pending.submissionId && current.session === pending.session &&
			current.channelId === pending.channelId && current.botId === pending.botId &&
			current.linkGeneration === pending.linkGeneration;
	}

	#pendingIsCurrent(pending: Pending): boolean {
		const state = this.#state.value();
		const binding = state.bindings[pending.channelId];
		return this.#pendingMatches(state.pending[pending.messageId], pending) &&
			binding !== undefined && binding.session === pending.session && binding.botId === pending.botId &&
			binding.generation === pending.linkGeneration;
	}

	async #forget(pending: Pending): Promise<void> {
		await this.#state.change((draft) => {
			if (this.#pendingMatches(draft.pending[pending.messageId], pending)) delete draft.pending[pending.messageId];
		});
	}

	async #check(port: DiscordPort, pending: Pending, now: number): Promise<void> {
		if (!this.#pendingIsCurrent(pending)) {
			await this.#forget(pending);
			return;
		}
		let turn: TurnState;
		try {
			turn = await this.#sessions.turn(pending.session, pending.submissionId);
		} catch (error) {
			console.error("p2 discord: reading a turn failed:", error instanceof Error ? error.message : error);
			if (now - pending.since < PENDING_TIMEOUT_MS) return;
			turn = { state: "unanswered", reason: "the session did not answer in time.", files: [] };
		}
		if (turn.state === "pending") {
			if (now - pending.since < PENDING_TIMEOUT_MS) return;
			turn = { state: "unanswered", reason: "the session did not answer in time.", files: [] };
		}
		// A stopped turn posts nothing; unlinking or relinking also revokes its right to post.
		if (turn.state === "stopped" || !this.#pendingIsCurrent(pending)) {
			await this.#forget(pending);
			return;
		}
		try {
			if (await this.#reply(port, pending, turn)) await this.#forget(pending);
		} catch (error) {
			console.error("p2 discord: posting a reply failed:", error instanceof Error ? error.message : error);
			if (!this.#pendingIsCurrent(pending) || isPermanentReplyFailure(error)) {
				await this.#forget(pending);
				return;
			}
			// Only a confirmed permanent channel/access error drops an answer.
			// Persist bounded exponential retry delay; successes reset it per posted chunk.
			const count = Math.min(32, (this.#state.value().pending[pending.messageId]?.retryCount ?? 0) + 1);
			const delay = Math.min(10 * 60_000, 1_000 * 2 ** Math.min(10, count - 1));
			await this.#state.change((draft) => {
				const current = draft.pending[pending.messageId];
				if (!this.#pendingMatches(current, pending)) return;
				current!.retryCount = count;
				current!.retryAt = now + delay;
			});
		}
	}

	/**
	 * Posts a finished turn's reply: its text split at 2000 characters, the first part replying to the waking message,
	 * and the files the turn offered attached (at most 10 a message, together within the server's limit; larger ones
	 * named only), the first ones on the last text part.
	 */
	async #reply(
		port: DiscordPort,
		pending: Pending,
		turn: Extract<TurnState, { state: "answered" | "unanswered" }>,
	): Promise<boolean> {
		if (!this.#pendingIsCurrent(pending)) return false;
		let text = turn.state === "answered" ? turn.text : `(No answer: ${turn.reason})`;
		const limit = pending.uploadLimit ?? (turn.files.length ? await port.uploadLimit(pending.replyChannelId) : 0);
		if (turn.files.length && pending.uploadLimit === undefined) {
			await this.#state.change((draft) => {
				const current = draft.pending[pending.messageId];
				if (this.#pendingMatches(current, pending)) current!.uploadLimit = limit;
			});
		}
		const tooLarge = turn.files.filter((file) => file.size > limit);
		if (tooLarge.length)
			text += `${text ? "\n\n" : ""}Too large for Discord: ${tooLarge.map((file) => `${file.name} (${megabytes(file.size)})`).join(", ")}`;
		const groups = attachmentGroups(turn.files.filter((file) => file.size <= limit), limit);
		const posts: { text: string; files: OfferedFile[] }[] = chunkText(text).map((chunk) => ({ text: chunk, files: [] }));
		for (const [index, group] of groups.entries()) {
			const last = posts.at(-1);
			if (index === 0 && last) last.files = group;
			else posts.push({ text: "", files: group });
		}
		for (let index = pending.nextPost ?? 0; index < posts.length; index++) {
			if (!this.#pendingIsCurrent(pending)) return false;
			const post = posts[index]!;
			const files: { name: string; data: Uint8Array }[] = [];
			for (const file of post.files)
				files.push({ name: file.name, data: await this.#readFile(pending.session, file) });
			if (!this.#pendingIsCurrent(pending)) return false;
			if (post.text || files.length)
				// Discord enforces this stable nonce for a short deduplication window, covering
				// an HTTP success whose reply was lost before our local checkpoint.
				await port.reply(pending.replyChannelId, index === 0 ? pending.messageId : undefined,
					post.text, files, replyNonce(pending.messageId, index));
			// Checkpoint each posted chunk so a later HTTP 429 never duplicates earlier successful chunks.
			await this.#state.change((draft) => {
				const current = draft.pending[pending.messageId];
				if (!this.#pendingMatches(current, pending)) return;
				current!.nextPost = index + 1;
				current!.retryCount = 0;
				current!.retryAt = 0;
			});
		}
		return this.#pendingIsCurrent(pending);
	}

	/** Offered file `file` of `session`, whole. */
	async #readFile(session: string, file: OfferedFile): Promise<Uint8Array> {
		const parts: Uint8Array[] = [];
		for (let offset = 0; offset < file.size; ) {
			const part = await this.#sessions.read(session, file.id, offset, Math.min(READ_CHUNK, file.size - offset));
			if (!part.length || part.length > Math.min(READ_CHUNK, file.size - offset))
				throw new Error(`Offered file ${file.name} ended before its declared size`);
			parts.push(part);
			offset += part.length;
		}
		const data = Buffer.concat(parts);
		if (data.length !== file.size) throw new Error(`Offered file ${file.name} is incomplete`);
		return data;
	}

	/**
	 * Refreshes "Pi is typing" (Discord shows it about 10 s; call it every 8 s) where a delivery is under way or a reply
	 * is pending, queued or not: it ends with the delivery's failure, or when the reply is posted, stopped or failed.
	 */
	async typing(): Promise<void> {
		const channels = new Map<string, string>();
		for (const [target, { bot }] of this.#delivering) channels.set(target, bot);
		for (const pending of Object.values(this.#state.value().pending))
			channels.set(pending.replyChannelId, pending.botId);
		for (const [channel, bot] of channels)
			await this.#discord(bot)
				?.typing(channel)
				.catch(() => {});
	}
}

/** Discord API code 10003 means the channel no longer exists; 50001/50013 deny access. */
function isPermanentReplyFailure(error: unknown): boolean {
	if (!error || typeof error !== "object") return false;
	const failure = error as { code?: unknown; rawError?: { code?: unknown } };
	const code = failure.code ?? failure.rawError?.code;
	return code === 10003 || code === "10003" || code === 50001 || code === "50001" ||
		code === 50013 || code === "50013";
}

/**
 * The messages of `channel` after `cursor` (null: from its start), oldest first, page by page; with `until`, up to and
 * with that message.
 */
async function* history(
	port: DiscordPort,
	channel: string,
	cursor: string | null,
	until?: string,
	onLimit?: () => void,
): AsyncGenerator<DiscordMessage> {
	let after = cursor ?? "0";
	for (let pages = 0; ; pages++) {
		if (pages >= DELIVERY_HISTORY_PAGES) {
			onLimit?.();
			return;
		}
		const page = await port.messages(channel, { after, limit: PAGE });
		for (const message of page) {
			if (until !== undefined && BigInt(message.id) > BigInt(until)) return;
			yield message;
		}
		const last = page.at(-1);
		if (page.length < PAGE || !last) return;
		after = last.id;
	}
}

/** Get at most the latest BATCH_CAP messages at/before a marker, without traversing a long backlog. */
async function recentHistory(
	port: DiscordPort,
	channel: string,
	cursor: string | null,
	until: string,
	includeUntil: boolean,
): Promise<DiscordMessage[]> {
	let before = includeUntil ? (BigInt(until) + 1n).toString() : until;
	const recent: DiscordMessage[] = [];
	for (let pages = 0; pages < Math.ceil(BATCH_CAP / PAGE) + 1; pages++) {
		const page = await port.messages(channel, { before, limit: PAGE });
		if (!page.length) break;
		const inRange = page.filter((message) =>
			(cursor === null || BigInt(message.id) > BigInt(cursor)) &&
			BigInt(message.id) <= BigInt(until),
		);
		recent.unshift(...inRange);
		if (recent.length >= BATCH_CAP || page.length < PAGE ||
			(cursor !== null && BigInt(page[0]!.id) <= BigInt(cursor))) break;
		before = page[0]!.id;
	}
	return recent.slice(-BATCH_CAP);
}

/**
 * The channel command `text` is, if it is one: with the bot's mentions removed, exactly a command (any case, an
 * optional leading slash).
 */
export function commandOf(text: string, botId: string): Command | undefined {
	const rest = text
		.replaceAll(`<@${botId}>`, "")
		.replaceAll(`<@!${botId}>`, "")
		.trim()
		.toLowerCase()
		.replace(/^\//, "");
	return COMMANDS.find((command) => command === rest);
}

/** Bytes one read of an offered file asks for. */
const READ_CHUNK = 4 * 1024 * 1024;
/** Attachments one Discord message carries at most. */
export const MAX_ATTACHMENTS_PER_MESSAGE = 10;

/** `files` (each within `limit`) in order, in groups of at most 10 whose sizes add up to at most `limit`. */
export function attachmentGroups<T extends { size: number }>(files: readonly T[], limit: number): T[][] {
	const groups: T[][] = [];
	let bytes = 0;
	for (const file of files) {
		const last = groups.at(-1);
		if (last && last.length < MAX_ATTACHMENTS_PER_MESSAGE && bytes + file.size <= limit) {
			last.push(file);
			bytes += file.size;
		} else {
			groups.push([file]);
			bytes = file.size;
		}
	}
	return groups;
}

function megabytes(size: number): string {
	return `${(size / (1024 * 1024)).toFixed(1)} MiB`;
}

/** Whether the author of a message may wake Pi in its binding. */
export function mayWake(wake: Wake, author: string, roles: readonly string[]): boolean {
	return wake.anyone || wake.users.includes(author) || roles.some((role) => wake.roles.includes(role));
}

/** Where a batch's message comes from: the place mentioned in, or (a thread's first batch) its parent channel. */
type Part = "channel" | "here";

/** The newest `cap` messages of a batch in order, by part, and how many there were in all. */
class BatchWindow {
	readonly #cap: number;
	readonly #entries: { part: Part; message: DiscordMessage }[] = [];
	readonly #counts: Record<Part, number> = { channel: 0, here: 0 };

	constructor(cap: number) {
		this.#cap = cap;
	}

	add(part: Part, message: DiscordMessage): void {
		this.#counts[part]++;
		this.#entries.push({ part, message });
		if (this.#entries.length > this.#cap) this.#entries.shift();
	}

	has(id: string): boolean {
		return this.#entries.some((entry) => entry.message.id === id);
	}

	/** Messages of `part`, kept or not. */
	count(part: Part): number {
		return this.#counts[part];
	}

	get total(): number {
		return this.#counts.channel + this.#counts.here;
	}

	get kept(): number {
		return this.#entries.length;
	}

	get omitted(): number {
		return this.total - this.kept;
	}

	/** The kept messages in runs of one part, each titled as `titles` says (none: untitled). */
	sections(titles: Record<Part, string | undefined>): { title?: string; messages: DiscordMessage[] }[] {
		const sections: { part: Part; messages: DiscordMessage[] }[] = [];
		for (const { part, message } of this.#entries) {
			const last = sections.at(-1);
			if (last?.part === part) last.messages.push(message);
			else sections.push({ part, messages: [message] });
		}
		return sections.map(({ part, messages }) => {
			const title = titles[part];
			return title === undefined ? { messages } : { title, messages };
		});
	}
}

/**
 * A batch's text: under the header, each section's title (if any), then one `Name: text` line (or paragraph) per
 * message, oldest first, the bot's mention written `@Pi`, and attachments too large to download listed as links. The
 * attachments to download, keyed by message and position.
 */
export function batchOf(
	sections: readonly { title?: string; messages: readonly DiscordMessage[] }[],
	botId: string,
	header: string,
): { text: string; files: { url: string; name: string; size: number; key: string; ref: string }[] } {
	const files: { url: string; name: string; size: number; key: string; ref: string }[] = [];
	const line = (message: DiscordMessage) => {
		const text = message.text.replaceAll(`<@${botId}>`, "@Pi").replaceAll(`<@!${botId}>`, "@Pi").trim();
		const links: string[] = [];
		message.attachments.forEach((attachment, index) => {
			if (attachment.size <= MAX_ATTACHMENT && files.length < MAX_FILES)
				files.push({
					url: attachment.url,
					name: attachment.name,
					size: attachment.size,
					key: `discord:${message.id}:${index}`,
					ref: message.id,
				});
			else links.push(`[attachment ${attachment.name} (${attachment.size} bytes): ${attachment.url}]`);
		});
		return `${message.author.name}: ${[text, ...links].filter(Boolean).join("\n")}`;
	};
	const lines = sections.flatMap(({ title, messages }) => [
		...(title === undefined ? [] : [title]),
		...messages.map(line),
	]);
	return { text: [header, ...lines].join("\n"), files };
}

/** `text` in pieces of at most `limit` characters, split at a line break where possible, else at a space. */
export function chunkText(text: string, limit = MESSAGE_LIMIT): string[] {
	const chunks: string[] = [];
	let rest = text.trim();
	while (rest.length > limit) {
		let cut = rest.lastIndexOf("\n", limit);
		if (cut < limit / 2) cut = rest.lastIndexOf(" ", limit);
		if (cut < limit / 2) cut = limit;
		chunks.push(rest.slice(0, cut).trimEnd());
		rest = rest.slice(cut).trimStart();
	}
	if (rest) chunks.push(rest);
	return chunks;
}
