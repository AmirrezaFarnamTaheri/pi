import { describe, expect, it } from "vitest";
import { EventStream } from "../src/utils/event-stream.ts";

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
