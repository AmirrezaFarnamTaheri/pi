# Agent runtime and token-efficiency baseline

The metrics observer is opt-in. It does not change the agent loop, model prompts, retry policy, tool execution or API calls.

## Usage

\`\`\`ts
import { Agent, monitorAgent, summarizeAgentEvaluations } from "@earendil-works/pi-agent-core";

const agent = new Agent(/* your existing options */);
const { monitor, unsubscribe } = monitorAgent(agent);
await agent.prompt("Fix the failing test");
const metrics = monitor.report();
console.log(JSON.stringify(metrics, null, 2));
unsubscribe();

// Grade correctness separately using real tests or an independent evaluator:
const evaluation = summarizeAgentEvaluations([
  { id: "fix-test", passed: externalTestSuitePassed, metrics },
]);
\`\`\`

The observer reports per-run wall time, first visible text latency, assistant requests, turns, tool count, tool errors, tool execution durations, tool-result UTF-8 bytes, manually reported retries, provider input/output/cache/reasoning tokens, total and provider-billed USD cost, and nested-tool model usage. Reasoning is a subset of output. Prompt-cache reads are included in total context tokens; they are not the same as input-token reduction. For user-facing reports, \`cacheReadFraction\` is the ratio of cache reads to all prompt input tokens.

The \`AgentPerformanceMonitor\` snapshots do **not** contain prompts, model text, tool arguments, file paths, or tool output. \`report().status === "finished"\` is a lifecycle result, **not** a quality judgment. Correctness and success must be supplied by independent tests/evaluations. A report of task costs divided by zero successes uses \`null\` rather than Infinity.

For telemetry covering an outer coding-agent session retry boundary (which lies outside the core Agent), call \`monitor.noteRetry()\` when that retry begins. The core Agent event interface does not expose automatic retry attempts. Do not include credentials or private task content in shared benchmark artifacts.

## Controlled baseline design

Measure the following cohorts on the same hardware, Node version, provider, model, context, prompt cache conditions, tool loadout, and working-tree commit:

- 0-, 10-, 100- and 1,000-turn contexts, using short and long tool outputs.
- 1, 8, 50, and 100 independent tool calls; separately test sequential barriers.
- Streaming output of 1 KiB, 256 KiB and 2 MiB; record time to first text and event-loop delay.
- Cold and warm prompt-cache runs with the same stable system prompt, tool order and prompt prefix.
- Real coding tasks with a fixed test suite and explicit success/failure verdict, and no discretionary changes to grading.

For each cohort, retain the baseline \`v1.5.0\` results, experiment commit, sample count, p50/p95 duration, total/cache/reasoning tokens, total cost, tool calls and external quality result. Do not publish absolute speedups until these measurements are available. A successful model response alone is not a task-quality pass.

## CI and integration gate

This PR deliberately has no behavior-changing default. Run \`npm run build\`, \`npm run check\`, \`npm run test --workspace packages/agent\`, and the existing full CI matrix. The fork's GitHub Actions did not create runs for hardening PR #4; do not merge this PR until CI is restored and all checks pass.
