// GC-based measurements for cost guards and leak tests: bytes a function allocates, and collecting garbage on demand.
import { GCProfiler, getHeapStatistics, setFlagsFromString } from "node:v8";
import { runInNewContext } from "node:vm";

setFlagsFromString("--expose-gc");
const gc = runInNewContext("gc") as () => void;

/** Run a full garbage collection a few times, yielding in between so finalizers and weak references settle. */
export async function collectGarbage(): Promise<void> {
	for (let round = 0; round < 4; round++) {
		await new Promise((resolve) => setImmediate(resolve));
		gc();
	}
}

/**
 * Give V8 several distinct event-loop turns to retire WeakRef targets.
 * Every deref is released before the next turn, so the check itself cannot
 * accidentally keep a target alive across the next GC.
 * This still fails if references remain reachable after all bounded rounds.
 */
export async function waitForCollected(references: readonly WeakRef<object>[], maxRounds = 20): Promise<boolean> {
	for (let round = 0; round < maxRounds; round++) {
		await new Promise<void>((resolve) => setImmediate(resolve));
		gc();
		if (references.every((reference) => reference.deref() === undefined)) return true;
	}
	return false;
}

/**
 * Bytes `run` allocates on the JavaScript heap, including garbage collected while it ran: the heap growth plus what
 * every collection during the run freed.
 */
export async function allocatedBytes(run: () => unknown): Promise<number> {
	gc();
	const profiler = new GCProfiler();
	profiler.start();
	const before = getHeapStatistics().used_heap_size;
	await run();
	const after = getHeapStatistics().used_heap_size;
	const { statistics } = profiler.stop();
	let freed = 0;
	for (const collection of statistics) {
		freed += collection.beforeGC.heapStatistics.usedHeapSize - collection.afterGC.heapStatistics.usedHeapSize;
	}
	return after - before + freed;
}

/** Whether `reference` is collected once nothing else holds its target. */
export async function isCollected(reference: WeakRef<object>): Promise<boolean> {
	await collectGarbage();
	return reference.deref() === undefined;
}
