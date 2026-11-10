/** Launch local shell commands independently of Pi, capturing output in a private log. */
import { spawn } from "node:child_process";
import { closeSync, constants, openSync } from "node:fs";
import { access, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ShellConfig } from "../../utils/shell.ts";

export interface BackgroundShellResult {
	pid: number;
	outputPath: string;
}

/** Start a detached process whose output remains readable after Pi exits. */
export async function startBackgroundShell(
	command: string,
	cwd: string,
	shellConfig: ShellConfig,
	env: NodeJS.ProcessEnv,
	tempFilePrefix: string,
): Promise<BackgroundShellResult> {
	await access(cwd, constants.F_OK);
	const outputDir = await mkdtemp(join(tmpdir(), `${tempFilePrefix}-`));
	const outputPath = join(outputDir, "output.log");
	let outputFd: number;
	try {
		outputFd = openSync(outputPath, "wx", 0o600);
	} catch (error) {
		await rm(outputDir, { recursive: true, force: true });
		throw error;
	}

	try {
		const commandFromStdin = shellConfig.commandTransport === "stdin";
		const child = spawn(shellConfig.shell, commandFromStdin ? shellConfig.args : [...shellConfig.args, command], {
			cwd,
			detached: true,
			env,
			stdio: [commandFromStdin ? "pipe" : "ignore", outputFd, outputFd],
			windowsHide: true,
		});
		if (commandFromStdin) {
			child.stdin?.on("error", () => {});
			child.stdin?.end(command);
		}
		const pid = await new Promise<number>((resolve, reject) => {
			child.once("spawn", () => {
				if (child.pid === undefined) reject(new Error("Background process started without a PID"));
				else resolve(child.pid);
			});
			child.once("error", reject);
		});
		child.unref();
		return { pid, outputPath };
	} catch (error) {
		await rm(outputDir, { recursive: true, force: true });
		throw error;
	} finally {
		closeSync(outputFd);
	}
}
