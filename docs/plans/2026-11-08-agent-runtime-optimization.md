# Agent and Interactive Runtime Optimization Implementation Plan

> **For agentic workers:** Use the host's available task-by-task implementation workflow. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Improve task-success-adjusted agent speed, token efficiency, and interactive Pi responsiveness without changing default prompt semantics, data durability, or tool authorization.

**Architecture:** Split independent performance experiments into reviewable PRs. Instrument before changing execution, preserve existing default paths, require deterministic tests and actual before/after workload measurements, and perform Windows x64 plus Linux verification. Runtime and token-budget options remain opt-in until task-correctness evidence supports a new default.

**Tech Stack:** Node.js 22.19+, TypeScript 7, Vitest 4, Bun platform binary releases, GitHub Actions, JSONL sessions, terminal UI.

## Global Constraints

- Preserve the fork's existing `main`, published v1.5.0 binaries, and open PR #4 (runtime hardening) and PR #5 (upstream synchronization).
- Do not merge PRs while the fork's Actions build/test checks are absent.
- No content-bearing telemetry by default; never send prompt text, API keys, file contents or tool arguments to performance artifacts.
- Preserve original source transcript, tool IDs/order, permission checks, edit barriers, cancellation, compaction boundaries, prompt sections, and crash-recovery rules.
- Every optimization needs a baseline, repeatable fixture, sample count, representative cold/warm cache case, a real correctness assertion, and a post-change profile. Revert changes inside measurement noise.
- The cost metric is total USD per externally graded successful coding task, not the model stop reason.
- Exact provider token billing, cache economics, and model routing cannot be inferred from character counts alone.

---

### Task 0: Restore CI and validate the hardening benchmark suite

**Files:**
- Inspect: `.github/workflows/ci.yml`
- Inspect: `.github/workflows/bench-runtime.yml` in PR #4
- Inspect: `scripts/bench-runtime.mjs` in PR #4

**Interfaces:**
- Consumes: GitHub Actions repository permissions; branch `hardening/reliability-sync-bench-20261108`
- Produces: reproducible six-job build/test results and versioned JSON performance artifacts

- [ ] Confirm the repo's **Settings → Actions → General** permits workflows and the CI workflow is enabled; this requires owner-side GitHub settings access that the connected GitHub tool does not expose.
- [ ] Trigger a new pull-request event from the GitHub UI (close/reopen PR #4) or a user-authored branch push after Actions are enabled; confirm run ID, head SHA and full job outcomes. `gh workflow run` is not available until `workflow_dispatch` is present on the default branch.
- [ ] Verify the benchmark suite after `npm ci --ignore-scripts && npm run hydrate:model-data && npm run build:offline` using `npm run bench:runtime -- --entries 12000 --samples 12 --warmups 3 --output .artifacts/runtime-baseline.json`.
- [ ] Confirm the full CI job matrix passes without skipped test groups, and that Windows/Linux releases smoke-test the correct installed fork binary.
- [ ] Gate all subsequent merges on these checks.

### Task 1: Agent PR A — opt-in observability and evaluated quality

**Files:**
- Create: `packages/agent/src/performance-metrics.ts`
- Modify: `packages/agent/src/index.ts`
- Test: `packages/agent/test/performance-metrics.test.ts`
- Document: `docs/agent-performance-baselines.md`

**Interfaces:**
- Consumes: `Agent.subscribe((event: AgentEvent) => void)`
- Produces: `AgentPerformanceMonitor.record(event)`, `report(): AgentRunMetrics`, `monitorAgent(agent)`, `summarizeAgentEvaluations(results)`

- [x] Add tests for nested vs provider usage, no reasoning-token double counting, tool UTF-8 output size, per-turn cost/latency, privacy, failed zero-success evaluations.
- [x] Record failing local stub-test assertions and implement opt-in metrics without modifying agent execution.
- [x] Verify the isolated Node type-stripping tests pass; check type-level compatibility with a minimal TypeScript shim.
- [ ] Run real Vitest `npm run test --workspace packages/agent -- performance-metrics`, `npm run check`, and full CI.
- [ ] Save baseline report from real agent tasks with external success criteria; quantify variance across at least three runs.

### Task 2: Agent PR B — opt-in token and context budgets

**Files:**
- Create: `packages/agent/src/context-budget.ts`
- Modify: `packages/agent/src/index.ts`
- Test: `packages/agent/test/context-budget.test.ts`
- Document: `docs/agent-token-efficiency.md`

**Interfaces:**
- Consumes: `AgentMessage[]`, `HistoricalToolResultBudget`
- Produces: `compactHistoricalToolResults(messages, options)` returning projected context and conservative character savings

- [x] Test that only older successful single-text results are abbreviated; preserve recent, error, image and multi-block results, order/IDs and original transcript.
- [x] Record failing local stub assertions, implement bounded head/tail summary and rerun focused tests green.
- [ ] Run exact Vitest and integrate an opt-in `transformContext` quality evaluation against unmodified behavior; reject when a task requires lost context.
- [ ] Compare actual model input usage, cache hit rates, extra tool re-reads, cost per task and external test success before choosing any default.

### Task 3: Agent PR C — bounded tool scheduling

**Files:**
- Create: `packages/agent/src/ordered-tool-pool.ts`
- Modify: `packages/agent/src/agent-loop.ts`, `packages/agent/src/agent.ts`, `packages/agent/src/types.ts`
- Test: `packages/agent/test/ordered-tool-pool.test.ts`, `packages/agent/test/tool-concurrency-integration.test.ts`
- Document: `docs/agent-concurrency.md`

**Interfaces:**
- Consumes: `AgentOptions.maxParallelToolExecutions?` and `AgentLoopConfig.maxParallelToolExecutions?`
- Produces: source-ordered execution of up to 1–32 concurrently running prepared independent tools, with default eight

- [x] Add tests for max-concurrency, order, immediate results, invalid limits, and thrown job failures; observe failing then passing local unit tests.
- [x] Extract bounded worker pool and thread optional config through the real Agent loop; keep permission preparation serial and sequential-tool barriers intact.
- [ ] Run integration and full Vitest with cancellation, nested tools, permission prompts, event order and mixed batch coverage.
- [ ] Record latency/peak RSS/CPU for 1, 2, 4, 8, 16 and 32 worker limits; keep only a proven improvement.

### Task 4: Incremental TUI and Markdown rendering

**Files:**
- Modify: `packages/tui/src/tui.ts`, `packages/tui/src/components/markdown.ts`, `packages/coding-agent/src/modes/interactive/components/assistant-message.ts`
- Test (proposed): `packages/tui/test/render-incremental.test.ts`

**Interfaces:**
- Consumes: component render/invalidate calls and terminal resizing events
- Produces: stable historical render buffers plus a mutable streaming tail, with identical terminal output

- [ ] Test 100/1,000/10,000-message transcripts and assert identical output after scroll, resize, theme switch and streamed Markdown.
- [ ] Profile render p50/p95 and allocation per frame on Windows x64 and Linux; record failing latency budget before changing code.
- [ ] Reuse completed transcript components and parsed Markdown blocks when the user-visible output is unchanged.
- [ ] Re-run image/mouse/selection/scrollback regressions and compare measured input-to-screen p95; revert when not improved.

### Task 5: Session-picker metadata indexing

**Files:**
- Modify: `packages/coding-agent/src/core/session-manager.ts`
- Test (proposed): `packages/coding-agent/test/session-index-performance.test.ts`

**Interfaces:**
- Consumes: append-only JSONL session content with same-size/same-time external rewrite detection
- Produces: optional rebuildable metadata index, preserving JSONL as source of truth

- [ ] Test unchanged stat, same-size rewrite, append, truncate, corruption, rename and external process modification.
- [ ] Benchmark total bytes read and session-picker p95 for 10/1,000/10,000 sessions, including slow Windows storage.
- [ ] Implement incremental index invalidation or rebuild-on-uncertainty; never use cached metadata for a changed file without verification.
- [ ] Verify title/session discovery results identical, then compare disk I/O and memory.

### Task 6: Bounded event-stream memory

**Files:**
- Modify: `packages/ai/src/utils/event-stream.ts`
- Test (proposed): `packages/ai/test/event-stream-memory.test.ts`

**Interfaces:**
- Consumes: normal `EventStream` push/backpressure
- Produces: explicit opt-in result-only consumer that skips storage of irrelevant progress, never altering the default lossless event mode

- [ ] Test slow consumers, no consumer, 100,000 events, cancel, failure, completion, backpressure fairness, and exact event ordering in default mode.
- [ ] Record peak RSS/heap and final result equivalence for streaming and result-only workloads.
- [ ] Add bounded result-only collection without dropping events in existing lossless mode.
- [ ] Run all event stream and agent lifecycle tests; keep only a measured memory reduction.

### Task 7: Transactional model/provider registration

**Files:**
- Modify: `packages/coding-agent/src/core/model-runtime.ts`
- Test (proposed): `packages/coding-agent/test/model-registration-batch.test.ts`

**Interfaces:**
- Consumes: registered providers, aliases, credentials, and refresh-generation rules
- Produces: optional `registerBatch` or transaction that publishes one coherent snapshot

- [ ] Test mixed add/remove, credential priority, stale refreshes and extension-loaded provider discovery.
- [ ] Benchmark 10/100/500 registrations and count credential checks and snapshot rebuilds.
- [ ] Coalesce only redundant recomposition; preserve externally observed registration ordering and atomic availability.
- [ ] Re-run model switching and virtual-model tests; confirm lower cold-start CPU/latency.

### Task 8: Versioned context projection reuse

**Files:**
- Modify: `packages/coding-agent/src/core/session-manager.ts`, `packages/coding-agent/src/core/agent-session.ts`
- Test (proposed): `packages/coding-agent/test/projection-cache-invalidation.test.ts`

**Interfaces:**
- Consumes: branch tip, edits, compaction boundaries, model/tool loadout, extension mutations
- Produces: exact context projection equivalence under an immutable version key

- [ ] Test every edit/branch/compaction/model/tool-loadout invalidator, and compare the entire provider-visible message list to uncached projection.
- [ ] Measure provider request-preparation p95 on 100/1,000/10,000-turn branches.
- [ ] Add immutable cache with explicit generation increments and bounded retained entries.
- [ ] Re-run transcript/compaction/context edit tests; reject any changed prompt text or stale edit.

### Task 9: Persistence and concurrency resilience

**Files:**
- Modify: `packages/coding-agent/src/core/session-manager.ts`, `packages/agent/src/agent-loop.ts`
- Test (proposed): `packages/coding-agent/test/session-write-order.test.ts`

**Interfaces:**
- Consumes: append-only JSONL state, abort and process-crash recovery behavior
- Produces: only measured, durably ordered write batching; tool scheduling remains bounded

- [ ] Test interruption between writes, multi-process appends, disk full, partial lines and branch switch.
- [ ] Measure event-loop delay, write sync latency, and correctness on Windows NTFS and Linux.
- [ ] Consider ordered writer and conditional batched fsync only if crash recovery and session durability are provably equal.
- [ ] Re-run entire session and agent suite; revert on ordering, recovery, or correctness change.

### Task 10: Economic cache warming and adaptive compaction (later experiment)

**Files:**
- Modify: `packages/coding-agent/src/core/cache-warmer.ts`, `packages/coding-agent/src/core/compaction/compaction.ts`
- Test (proposed): `packages/coding-agent/test/cache-warmer-economics.test.ts`, `packages/coding-agent/test/compaction-quality-eval.test.ts`

**Interfaces:**
- Consumes: provider token prices, cache TTL/retention, observed session continuation, context usage
- Produces: expected-net-savings calculation and conservative compaction choice with observable opt-out

- [ ] Test provider-specific cache pricing, TTL expiry, miss probability, sleeping laptops and aborted warm requests.
- [ ] Measure real cost and task success of different context retention thresholds, including extra reads after compaction.
- [ ] Compare changes against the existing $0.05 minimum expected savings and 16,384 reserve/20,000 recent token defaults.
- [ ] Ship only if real cost per externally successful task improves with no meaningful quality regression.

## Verification

Use `npm ci --ignore-scripts`, `npm run hydrate:model-data`, `npm run build`, `npm run check`, `npm run test --workspace packages/agent`, `npm run test --workspace packages/ai`, `npm run test --workspace packages/coding-agent`, `npm run test:scripts` and the full CI matrix. Record the exact head SHA and checks. Benchmark on both Windows and Linux, repeat, compare against v1.5.0 and store fixture hashes in the report.

## Open product decisions

- Whether any opt-in token/context policy should become a default: keep opt-in pending external success-rate and cache-economics evidence.
- Regression budgets: derive stable numerical thresholds after repeated runs on controlled runner hardware, rather than inventing pass/fail percentages now.
- Provider-specific tokenizer accounting for preview models: depend on actual usage receipts; keep character savings as an approximation, not billable tokens.
- User-facing quality scorer: an external task test suite must provide pass/fail labels; a model stop reason is not a substitute.
