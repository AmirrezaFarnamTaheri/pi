import { readFile, rm } from "node:fs/promises";
import { dirname } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type BackgroundJobToolOutput, createBackgroundJobTool } from "../src/core/tools/background-job.ts";
import { type BashToolOutput, createBashTool } from "../src/core/tools/bash.ts";
import { killProcessTree } from "../src/utils/shell.ts";

const started: Array<{ pid: number; outputPath: string }> = [];
afterEach(async () => {
	for (const job of started.splice(0)) {
		killProcessTree(job.pid);
		await rm(dirname(job.outputPath), { recursive: true, force: true });
	}
});

/** Spawn real local work; each test cleans its own supervisor and log directory. */
async function start(cwd: string, script: string) {
	const bash = createBashTool(cwd);
	const result = await bash.execute("start", {
		command: `${JSON.stringify(process.execPath)} -e ${JSON.stringify(script)}`,
		background: true,
	});
	const output = result.structuredContent as BashToolOutput;
	expect(output.background_pid).toBeGreaterThan(0);
	expect(output.background_job_id).toMatch(/^pi-bash-[a-zA-Z0-9]{6}$/);
	started.push({ pid: output.background_pid!, outputPath: output.background_output_path! });
	return output.background_job_id!;
}

describe("background_job lifecycle", () => {
	it.skipIf(process.platform === "win32")("returns a stable job ID and persists a completed exit code", async () => {
		const cwd = process.cwd();
		const jobId = await start(cwd, 'process.stdout.write("ready\\n")');
		const tool = createBackgroundJobTool(cwd);
		const finished = await tool.execute("wait", { action: "wait", job_id: jobId, timeout_ms: 10_000 });
		const info = finished.structuredContent as BackgroundJobToolOutput;
		expect(info.status).toBe("completed");
		expect(info.exit_code).toBe(0);
		expect(info.job_id).toBe(jobId);
		const log = await tool.execute("tail", { action: "tail", job_id: jobId });
		expect((log.structuredContent as BackgroundJobToolOutput).output).toContain("ready");
	});

	it.skipIf(process.platform === "win32")("uses a scoped job ID rather than a caller-supplied PID or path", async () => {
		const cwd = process.cwd();
		const jobId = await start(cwd, 'setInterval(() => {}, 1000)');
		const wrongScope = createBackgroundJobTool(dirname(cwd));
		await expect(wrongScope.execute("wrong", { action: "status", job_id: jobId })).rejects.toThrow(
			/unauthorized|not found/i,
		);
		const tool = createBackgroundJobTool(cwd);
		await expect(tool.execute("path", { action: "status", job_id: "../state.json" })).rejects.toThrow();
		const listed = await tool.execute("list", { action: "list" });
		expect((listed.structuredContent as BackgroundJobToolOutput).jobs?.some((job) => job.job_id === jobId)).toBe(true);
	});

	it.skipIf(process.platform === "win32")("times out without claiming success, then cancels the original process", async () => {
		const cwd = process.cwd();
		const jobId = await start(cwd, 'setInterval(() => {}, 1000)');
		const tool = createBackgroundJobTool(cwd);
		const waiting = await tool.execute("wait", { action: "wait", job_id: jobId, timeout_ms: 20 });
		const pending = waiting.structuredContent as BackgroundJobToolOutput;
		expect(pending.status).toBe("running");
		expect(pending.timed_out).toBe(true);
		await tool.execute("cancel", { action: "stop", job_id: jobId });
		const ended = await tool.execute("done", { action: "wait", job_id: jobId, timeout_ms: 10_000 });
		expect((ended.structuredContent as BackgroundJobToolOutput).status).toBe("canceled");
		const again = await tool.execute("again", { action: "stop", job_id: jobId });
		expect((again.structuredContent as BackgroundJobToolOutput).status).toBe("canceled");
	});

	it.skipIf(process.platform === "win32")("tails bounded chunks using a stable byte cursor", async () => {
		const cwd = process.cwd();
		const jobId = await start(cwd, 'process.stdout.write("abcdefghijklmnopqrstuv")');
		const tool = createBackgroundJobTool(cwd);
		await tool.execute("wait", { action: "wait", job_id: jobId, timeout_ms: 10_000 });
		const first = await tool.execute("tail", { action: "tail", job_id: jobId, cursor: 0, max_bytes: 8 });
		const firstData = first.structuredContent as BackgroundJobToolOutput;
		expect(firstData.output).toBe("abcdefgh");
		expect(firstData.next_cursor).toBe(8);
		const second = await tool.execute("tail", { action: "tail", job_id: jobId, cursor: 8, max_bytes: 8 });
		expect((second.structuredContent as BackgroundJobToolOutput).output).toBe("ijklmnop");
	});
});
