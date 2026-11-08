# Result-only event-stream retention (opt-in)

The normal `EventStream` and `AssistantMessageEventStream` behavior remains **lossless**: events that arrive before an async iterator starts are kept and can be replayed. This can use substantial memory if a caller only awaits `result()` and never iterates progress.

Use an explicit result-only stream **only** when your caller needs the final result and does not expect to replay earlier progress:

```ts
import { EventStream, createAssistantMessageEventStream } from "@earendil-works/pi-ai";

const stream = new EventStream<number, number>(
  event => event === 100,
  event => event,
  { retention: "result-only" },
);
for (let i = 0; i <= 100; i++) stream.push(i);
console.log(await stream.result()); // 100
// Async iteration started after these pushes does not replay prior events.

const assistantStream = createAssistantMessageEventStream({ retention: "result-only" });
```

- No progress events are queued while **no async iterator is active**. Terminal events still resolve `result()`; failures still reject it.
- **Active iterators remain lossless**, and producers should use `pushWithBackpressure` when they need bounded memory with a slow consumer.
- A late iterator cannot replay events skipped under result-only retention. This is an explicitly selected compatibility trade-off, not a silent change to default behavior.
- Switching an already-producing stream from all-events mode to result-only mode is not supported.
- This does **not** reduce provider token usage or API fees. It only avoids retaining unused progress events in host memory.

## Validation

The focused tests cover default replay, 10,001 unconsumed events, active iterators, failures, and the assistant final-message/timing API. The minimal isolated Node harness observed a failing test against the old implementation and four passing tests against the new one. Full repository Vitest, platform binary build and CI are still required before merging.

To measure peak memory, compare a fixed-event-count producer with equal event payloads and process flags (including GC settings), collecting peak heap/RSS and final-result equivalence. Vary 10k/100k/1M events and consider streaming consumers separately. Do not assert speedup without reproducible, comparable measurements.


## Memory measurement protocol

After compiling the fork, run the committed production-API benchmark in **separate processes** to compare retained heap and throughput:

```bash
node --expose-gc scripts/bench-event-stream.mjs --events 100000 --retention all
node --expose-gc scripts/bench-event-stream.mjs --events 100000 --retention result-only
```

In an isolated local Node 22.16 harness using the same queue algorithm and 100,000 events with 256-character payloads, three repeated processes measured retained-heap deltas of approximately **28.46 MiB** (all-events mode) versus **0.12 MiB** (result-only mode). These are **synthetic local measurements**, not measured gains in the deployed Pi application. The new benchmark script must be run against the built fork on identical hardware before claiming production impact.

A result-only stream is only useful if the producer itself creates one with the explicit option. Simply awaiting `result()` on an ordinary provider-created stream does not retroactively enable the optimization.
