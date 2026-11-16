/**
 * Measure event retention against the compiled production EventStream.
 *
 * Build the project first, then run each retention mode in a separate process:
 *   node --expose-gc scripts/bench-event-stream.mjs --retention all
 *   node --expose-gc scripts/bench-event-stream.mjs --retention result-only
 */
import { performance } from "node:perf_hooks";
import { EventStream } from "../packages/ai/dist/utils/event-stream.js";

if (typeof global.gc !== "function") {
	throw new Error("Run with node --expose-gc for comparable retained-heap measurements.");
}

const args = process.argv.slice(2);
const allowed = new Set(["--events", "--retention"]);
const options = { events: 100_000, retention: "all" };
for (let i = 0; i < args.length; i += 2) {
	const flag = args[i];
	const value = args[i + 1];
	if (!allowed.has(flag) || value === undefined) throw new Error("Usage: --events N --retention all|result-only");
	if (flag === "--events") {
		const n = Number(value);
		if (!Number.isSafeInteger(n) || n < 1 || n > 1_000_000) throw new RangeError("events must be 1–1000000");
		options.events = n;
	} else {
		if (value !== "all" && value !== "result-only") throw new RangeError("Invalid event retention");
		options.retention = value;
	}
}

global.gc();
const before = process.memoryUsage();
const started = performance.now();
const stream = new EventStream(
	(event) => event.end === true,
	(event) => event.count,
	{ retention: options.retention },
);
for (let i = 0; i < options.events; i++) {
	stream.push({ index: i, content: `event-${i}-` + "a".repeat(256) });
}
stream.push({ end: true, count: options.events });
const completed = await stream.result();
const elapsedMs = performance.now() - started;
// Keep stream reachable through GC to inspect the queued, retained events.
global.gc();
const after = process.memoryUsage();
if (completed !== options.events) throw new Error("Final result was lost");
console.log(JSON.stringify({
	schemaVersion: 1,
	events: options.events,
	retention: options.retention,
	elapsedMs,
	retainedHeapBytes: after.heapUsed - before.heapUsed,
	rssDeltaBytes: after.rss - before.rss,
	node: process.version,
	platform: process.platform,
	arch: process.arch,
}));
void stream;
