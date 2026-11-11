import { strict as assert } from "node:assert";
import { test } from "vitest";
import { compactHistoricalToolResults } from "../src/context-budget.ts";

const tool = (toolCallId: string, text: string, isError = false) => ({
	role: "toolResult" as const,
	toolCallId,
	toolName: "grep",
	content: [{ type: "text" as const, text }],
	isError,
	timestamp: 0,
});

test("abbreviates old successful results, preserving their head and tail within budget", () => {
	const old = tool("old", "START-" + "x".repeat(900) + "-END");
	const newest1 = tool("newer", "y".repeat(200));
	const newest2 = tool("newest", "z".repeat(200));
	const messages = [{ role: "user" as const, content: "hello", timestamp: 0 }, old, newest1, newest2];
	const result = compactHistoricalToolResults(messages, { maxCharsPerToolResult: 180, keepRecentResults: 2 });
	assert.equal(result.trimmedResults, 1);
	assert.equal(result.messages.length, 4);
	assert.equal(result.messages[0], messages[0]);
	assert.equal(result.messages[2], newest1);
	assert.equal(result.messages[3], newest2);
	assert.equal(result.messages[1]!.role, "toolResult");
	const abridged = result.messages[1]!;
	if (abridged.role !== "toolResult" || abridged.content[0]?.type !== "text") throw new Error("Expected text result");
	assert.equal(abridged.toolCallId, "old");
	const text = abridged.content[0].text;
	assert.ok(text.length <= 180);
	assert.ok(text.startsWith("START-"));
	assert.ok(text.endsWith("-END"));
	assert.ok(text.includes("omitted"));
	assert.ok(result.savedChars > 0);
	assert.equal(old.content[0]!.text.length, 910);
});

test("leaves errors, image payloads and multi-block tool results unchanged", () => {
	const error = tool("bad", "ERROR " + "x".repeat(900), true);
	const image = {
		role: "toolResult" as const,
		toolCallId: "image",
		toolName: "read",
		content: [{ type: "image" as const, data: "abc", mimeType: "image/png" }],
		isError: false,
		timestamp: 0,
	};
	const multi = {
		role: "toolResult" as const,
		toolCallId: "multi",
		toolName: "read",
		content: [
			{ type: "text" as const, text: "x".repeat(700) },
			{ type: "text" as const, text: "y".repeat(700) },
		],
		isError: false,
		timestamp: 0,
	};
	const messages = [error, image, multi];
	const result = compactHistoricalToolResults(messages, { maxCharsPerToolResult: 128, keepRecentResults: 0 });
	assert.equal(result.trimmedResults, 0);
	assert.deepEqual(result.messages, messages);
	assert.equal(result.savedChars, 0);
});

test("preserves original arrays when there are no changes and validates settings", () => {
	const message = tool("small", "small");
	const messages = [message];
	const result = compactHistoricalToolResults(messages, { maxCharsPerToolResult: 128, keepRecentResults: 0 });
	assert.equal(result.messages, messages);
	assert.throws(() => compactHistoricalToolResults(messages, { maxCharsPerToolResult: 0 }), RangeError);
	assert.throws(
		() => compactHistoricalToolResults(messages, { maxCharsPerToolResult: 128, keepRecentResults: -1 }),
		RangeError,
	);
});
