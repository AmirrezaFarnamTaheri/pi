/**
 * Supervisor for compiled standalone Pi binaries. An independently running
 * child writes bounded background output and (only while attached) a separate
 * lossless foreground spool for the TUI's streaming shell callbacks.
 */
import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import {
	closeSync,
	existsSync,
	openSync,
	readFileSync,
	renameSync,
	rmSync,
	writeFileSync,
	writeSync,
} from "node:fs";
import { join } from "node:path";
import type { ShellConfig } from "../../utils/shell.ts";

interface SupervisorRequest {
	command: string;
	cwd: string;
	shellConfig: ShellConfig;
	maxLogBytes: number;
	captureForegroundOutput?: boolean;
}

export function runBackgroundShellSupervisor(folder: string): void {
	const requestPath = join(folder, "request.json");
	const request = JSON.parse(readFileSync(requestPath, "utf8")) as SupervisorRequest;
	rmSync(requestPath, { force: true });
	const statePath = join(folder, "state.json");
	const detachedPath = join(folder, "detached");
	const foregroundPath = join(folder, "foreground.log");
	let fd: number | undefined;
	let foregroundFd: number | undefined;
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
			foregroundOutputTruncated: false,
			updatedAt: Date.now(),
			...patch,
		};
		const temporary = `${statePath}.${process.pid}.tmp`;
		writeFileSync(temporary, JSON.stringify(state), { mode: 0o600 });
		renameSync(temporary, statePath);
	};
	const closeForeground = () => {
		if (foregroundFd !== undefined) {
			closeSync(foregroundFd);
			foregroundFd = undefined;
		}
	};
	const finish = (
		status: "completed" | "failed",
		exitCode: number | null,
		signal: string | null,
		error: string | null,
	) => {
		if (done) return;
		done = true;
		try {
			if (fd !== undefined) closeSync(fd);
			fd = undefined;
			closeForeground();
		} catch {
			// Even a closing error must not prevent final-state reporting.
		}
		try {
			save({ status, exitCode, signal, error, finishedAt: Date.now() });
		} catch {
			process.exitCode = 1;
		}
	};
	const stopChildTree = () => {
		const pid = child?.pid;
		if (!pid) return;
		try {
			if (process.platform === "win32") {
				spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], { windowsHide: true });
			} else {
				process.kill(-pid, "SIGKILL");
			}
		} catch {
			child?.kill();
		}
	};
	const fail = (error: unknown) => {
		if (done) return;
		stopChildTree();
		const message = error instanceof Error ? error.message : String(error);
		finish("failed", null, null, message);
	};
	const writeFully = (target: number, buffer: Buffer, count: number) => {
		let offset = 0;
		while (offset < count) {
			const written = writeSync(target, buffer, offset, count - offset);
			if (written <= 0) throw new Error("Background output write failed");
			offset += written;
		}
	};
	const write = (buffer: Buffer) => {
		if (done) return;
		if (foregroundFd !== undefined) {
			if (existsSync(detachedPath)) {
				closeForeground();
			} else {
				// This path stays lossless while a command remains foregrounded.
				writeFully(foregroundFd, buffer, buffer.length);
			}
		}
		if (fd === undefined) return;
		const remaining = request.maxLogBytes - used;
		if (remaining <= 0) {
			if (buffer.length) truncated = true;
			return;
		}
		const count = Math.min(remaining, buffer.length);
		writeFully(fd, buffer, count);
		used += count;
		if (buffer.length > count) truncated = true;
	};

	try {
		fd = openSync(join(folder, "output.log"), "wx", 0o600);
		if (request.captureForegroundOutput) foregroundFd = openSync(foregroundPath, "wx", 0o600);
		const shell = request.shellConfig;
		const fromStdin = shell.commandTransport === "stdin";
		const started = spawn(shell.shell, fromStdin ? shell.args : [...shell.args, request.command], {
			cwd: request.cwd,
			env: process.env,
			detached: process.platform !== "win32",
			stdio: [fromStdin ? "pipe" : "ignore", "pipe", "pipe"],
			windowsHide: true,
		});
		child = started;
		started.once("spawn", () => {
			try {
				save({ status: "running", exitCode: null });
			} catch (error) {
				fail(error);
			}
		});
		started.once("error", fail);
		for (const stream of [started.stdout, started.stderr]) {
			if (!stream) continue;
			stream.on("data", (buffer: Buffer) => {
				try {
					write(buffer);
				} catch (error) {
					fail(error);
				}
			});
			stream.on("error", fail);
		}
		if (fromStdin) {
			started.stdin?.on("error", fail);
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
		fail(error);
	}
}
