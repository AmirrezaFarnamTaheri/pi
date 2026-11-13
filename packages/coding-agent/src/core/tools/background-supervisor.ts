/**
 * Executable-internal shell supervisor used by standalone compiled Pi releases.
 * A compiled pi.exe does not accept Node's -e option. The normal CLI invokes this
 * internal entrypoint to supervise shell work independently of the foreground TUI.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { closeSync, openSync, readFileSync, renameSync, rmSync, writeFileSync, writeSync } from "node:fs";
import { join } from "node:path";
import type { ShellConfig } from "../../utils/shell.ts";

interface SupervisorRequest {
	command: string;
	cwd: string;
	shellConfig: ShellConfig;
	maxLogBytes: number;
}

export function runBackgroundShellSupervisor(folder: string): void {
	const requestPath = join(folder, "request.json");
	const request = JSON.parse(readFileSync(requestPath, "utf8")) as SupervisorRequest;
	rmSync(requestPath, { force: true });
	const statePath = join(folder, "state.json");
	let fd: number | undefined;
	let child: ChildProcess | undefined;
	let used = 0;
	let truncated = false;
	let done = false;

	const save = (patch: Record<string, unknown>) => {
		const state = {
			version: 1,
			workerPid: process.pid,
			childPid: child?.pid ?? null,
			outputTruncated: truncated,
			updatedAt: Date.now(),
			...patch,
		};
		const tmp = `${statePath}.${process.pid}.tmp`;
		writeFileSync(tmp, JSON.stringify(state), { mode: 0o600 });
		renameSync(tmp, statePath);
	};
	const finish = (status: "completed" | "failed", exitCode: number | null, signal: string | null, error: string | null) => {
		if (done) return;
		done = true;
		try {
			if (fd !== undefined) closeSync(fd);
			fd = undefined;
		} catch {
			// Keep writing final state when closing the log failed.
		}
		try {
			save({ status, exitCode, signal, error, finishedAt: Date.now() });
		} catch {
			process.exitCode = 1;
		}
	};
	const write = (buffer: Buffer) => {
		if (done || fd === undefined) return;
		const remaining = request.maxLogBytes - used;
		if (remaining <= 0) {
			if (buffer.length > 0) truncated = true;
			return;
		}
		const count = Math.min(remaining, buffer.length);
		let pos = 0;
		while (pos < count) {
			const n = writeSync(fd, buffer, pos, count - pos);
			if (n <= 0) throw new Error("background log write failed");
			pos += n;
		}
		used += count;
		if (buffer.length > count) truncated = true;
	};

	try {
		fd = openSync(join(folder, "output.log"), "wx", 0o600);
		const cfg = request.shellConfig;
		const fromStdin = cfg.commandTransport === "stdin";
		const started = spawn(cfg.shell, fromStdin ? cfg.args : [...cfg.args, request.command], {
			cwd: request.cwd,
			env: process.env,
			detached: process.platform !== "win32",
			stdio: [fromStdin ? "pipe" : "ignore", "pipe", "pipe"],
			windowsHide: true,
		});
		child = started;
		started.once("spawn", () => save({ status: "running", exitCode: null }));
		started.once("error", (e) => finish("failed", null, null, (e as NodeJS.ErrnoException).code ?? "spawn failed"));
		for (const stream of [started.stdout, started.stderr]) {
			if (!stream) continue;
			stream.on("data", write);
			stream.on("error", (e: NodeJS.ErrnoException) => finish("failed", null, null, e.code ?? "stream failure"));
		}
		if (fromStdin) {
			started.stdin?.on("error", () => {});
			started.stdin?.end(request.command);
		}
		started.once("exit", () => {
			const guard = setTimeout(() => {
				started.stdout?.destroy();
				started.stderr?.destroy();
			}, 1000);
			guard.unref();
		});
		started.once("close", (code, signal) => finish(code === 0 ? "completed" : "failed", code, signal, null));
	} catch (error) {
		try {
			child?.kill();
		} catch {
			// A spawn error may not have a child process to kill.
		}
		finish("failed", null, null, (error as NodeJS.ErrnoException).code ?? "supervisor failure");
	}
}
