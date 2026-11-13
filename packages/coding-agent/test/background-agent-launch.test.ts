import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { backgroundAgentInvocation, startBackgroundAgent } from "../src/modes/interactive/background-agent.ts";

describe("independent background agent invocation", () => {
	it("executes the installed standalone binary directly, without reusing the interactive session", () => {
		const launched = backgroundAgentInvocation({
			executable: "C:\\Users\\Test\\Apps\\pi\\pi.exe",
			entryArgs: [],
			sessionDir: "C:\\jobs\\task-1\\sessions",
			model: { provider: "openai", id: "some-model" },
			thinkingLevel: "medium",
		});
		expect(launched.args).toEqual([
			"--print", "--session-dir", "C:\\jobs\\task-1\\sessions",
			"--model", "openai/some-model", "--thinking", "medium",
		]);
		expect(launched.args).not.toContain("--continue");
		expect(launched.args).not.toContain("--session");
	});

	it("launches in the same working directory, pipes the prompt privately, and persists output", async () => {
		const agentDir = await mkdtemp(join(tmpdir(), "pi-background-agent-test-"));
		const fakeCli = join(agentDir, "fake-cli.cjs");
		await writeFile(fakeCli, [
			"const chunks = [];",
			"process.stdin.setEncoding('utf8');",
			"process.stdin.on('data', chunk => chunks.push(chunk));",
			"process.stdin.on('end', () => {",
			"  console.log('PROMPT=' + chunks.join('').trim());",
			"  console.log('CWD=' + process.cwd());",
			"  console.log('ARGS=' + process.argv.slice(2).join(' '));",
			"});",
		].join("\n"));
		try {
			const result = await startBackgroundAgent("investigate tests", {
				cwd: agentDir,
				agentDir,
				launcher: { executable: process.execPath, entryArgs: [fakeCli] },
			});
			expect(result.pid).toBeGreaterThan(0);
			expect(result.outputPath).toContain("background-tasks");
			await vi.waitFor(async () => {
				const log = await readFile(result.outputPath, "utf8");
				expect(log).toContain("PROMPT=investigate tests");
				expect(log).toContain("CWD=" + agentDir);
				expect(log).toContain("--print --session-dir");
			}, { timeout: 8000 });
		} finally {
			await rm(agentDir, { recursive: true, force: true, maxRetries: 4, retryDelay: 50 });
		}
	});

	it("does not launch an empty prompt", async () => {
		await expect(startBackgroundAgent("  ", { cwd: process.cwd(), agentDir: tmpdir() }))
			.rejects.toThrow(/empty/i);
	});
});
