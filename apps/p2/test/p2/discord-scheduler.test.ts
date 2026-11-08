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


	it("notifies the sender instead of silently dropping a saturated control command", async () => {
		let release!: () => void;
		const gate = new Promise<void>((resolve) => { release = resolve; });
		const rejected: string[] = [];
		const scheduler = new DiscordScheduler(() => {}, () => {}, 1, 1, 1, 1);
		assert.equal(scheduler.enqueue({ bot: "b", key: "control-one", priority: true, run: () => gate }), true);
		assert.equal(scheduler.enqueue({ bot: "b", key: "control-two", priority: true, run: async () => {} }), true);
		assert.equal(scheduler.enqueue({
			bot: "b", key: "control-three", priority: true, run: async () => {},
			onRejected: async () => { rejected.push("control-three"); },
		}), false);
		await tick();
		assert.deepEqual(rejected, ["control-three"]);
		release();
		await scheduler.idle();
	});


	it("defers rejected catch-up triggers until capacity returns rather than spinning", async () => {
		let release!: () => void;
		const gate = new Promise<void>((resolve) => { release = resolve; });
		const missed: string[] = [];
		const scheduler = new DiscordScheduler((bot) => missed.push(bot), () => {}, 1, 1);
		scheduler.enqueue({ bot: "b", key: "same", priority: false, run: () => gate });
		scheduler.enqueue({ bot: "b", key: "same", priority: false, run: async () => {} });
		assert.equal(scheduler.enqueue({ bot: "b", key: "catchup", priority: false, catchUp: true, run: async () => {} }), false);
		assert.deepEqual(missed, [], "no immediate retry while queue remains saturated");
		release();
		await scheduler.idle();
		assert.deepEqual(missed, ["b"], "one deferred retry is requested when capacity returns");
	});

	it("bounds asynchronous rejection notices even under sustained command overload", async () => {
		let unblock!: () => void;
		const gate = new Promise<void>((resolve) => { unblock = resolve; });
		let notices = 0;
		let freeNotices!: () => void;
		const noticeGate = new Promise<void>((resolve) => { freeNotices = resolve; });
		const scheduler = new DiscordScheduler(() => {}, () => {}, 1, 1, 1, 1);
		scheduler.enqueue({ bot: "b", key: "busy", priority: true, run: () => gate });
		scheduler.enqueue({ bot: "b", key: "busy", priority: true, run: async () => {} });
		for (let i = 0; i < 100; i++) scheduler.enqueue({
			bot: "b", key: "different", priority: true, run: async () => {},
			onRejected: async () => { notices++; await noticeGate; },
		});
		await tick();
		assert(notices <= 8, "rejection notices must use a bounded async pool");
		freeNotices();
		unblock();
		await scheduler.idle();
	});


	it("runs stop in a reserved lane even when other priority commands are saturated", async () => {
		let release!: () => void;
		const blocked = new Promise<void>((resolve) => { release = resolve; });
		const seen: string[] = [];
		const scheduler = new DiscordScheduler(() => {}, () => {}, 1, 1, 1, 1);
		scheduler.enqueue({ bot: "b", key: "c1", priority: true, run: () => blocked });
		scheduler.enqueue({ bot: "b", key: "c1", priority: true, run: async () => { seen.push("status"); } });
		assert.equal(scheduler.enqueue({
			bot: "b", key: "c1", priority: true, stop: true,
			run: async () => { seen.push("stop"); },
		}), true);
		await tick();
		assert.deepEqual(seen, ["stop"], "stop is not held by the saturated regular control lane");
		release();
		await scheduler.idle();
		assert.deepEqual(seen, ["stop", "status"]);
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

it("idle waits for an outstanding asynchronous rejected-command notice", async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const scheduler = new DiscordScheduler(() => {}, () => {}, 1, 1, 1, 1);
  scheduler.enqueue({ bot: "b", key: "busy", priority: true, run: async () => {} });
  scheduler.enqueue({ bot: "b", key: "queued", priority: true, run: async () => {} });
  scheduler.enqueue({ bot: "b", key: "reject", priority: true, run: async () => {},
    onRejected: () => gate });
  await new Promise<void>((resolve) => setImmediate(resolve));
  let idle = false;
  void scheduler.idle().then(() => { idle = true; });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(idle, false);
  release();
  await scheduler.idle();
  assert.equal(idle, true);
});
