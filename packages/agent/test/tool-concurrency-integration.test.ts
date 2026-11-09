import { strict as assert } from "node:assert";
import { type AssistantMessage, createAssistantMessageEventStream } from "@earendil-works/pi-ai/compat";
import { obj } from "@earendil-works/pi-schema";
import { test } from "vitest";
import { Agent, type AgentTool } from "../src/index.ts";

test("agent honors configured tool limit while keeping source-order results", async () => {
	let active = 0;
	let peak = 0;
	let requests = 0;
	const tool: AgentTool = {
		name: "async_read",
		label: "Async read",
		description: "Independent read",
		parameters: obj({}),
		execute: async () => {
			active++;
			peak = Math.max(peak, active);
			await new Promise<void>((resolve) => setTimeout(resolve, 10));
			active--;
			return { content: [{ type: "text", text: "ok" }], details: {} };
		},
	};
	const assistant = (toolUse: boolean): AssistantMessage => ({
		role: "assistant",
		content: toolUse
			? Array.from({ length: 5 }, (_, index) => ({
					type: "toolCall" as const,
					id: `call-${index}`,
					name: "async_read",
					arguments: {},
				}))
			: [{ type: "text", text: "done" }],
		api: "openai-responses",
		provider: "openai",
		model: "mock",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: toolUse ? "toolUse" : "stop",
		timestamp: Date.now(),
	});
	const agent = new Agent({
		maxParallelToolExecutions: 2,
		initialState: { tools: [tool] },
		streamFn: () => {
			const stream = createAssistantMessageEventStream();
			const message = assistant(requests++ === 0);
			queueMicrotask(() => {
				if (message.stopReason === "toolUse") stream.push({ type: "done", reason: "toolUse", message });
				else stream.push({ type: "done", reason: "stop", message });
			});
			return stream;
		},
	});
	await agent.prompt("read five independent files");
	assert.equal(requests, 2);
	assert.equal(peak, 2);
	assert.deepEqual(
		agent.state.messages.filter((message) => message.role === "toolResult").map((message) => message.toolCallId),
		["call-0", "call-1", "call-2", "call-3", "call-4"],
	);
});
