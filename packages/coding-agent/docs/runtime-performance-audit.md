# Agent runtime performance and correctness audit

Audit date: 2026-11-07. Base: PR #2 merged main. This is a targeted runtime audit, not an assertion that every performance flaw has been identified.

## Reproduced problems and regression tests

| Area | Evidence | Remedy |
| --- | --- | --- |
| AI event stream capacity waiters | An aborted producer leaves a stale capacity waiter ahead of a live publisher. Consuming one queued item may wake only the aborted waiter, leaving the live publisher blocked with spare capacity. | Remove aborted waiters immediately; preserve FIFO waking and terminal cleanup. |
| Session projection | `SessionManager.buildSessionProjection()` copies every stored entry and walks the active branch twice. After branching/compacting a long session, irrelevant historical events still cause allocation and traversal. | Project directly from the indexed active branch and reuse one path traversal. |
| Context compaction | `contextEntries.push(...path.slice(...))` can exceed the JS argument limit at about 125,000+ retained entries (engine-dependent). | Append entries iteratively instead of spreading a huge argument list. |
| Session title on TUI frames | `getSessionName()` reverse-scanned all file entries even when no name existed. A local Node 22.16 synthetic microbenchmark found 250 scans of 100,000 entries took 47.77 ms. | Cache the latest title, invalidated by session array identity or append length. |
| Session tree navigation | `getChildren()` scans all stored entries for every parent lookup. A local Node 22.16 synthetic microbenchmark of 250 lookups across 100,000 entries took 200.33 ms. | Build a lazy parent-child index once (11.61 ms in that microbenchmark); 250 raw Map lookups took 0.022 ms (excluding the public API's defensive array copies). |
| Cache miss notifications | `detectCacheMiss()` rescans every stored event at each `message_end`, and the caller copied all branches. | Scan backward to the most recent request/cache evidence and use the active branch only, while retaining full scans for explicit cache reports. |
| Corrupt cyclic parent links | A malformed or tampered session parent chain loops indefinitely during branch/context traversal. | Bound ancestry traversal by the number of indexed session entries and fail clearly. |
| Very wide session trees | `getTree()` uses a single spread call for all children, exceeding the function-argument limit beyond ~100,000 siblings. | Push children into the traversal stack individually; test a root with 140,000 direct children. |

Synthetic lookup benchmarks ran under Node.js v22.16.0 in the analysis container using arrays and Maps of 100,000 session-like entries and 250 lookups. They did not include I/O, React/TUI rendering, a production Pi session, or network calls. These are **not** end-to-end latency claims; actual gains depend on session size and workload.

## Follow-up fixes after CodeRabbit review

The branch-local cache-miss reconstruction now excludes abandoned sibling responses from its re-billed token baseline. The idle-time explanation, however, also checks the latest *actual provider request* across stored branches: a recent abandoned-branch response may have refreshed a shared cache prefix. These concerns are computed separately for live notices and transcript rebuilds. Regression tests cover branch divergence, idle time after navigation and session reload, and incremental request-state caching.

Further runtime changes:

- `loadEntriesFromFile()` scans each newly decoded chunk exactly once and joins a multi-buffer JSONL line only when complete, preserving UTF-8 boundaries and unfinished-record repair. On isolated Node 22.16.0, 64 MiB newline-free synthetic text took approximately 952 ms with the previous accumulation/indexOf loop and 22 ms with chunk-local scanning; this is **not** a real-session performance measurement.
- The lazy `getChildren()` index stores one entry directly for single-child parents, allocating child arrays only for genuinely branching parents. The public API still returns defensive arrays.
- Repeated extension/native/virtual model registrations made synchronously in one turn schedule one asynchronous non-network model refresh. Model composition and provisional availability still update synchronously.
- Parallel tool execution is bounded to eight active tools in a batch instead of launching every approved tool at once. Permission/preparation hooks remain ordered; tool results are still emitted in original call order.
- `getTree()` now detects disconnected cyclic components instead of silently hiding entries. Wide-sibling sorting parses each child timestamp once rather than in every comparator call.

## Remaining safety and profiling trade-offs


- `SessionInfoCache.get()` still verifies file integrity using a full-file digest even when stat metadata matches. Dropping that check would weaken detection of same-size, same-timestamp rewrites. Profile real picker reopen frequency and I/O before revising its validity contract.
- Ordered permission/preparation hooks and an eight-tool peak execution budget prioritize deterministic approvals and resource safety over shortest possible start latency; profile representative 10/50/100-tool batches before making the limit configurable.
- Cache warming, compaction, model/auth refresh, extensions, and tool-output persistence may introduce latency under high concurrency; collect CPU, allocation, event-loop, and I/O traces rather than assuming they dominate.
- `EventStream.push()` allows unbounded buffering for result-only consumers by design; changing that contract requires consumer-migration tests.

## Validation

Focused regressions are in `packages/ai/test/event-stream-backpressure.test.ts`, `packages/agent/test/agent-loop.test.ts`, `packages/coding-agent/test/virtual-models.test.ts`, `packages/coding-agent/test/session-manager/file-operations.test.ts`, `packages/coding-agent/test/session-manager/build-context.test.ts`, `packages/coding-agent/test/session-manager/tree-traversal.test.ts`, and `packages/coding-agent/test/cache-stats.test.ts`. Full repository build, type checks, and CI must pass before considering this PR ready. No external-service latency, live-account performance, or production flamegraphs were measured.
