import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createLocalBashOperations } from "../src/core/tools/bash.ts";
import { ManualBackgroundController } from "../src/core/tools/manual-background.ts";
import { killProcessTree } from "../src/utils/shell.ts";

describe("Ctrl+B running-command backgrounding", () => {
	it("does not background a command when there is no active local process", () => {
		const controller = new ManualBackgroundController();
		controller.enable();
		expect(controller.backgroundCurrentCommand()).toBe(false);
	});

	it.skipIf(process.platform === "win32")("detaches the SAME running test process, leaves it executing, and retains its output log", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "pi-detach-test-"));
		const marker = join(cwd, "started.txt");
		const controller = new ManualBackgroundController();
		controller.enable();
		const output: string[] = [];
		let pid: number | undefined;
		try {
			const script = [
				"const fs = require('node:fs');",
				`fs.appendFileSync(${JSON.stringify(marker)}, 'started\\n');`,
				"process.stdout.write('first\\n');",
				"setTimeout(() => { process.stdout.write('finished\\n'); }, 600);",
			].join(" ");
			const running = createLocalBashOperations({ backgroundController: controller }).exec(
				`${JSON.stringify(process.execPath)} -e ${JSON.stringify(script)}`,
				cwd,
				{ onData: (chunk) => output.push(chunk.toString()) },
			);
			await vi.waitFor(() => expect(controller.hasActiveCommand).toBe(true));
			expect(controller.backgroundCurrentCommand()).toBe(true);
			const result = await running;
			expect(result.background).toBeDefined();
			pid = result.background?.pid;
			expect(pid).toBeGreaterThan(0);
			expect(result.background?.outputPath).toBeTruthy();
			await vi.waitFor(async () => {
				const log = await readFile(result.background!.outputPath, "utf8");
				expect(log).toContain("finished");
			}, { timeout: 8000 });
			expect(await readFile(marker, "utf8")).toBe("started\\n");
			expect(controller.hasActiveCommand).toBe(false);
		} finally {
			if (pid) killProcessTree(pid);
			await rm(cwd, { recursive: true, force: true });
		}
	});

	it("does not enable detachment for a noninteractive command", async () => {
		const controller = new ManualBackgroundController();
		const operations = createLocalBashOperations({ backgroundController: controller });
		const result = await operations.exec("echo completed", process.cwd(), { onData: () => {} });
		expect(result.exitCode).toBe(0);
		expect(result.background).toBeUndefined();
		expect(controller.backgroundCurrentCommand()).toBe(false);
	});
});
