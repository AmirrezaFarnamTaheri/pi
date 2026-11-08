import { describe, expect, it } from "vitest";
import { EventStream, createAssistantMessageEventStream } from "../src/utils/event-stream.ts";

describe("EventStream opt-in result-only retention", () => {
	it("preserves historical events by default for late consumers", async () => {
		const stream = new EventStream<number, number>((event) => event === 3, (event) => event);
		stream.push(1);
		stream.push(2);
		stream.push(3);
		expect(await stream.result()).toBe(3);
		const seen: number[] = [];
		for await (const event of stream) seen.push(event);
		expect(seen).toEqual([1, 2, 3]);
	});

	it("does not accumulate events when only the final result is needed", async () => {
		const stream = new EventStream<number, number>(
			(event) => event === 10_000,
			(event) => event,
			{ retention: "result-only" },
		);
		for (let i = 0; i <= 10_000; i++) stream.push(i);
		expect(await stream.result()).toBe(10_000);
		const lateEvents: number[] = [];
		for await (const event of stream) lateEvents.push(event);
		expect(lateEvents).toEqual([]);
	});

	it("still preserves delivery to active consumers", async () => {
		const stream = new EventStream<number, number>(
			(event) => event === 2,
			(event) => event,
			{ retention: "result-only" },
		);
		const seen: number[] = [];
		const consuming = (async () => { for await (const event of stream) seen.push(event); })();
		await new Promise<void>((resolve) => setImmediate(resolve));
		stream.push(1);
		stream.push(2);
		await consuming;
		expect(seen).toEqual([1, 2]);
		expect(await stream.result()).toBe(2);
	});

	it("allows assistant response callers to opt out without losing the final response", async () => {
		const stream = createAssistantMessageEventStream({ retention: "result-only" });
		const message = {
			role: "assistant" as const,
			content: [],
			api: "openai-responses" as const,
			provider: "openai" as const,
			model: "test-model",
			timestamp: Date.now(),
			stopReason: "stop" as const,
			usage: {
				input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
		};
		stream.push({ type: "done", reason: "stop", message });
		expect(await stream.result()).toBe(message);
		expect(message).toHaveProperty("durationMs");
		const replay: unknown[] = [];
		for await (const event of stream) replay.push(event);
		expect(replay).toEqual([]);
	});

	it("still propagates producer failure to both result and iteration", async () => {
		const stream = new EventStream<number, number>(
			(event) => event === 2,
			(event) => event,
			{ retention: "result-only" },
		);
		stream.push(1);
		stream.fail(new Error("provider failed"));
		await expect(stream.result()).rejects.toThrow("provider failed");
		const consume = async () => { for await (const _event of stream) { /* nothing */ } };
		await expect(consume()).rejects.toThrow("provider failed");
	});
});
