import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import type { Bot, BotEvent } from "../../plugins/discord/bot.ts";
import type { BotStatus } from "../../plugins/discord/contract.ts";
import { Fleet } from "../../plugins/discord/fleet.ts";

class FakeBot {
	status: BotStatus = { state: "connecting" };
	client: { isReady: () => boolean; user: { id: string } } | undefined;
	readonly #onEvent: (event: BotEvent) => void;
	readonly replies: { channelId: string; messageId: string | undefined; text: string }[] = [];
	async reply(channelId: string, messageId: string | undefined, text: string): Promise<void> {
		this.replies.push({ channelId, messageId, text });
	}
	readonly #listeners = new Set<() => void>();

	constructor(onEvent: (event: BotEvent) => void) {
		this.#onEvent = onEvent;
	}
	subscribe(listener: () => void): () => void {
		this.#listeners.add(listener);
		return () => this.#listeners.delete(listener);
	}
	async connect(token: string): Promise<BotStatus> {
		await new Promise((resolve) => setTimeout(resolve, 3));
		if (token.includes("offline")) {
			this.status = { state: "error", error: "offline" };
			return this.status;
		}
		const app = token.split(":")[0]!;
		this.client = { isReady: () => true, user: { id: "999" } };
		this.status = { state: "connected", applicationId: app, user: app, inviteUrl: "", guilds: [] };
		for (const listener of this.#listeners) listener();
		if (token.includes("early-command"))
			this.emit({
				kind: "message",
				message: {
					id: "777",
					channelId: "channel",
					author: { id: "owner", name: "owner", bot: false },
					roles: [],
					text: "<@999> stop",
					mentionsBot: true,
					attachments: [],
				},
			});
		return this.status;
	}
	async close(): Promise<void> {
		this.client = undefined;
	}
	emit(event: BotEvent): void {
		this.#onEvent(event);
	}
}

describe("Discord fleet persistence and identity isolation", () => {
	it("serializes concurrent additions and rejects a different application even after a disconnect", async () => {
		const dir = await mkdtemp(join(tmpdir(), "pi-discord-fleet-"));
		const created: FakeBot[] = [];
		const makeBot = (onEvent: (event: BotEvent) => void): Bot => {
			const bot = new FakeBot(onEvent);
			created.push(bot);
			return bot as unknown as Bot;
		};
		try {
			const fleet = await Fleet.open(dir, makeBot);
			const [first, second] = await Promise.all([fleet.add("app-one:key"), fleet.add("app-two:key")]);
			assert.notEqual(first, second);
			const path = join(dir, "discord.json");
			const persisted = JSON.parse(await readFile(path, "utf8"));
			assert.equal(persisted.bots[first].applicationId, "app-one");
			assert.equal(persisted.bots[second].applicationId, "app-two");
			created[0]!.status = { state: "error", error: "offline" };
			created[0]!.client = undefined;
			await assert.rejects(fleet.add("app-one:duplicate"), /added already/i);
			await assert.rejects(fleet.setToken(first, "another-application:key"), /another bot/i);
			await fleet.setToken(first, "app-one:refreshed");
			const updated = JSON.parse(await readFile(path, "utf8"));
			assert.equal(updated.bots[first].token, "app-one:refreshed");
			assert.equal(updated.bots[second].token, "app-two:key");
			await fleet.close();
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	it("keeps failed add, replace and removal operations consistent with persisted state", async () => {
		const dir = await mkdtemp(join(tmpdir(), "pi-discord-disk-failure-"));
		try {
			const fleet = await Fleet.open(dir, (onEvent) => new FakeBot(onEvent) as unknown as Bot);
			const id = await fleet.add("app-one:original");
			const persistedPath = join(dir, "discord.json");
			const backupPath = join(dir, "discord.backup.json");
			await rename(persistedPath, backupPath);
			await mkdir(persistedPath);
			await assert.rejects(fleet.add("app-two:key"));
			assert.deepEqual(
				fleet.views().map((view) => view.id),
				[id],
				"failed add is not adopted",
			);
			await assert.rejects(fleet.setToken(id, "app-one:replacement"));
			assert.equal(fleet.connected(id)?.status.state, "connected", "old bot remains connected");
			await assert.rejects(fleet.remove(id));
			assert.deepEqual(
				fleet.views().map((view) => view.id),
				[id],
				"failed removal keeps the bot",
			);
			await rm(persistedPath, { recursive: true });
			await rename(backupPath, persistedPath);
			assert.equal(JSON.parse(await readFile(persistedPath, "utf8")).bots[id].token, "app-one:original");
			await fleet.close();
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	it("fails closed on an offline legacy token whose original application was never established", async () => {
		const dir = await mkdtemp(join(tmpdir(), "pi-discord-legacy-"));
		try {
			await writeFile(
				join(dir, "discord.json"),
				JSON.stringify({
					bots: { legacy: { token: "app:offline", addedAt: 1 } },
				}),
			);
			const fleet = await Fleet.open(dir, (onEvent) => new FakeBot(onEvent) as unknown as Bot);
			await assert.rejects(fleet.setToken("legacy", "different:key"), /identity|connect|original/i);
			await fleet.close();
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	it("acknowledges discarded commands when the urgent ingress buffer is saturated", async () => {
		const dir = await mkdtemp(join(tmpdir(), "pi-discord-overflow-"));
		const created: FakeBot[] = [];
		try {
			const fleet = await Fleet.open(dir, (onEvent) => {
				const bot = new FakeBot(onEvent);
				created.push(bot);
				return bot as unknown as Bot;
			});
			await fleet.add("app-one:key");
			fleet.setControlRejectionHandler(async (id, message) => {
				await fleet
					.connected(id)
					?.reply(
						message.channelId,
						message.id,
						"Pi control backlog is full; your command was not executed. Please retry.",
					);
			});
			const bot = created[0]!;
			for (let i = 0; i <= 128; i++)
				bot.emit({
					kind: "message",
					message: {
						id: String(i + 1),
						channelId: "channel",
						author: { id: "user", name: "user", bot: false },
						roles: [],
						text: "<@999> stop",
						mentionsBot: true,
						attachments: [],
					},
				});
			await new Promise<void>((resolve) => setImmediate(resolve));
			assert.equal(bot.replies.length, 1);
			assert.equal(bot.replies[0]!.channelId, "channel");
			assert.equal(bot.replies[0]!.messageId, "1");
			assert.match(bot.replies[0]!.text, /not executed|retry/i);
			await fleet.close();
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	it("preserves candidate stop during blocked disk save, even with offline prior bot and duplicate gateway traffic", async () => {
		const dir = await mkdtemp(join(tmpdir(), "pi-discord-candidate-"));
		const created: FakeBot[] = [];
		let blockSave = false;
		let release!: () => void;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		let signalSaving!: () => void;
		const saving = new Promise<void>((resolve) => {
			signalSaving = resolve;
		});
		try {
			const fleet = await Fleet.open(
				dir,
				(onEvent) => {
					const bot = new FakeBot(onEvent);
					created.push(bot);
					return bot as unknown as Bot;
				},
				async () => {
					if (blockSave) {
						signalSaving();
						await gate;
					}
				},
			);
			const id = await fleet.add("app-one:original");
			await fleet.next(new AbortController().signal);
			blockSave = true;
			const changing = fleet.setToken(id, "app-one:replacement");
			await saving;
			created[0]!.client = undefined; // simulate old gateway offline
			const control: BotEvent = {
				kind: "message",
				message: {
					id: "777",
					channelId: "channel",
					author: { id: "owner", name: "owner", bot: false },
					roles: [],
					text: "<@999> stop",
					mentionsBot: true,
					attachments: [],
				},
			};
			created[1]!.emit(control);
			for (let i = 0; i < 160; i++)
				created[1]!.emit({
					kind: "message",
					message: {
						...control.message,
						id: String(10_000 + i),
						text: "<@999> status",
					},
				});
			release();
			await changing;
			const first = await fleet.next(AbortSignal.timeout(1_000));
			assert(first?.event.kind === "message");
			assert.equal(first.event.message.id, "777", "stop survived an overfull candidate handoff");
			created[1]!.emit(control);
			let duplicates = 0;
			for (;;) {
				// AbortSignal.timeout uses an unref'ed timer: without another handle
				// Node can cancel this test with a pending promise before it fires.
				const controller = new AbortController();
				const timeout = setTimeout(() => controller.abort(), 25);
				let event: Awaited<ReturnType<typeof fleet.next>>;
				try {
					event = await fleet.next(controller.signal);
				} finally {
					clearTimeout(timeout);
				}
				if (!event) break;
				if (event.event.kind === "message" && event.event.message.id === "777") duplicates++;
			}
			assert.equal(duplicates, 0, "a post-adoption duplicate must not be queued");
			await fleet.close();
		} finally {
			release?.();
			await rm(dir, { recursive: true, force: true });
		}
	});

	it("reserves stop ingress priority under a saturated status-command buffer", async () => {
		const dir = await mkdtemp(join(tmpdir(), "pi-discord-emergency-"));
		const created: FakeBot[] = [];
		try {
			const fleet = await Fleet.open(dir, (onEvent) => {
				const bot = new FakeBot(onEvent);
				created.push(bot);
				return bot as unknown as Bot;
			});
			await fleet.add("app-one:key");
			await fleet.next(new AbortController().signal);
			const bot = created[0]!;
			for (let i = 0; i < 256; i++)
				bot.emit({
					kind: "message",
					message: {
						id: String(i + 1),
						channelId: "channel",
						author: { id: "owner", name: "owner", bot: false },
						roles: [],
						text: "<@999> status",
						mentionsBot: true,
						attachments: [],
					},
				});
			bot.emit({
				kind: "message",
				message: {
					id: "99999",
					channelId: "channel",
					author: { id: "owner", name: "owner", bot: false },
					roles: [],
					text: "<@999> stop",
					mentionsBot: true,
					attachments: [],
				},
			});
			const received = await fleet.next(new AbortController().signal);
			assert(received?.event.kind === "message");
			assert.equal(received.event.message.text, "<@999> stop");
			await fleet.close();
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	it("delivers stop control messages ahead of queued ordinary mentions", async () => {
		const dir = await mkdtemp(join(tmpdir(), "pi-discord-priority-"));
		const created: FakeBot[] = [];
		try {
			const fleet = await Fleet.open(dir, (onEvent) => {
				const bot = new FakeBot(onEvent);
				created.push(bot);
				return bot as unknown as Bot;
			});
			const id = await fleet.add("app-one:key");
			// Ignore the normal connection notification before asserting message priority.
			await fleet.next(new AbortController().signal);
			const bot = created[0]!;
			const normal = (text: string): BotEvent => ({
				kind: "message",
				message: {
					id: text,
					channelId: "c1",
					author: { id: "u", name: "u", bot: false },
					roles: [],
					text,
					mentionsBot: true,
					attachments: [],
				},
			});
			bot.emit(normal("<@999> long task"));
			bot.emit(normal("<@999> stop"));
			const first = await fleet.next(new AbortController().signal);
			assert(first?.event.kind === "message");
			assert.equal(first.event.message.text, "<@999> stop");
			const second = await fleet.next(new AbortController().signal);
			assert(second?.event.kind === "message");
			assert.equal(second.event.message.text, "<@999> long task");
			assert.equal(first.bot, id);
			await fleet.close();
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});
});
