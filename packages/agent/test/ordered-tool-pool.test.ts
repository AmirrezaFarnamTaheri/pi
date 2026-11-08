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
