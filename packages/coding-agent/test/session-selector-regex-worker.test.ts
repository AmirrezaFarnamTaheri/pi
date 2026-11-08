import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { SessionInfo } from "../src/core/session-manager.ts";
import { filterSessionsByRegexInWorker } from "../src/modes/interactive/components/session-selector-regex-worker.ts";

function session(id: string, allMessagesText: string, name?: string, modified = 0): SessionInfo {
	return {
		id,
		path: `/tmp/${id}.jsonl`,
		cwd: "/tmp",
		name,
		created: new Date(0),
		modified: new Date(modified),
		messageCount: 1,
		firstMessage: allMessagesText.slice(0, 100),
		allMessagesText,
	};
}

describe("isolated session regex search", () => {
	it("preserves word-boundary and case-insensitive matching", async () => {
		const items = [session("one", "Brave is great"), session("two", "bravery is not the same")];
		const result = await filterSessionsByRegexInWorker(items, "\\bbrave\\b", "recent");
		expect(result.map((item) => item.id)).toEqual(["one"]);
	});

	it("ranks session names above message text and breaks ties by recent activity", async () => {
		const items = [
			session("a", "brave", undefined, 50),
			session("b", "unrelated", "Brave work", 10),
			session("c", "brave", undefined, 100),
		];
		const result = await filterSessionsByRegexInWorker(items, "brave", "relevance");
		expect(result.map((item) => item.id)).toEqual(["b", "c", "a"]);
	});

	it("keeps the main event loop responsive and terminates catastrophic backtracking", async () => {
		const items = [session("catastrophic", "a".repeat(20_000) + "!")];
		let ticks = 0;
		const timer = setInterval(() => ticks++, 10);
		try {
			await expect(filterSessionsByRegexInWorker(items, "^(a|aa)+$", "recent")).rejects.toThrow(
				/regex search timed out/i,
			);
		} finally {
			clearInterval(timer);
		}
		expect(ticks).toBeGreaterThan(5);
	});

	it("cancels a search before starting work", async () => {
		const controller = new AbortController();
		controller.abort();
		await expect(filterSessionsByRegexInWorker([session("one", "x")], "x", "recent", controller.signal))
			.rejects.toThrow(/cancelled/i);
	});

	it("cancels a catastrophic regex after execution begins without blocking the event loop", async () => {
		const controller = new AbortController();
		const pending = filterSessionsByRegexInWorker(
			[session("catastrophic", "a".repeat(20_000) + "!")],
			"^(a|aa)+$",
			"recent",
			controller.signal,
		);
		setTimeout(() => controller.abort(), 50);
		await expect(pending).rejects.toThrow(/cancelled/i);
	});

	it("searches large history from the JSONL file on the worker, including matches across messages", async () => {
		const directory = mkdtempSync(join(tmpdir(), "pi-regex-large-session-"));
		try {
			const path = join(directory, "large.jsonl");
			const first = "x".repeat(150_000) + "needle";
			writeFileSync(path, [
				JSON.stringify({ type: "session", version: 3, id: "large", cwd: directory, timestamp: "2026-01-01T00:00:00Z" }),
				JSON.stringify({ type: "message", id: "1", message: { role: "user", content: first }, timestamp: "2026-01-01T00:00:01Z" }),
				JSON.stringify({ type: "message", id: "2", message: { role: "assistant", content: [{ type: "text", text: "next" }] }, timestamp: "2026-01-01T00:00:02Z" }),
			].join("\n") + "\n");
			const item = { ...session("large", first + " next"), path, cwd: directory };
			const result = await filterSessionsByRegexInWorker([item], "needle next$", "recent");
			expect(result.map((value) => value.id)).toEqual(["large"]);
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	});


	it("streams many messages without accumulating the full transcript in the worker", async () => {
		const directory = mkdtempSync(join(tmpdir(), "pi-regex-stream-"));
		try {
			const path = join(directory, "many.jsonl");
			const lines = Array.from({ length: 1_000 }, (_, id) =>
				JSON.stringify({ type: "message", message: { role: "user", content: "prefix " + "x".repeat(1_000) + (id === 999 ? " final-marker" : "") } }),
			);
			writeFileSync(path, lines.join("\n") + "\n");
			const item = { ...session("many", "x".repeat(100_000)), path };
			const result = await filterSessionsByRegexInWorker([item], "final-marker", "recent");
			expect(result.map((entry) => entry.id)).toEqual(["many"]);
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	});

	it("preserves matches in other sessions and reports an incomplete oversized history", async () => {
		const directory = mkdtempSync(join(tmpdir(), "pi-regex-too-large-"));
		try {
			const hugePath = join(directory, "oversized.jsonl");
			const validPath = join(directory, "valid.jsonl");
			writeFileSync(hugePath, JSON.stringify({ type: "message", message: { role: "user", content: "x".repeat(1_200_000) } }) + "\n");
			writeFileSync(validPath, JSON.stringify({ type: "message", message: { role: "user", content: "needle" } }) + "\n");
			const huge = { ...session("oversized", "x".repeat(100_000)), path: hugePath };
			const valid = { ...session("valid", "x".repeat(100_000)), path: validPath };
			const failures: string[][] = [];
			const result = await filterSessionsByRegexInWorker([huge, valid], "needle", "recent", undefined, (ids) => failures.push(ids));
			expect(result.map((entry) => entry.id)).toEqual(["valid"]);
			expect(failures).toEqual([["oversized"]]);
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	});

	it("preserves beginning and end regex anchors across streamed JSONL chunks", async () => {
		const directory = mkdtempSync(join(tmpdir(), "pi-regex-anchors-"));
		try {
			const path = join(directory, "anchored.jsonl");
			writeFileSync(path, [
				JSON.stringify({ type: "message", message: { role: "user", content: "start-" + "x".repeat(150_000) } }),
				JSON.stringify({ type: "message", message: { role: "assistant", content: "final" } }),
			].join("\n") + "\n");
			const item = { ...session("anchored", "x".repeat(100_000)), path };
			const begin = await filterSessionsByRegexInWorker([item], "^final", "recent");
			expect(begin).toEqual([]);
			const end = await filterSessionsByRegexInWorker([item], "final$", "recent");
			expect(end.map((entry) => entry.id)).toEqual(["anchored"]);
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	});

	it("uses full-transcript regex semantics for long history, anchors, lookaheads, and empty text blocks", async () => {
		const directory = mkdtempSync(join(tmpdir(), "pi-regex-exact-"));
		try {
			const path = join(directory, "full.jsonl");
			const first = "BEGIN" + "x".repeat(170_000) + "END";
			writeFileSync(path, [
				JSON.stringify({ type: "message", message: { role: "user", content: [{ type: "text", text: "hello" }, { type: "text", text: "world" }] } }),
				JSON.stringify({ type: "message", message: { role: "assistant", content: [
					{ type: "text", text: "a" }, { type: "text", text: "" }, { type: "text", text: "b" },
				] } }),
				JSON.stringify({ type: "message", message: { role: "user", content: first } }),
				JSON.stringify({ type: "message", message: { role: "user", content: "needle" } }),
			].join("\n") + "\n");
			const item = { ...session("full", "x".repeat(100_000)), path };
			for (const [pattern, present] of [
				["^hello world", true], ["a {2}b", true], ["BEGIN[\\s\\S]*END", true],
				["^absent|needle", true], ["(?:needle$)", true], ["foo(?!bar)", false],
				["x{20000}$", false], ["^needle", false], ["^missing|absent", false],
			] as const) {
				const result = await filterSessionsByRegexInWorker([item], pattern, "recent");
				expect(result.length, pattern).toBe(present ? 1 : 0);
			}
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	});


	it("bounds retained full-transcript text independent of total message count", async () => {
		const directory = mkdtempSync(join(tmpdir(), "pi-regex-memory-limit-"));
		try {
			const path = join(directory, "large.jsonl");
			writeFileSync(path, Array.from({ length: 1_000 }, (_, index) =>
				JSON.stringify({ type: "message", message: { role: "user",
					content: `line ${index} ` + "x".repeat(100) } }),
			).join("\n") + "\n");
			const fixture = { ...session("large", "x".repeat(100_000)), path };
			const incomplete: string[][] = [];
			const result = await filterSessionsByRegexInWorker([fixture], "no-match", "recent",
				undefined, (ids) => incomplete.push(ids), { maxSessionTextChars: 16_384 });
			expect(result).toEqual([]);
			expect(incomplete).toEqual([["large"]]);
			// The production cap is 16 MiB; the test uses a much smaller injected
			// cap to deterministically prove we stop retaining text past the limit.
			await expect(filterSessionsByRegexInWorker([fixture], "x", "recent",
					undefined, undefined, { maxSessionTextChars: 32 * 1024 * 1024 })).rejects.toThrow(/cap/i);
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	});

	it("preserves recent order across worker batches", async () => {
		const items = Array.from({ length: 51 }, (_, index) =>
			session(`s${index}`, index % 3 === 0 ? "match" : "miss"),
		);
		const result = await filterSessionsByRegexInWorker(items, "match", "recent");
		expect(result.map((item) => item.id)).toEqual(items.filter((_, index) => index % 3 === 0).map((item) => item.id));
	});

	it("reports an invalid expression without blocking the picker", async () => {
		await expect(filterSessionsByRegexInWorker([session("one", "x")], "(", "recent")).rejects.toThrow();
	});
});
