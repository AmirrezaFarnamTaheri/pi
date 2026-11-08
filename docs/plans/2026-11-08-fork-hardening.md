# Fork reliability, upstream sync and runtime benchmarks implementation plan

> **For agentic workers:** Use the host's available task-by-task implementation workflow. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Keep the fork independently maintainable, prevent recoverable crashes, measure real runtime performance, reduce coupled modules, and improve CI reliability.

**Architecture:** Preserve existing command and API semantics, isolate independently testable work into small modules, and use an explicit upstream-sync pull request rather than rewriting fork history. GitHub Actions builds and tests each change; fork-only releases never publish upstream-owned packages or external artifacts.

**Tech Stack:** Node.js >=22.19, TypeScript 7, Vitest 4, GitHub Actions, Bun cross-platform packaging, PowerShell Windows support.

## Global Constraints

- Retain fork-specific runtime fixes and release artifacts and preserve the `v1.5.0` tag.
- Never auto-merge unreviewed upstream changes or push to upstream.
- Preserve session data, tool execution ordering, cancellation, credentials, and extension behavior.
- Do not publish any `@earendil-works/*` npm packages or upstream model catalogs from the fork.
- Record latency, RSS and heap usage without assuming synthetic timings are production results.
- Tests and CI must be green before merge. Keep upstream sync as a separate human-reviewed PR.

---

### Task 1: Recover from failed temporary-output streams

**Files:**
- Modify: `packages/coding-agent/src/core/bash-executor.ts`
- Test: `packages/coding-agent/test/bash-temp-file-errors.test.ts` (proposed)
- Verify: `packages/coding-agent/test/bash-executor-truncation.test.ts`

**Interfaces:**
- Consumes: `executeBashWithOperations(command, cwd, operations, options)`, `createOutputFileStream(prefix, extension)`
- Produces: existing `BashResult` unchanged, with `fullOutputPath` undefined if storage failed

- [ ] Add tests with a fake WriteStream that emits asynchronous ENOSPC and synchronous EACCES construction errors; assert no crash, truncated output and undefined path.
- [ ] Run the focused Vitest and confirm the expected unhandled error or propagated exception.
- [ ] Register stream error handling before writes, stop retrying a failed spool, await stream completion when returning; preserve in-memory tail.
- [ ] Rerun the focused tests and existing truncation tests.
- [ ] Run the coding-agent CI test suite; commit the independently passing change.

### Task 2: Stabilize GC-based leak assertions without masking leaks

**Files:**
- Modify: `packages/ai/test/memory-helpers.ts`
- Modify: `packages/ai/test/streaming-tool-arguments.test.ts`
- Test: `packages/ai/test/memory-helpers.test.ts` (proposed)

**Interfaces:**
- Consumes: `collectGarbage()`
- Produces: `waitForCollected(references, timeoutMs)` with a bounded deadline and no retained dereferences across turns

- [ ] Test that a genuinely reachable object stays reachable while a released object can be collected.
- [ ] Verify current flaky assertion history on main, and red state for the proposed helper if absent.
- [ ] Yield across event-loop turns, perform bounded full GC passes, and preserve a hard failure when any WeakRef remains reachable at the deadline.
- [ ] Run focused tests and the `test (other)` matrix under CI; commit.

### Task 3: Keep upstream differences reviewable

**Files:**
- Create: `.github/workflows/sync-upstream.yml`
- Create: `docs/fork-maintenance.md`
- Test: `scripts/test-upstream-sync-config.mjs` (proposed)

**Interfaces:**
- Consumes: `https://github.com/earendil-works/pi.git`, fork `main`
- Produces: a `sync/upstream-main` branch and PR when the upstream merge is conflict-free; otherwise an actionable conflict report, no forced merge

- [ ] Add a workflow configuration test for pinned upstream URL, permissions and no automatic merge.
- [ ] Verify the workflow test fails when the workflow does not exist.
- [ ] Implement scheduled/manual fetch, merge-without-rewrite, PR update/create and conflict reporting.
- [ ] Verify workflow static check and GitHub Actions validation; commit.
- [ ] Keep any resulting sync PR open for review until conflicts and fork-specific integration tests are resolved.

### Task 4: Independent GitHub workflows

**Files:**
- Modify or retire upstream-owned publishing and staff workflows under `.github/workflows/`
- Modify: `.github/workflows/fork-github-release.yml`
- Document: `docs/fork-maintenance.md`

**Interfaces:**
- Consumes: fork CI and source commit
- Produces: non-upstream fork CI/release only

- [ ] Verify each publishing workflow's triggers and external credentials.
- [ ] Add a policy check that rejects references to upstream publish endpoints in active fork workflows.
- [ ] Disable upstream-only publishing and staff-bot jobs on the fork, retaining only required CI/security/test workflows.
- [ ] Verify CI and release workflow validation; commit.

### Task 5: Measure real runtime paths and report regressions

**Files:**
- Create: `scripts/bench-runtime.mjs`, `scripts/bench-runtime.test.mjs`
- Modify: `package.json`
- Create: `.github/workflows/bench-runtime.yml`
- Document: `docs/fork-maintenance.md`

**Interfaces:**
- Consumes: actual compiled session APIs and representative synthetic fixture sessions
- Produces: JSON report of sample count, median, p95, CPU usage, heap delta and RSS for each workload

- [ ] Test reporting helpers, fixture configuration and invalid CLI input.
- [ ] Verify helper tests fail before the benchmarking implementation.
- [ ] Measure repeated `getBranch`, `getTree`, `loadEntriesFromFile`, and session navigation on real APIs.
- [ ] Run with warmups, bounded samples and deterministic fixture sizes; store JSON artifact in a manual/scheduled Actions workflow.
- [ ] Verify data shape and bounded runtime, do not set arbitrary CI speed thresholds; commit.

### Task 6: Extract focused responsibilities from large modules

**Files:**
- Modify: `packages/coding-agent/src/modes/interactive/interactive-mode.ts`
- Modify: `packages/coding-agent/src/core/agent-session.ts`
- Create: narrow helper modules based on existing pure functions and their dependencies
- Test: reuse existing public behavior tests and add direct tests only for uncovered contracts

**Interfaces:**
- Consumes/produces: existing public functions and session UI behavior, unchanged

- [ ] Identify an independently testable set of formatting/status helpers in each module.
- [ ] Run existing focused tests before changes.
- [ ] Move helpers into focused files, preserve current exports as re-exports, and avoid changing behavior.
- [ ] Verify focused tests, the full coding-agent suite and lint/type checks; commit.

## Verification

Commands: `npm ci --ignore-scripts`, `npm run build`, `npm run check`, `npm run test --workspace packages/ai -- --run`, `npm run test --workspace packages/coding-agent -- --run`, `npm run test:scripts`, and `npm run bench:runtime`. Hosted CI is required if the checkout or dependencies are unavailable locally.

## Open decisions recorded for review

- An actual 37+-commit upstream merge may conflict with fork-specific changes. Do not auto-resolve or merge it; require review of the generated PR and keep the fork `main` intact.
- The default benchmark fixture sizes establish a baseline only; enforce numerical regressions after normalizing runner hardware and collecting repeated measurements.
- Remove unused upstream staff automation only when its trigger/output is verified to be independent of fork CI and release verification.
