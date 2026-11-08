import { strict as assert } from "node:assert";
import { test } from "vitest";
import { configuredParallelToolLimit, executeBoundedInOrder } from "../src/ordered-tool-pool.ts";

test("returns results in source order with no more than the configured active jobs", async () => {
	let active = 0;
	let peak = 0;
	const jobs = Array.from({ length: 9 }, (_, n) => async () => {
		active++;
		peak = Math.max(peak, active);
		await new Promise<void>((resolve) => setTimeout(resolve, (9 - n) * 2));
		active--;
		return n;
	});
	assert.deepEqual(await executeBoundedInOrder(jobs, 3), [0, 1, 2, 3, 4, 5, 6, 7, 8]);
	assert.equal(peak, 3);
});

test("preserves the position of immediate results relative to delayed tasks", async () => {
	assert.deepEqual(await executeBoundedInOrder([1, async () => 2, 3, async () => 4], 2), [1, 2, 3, 4]);
});

test("uses eight workers by default and rejects invalid/out-of-bound choices", async () => {
	assert.equal(configuredParallelToolLimit(), 8);
	assert.equal(configuredParallelToolLimit(1), 1);
	assert.equal(configuredParallelToolLimit(16), 16);
	for (const input of [0, -1, 1.5, 33, Number.NaN]) {
		assert.throws(() => configuredParallelToolLimit(input), RangeError);
	}
	await assert.rejects(() => executeBoundedInOrder([async () => 1], 0), RangeError);
});

test("on rejection, does not launch additional queued work", async () => {
	let started = 0;
	const jobs = [
		async () => { started++; throw new Error("failure"); },
		async () => { started++; return 2; },
	];
	await assert.rejects(() => executeBoundedInOrder(jobs, 1), /failure/);
	assert.equal(started, 1);
});

test("does not settle a rejected batch before other in-flight calls finish", async () => {
	let release!: () => void;
	let otherSettled = false;
	let queuedStarted = false;
	const barrier = new Promise<void>((resolve) => { release = resolve; });
	const promise = executeBoundedInOrder([
		async () => { await new Promise<void>((resolve) => setImmediate(resolve)); throw new Error("bad tool"); },
		async () => { await barrier; otherSettled = true; return 2; },
		async () => { queuedStarted = true; return 3; },
	], 2);
	let settled = false;
	const observed = promise.then(() => ({ ok: true as const, error: undefined }),
		(error: unknown) => ({ ok: false as const, error }));
	void observed.then(() => { settled = true; });
	await new Promise<void>((resolve) => setTimeout(resolve, 25));
	assert.equal(settled, false, "batch should wait for other running calls");
	release();
	const result = await observed;
	assert.equal(result.ok, false);
	assert.match(String(result.error), /bad tool/);
	assert.equal(otherSettled, true);
	assert.equal(queuedStarted, false);
});

test("reports the first observed failure, not the first worker in Promise.allSettled order", async () => {
	const lateFailure = new Error("worker zero failed later");
	const earlyFailure = new Error("worker one failed first");
	let extraStarted = false;
	await assert.rejects(
		() => executeBoundedInOrder([
			async () => {
				await new Promise<void>((resolve) => setTimeout(resolve, 25));
				throw lateFailure;
			},
			async () => { throw earlyFailure; },
			async () => { extraStarted = true; return 3; },
		], 2),
		(error: unknown) => error === earlyFailure,
	);
	assert.equal(extraStarted, false);
});
