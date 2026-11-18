import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	listBackgroundJobs,
	readBackgroundJob,
	readBackgroundJobOutput,
	stopBackgroundJob,
	waitForBackgroundJob,
} from "../src/core/tools/background-jobs.ts";
import { createBashTool } from "../src/core/tools/bash.ts";

const dirs: string[] = [];

afterEach(async () => {
	for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

describe("managed local shell background jobs", () => {
	it.skipIf(process.platform === "win32")("inspects a completed job", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "pi-job-done-"));
		dirs.push(cwd);
		const cmd = `${JSON.stringify(process.execPath)} -e ${JSON.stringify('process.stdout.write("hello\\n")')}`;
		const result = await createBashTool(cwd).execute("job-success", { command: cmd, background: true });
		const data = result.structuredContent as {
			background_job_id: string;
			background_pid: number;
			exit_code?: number;
		};
		expect(data.background_job_id).toMatch(/^[0-9a-f-]{36}$/);
		expect(data.exit_code).toBeUndefined();
		const finished = await waitForBackgroundJob(data.background_job_id, cwd, 10000);
		expect(finished.status).toBe("completed");
		expect(finished.exitCode).toBe(0);
		const output = await readBackgroundJobOutput(data.background_job_id, cwd, 0, 100);
		expect(output.output).toContain("hello");
		expect(output.nextCursor).toBeGreaterThan(0);
		expect((await listBackgroundJobs(cwd)).some((job) => job.id === data.background_job_id)).toBe(true);
	});

	it.skipIf(process.platform === "win32")("reports nonzero exits as failed, never as completed", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "pi-job-fail-"));
		dirs.push(cwd);
		const result = await createBashTool(cwd).execute("job-failed", {
			command: `${JSON.stringify(process.execPath)} -e ${JSON.stringify("process.exit(13)")}`,
			background: true,
		});
		const { background_job_id } = result.structuredContent as { background_job_id: string };
		const terminal = await waitForBackgroundJob(background_job_id, cwd, 10000);
		expect(terminal.status).toBe("failed");
		expect(terminal.exitCode).toBe(13);
		await expect(readBackgroundJob(background_job_id, join(cwd, "unrelated"))).rejects.toThrow(
			/Unknown background job/,
		);
	});

	it.skipIf(process.platform === "win32")("cancels through the original supervisor and stays canceled", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "pi-job-stop-"));
		dirs.push(cwd);
		const result = await createBashTool(cwd).execute("job-cancel", {
			command: `${JSON.stringify(process.execPath)} -e ${JSON.stringify("setInterval(() => {}, 1000)")}`,
			background: true,
		});
		const { background_job_id } = result.structuredContent as { background_job_id: string };
		await stopBackgroundJob(background_job_id, cwd);
		const terminal = await waitForBackgroundJob(background_job_id, cwd, 10000);
		expect(terminal.status).toBe("canceled");
		expect((await stopBackgroundJob(background_job_id, cwd)).status).toBe("canceled");
	});

	it("rejects forged or unknown handles without reading or killing a PID", async () => {
		await expect(readBackgroundJob("../../etc/passwd", process.cwd())).rejects.toThrow(/Unknown background job/);
		await expect(stopBackgroundJob("00000000-0000-4000-8000-000000000000", process.cwd())).rejects.toThrow(
			/Unknown background job/,
		);
	});
});
