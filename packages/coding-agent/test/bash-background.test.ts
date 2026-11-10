import { readFile, rm } from "node:fs/promises";
import { dirname } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createBashTool, type BashOperations, type BashToolOutput } from "../src/core/tools/bash.ts";
import { killProcessTree } from "../src/utils/shell.ts";

const started: Array<{ pid: number; outputPath: string }> = [];

afterEach(async () => {
	for (const { pid, outputPath } of started.splice(0)) {
		killProcessTree(pid);
		await rm(dirname(outputPath), { recursive: true, force: true });
	}
});

describe("background shell runs", () => {
	it.skipIf(process.platform === "win32")("returns immediately with a PID and a persistent log", async () => {
		const tool = createBashTool(process.cwd());
		const script = 'process.stdout.write("ready\\n"); process.stderr.write("warning\\n"); setInterval(() => {}, 1000)';
		const result = await tool.execute("bg-1", {
			command: `${JSON.stringify(process.execPath)} -e ${JSON.stringify(script)}`,
			background: true,
		});
		const data = result.structuredContent as BashToolOutput;
		expect(data.exit_code).toBeUndefined();
		expect(data.background_pid).toBeGreaterThan(0);
		expect(data.background_output_path).toBeTruthy();
		started.push({ pid: data.background_pid!, outputPath: data.background_output_path! });
		expect(result.content).toEqual([
			{ type: "text", text: expect.stringContaining(`PID ${data.background_pid}`) },
		]);
		await vi.waitFor(async () => {
			const content = await readFile(data.background_output_path!, "utf8");
			expect(content).toContain("ready\n");
			expect(content).toContain("warning\n");
		});
	});

	it("does not silently run a background command through a remote backend", async () => {
		const operations: BashOperations = { exec: vi.fn(async () => ({ exitCode: 0 })) };
		const tool = createBashTool(process.cwd(), { operations });
		await expect(tool.execute("bg-remote", { command: "remote", background: true })).rejects.toThrow(
			/Background execution is not supported/,
		);
		expect(operations.exec).not.toHaveBeenCalled();
	});

	it("rejects a timeout on a detached background command", async () => {
		const tool = createBashTool(process.cwd());
		await expect(tool.execute("bg-timeout", { command: "echo unsafe", timeout: 1, background: true })).rejects.toThrow(
			/Cannot set a timeout for a background command/,
		);
	});

	it("never launches a background command after cancellation", async () => {
		const controller = new AbortController();
		controller.abort();
		const tool = createBashTool(process.cwd());
		await expect(tool.execute("bg-aborted", { command: "echo unwanted", background: true }, controller.signal)).rejects.toThrow(
			/aborted/,
		);
	});
});
