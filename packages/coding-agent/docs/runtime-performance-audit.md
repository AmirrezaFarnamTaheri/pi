# Agent runtime performance and correctness audit

Audit date: 2026-11-07. Base: PR #2 merged main. This is a targeted runtime audit, not an assertion that every performance flaw has been identified.

## Reproduced problems and regression tests

| Area | Evidence | Remedy |
| --- | --- | --- |
| AI event stream capacity waiters | An aborted producer leaves a stale capacity waiter ahead of a live publisher. Consuming one queued item may wake only the aborted waiter, leaving the live publisher blocked with spare capacity. | Remove aborted waiters immediately; preserve FIFO waking and terminal cleanup. |
| Session projection | `SessionManager.buildSessionProjection()` copies every stored entry and walks the active branch twice. After branching/compacting a long session, irrelevant historical events still cause allocation and traversal. | Project directly from the indexed active branch and reuse one path traversal. |
| Context compaction | `contextEntries.push(...path.slice(...))` can exceed the JS argument limit at about 125,000+ retained entries (engine-dependent). | Append entries iteratively instead of spreading a huge argument list. |
| Session title on TUI frames | `getSessionName()` reverse-scanned all file entries even when no name existed. A local Node 22.16 synthetic microbenchmark found 250 scans of 100,000 entries took 47.77 ms. | Cache the latest title, invalidated by session array identity or append length. |
| Session tree navigation | `getChildren()` scans all stored entries for every parent lookup. A local Node 22.16 synthetic microbenchmark of 250 lookups across 100,000 entries took 200.33 ms. | Build a lazy parent-child index once (11.61 ms in that microbenchmark); indexed repeated lookups took 0.022 ms for 250 calls. |
| Cache miss notifications | `detectCacheMiss()` rescans every stored event at each `message_end`, and the caller copied all branches. | Scan backward to the most recent request/cache evidence and use the active branch only, while retaining full scans for explicit cache reports. |
| Corrupt cyclic parent links | A malformed or tampered session parent chain loops indefinitely during branch/context traversal. | Bound ancestry traversal by the number of indexed session entries and fail clearly. |
| Very wide session trees | `getTree()` uses a single spread call for all children, exceeding the function-argument limit beyond ~100,000 siblings. | Push children into the traversal stack individually; test a root with 140,000 direct children. |

Synthetic lookup benchmarks ran under Node.js v22.16.0 in the analysis container using arrays and Maps of 100,000 session-like entries and 250 lookups. They did not include I/O, React/TUI rendering, a production Pi session, or network calls. These are **not** end-to-end latency claims; actual gains depend on session size and workload.

## Additional candidates requiring production profiling

- The new `getChildren()` lazy index trades a small additional memory footprint and one index build for faster repeated navigation. Verify against large real branch graphs and loaded sessions.
- Long JSONL entries use repeated string-buffer concatenation in `loadEntriesFromFile()`. Memory and time growth for unusually large single entries should be measured before changing the parser.
- Cache warming, compaction, model/auth refresh, extensions, and tool-output persistence may introduce latency under high concurrency; collect CPU, allocation, event-loop, and I/O traces rather than assuming they dominate.
- `EventStream.push()` allows unbounded buffering for result-only consumers by design; changing that contract requires consumer-migration tests.

## Validation

Focused regressions are in `packages/ai/test/event-stream-backpressure.test.ts` and `packages/coding-agent/test/session-manager/build-context.test.ts`. Full repository build, type checks, and CI must pass before considering this PR ready. No external-service latency, live-account performance, or production flamegraphs were measured.
