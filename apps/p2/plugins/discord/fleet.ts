// The owner's Discord bots (server, a native of `DiscordStore`): their tokens in `<data>/discord.json` (0600), one
// connected `Bot` each, their views, and what they all receive in one queue (oldest first) for the store's routine.
import { randomBytes } from "node:crypto";
import { chmod, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { optionalText } from "@p2/app/v1/node";
import { Bot, type BotEvent } from "./bot.ts";
import type { BotView } from "./contract.ts";
import { commandOf } from "./relay.ts";

/** discord.json: each bot's token by p2's ID for it. */
type BotsFile = { bots: Record<string, { token: string; addedAt: number; applicationId?: string }> };

/** The ID the one bot of the first release (`{ "token": … }`) gets; its links name it too (server.ts migrates them). */
export const FIRST_BOT = "bot1";

/** What a bot of the fleet received (a message, or its (re)connection), and which bot. */
export type Received = { bot: string; event: BotEvent };

const MAX_QUEUED = 2_048;
const MAX_URGENT = 256;
type BotFactory = (onEvent: (event: BotEvent) => void) => Bot;

export class Fleet {
	readonly #path: string;
	#file: BotsFile;
	readonly #bots = new Map<string, Bot>();
	readonly #listeners = new Set<() => void>();
	readonly #queue: Received[] = [];
	readonly #urgent: Received[] = [];
	readonly #missed = new Set<string>();
	readonly #waiters = new Set<() => void>();
	readonly #makeBot: BotFactory;
	#mutation: Promise<void> = Promise.resolve();
	#saveTail: Promise<void> = Promise.resolve();

	private constructor(path: string, file: BotsFile, makeBot: BotFactory) {
		this.#path = path;
		this.#file = file;
		this.#makeBot = makeBot;
	}

	/** Serialize administrative changes through network calls and disk commits. */
	#mutate<T>(action: () => Promise<T>): Promise<T> {
		const result = this.#mutation.then(action, action);
		this.#mutation = result.then(() => {}, () => {});
		return result;
	}

	/** The fleet of `dataDir`'s discord.json, each bot connecting in the background. */
	static async open(dataDir: string, makeBot: BotFactory = (onEvent) => new Bot(onEvent)): Promise<Fleet> {
		const path = join(dataDir, "discord.json");
		const { file, migrated } = parseBots(await optionalText(path));
		const fleet = new Fleet(path, file, makeBot);
		if (migrated) await fleet.#save();
		for (const [id, { token }] of Object.entries(file.bots)) void fleet.#start(id).connect(token);
		return fleet;
	}

	subscribe(listener: () => void): () => void {
		this.#listeners.add(listener);
		return () => this.#listeners.delete(listener);
	}

	#changed(): void {
		for (const listener of [...this.#listeners]) listener();
	}

	/** Every bot with its status, oldest first. */
	views(): BotView[] {
		return Object.entries(this.#file.bots)
			.sort(([, a], [, b]) => a.addedAt - b.addedAt)
			.map(([id]) => ({ id, status: this.#bots.get(id)?.status ?? { state: "connecting" as const } }));
	}

	/** Bot `id` while it is connected. */
	connected(id: string): Bot | undefined {
		const bot = this.#bots.get(id);
		return bot?.client?.isReady() ? bot : undefined;
	}

	/** Connects a new bot with `token` and keeps it once Discord accepted it: its ID. */
	async add(token: string): Promise<string> {
		return this.#mutate(async () => {
			const id = `b${randomBytes(4).toString("hex")}`;
			const bot = this.#candidate(id);
			const status = await bot.connect(token);
			if (status.state !== "connected") {
				await bot.close();
				throw new Error(status.state === "error" ? status.error : "Discord did not answer");
			}
			const same = this.views().find(
				(view) => view.status.state === "connected" && view.status.applicationId === status.applicationId,
			);
			if (same) {
				await bot.close();
				throw new Error(`${status.user} is added already`);
			}
			this.#adopt(id, bot);
			this.#file.bots[id] = { token, addedAt: Date.now(), applicationId: status.applicationId };
			await this.#save();
			this.#changed();
			return id;
		});
	}

	/** A replacement must always belong to the persisted application, including when the old bot is offline. */
	async setToken(id: string, token: string): Promise<void> {
		return this.#mutate(async () => {
			const current = this.#bots.get(id);
			const old = this.#file.bots[id];
			if (!current || !old) throw new Error("No such bot");
			const identity = old.applicationId ??
				(current.status.state === "connected" ? current.status.applicationId : undefined);
			if (!identity)
				throw new Error("Original bot identity is not verified while offline; reconnect it before replacing the token");
			const bot = this.#candidate(id);
			const status = await bot.connect(token);
			if (status.state !== "connected") {
				await bot.close();
				throw new Error(status.state === "error" ? status.error : "Discord did not answer");
			}
			if (status.applicationId !== identity) {
				await bot.close();
				throw new Error(`This token is for ${status.user}, another bot: add it as a new bot`);
			}
			await current.close();
			this.#adopt(id, bot);
			this.#file.bots[id] = { token, addedAt: old.addedAt, applicationId: identity };
			await this.#save();
			this.#changed();
		});
	}

	/** Disconnects and forgets bot `id`. */
	async remove(id: string): Promise<void> {
		return this.#mutate(async () => {
			await this.#bots.get(id)?.close();
			this.#bots.delete(id);
			delete this.#file.bots[id];
			await this.#save();
			this.#changed();
		});
	}

	/** The next received event, or undefined when `signal` aborts. */
	async next(signal: AbortSignal): Promise<Received | undefined> {
		while (!signal.aborted) {
			// Stop/status/compact bypass slow history delivery, including when the normal queue is saturated.
			const received = this.#urgent.shift() ?? this.#queue.shift();
			if (received) return received;
			const bot = this.#missed.values().next().value;
			if (bot !== undefined) {
				this.#missed.delete(bot);
				return { bot, event: { kind: "ready" } };
			}
			await new Promise<void>((resolve) => {
				const wake = () => {
					this.#waiters.delete(wake);
					signal.removeEventListener("abort", wake);
					resolve();
				};
				this.#waiters.add(wake);
				signal.addEventListener("abort", wake, { once: true });
			});
		}
		return undefined;
	}

	async close(): Promise<void> {
		await this.#mutation;
		await this.#saveTail;
		await Promise.all([...this.#bots.values()].map((bot) => bot.close()));
		this.#bots.clear();
	}

	/** A bot `id` that is not one of the fleet's yet (a token being tried); it delivers messages once adopted. */
	#candidate(id: string): Bot {
		const bot: Bot = this.#makeBot((event) => {
			if (this.#bots.get(id) === bot) this.#push({ bot: id, event });
		});
		return bot;
	}

	/** Makes `bot` the fleet's bot `id`; one connected already (a new token) catches up at once. */
	#adopt(id: string, bot: Bot): void {
		this.#bots.set(id, bot);
		bot.subscribe(() => {
			const saved = this.#file.bots[id];
			if (saved && bot.status.state === "connected") {
				if (saved.applicationId && saved.applicationId !== bot.status.applicationId) {
					console.error("p2 discord: saved bot identity mismatch; disconnecting");
					void bot.close();
				} else if (!saved.applicationId) {
					// Upgrade the first release's token-only configuration after a verified connection.
					saved.applicationId = bot.status.applicationId;
					void this.#save().catch((error: unknown) =>
						console.error("p2 discord: could not persist original bot identity:", error));
				}
			}
			this.#changed();
		});
		if (bot.client?.isReady()) this.#push({ bot: id, event: { kind: "ready" } });
	}

	/** A dropped non-command message is recovered by a history catch-up, not silently forgotten. */
	requestCatchUp(bot: string): void {
		this.#missed.add(bot);
		for (const wake of [...this.#waiters]) wake();
	}

	#push(received: Received): void {
		const event = received.event;
		const botId = this.#bots.get(received.bot)?.client?.user?.id;
		const urgent = event.kind === "message" && event.message.mentionsBot &&
			botId !== undefined && commandOf(event.message.text, botId) !== undefined;
		if (urgent) {
			if (this.#urgent.length === MAX_URGENT) {
				console.error("p2 discord: control queue saturated; dropping oldest command");
				this.#urgent.shift();
			}
			this.#urgent.push(received);
		} else if (this.#queue.length >= MAX_QUEUED) {
			this.requestCatchUp(received.bot);
			return;
		} else if (event.kind === "ready" && this.#queue.some((queued) =>
			queued.bot === received.bot && queued.event.kind === "ready"
		)) {
			return;
		} else {
			this.#queue.push(received);
		}
		for (const wake of [...this.#waiters]) wake();
	}

	#start(id: string): Bot {
		const bot = this.#candidate(id);
		this.#adopt(id, bot);
		return bot;
	}

	async #save(): Promise<void> {
		const snapshot = `${JSON.stringify(this.#file, null, "\\t")}\\n`;
		const persist = async () => {
			// Each attempt has its own temp file; the queue also prevents stale snapshots from winning.
			const temporary = `${this.#path}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
			try {
				await writeFile(temporary, snapshot, { mode: 0o600 });
				await chmod(temporary, 0o600);
				await rename(temporary, this.#path);
			} finally {
				await rm(temporary, { force: true });
			}
		};
		const saved = this.#saveTail.then(persist, persist);
		this.#saveTail = saved.then(() => {}, () => {});
		await saved;
	}
}

/**
 * discord.json (a trust boundary: the owner may edit it): the bots, and whether it was the first release's
 * `{ "token": … }` (that bot becomes `FIRST_BOT`). Unreadable: no bots, said in the log.
 */
function parseBots(text: string | undefined): { file: BotsFile; migrated: boolean } {
	if (!text?.trim()) return { file: { bots: {} }, migrated: false };
	let value: unknown;
	try {
		value = JSON.parse(text);
	} catch {
		console.error("p2 discord: discord.json is not valid JSON; no bots run");
		return { file: { bots: {} }, migrated: false };
	}
	if (!value || typeof value !== "object") return { file: { bots: {} }, migrated: false };
	if ("token" in value && typeof value.token === "string" && value.token)
		return { file: { bots: { [FIRST_BOT]: { token: value.token, addedAt: 0 } } }, migrated: true };
	const bots: BotsFile["bots"] = {};
	const listed = "bots" in value && value.bots && typeof value.bots === "object" ? value.bots : {};
	for (const [id, entry] of Object.entries(listed))
		if (entry && typeof entry === "object" && typeof entry.token === "string" && entry.token)
			bots[id] = {
				token: entry.token,
				addedAt: typeof entry.addedAt === "number" ? entry.addedAt : 0,
				...(typeof entry.applicationId === "string" && entry.applicationId
					? { applicationId: entry.applicationId } : {}),
			};
	return { file: { bots }, migrated: false };
}
