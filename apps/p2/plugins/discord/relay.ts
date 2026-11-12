// What happens between a Discord channel and its linked session (server): a mention by someone allowed to wake Pi, seen
// by the link's bot, delivers the messages since the link's cursor (a thread's: to its forked subagent) as one input; a
// pending reply is posted once its turn ended. Plain logic over ports, so tests run it with fake bots and sessions.
import type { SessionLock } from "@p2/app/v1";
import { type Binding, COMMANDS, type Command, type OfferedFile, type Pending, type Wake } from "./contract.ts";
import { replyNonce } from "./reply-nonce.ts";

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
	| { state: "answered"; text: string; files: OfferedFile[]; answer?: number }
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
/** Aggregate cap shared by catch-up scan and any delivery-history lookups. */
export const CATCH_UP_TOTAL_PAGES = 64;
/** Maximum forward history pages per delivery before switching to newest-message pagination. */
export const DELIVERY_HISTORY_PAGES = 32;
/** Discord's limit for one message's text. */
export const MESSAGE_LIMIT = 2000;
/** Attachments up to this size are downloaded into the session; larger ones are listed as links. */
export const MAX_ATTACHMENT = 25 * 1024 * 1024;
const MAX_FILES = 20;

/** A pending reply older than this is dropped with a notice: its turn is not going to end on its own. */
export const PENDING_TIMEOUT_MS = 6 * 60 * 60 * 1000;
export const MAX_BOT_TURNS = 3;

export class Relay {
	readonly #discord: (bot: string) => DiscordPort | undefined;
	/** Pending replies being checked: two checks at once would post one reply twice. */
	readonly #checking = new Set<string>();
	/** Recently posted session-answer IDs prevent duplicate replies across separate checks. */
	readonly #postedAnswerKeys = new Set<string>();
	/**
	 * Each channel's and thread's delivery under way, the next one chained after it: two mentions in quick succession
	 * would otherwise both read from the same cursor and deliver overlapping batches.
	 */
	readonly #lanes = new Map<string, Promise<void>>();
	/** Channels and threads with deliveries under way (how many), and their bots: "typing" from the first moment. */
	readonly #delivering = new Map<string, { bot: string; count: number }>();
	readonly #botStreaks = new Map<string, { turns: number; noticed: boolean }>();
	readonly #sessions: SessionPort;
	readonly #state: StatePort;
	readonly #resumeCatchUp: ((bot: string) => void) | undefined;
	/** Stable place identities survive deletions/reordering of links during continuation. */
	readonly #catchUpVisited = new Map<string, Set<string>>();
	readonly #catchUpRetries = new Map<string, { bot: string; after: number }>();

	/** Called by the live server's periodic tick; never requeue failed work in a tight loop. */
	retryDeferredCatchUps(now = Date.now()): void {
		const ready = new Set<string>();
		for (const [key, retry] of this.#catchUpRetries) {
			if (retry.after > now) continue;
			this.#catchUpRetries.delete(key);
			ready.add(retry.bot);
		}
		for (const bot of ready) this.#resumeCatchUp?.(bot);
	}
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
		const port = this.#port(bot);
		if (message.author.id === port.botId) return;
		if (!message.author.bot) this.#personWrote(message.channelId);
		if (!message.mentionsBot) return;
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
		if (
			!current ||
			current.session !== binding.session ||
			current.generation !== binding.generation ||
			!mayWake(current.wake, message.author.id, message.roles)
		)
			return;
		// A command runs now, never behind the delivery under way (a stop must reach the running turn).
		const command = commandOf(message.text, port.botId);
		if (command) await this.#trackSession(binding.session, this.#command(binding, thread, message, command));
		else if (this.#botTurnAllowed(port, message)) await this.deliver(binding.channelId, message, thread);
	}

	/** A person wrote in `target` (a channel or thread): bots may wake Pi there again. */
	#personWrote(target: string): void {
		this.#botStreaks.delete(target);
	}

	/**
	 * Whether `message` may start a turn: a person's always; a bot's while fewer than `MAX_BOT_TURNS` turns in a row
	 * there were started by bots (two bots mentioning each other would otherwise talk forever). The first one refused
	 * gets a short notice; the streak ends when a person writes.
	 */
	#botTurnAllowed(port: DiscordPort, message: DiscordMessage): boolean {
		if (!message.author.bot) return true;
		const target = message.channelId;
		const streak = this.#botStreaks.get(target) ?? { turns: 0, noticed: false };
		this.#botStreaks.set(target, streak);
		if (streak.turns < MAX_BOT_TURNS) {
			streak.turns++;
			return true;
		}
		console.error(
			`p2 discord: not answering ${message.author.name} in ${target}: ${MAX_BOT_TURNS} bot-started turns in a row`,
		);
		if (!streak.noticed) {
			streak.noticed = true;
			void port
				.reply(
					target,
					message.id,
					`Not answering more bots here until a person writes (${MAX_BOT_TURNS} bot turns in a row).`,
				)
				.catch(() => {});
		}
		return false;
	}

	/**
	 * Only the actual linked bot may acknowledge an overloaded command. Resolve
	 * thread membership before the final state lookup, so unlink/relink changes
	 * during the network request cannot leak a notice to a stale channel.
	 */
	async mayNotifyControlRejected(bot: string, message: DiscordMessage): Promise<boolean> {
		if (message.author.bot || !message.mentionsBot) return false;
		const port = this.#discord(bot);
		if (!port || !commandOf(message.text, port.botId)) return false;
		let channelId = message.channelId;
		if (!this.#state.value().bindings[channelId]) {
			const thread = await port.channel(channelId).catch(() => undefined);
			if (!thread?.thread) return false;
			channelId = thread.thread.parentId;
		}
		const binding = this.#state.value().bindings[channelId];
		return binding?.botId === bot && mayWake(binding.wake, message.author.id, message.roles);
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
	deliver(
		channelId: string,
		trigger: DiscordMessage,
		thread: DiscordChannel | undefined,
		historyBudget?: { remaining: number },
	): Promise<void> {
		const session = this.#state.value().bindings[channelId]?.session;
		const task = this.#deliverQueued(channelId, trigger, thread, historyBudget);
		return session ? this.#trackSession(session, task) : task;
	}

	async #deliverQueued(
		channelId: string,
		trigger: DiscordMessage,
		thread: DiscordChannel | undefined,
		historyBudget?: { remaining: number },
	): Promise<void> {
		const target = thread?.id ?? channelId;
		// "Typing" at once, before the wait for an earlier delivery and the history's pages: `typing()` refreshes it
		// until the delivery ends, then the pending reply keeps it on.
		const stopTyping = this.#typingWhile(channelId, target, trigger);
		const run = (this.#lanes.get(target) ?? Promise.resolve()).then(() =>
			this.#deliver(channelId, trigger, thread, historyBudget),
		);
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

	async #deliver(
		channelId: string,
		trigger: DiscordMessage,
		thread: DiscordChannel | undefined,
		historyBudget?: { remaining: number },
	): Promise<void> {
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
		const markTruncated = () => {
			truncated = true;
		};
		const historicalPort: Pick<DiscordPort, "messages"> = historyBudget
			? {
					messages: async (id, query) => {
						if (historyBudget.remaining <= 0)
							throw new Error("Discord catch-up context history budget exhausted; delivery not checkpointed");
						historyBudget.remaining--;
						return port.messages(id, query);
					},
				}
			: port;
		if (before !== undefined)
			for await (const message of history(historicalPort, channelId, binding.cursor, before, markTruncated))
				if (message.author.id !== port.botId && !this.#isCommand(binding, message, port.botId))
					window.add("channel", message);
		for await (const message of history(historicalPort, where, cursor, trigger.id, markTruncated))
			if (message.author.id !== port.botId && !this.#isCommand(binding, message, port.botId))
				window.add("here", message, message.id === trigger.id);
		if (truncated) {
			// The prompt already keeps only BATCH_CAP messages. Do not scan a giant backlog:
			// fetch recent pages backwards from the trigger instead of unbounded older pages.
			window = new BatchWindow(BATCH_CAP);
			if (before !== undefined)
				for (const message of await recentHistory(
					historicalPort,
					channelId,
					binding.cursor,
					before,
					true,
					(message) => message.author.id !== port.botId && !this.#isCommand(binding, message, port.botId),
				))
					if (message.author.id !== port.botId && !this.#isCommand(binding, message, port.botId))
						window.add("channel", message);
			for (const message of await recentHistory(
				historicalPort,
				where,
				cursor,
				trigger.id,
				false,
				(message) => message.author.id !== port.botId && !this.#isCommand(binding, message, port.botId),
			))
				if (message.author.id !== port.botId && !this.#isCommand(binding, message, port.botId))
					window.add("here", message, message.id === trigger.id);
		}
		if (!window.has(trigger.id)) window.add("here", trigger, true);
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
			if (
				!latest ||
				latest.session !== binding.session ||
				latest.generation !== binding.generation ||
				!mayWake(latest.wake, trigger.author.id, trigger.roles)
			)
				return;
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
		const historyBudget = { remaining: CATCH_UP_TOTAL_PAGES };
		const places = Object.values(this.#state.value().bindings)
			.filter((binding) => binding.botId === bot)
			.flatMap((binding) => [
				{
					binding,
					id: binding.channelId,
					cursor: binding.cursor,
					scan: binding.catchUpScan,
					thread: false,
					key: `${bot}:${binding.channelId}:${binding.generation ?? ""}`,
				},
				...Object.entries(binding.threads).map(([id, known]) => ({
					binding,
					id,
					cursor: known.cursor,
					scan: known.catchUpScan,
					thread: true,
					key: `${bot}:${binding.channelId}:${id}:${binding.generation ?? ""}`,
				})),
			]);
		const visited = this.#catchUpVisited.get(bot) ?? new Set<string>();
		this.#catchUpVisited.set(bot, visited);
		const active = new Set(places.map((place) => place.key));
		for (const key of visited) if (!active.has(key)) visited.delete(key);
		for (const [key, retry] of this.#catchUpRetries)
			if (retry.bot === bot && !active.has(key)) this.#catchUpRetries.delete(key);
		let remaining = CATCH_UP_PAGES;
		let needsContinuation = false;
		for (const place of places) {
			if (visited.has(place.key)) continue;
			if ((this.#catchUpRetries.get(place.key)?.after ?? 0) > Date.now()) continue;
			const binding = place.binding;
			if (remaining === 0 || historyBudget.remaining === 0) {
				needsContinuation = true;
				break;
			}
			try {
				// Scan progress is separate from delivery's cursor; a later mention still
				// includes all required context since the last successful delivery.
				let after =
					place.scan && (place.cursor === null || BigInt(place.scan) > BigInt(place.cursor))
						? place.scan
						: (place.cursor ?? "0");
				let newest: DiscordMessage | undefined;
				let more = false;
				let scanned = false;
				do {
					const page = await port.messages(place.id, { after, limit: PAGE });
					remaining--;
					historyBudget.remaining--;
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
				let refused = false;
				if (newest) {
					const thread = place.thread ? await port.channel(place.id) : undefined;
					// A link or wake policy can change while the Discord API is awaited.
					const current = this.#state.value().bindings[binding.channelId];
					if (
						!current ||
						current.session !== binding.session ||
						current.generation !== binding.generation ||
						(place.thread && !current.threads[place.id]) ||
						!mayWake(current.wake, newest.author.id, newest.roles)
					)
						continue;
					await this.deliver(binding.channelId, newest, thread, historyBudget);
					const updated = this.#state.value().bindings[binding.channelId];
					const cursor = place.thread ? updated?.threads[place.id]?.cursor : updated?.cursor;
					if (
						updated?.session === binding.session &&
						(cursor === undefined || cursor === null || BigInt(cursor) < BigInt(newest.id))
					) {
						// A refused/failed worker RPC must not consume its trigger.
						after = (BigInt(newest.id) - 1n).toString();
						refused = true;
					}
				}
				if (scanned)
					await this.#state.change((draft) => {
						const current = draft.bindings[binding.channelId];
						if (!current || current.session !== binding.session || current.generation !== binding.generation)
							return;
						const target = place.thread ? current.threads[place.id] : current;
						if (!target) return;
						if (target.cursor !== null && BigInt(after) <= BigInt(target.cursor)) delete target.catchUpScan;
						else target.catchUpScan = after;
					});
				if (refused) {
					this.#catchUpRetries.set(place.key, { bot, after: Date.now() + 8_000 });
					continue;
				}
				if (more) {
					// Persisted scan cursor lets the next job continue this exact place.
					needsContinuation = true;
					break;
				}
				visited.add(place.key);
			} catch (error) {
				console.error("p2 discord: catching up failed:", error instanceof Error ? error.message : error);
				this.#catchUpRetries.set(place.key, { bot, after: Date.now() + 8_000 });
			}
		}
		if (needsContinuation) this.#resumeCatchUp?.(bot);
		else if (visited.size === places.length) this.#catchUpVisited.delete(bot);
	}

	/** Posts the replies of the turns that ended (`sessions`: only those, when given); answers split at 2000. */
	async checkPending(sessions?: ReadonlySet<string>): Promise<void> {
		const now = Date.now();
		const candidates: { pending: Pending; port: DiscordPort; turn: TurnState | undefined }[] = [];
		const claimed: string[] = [];
		try {
			for (const pending of Object.values(this.#state.value().pending)) {
				if ((sessions && !sessions.has(pending.session)) || this.#checking.has(pending.messageId)) continue;
				if ((pending.retryAt ?? 0) > now) continue;
				// A temporarily disconnected bot must retain its pending replies.
				const port = this.#discord(pending.botId);
				if (!port) continue;
				this.#checking.add(pending.messageId);
				claimed.push(pending.messageId);
				let turn: TurnState | undefined;
				try {
					turn = await this.#sessions.turn(pending.session, pending.submissionId);
				} catch {
					// The normal check handles transient failures and the timeout notice.
				}
				candidates.push({ pending, port, turn });
			}

			// Steered inputs can share one answer. Only the newest mention gets its reply,
			// including files offered by earlier inputs of that same turn.
			const grouped = new Map<string, typeof candidates>();
			const individual: typeof candidates = [];
			for (const item of candidates) {
				const key =
					item.turn?.state === "answered" && typeof item.turn.answer === "number"
						? `${item.pending.session}:${item.turn.answer}`
						: undefined;
				if (!key) {
					individual.push(item);
					continue;
				}
				const group = grouped.get(key) ?? [];
				group.push(item);
				grouped.set(key, group);
			}
			for (const [key, group] of grouped) {
				if (this.#postedAnswerKeys.has(key)) {
					for (const { pending } of group) await this.#forget(pending);
					continue;
				}
				const newest = group.reduce((latest, item) =>
					BigInt(item.pending.messageId) > BigInt(latest.pending.messageId) ? item : latest,
				);
				if (newest.turn?.state !== "answered") continue;
				const offered = new Map<string, OfferedFile>();
				for (const { turn } of group)
					if (turn?.state === "answered") for (const file of turn.files) offered.set(file.id, file);
				await this.#check(newest.port, newest.pending, now, {
					...newest.turn,
					files: Array.from(offered.values()),
				});
				if (!this.#state.value().pending[newest.pending.messageId]) {
					this.#postedAnswerKeys.add(key);
					if (this.#postedAnswerKeys.size > 512)
						this.#postedAnswerKeys.delete(this.#postedAnswerKeys.values().next().value!);
					for (const { pending } of group)
						if (pending.messageId !== newest.pending.messageId) await this.#forget(pending);
				}
			}
			for (const item of individual) await this.#check(item.port, item.pending, now, item.turn);
		} finally {
			for (const id of claimed) this.#checking.delete(id);
		}
	}

	/** Ensure a pending reply still belongs to the exact live channel link. */
	#pendingMatches(current: Pending | undefined, pending: Pending): boolean {
		return (
			current !== undefined &&
			current.messageId === pending.messageId &&
			current.submissionId === pending.submissionId &&
			current.session === pending.session &&
			current.channelId === pending.channelId &&
			current.botId === pending.botId &&
			current.linkGeneration === pending.linkGeneration
		);
	}

	#pendingIsCurrent(pending: Pending): boolean {
		const state = this.#state.value();
		const binding = state.bindings[pending.channelId];
		return (
			this.#pendingMatches(state.pending[pending.messageId], pending) &&
			binding !== undefined &&
			binding.session === pending.session &&
			binding.botId === pending.botId &&
			binding.generation === pending.linkGeneration
		);
	}

	async #forget(pending: Pending): Promise<void> {
		await this.#state.change((draft) => {
			if (this.#pendingMatches(draft.pending[pending.messageId], pending)) delete draft.pending[pending.messageId];
		});
	}

	async #check(port: DiscordPort, pending: Pending, now: number, knownTurn?: TurnState): Promise<void> {
		if (!this.#pendingIsCurrent(pending)) {
			await this.#forget(pending);
			return;
		}
		let turn: TurnState;
		if (knownTurn) turn = knownTurn;
		else {
			try {
				turn = await this.#sessions.turn(pending.session, pending.submissionId);
			} catch (error) {
				console.error("p2 discord: reading a turn failed:", error instanceof Error ? error.message : error);
				if (now - pending.since < PENDING_TIMEOUT_MS) return;
				turn = { state: "unanswered", reason: "the session did not answer in time.", files: [] };
			}
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
		const groups = attachmentGroups(
			turn.files.filter((file) => file.size <= limit),
			limit,
		);
		const posts: { text: string; files: OfferedFile[] }[] = chunkText(text).map((chunk) => ({
			text: chunk,
			files: [],
		}));
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
				await port.reply(
					pending.replyChannelId,
					index === 0 ? pending.messageId : undefined,
					post.text,
					files,
					replyNonce(pending.messageId, index),
				);
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
	return (
		code === 10003 || code === "10003" || code === 50001 || code === "50001" || code === 50013 || code === "50013"
	);
}

/**
 * The messages of `channel` after `cursor` (null: from its start), oldest first, page by page; with `until`, up to and
 * with that message.
 */
async function* history(
	port: Pick<DiscordPort, "messages">,
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

/** Bounded reverse history, preserving the latest human context even behind a flood of bot posts. */
async function recentHistory(
	port: Pick<DiscordPort, "messages">,
	channel: string,
	cursor: string | null,
	until: string,
	includeUntil: boolean,
	eligible: (message: DiscordMessage) => boolean,
): Promise<DiscordMessage[]> {
	let before = includeUntil ? (BigInt(until) + 1n).toString() : until;
	const recent: DiscordMessage[] = [];
	let preferred = 0;
	const selected = (): DiscordMessage[] => {
		const window = new BatchWindow(BATCH_CAP);
		for (const message of recent) window.add("here", message);
		return window.sections({ channel: undefined, here: undefined }).flatMap(({ messages }) => messages);
	};
	// Look beyond a burst of bot messages for human context, but keep a hard
	// bound on remote reads: incomplete history must not checkpoint the cursor.
	for (let pages = 0; pages < 32; pages++) {
		const page = await port.messages(channel, { before, limit: PAGE });
		if (!page.length) return selected();
		const inRange = page.filter(
			(message) =>
				(cursor === null || BigInt(message.id) > BigInt(cursor)) &&
				BigInt(message.id) <= BigInt(until) &&
				eligible(message),
		);
		recent.unshift(...inRange);
		preferred += inRange.filter((message) => !message.author.bot).length;
		if (
			preferred >= BATCH_CAP ||
			page.length < PAGE ||
			(cursor !== null && BigInt(page[0]!.id) <= BigInt(cursor))
		)
			return selected();
		before = page[0]!.id;
	}
	// Do not quietly checkpoint a trigger if earlier eligible context was
	// hidden by a long burst of bot/system posts beyond the request budget.
	throw new Error("Discord history incomplete: eligible message context exceeds the bounded reverse scan");
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
	readonly #entries: { part: Part; message: DiscordMessage; pinned: boolean }[] = [];
	readonly #counts: Record<Part, number> = { channel: 0, here: 0 };

	constructor(cap: number) {
		this.#cap = cap;
	}

	add(part: Part, message: DiscordMessage, pinned = false): void {
		this.#counts[part]++;
		this.#entries.push({ part, message, pinned });
		if (this.#entries.length <= this.#cap) return;
		// Other bots may speak, but a burst of their messages must not eject the last
		// human context. The trigger itself is pinned even when another bot sent it.
		const bot = this.#entries.findIndex((entry) => !entry.pinned && entry.message.author.bot);
		const oldest = this.#entries.findIndex((entry) => !entry.pinned);
		this.#entries.splice(bot >= 0 ? bot : Math.max(0, oldest), 1);
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
		return `${message.author.name} (${message.author.bot ? "bot, " : ""}<@${message.author.id}>): ${[text, ...links].filter(Boolean).join("\n")}`;
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
