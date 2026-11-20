import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createBackgroundJobTool } from "../src/core/tools/background-job.ts";
import {
	backgroundJobFolder,
	backgroundJobStatus,
	listBackgroundJobs,
	stopBackgroundJob,
	tailBackgroundJob,
} from "../src/core/tools/background-jobs.ts";
import { type BashToolOutput, createBashTool, createLocalBashOperations } from "../src/core/tools/bash.ts";
import { ManualBackgroundController } from "../src/core/tools/manual-background.ts";

const dirs: string[] = [];
const jobs: Array<{ jobId: string; cwd: string }> = [];

afterEach(async () => {
	for (const job of jobs.splice(0)) {
		try {
			await createBackgroundJobTool(job.cwd).execute("cleanup", { action: "stop", jobId: job.jobId });
			if ((await backgroundJobStatus(job.jobId, job.cwd)).status !== "running") {
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

	it.skipIf(process.platform === "win32")(
		"reports nonzero exits as failed results rather than successful waits",
		async () => {
			const cwd = await workspace();
			const started = await createBashTool(cwd).execute("run", { command: "exit 7", background: true });
			const output = started.structuredContent as BashToolOutput;
			jobs.push({ jobId: output.background_job_id!, cwd });
			const waited = await createBackgroundJobTool(cwd).execute("wait", {
				action: "wait",
				jobId: output.background_job_id,
				timeoutMs: 10_000,
			});
			expect(waited.structuredContent).toMatchObject({ status: "failed", exitCode: 7 });
			expect(waited.isError).toBe(true);
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

	it("tails multi-byte UTF-8 output without moving the cursor through a code point", async () => {
		const cwd = await workspace();
		const jobId = `job_${randomUUID()}`;
		const folder = backgroundJobFolder(jobId);
		await mkdir(folder, { recursive: true, mode: 0o700 });
		await writeFile(
			join(folder, "owner.json"),
			JSON.stringify({ version: 1, cwd: resolve(cwd), createdAt: Date.now() }),
		);
		await writeFile(join(folder, "output.log"), "A€B");
		jobs.push({ jobId, cwd });
		const first = await tailBackgroundJob(jobId, cwd, 0, 2);
		expect(first).toMatchObject({ text: "A", cursor: 1, more: true });
		const second = await tailBackgroundJob(jobId, cwd, first.cursor, 4);
		expect(second).toMatchObject({ text: "€B", cursor: 5, more: false });
	});

	it("places a cancellation marker for inferred lost supervisors", async () => {
		const cwd = await workspace();
		const jobId = `job_${randomUUID()}`;
		const folder = backgroundJobFolder(jobId);
		await mkdir(folder, { recursive: true, mode: 0o700 });
		await writeFile(
			join(folder, "owner.json"),
			JSON.stringify({ version: 1, cwd: resolve(cwd), createdAt: Date.now() - 60_000 }),
		);
		jobs.push({ jobId, cwd });
		await stopBackgroundJob(jobId, cwd);
		expect(await import("node:fs/promises").then((fs) => fs.readFile(join(folder, "cancel"), "utf8"))).toBe("");
	});

	it("marks a stale startup without supervisor state as lost, never completed", async () => {
		const cwd = await workspace();
		const jobId = `job_${randomUUID()}`;
		const folder = backgroundJobFolder(jobId);
		await mkdir(dirname(folder), { recursive: true, mode: 0o700 });
		await mkdir(folder, { mode: 0o700 });
		await writeFile(
			join(folder, "owner.json"),
			JSON.stringify({ version: 1, cwd: resolve(cwd), createdAt: Date.now() - 20_000 }),
			{ mode: 0o600 },
		);
		jobs.push({ jobId, cwd });
		expect(await backgroundJobStatus(jobId, cwd)).toMatchObject({ status: "lost" });
	});

	it.skipIf(process.platform === "win32")(
		"excludes live foreground commands from the job list until Ctrl+B detaches them",
		async () => {
			const cwd = await workspace();
			const controller = new ManualBackgroundController();
			controller.enable();
			const command = `${JSON.stringify(process.execPath)} -e ${JSON.stringify("setTimeout(() => {}, 2000)")}`;
			const running = createLocalBashOperations({ backgroundController: controller }).exec(command, cwd, {
				onData: () => {},
			});
			await vi.waitFor(() => expect(controller.hasActiveCommand).toBe(true), { timeout: 5_000 });
			expect(await listBackgroundJobs(cwd)).toEqual([]);
			expect(controller.backgroundCurrentCommand()).toBe(true);
			const detached = await running;
			expect(detached.background?.jobId).toMatch(/^job_[a-f0-9-]{36}$/u);
			jobs.push({ jobId: detached.background!.jobId, cwd });
			expect((await listBackgroundJobs(cwd)).map((job) => job.jobId)).toContain(detached.background!.jobId);
		},
	);
});

describe("background supervisor restart recovery", () => {
	it("does not mistake a reused supervisor PID for a running job", async () => {
		const cwd = await workspace();
		const jobId = `job_${randomUUID()}`;
		const folder = backgroundJobFolder(jobId);
		await mkdir(dirname(folder), { recursive: true, mode: 0o700 });
		await mkdir(folder, { mode: 0o700 });
		const staleAt = Date.now() - 60_000;
		await writeFile(
			join(folder, "owner.json"),
			JSON.stringify({ version: 1, cwd: resolve(cwd), createdAt: staleAt }),
			{
				mode: 0o600,
			},
		);
		await writeFile(
			join(folder, "state.json"),
			JSON.stringify({
				version: 1,
				workerPid: process.pid,
				childPid: process.pid,
				status: "running",
				updatedAt: staleAt,
			}),
			{ mode: 0o600 },
		);
		jobs.push({ jobId, cwd });
		expect(await backgroundJobStatus(jobId, cwd)).toMatchObject({ status: "lost" });
	});
});
