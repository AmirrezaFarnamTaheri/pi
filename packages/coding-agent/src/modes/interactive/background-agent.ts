/**
 * Run a draft prompt in a separate, persistent Pi session without blocking the interactive agent.
 *
 * The child is the same Pi executable (including a compiled standalone binary), not a Node
 * supervisor. Prompt text travels over stdin rather than appearing in the process command line.
 * A separate --session-dir prevents concurrent writes to the foreground transcript.
 */
import { spawn } from "node:child_process";
import { closeSync, openSync } from "node:fs";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { basename, join } from "node:path";

export interface BackgroundAgentOptions {
	cwd: string;
	agentDir: string;
	model?: { provider: string; id: string };
	thinkingLevel?: string;
	/** Override only for tests; production derives this from the running Pi executable. */
	launcher?: { executable: string; entryArgs: string[] };
}

export interface BackgroundAgentResult {
	pid: number;
	outputPath: string;
	sessionDir: string;
}

export function backgroundAgentInvocation(options: {
	executable: string;
	entryArgs: readonly string[];
	sessionDir: string;
	model?: { provider: string; id: string };
	thinkingLevel?: string;
}): { executable: string; args: string[] } {
	const args = [...options.entryArgs, "--print", "--session-dir", options.sessionDir];
	if (options.model) args.push("--model", `${options.model.provider}/${options.model.id}`);
	if (options.thinkingLevel) args.push("--thinking", options.thinkingLevel);
	return { executable: options.executable, args };
}

function currentPiLauncher(): { executable: string; entryArgs: string[] } {
	const executable = process.execPath;
	const runtime = basename(executable).toLowerCase();
	// In a Bun-compiled release process.execPath is the pi binary itself. In a
	// source/npm invocation, preserve Node/Bun loader flags and the CLI entrypoint.
	if (["node", "node.exe", "bun", "bun.exe"].includes(runtime)) {
		const entry = process.argv[1];
		if (!entry || entry.startsWith("-")) {
			throw new Error("Cannot start a background Pi agent without a CLI entrypoint");
		}
		return { executable, entryArgs: [...process.execArgv, entry] };
	}
	return { executable, entryArgs: [] };
}

/** Start a detached, independent agent; the foreground session keeps working. */
export async function startBackgroundAgent(\n  prompt: string,\n  options: BackgroundAgentOptions,\n): Promise<BackgroundAgentResult> {
	if (!prompt.trim()) throw new Error("Cannot background an empty prompt");
	const root = join(options.agentDir, "background-tasks");
	await mkdir(root, { recursive: true, mode: 0o700 });
	const folder = await mkdtemp(join(root, "task-"));
	const sessionDir = join(folder, "sessions");
	const outputPath = join(folder, "output.log");
	let fd: number | undefined;
	try {
		await mkdir(sessionDir, { mode: 0o700 });
		fd = openSync(outputPath, "wx", 0o600);
		const launcher = options.launcher ?? currentPiLauncher();
		const { executable, args } = backgroundAgentInvocation({
			...launcher,
			sessionDir,
			...(options.model ? { model: options.model } : {}),
			...(options.thinkingLevel ? { thinkingLevel: options.thinkingLevel } : {}),
		});
		const child = spawn(executable, args, {
			cwd: options.cwd,
			env: process.env,
			detached: true,
			windowsHide: true,
			stdio: ["pipe", fd, fd],
		});
		await new Promise<void>((resolve, reject) => {
			child.once("spawn", resolve);
			child.once("error", reject);
		});
		if (!child.pid) throw new Error("Pi background agent did not receive a process ID");
		// Deliberately do not write the task prompt to any file or argv.
		child.stdin.on("error", () => {}); // a failed child is reported in its log
		child.stdin.end(prompt + "\n");
		child.unref();
		return { pid: child.pid, outputPath, sessionDir };
	} catch (error) {
		await rm(folder, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
		throw error;
	} finally {
		if (fd !== undefined) closeSync(fd);
	}
}
