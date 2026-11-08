# Experimental agent tool execution concurrency

The default remains eight parallel workers. Model-issued tools are still validated and checked by permission hooks **in source order**, then eligible tools execute concurrently; result messages are still emitted in source order. Tools declaring \`executionMode: "sequential"\` continue to act as hard barriers.

Application authors can opt into a smaller or larger worker pool when constructing an agent:

\`\`\`ts
const agent = new Agent({
  streamFn,
  maxParallelToolExecutions: 4,
});
\`\`\`

The limit is an integer between 1 and 32. Default is 8. Invalid values fail with \`RangeError\` if the parallel tool path is used. This setting changes neither sequential tool behavior nor the ordered permission preflight. The scheduler does not launch additional queued jobs after an unexpected rejected job; already-running tools may still settle. Abort and tool-result ordering must be checked by the full agent suite.

Use the opt-in monitor in PR #7 to measure p50/p95 completion time, peak active calls, memory and tool errors at limits 1, 2, 4, 8, 16 and 32. Prefer lower limits for expensive CPU- or memory-bound tools and higher limits only for measured independent I/O-bound workloads. Merely increasing the maximum does not imply better performance.

Potential follow-up: overlap ordered permission preparation and bounded execution without violating permission-hook ordering or write hazards. This is intentionally excluded until complete behavioral tests pass.
