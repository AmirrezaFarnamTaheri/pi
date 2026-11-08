import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DiscordScheduler } from "../../plugins/discord/scheduler.ts";

const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

describe("discord event scheduler", () => {
	it("runs unrelated channels and a stop command while another channel is blocked", async () => {
		const order: string[] = [];
		let releaseSlow!: () => void;
		const slow = new Promise<void>((resolve) => {
			releaseSlow = resolve;
		});
		const errors: unknown[] = [];
		const scheduler = new DiscordScheduler(() => {}, (error) => errors.push(error), 2);
		scheduler.enqueue({
			bot: "b",
			key: "b:c1",
			priority: false,
			run: async () => {
				order.push("slow-start");
				await slow;
				order.push("slow-end");
			},
		});
		scheduler.enqueue({
			bot: "b",
			key: "b:c1",
			priority: false,
			run: async () => {
				order.push("same-channel-after");
			},
		});
		scheduler.enqueue({
			bot: "b",
			key: "b:c2",
			priority: false,
			run: async () => {
				order.push("other-channel");
			},
		});
		scheduler.enqueue({
			bot: "b",
			key: "b:c1",
			priority: true,
			run: async () => {
				order.push("stop");
			},
		});
		await tick();
		assert(order.includes("slow-start"));
		assert(order.includes("other-channel"), "another channel is not blocked");
		assert(order.includes("stop"), "stop bypasses its channel's slow delivery");
		assert(!order.includes("same-channel-after"), "non-command delivery preserves its lane");
		releaseSlow();
		await scheduler.idle();
		assert.deepEqual(errors, []);
		assert.equal(order.at(-1), "same-channel-after");
	});

	it("bounds pending deliveries and requests a catch-up instead of storing unbounded events", async () => {
		const missed: string[] = [];
		let release!: () => void;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const scheduler = new DiscordScheduler((bot) => missed.push(bot), () => {}, 1, 1);
		scheduler.enqueue({ bot: "b", key: "one", priority: false, run: () => gate });
		scheduler.enqueue({ bot: "b", key: "two", priority: false, run: async () => {} });
		assert.equal(scheduler.enqueue({ bot: "b", key: "three", priority: false, run: async () => {} }), false);
		assert.deepEqual(missed, ["b"]);
		release();
		await scheduler.idle();
	});
});
