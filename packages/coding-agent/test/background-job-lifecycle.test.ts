import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createBackgroundJobTool } from "../src/core/tools/background-job.ts";
import { backgroundJobFolder } from "../src/core/tools/background-jobs.ts";
import { type BashToolOutput, createBashTool } from "../src/core/tools/bash.ts";

const dirs: string[] = [];
const jobs: Array<{ jobId: string; cwd: string }> = [];

afterEach(async () => {
	for (const job of jobs.splice(0)) {
		try {
			const result = await createBackgroundJobTool(job.cwd).execute("cleanup", { action: "stop", jobId: job.jobId });
			if (result.structuredContent?.status !== "running") {
				await rm(backgroundJobFolder(job.jobId), { recursive: true, force: true });
			}
		} catch {
			// Completed jobs and already-deleted records need no further cancellation.
		}
	}
	for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

async function workspace(): Promise<string> {
	const cwd = await mkdtemp(join(tmpdir(), "pi-bg-jobs-"));
	dirs.push(cwd);
	return cwd;
}

describe("background_job", () => {
	it.skipIf(process.platform === "win32")(
		"tracks successful completion without mistaking start for success",
		async () => {
			const cwd = await workspace();
			const started = await createBashTool(cwd).execute("run", {
				command: "printf 'ready\\n'; sleep 0.1; printf 'complete\\n'",
				background: true,
			});
			const output = started.structuredContent as BashToolOutput;
			expect(output.background_job_id).toMatch(/^job_[a-f0-9-]{36}$/u);
			expect(output.exit_code).toBeUndefined();
			jobs.push({ jobId: output.background_job_id!, cwd });
			const tool = createBackgroundJobTool(cwd);
			const result = await tool.execute("wait", {
				action: "wait",
				jobId: output.background_job_id,
				timeoutMs: 10_000,
			});
			expect(result.structuredContent).toMatchObject({ status: "completed", exitCode: 0 });
			const tail = await tool.execute("tail", { action: "tail", jobId: output.background_job_id });
			expect(tail.content).toEqual([{ type: "text", text: expect.stringContaining("complete") }]);
		},
	);

	it.skipIf(process.platform === "win32")("stops a running job and preserves a terminal cancellation", async () => {
		const cwd = await workspace();
		const started = await createBashTool(cwd).execute("run", { command: "sleep 30", background: true });
		const output = started.structuredContent as BashToolOutput;
		jobs.push({ jobId: output.background_job_id!, cwd });
		const tool = createBackgroundJobTool(cwd);
		await tool.execute("cancel", { action: "stop", jobId: output.background_job_id });
		const waited = await tool.execute("wait", { action: "wait", jobId: output.background_job_id, timeoutMs: 10_000 });
		expect(waited.structuredContent).toMatchObject({ status: "canceled" });
	});

	it.skipIf(process.platform === "win32")("prevents cross-workspace job access", async () => {
		const cwd = await workspace();
		const other = await workspace();
		const started = await createBashTool(cwd).execute("run", { command: "sleep 30", background: true });
		const output = started.structuredContent as BashToolOutput;
		jobs.push({ jobId: output.background_job_id!, cwd });
		await expect(
			createBackgroundJobTool(other).execute("inspect", { action: "status", jobId: output.background_job_id }),
		).rejects.toThrow(/not found|access denied/i);
		await expect(
			createBackgroundJobTool(cwd).execute("traversal", { action: "status", jobId: "../other" }),
		).rejects.toThrow(/invalid/i);
	});

	it.skipIf(process.platform === "win32")(
		"can list records from a second tool instance after the first is gone",
		async () => {
			const cwd = await workspace();
			const started = await createBashTool(cwd).execute("run", { command: "printf 'done\\n'", background: true });
			const output = started.structuredContent as BashToolOutput;
			jobs.push({ jobId: output.background_job_id!, cwd });
			const second = createBackgroundJobTool(cwd);
			const listed = await second.execute("list", { action: "list" });
			expect(listed.content[0]).toEqual({ type: "text", text: expect.stringContaining(output.background_job_id!) });
		},
	);
});
