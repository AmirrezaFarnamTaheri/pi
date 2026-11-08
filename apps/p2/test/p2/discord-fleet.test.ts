import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { type BotEvent, Bot } from "../../plugins/discord/bot.ts";
import type { BotStatus } from "../../plugins/discord/contract.ts";
import { Fleet } from "../../plugins/discord/fleet.ts";

class FakeBot {
	status: BotStatus = { state: "connecting" };
	client: { isReady: () => boolean; user: { id: string } } | undefined;
	readonly #onEvent: (event: BotEvent) => void;
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
		return this.status;
	}
	async close(): Promise<void> { this.client = undefined; }
	emit(event: BotEvent): void { this.#onEvent(event); }
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

	it("fails closed on an offline legacy token whose original application was never established", async () => {
		const dir = await mkdtemp(join(tmpdir(), "pi-discord-legacy-"));
		try {
			await writeFile(join(dir, "discord.json"), JSON.stringify({
				bots: { legacy: { token: "app:offline", addedAt: 1 } },
			}));
			const fleet = await Fleet.open(dir, (onEvent) => new FakeBot(onEvent) as unknown as Bot);
			await assert.rejects(fleet.setToken("legacy", "different:key"), /identity|connect|original/i);
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
				message: { id: text, channelId: "c1", author: { id: "u", name: "u", bot: false },
					roles: [], text, mentionsBot: true, attachments: [] },
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
