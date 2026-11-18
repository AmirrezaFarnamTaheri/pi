import { describe, expect, it } from "vitest";
import {
	AgyAdmissionQueue,
	AgyBridge,
	classifyAgyFailure,
	parseAgyModels,
	parseQuotaResetMs,
	resolveAgyModelChain,
	runAgyProcess,
	truncateAgyOutput,
	type AgyProcessRequest,
	type AgyProcessResult,
} from "../examples/extensions/antigravity/core.ts";

describe("Antigravity CLI bridge: reusable parsing and model routing", () => {
	it("parses the old and two-column model list without status chatter", () => {
		expect(parseAgyModels("Fetching available models...\ngemini-3.7-flash\tGemini 3.7 Flash (High) (current)\nclaude-4\tClaude 4\n")).toEqual([
			{ id: "gemini-3.7-flash", name: "Gemini 3.7 Flash (High)" },
			{ id: "claude-4", name: "Claude 4" },
		]);
		expect(parseAgyModels("Gemini 3 Flash\nGemini 3 Pro (current)\n")).toEqual([
			{ name: "Gemini 3 Flash" },
			{ name: "Gemini 3 Pro" },
		]);
	});

	it("resolves wildcard versions numerically, deduplicates, and accepts a model ID", () => {
		const entries = parseAgyModels("gemini-3\tGemini 3 Flash (High)\ngemini-3.12\tGemini 3.12 Flash (High)\ngemini-3.9\tGemini 3.9 Flash (High)\n");
		expect(resolveAgyModelChain(entries, ["Gemini * Flash (High)", "Gemini 3.9 Flash (High)", "Gemini * Flash (High)"])).toEqual([
			"Gemini 3.12 Flash (High)",
			"Gemini 3.9 Flash (High)",
		]);
		expect(resolveAgyModelChain(entries, [], "gemini-3")).toEqual(["Gemini 3 Flash (High)"]);
		expect(resolveAgyModelChain(entries, [], "not-on-list")).toEqual([]);
	});

	it("handles 429 quota reset windows while distinguishing auth and provider failures", () => {
		expect(classifyAgyFailure("RESOURCE_EXHAUSTED (code 429) Resets in 1h2m3s")).toBe("quota");
		expect(parseQuotaResetMs("Resets in 1h2m3s")).toBe(3_723_000);
		expect(parseQuotaResetMs("Resets in 999999999999h")).toBeUndefined();
		expect(classifyAgyFailure("HTTP 401 invalid credentials")).toBe("auth");
		expect(classifyAgyFailure("HTTP 503 overloaded")).toBe("overloaded");
		expect(classifyAgyFailure("HTTP 400 invalid argument")).toBe("other");
	});

	it("clips delegated content without displaying an unbounded response", () => {
		expect(truncateAgyOutput("hello", 10)).toEqual({ text: "hello", truncated: false });
		const result = truncateAgyOutput("abcdefgh", 4);
		expect(result.truncated).toBe(true);
		expect(result.text).toContain("abcd");
		expect(result.text).toContain("truncated");
	});
});

describe("Antigravity CLI bridge: execution and failover", () => {
	const cwd = process.cwd();
	const successful = (stdout: string): AgyProcessResult => ({ stdout, stderr: "", exitCode: 0 });

	it("fails over to another available model only when the first fails before output", async () => {
		const calls: AgyProcessRequest[] = [];
		const bridge = new AgyBridge(
			{ preferredModels: ["Gemini 3 Flash", "Gemini 3 Pro"], outputLimit: 5, now: () => 10_000 },
			{
				exec: async (request) => {
					calls.push(request);
					if (request.args[0] === "models") return successful("Gemini 3 Flash\nGemini 3 Pro\n");
					if (request.args.includes("Gemini 3 Flash")) {
						return { stdout: "", stderr: "RESOURCE_EXHAUSTED (code 429) Resets in 5m", exitCode: 1 };
					}
					return successful("response content");
				},
				readSessionId: async () => "session-123",
			},
		);
		const result = await bridge.delegate({ prompt: "Analyze this file", cwd });
		expect(result.model).toBe("Gemini 3 Pro");
		expect(result.attempts).toEqual(["Gemini 3 Flash", "Gemini 3 Pro"]);
		expect(result.truncated).toBe(true);
		expect(result.sessionId).toBe("session-123");
		expect(calls[2]?.args).toContain("--sandbox");
		expect(calls[2]?.args).toContain("-p");
		expect(calls[2]?.args).not.toContain("--dangerously-skip-permissions");
		const second = await bridge.delegate({ prompt: "Another", cwd });
		expect(second.attempts).toEqual(["Gemini 3 Pro"]);
	});

	it("does not switch models for explicitly pinned model or replay partial output", async () => {
		let count = 0;
		const bridge = new AgyBridge(
			{ preferredModels: ["Gemini 3 Flash", "Gemini 3 Pro"] },
			{
				exec: async (req) => {
					if (req.args[0] === "models") return successful("Gemini 3 Flash\nGemini 3 Pro");
					count++;
					return { stdout: "partial answer", stderr: "HTTP 429", exitCode: 1 };
				},
			},
		);
		await expect(bridge.delegate({ prompt: "one", cwd })).rejects.toThrow(/partial output/i);
		expect(count).toBe(1);
		await expect(bridge.delegate({ prompt: "two", cwd, model: "Gemini 3 Flash" })).rejects.toThrow(/partial output/i);
		expect(count).toBe(2);
	});

	it("does not retry auth, unrelated 4xx, or opaque process failures", async () => {
		let runs = 0;
		const bridge = new AgyBridge(
			{ preferredModels: ["Gemini 3 Flash", "Gemini 3 Pro"] },
			{
				exec: async (req) => {
					if (req.args[0] === "models") return successful("Gemini 3 Flash\nGemini 3 Pro");
					runs++;
					return { stdout: "", stderr: "HTTP 401 invalid token secret-value", exitCode: 1 };
				},
			},
		);
		await expect(bridge.delegate({ prompt: "one", cwd })).rejects.toThrow(/authentication/i);
		expect(runs).toBe(1);
	});

	it("continues existing sessions and does not silently invent an id", async () => {
		const calls: AgyProcessRequest[] = [];
		const bridge = new AgyBridge({}, {
			exec: async (r) => {
				calls.push(r);
				return successful("done");
			},
			readSessionId: async () => undefined,
		});
		const result = await bridge.delegate({ prompt: "follow-up", cwd, conversationId: "saved-conversation" });
		expect(calls[1]?.args).toContain("saved-conversation");
		expect(result.sessionId).toBe("saved-conversation");
		await expect(bridge.delegate({ prompt: "x", cwd, model: "unknown model" })).rejects.toThrow(/not available/i);
	});

	it("closes child stdin so agy print mode cannot hang waiting for EOF", async () => {
		const result = await runAgyProcess({
			binary: process.execPath,
			args: ["-e", "process.stdin.on('end', () => process.stdout.write('EOF')); process.stdin.resume();"],
			cwd,
			timeoutMs: 3000,
		});
		expect(result).toEqual({ stdout: "EOF", stderr: "", exitCode: 0 });
	});

	it("bounds runaway child output instead of treating partial text as success", async () => {
		const result = await runAgyProcess({
			binary: process.execPath,
			args: ["-e", "process.stdout.write('x'.repeat(100000));"],
			cwd,
			timeoutMs: 3000,
			maxCaptureBytes: 1024,
		});
		expect(result.outputOverflow).toBe(true);
	});
});

describe("Antigravity CLI admission", () => {
	it("serializes calls and cancels queued work before it starts", async () => {
		const queue = new AgyAdmissionQueue(1, 1);
		let release: (() => void) | undefined;
		const first = queue.run(() => new Promise<void>((resolve) => { release = resolve; }));
		const signal = new AbortController();
		const queued = queue.run(async () => "should not run", signal.signal);
		await expect(queue.run(async () => "overflow")).rejects.toThrow(/queue is full/i);
		signal.abort();
		await expect(queued).rejects.toThrow(/cancelled/i);
		release?.();
		await first;
		expect(await queue.run(async () => "next")).toBe("next");
	});
});
