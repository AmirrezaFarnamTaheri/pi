import { strict as assert } from "node:assert";
import { test } from "vitest";
import { AgentPerformanceMonitor, summarizeAgentEvaluations } from "../src/performance-metrics.ts";

const usage = (input: number, output: number, cacheRead: number, cacheWrite: number, reasoning: number | undefined, cost: number) => ({
	input, output, cacheRead, cacheWrite, ...(reasoning === undefined ? {} : { reasoning }),
	totalTokens: input + output + cacheRead + cacheWrite,
	cost: { input: cost, output: 0, cacheRead: 0, cacheWrite: 0, total: cost, totalFromProvider: true },
});
const response = (u: ReturnType<typeof usage>, stopReason = "stop") => ({
	role: "assistant" as const, content: [{ type: "text" as const, text: "all good" }],
	api: "openai-responses" as const, provider: "openai" as const, model: "test-model",
	usage: u, stopReason: stopReason as "stop" | "error", timestamp: 0,
});

test("records provider token/cost counters without double-counting reasoning", () => {
	let now = 0;
	const monitor = new AgentPerformanceMonitor({ now: () => now });
	monitor.record({ type: "agent_start" });
	now = 5; monitor.record({ type: "turn_start" });
	now = 10; monitor.record({ type: "message_start", message: response(usage(0, 0, 0, 0, 0, 0)) });
	now = 24; monitor.record({ type: "message_update", message: response(usage(0, 0, 0, 0, 0, 0)), assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "t", partial: response(usage(0, 0, 0, 0, 0, 0)) } });
	now = 40; monitor.record({ type: "message_end", message: response(usage(100, 20, 300, 50, 6, 0.052)) });
	now = 43; monitor.record({ type: "tool_execution_start", toolCallId: "tool-1", toolName: "read", args: {} });
	now = 73; monitor.record({ type: "tool_execution_end", toolCallId: "tool-1", toolName: "read", result: {}, isError: false, durationMs: 30 });
	now = 74; monitor.record({ type: "message_end", message: { role: "toolResult", toolCallId: "tool-1", toolName: "read", content: [{ type: "text", text: "αβ" }], isError: false, timestamp: 0 } });
	now = 80; monitor.record({ type: "turn_end", message: response(usage(100, 20, 300, 50, 6, 0.052)), toolResults: [] });
	now = 90; monitor.record({ type: "agent_end", messages: [] });
	const result = monitor.report();
	assert.equal(result.status, "finished");
	assert.equal(result.durationMs, 90);
	assert.equal(result.timeToFirstTextMs, 24);
	assert.equal(result.requestCount, 1);
	assert.equal(result.turnCount, 1);
	assert.equal(result.turns.length, 1);
	assert.equal(result.turns[0]!.durationMs, 75);
	assert.equal(result.turns[0]!.tokens.total, 470);
	assert.equal(result.turns[0]!.costUsd, 0.052);
	assert.equal(result.toolCalls, 1);
	assert.equal(result.toolErrors, 0);
	assert.equal(result.toolExecutionMs, 30);
	assert.equal(result.toolResultBytes, 4);
	assert.equal(result.tokens.input, 100);
	assert.equal(result.tokens.cacheRead, 300);
	assert.equal(result.tokens.cacheWrite, 50);
	assert.equal(result.tokens.output, 20);
	assert.equal(result.tokens.reasoning, 6);
	assert.equal(result.tokens.total, 470);
	assert.equal(result.costUsd, 0.052);
	assert.equal(result.cacheReadFraction, 300 / 450);
	assert.equal(result.providerBilledCostUsd, 0.052);
});

test("accounts for retries, failed tools and nested usage independently", () => {
	let now = 100;
	const monitor = new AgentPerformanceMonitor({ now: () => now });
	monitor.record({ type: "agent_start" });
	monitor.noteRetry();
	monitor.record({ type: "tool_execution_start", toolCallId: "bad", toolName: "bash", args: {} });
	monitor.record({ type: "tool_execution_end", toolCallId: "bad", toolName: "bash", result: {}, isError: true });
	monitor.record({ type: "message_end", message: { role: "toolResult", toolCallId: "bad", toolName: "bash", content: [{ type: "text", text: "failure" }], isError: true, usage: usage(10, 2, 5, 0, undefined, 0.011), timestamp: 0 } });
	now = 180; monitor.record({ type: "message_end", message: response(usage(1, 3, 0, 0, undefined, 0.005), "error") });
	now = 200; monitor.record({ type: "agent_end", messages: [] });
	const result = monitor.report();
	assert.equal(result.status, "error");
	assert.equal(result.retryCount, 1);
	assert.equal(result.toolErrors, 1);
	assert.equal(result.nestedUsageCostUsd, 0.011);
	assert.equal(result.costUsd, 0.016);
	assert.equal(result.tokens.reasoning, 0);
	assert.equal(result.tokens.reasoningReported, false);
	assert.equal(result.tokens.total, 21);
	assert.equal(result.toolResultBytes, 7);
});

test("never retains conversation content or mutates prior snapshots", () => {
	let now = 0;
	const monitor = new AgentPerformanceMonitor({ now: () => now });
	monitor.record({ type: "agent_start" });
	monitor.record({ type: "message_end", message: response(usage(1, 2, 0, 0, undefined, 0.1)) });
	const prior = monitor.report();
	monitor.record({ type: "message_end", message: response(usage(2, 3, 0, 0, undefined, 0.2)) });
	assert.equal(prior.costUsd, 0.1);
	assert.equal(prior.tokens.input, 1);
	assert.equal(monitor.report().tokens.input, 3);
	assert.equal(JSON.stringify(monitor.report()).includes("all good"), false);
	assert.equal("passed" in monitor.report(), false);
});

test("quality metrics use an external grader and avoid division by zero", () => {
	const one = { costUsd: 0.1, tokens: { total: 100 } };
	const two = { costUsd: 0.2, tokens: { total: 200 } };
	const result = summarizeAgentEvaluations([{ id: "a", passed: true, metrics: one }, { id: "b", passed: false, metrics: two }]);
	assert.equal(result.cases, 2);
	assert.equal(result.successes, 1);
	assert.equal(result.passRate, 0.5);
	assert.equal(result.costPerSuccessUsd, 0.3);
	assert.equal(result.tokensPerSuccess, 300);
	const allFailed = summarizeAgentEvaluations([{ id: "b", passed: false, metrics: two }]);
	assert.equal(allFailed.costPerSuccessUsd, null);
	assert.equal(allFailed.tokensPerSuccess, null);
});

test("counts UTF-8 bytes in runtimes without the Node Buffer global", () => {
	const monitor = new AgentPerformanceMonitor();
	const savedBuffer = globalThis.Buffer;
	try {
		(globalThis as { Buffer?: typeof Buffer }).Buffer = undefined;
		monitor.record({ type: "agent_start" });
		monitor.record({ type: "message_end", message: {
			role: "toolResult", toolCallId: "unicode", toolName: "read",
			content: [{ type: "text", text: "αβ😀" }], isError: false, timestamp: 0,
		} });
		assert.equal(monitor.report().toolResultBytes, 8);
	} finally {
		globalThis.Buffer = savedBuffer;
	}
});
