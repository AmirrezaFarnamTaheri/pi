# Agent runtime performance and correctness audit

Audit date: 2026-11-07. Base: PR #2 merged main. This is a targeted runtime audit, not an assertion that every performance flaw has been identified.

## Reproduced problems and regression tests

| Area | Evidence | Remedy |
| --- | --- | --- |
| AI event stream capacity waiters | An aborted producer leaves a stale capacity waiter ahead of a live publisher. Consuming one queued item may wake only the aborted waiter, leaving the live publisher blocked with spare capacity. | Remove aborted waiters immediately; preserve FIFO waking and terminal cleanup. |
| Session projection | `SessionManager.buildSessionProjection()` copies every stored entry and walks the active branch twice. After branching/compacting a long session, irrelevant historical events still cause allocation and traversal. | Project directly from the indexed active branch and reuse one path traversal. |
| Context compaction | `contextEntries.push(...path.slice(...))` can exceed the JS argument limit at about 125,000+ retained entries (engine-dependent). | Append entries iteratively instead of spreading a huge argument list. |
| Session title on TUI frames | `getSessionName()` reverse-scans all file entries even when no name exists; synthetic Node 22 measurements show 250 scans of 100,000 entries took ~47 ms on the test host. | Cache the scan with append-aware invalidation. |

Synthetic lookup benchmark used an array of plain session-like objects without I/O or rendering. It is **not** an end-to-end latency claim; actual gains depend on session size, update rate, and user interface.

## Additional candidates requiring production profiling

- `SessionManager.getChildren()` currently scans every entry; repeated tree-navigation calls may have quadratic aggregate cost. Profile navigation on sessions with many branches before introducing an index.
- Long JSONL entries use repeated string-buffer concatenation in `loadEntriesFromFile()`. Memory and time growth for unusually large single entries should be measured before changing the parser.
- Cache warming, compaction, model/auth refresh, extensions, and tool-output persistence may introduce latency under high concurrency; collect CPU, allocation, event-loop, and I/O traces rather than assuming they dominate.
- `EventStream.push()` allows unbounded buffering for result-only consumers by design; changing that contract requires consumer-migration tests.

## Validation

Focused regressions are in `packages/ai/test/event-stream-backpressure.test.ts` and `packages/coding-agent/test/session-manager/build-context.test.ts`. Full repository build, type checks, and CI must pass before considering this PR ready. No external-service latency, live-account performance, or production flamegraphs were measured.
