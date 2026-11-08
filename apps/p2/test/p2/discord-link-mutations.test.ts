import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { LinkMutationQueue } from "../../plugins/discord/link-mutations.ts";

describe("serialized Discord owner link mutations", () => {
	it("rejects the second concurrent channel link for a session after the first network await", async () => {
		const queue = new LinkMutationQueue();
		const linked = new Map<string, string>();
		let release!: () => void;
		const slowDiscordRequest = new Promise<void>((resolve) => { release = resolve; });
		let waiting: () => void = () => {};
		const started = new Promise<void>((resolve) => { waiting = resolve; });
		const link = (session: string, channel: string) => queue.run(async () => {
			if ([...linked.values()].includes(session)) throw new Error("Session linked already");
			waiting();
			await slowDiscordRequest;
			linked.set(channel, session);
		});
		const first = link("s1", "c1");
		const second = link("s1", "c2");
		await started;
		assert.equal(linked.size, 0, "both requests initially see an empty state");
		release();
		await first;
		await assert.rejects(second, /linked already/i);
		assert.deepEqual([...linked.entries()], [["c1", "s1"]]);
	});

	it("continues processing later link updates after a prior operation fails", async () => {
		const queue = new LinkMutationQueue();
		const operations: string[] = [];
		await assert.rejects(queue.run(async () => { throw new Error("offline"); }), /offline/);
		await queue.run(async () => { operations.push("accepted"); });
		assert.deepEqual(operations, ["accepted"]);
	});
});
