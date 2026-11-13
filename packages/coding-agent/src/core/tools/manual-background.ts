/**
 * Manual handoff of an already-running local shell command. The process is launched
 * once under the existing detached shell supervisor, so Ctrl+B changes who waits
 * for it; it never restarts a test suite or starts another agent.
 */
import { open, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { killProcessTree, type ShellConfig, trackDetachedChildPid, untrackDetachedChildPid } from "../../utils/shell.ts";
import { startBackgroundShell } from "./background-shell.ts";

export interface BackgroundedProcess {
	pid: number;
	outputPath: string;
}

export class ManualBackgroundController {
	private enabled = false;
	private readonly active = new Set<() => void>();

	enable(): void {
		this.enabled = true;
	}

	disable(): void {
		this.enabled = false;
	}

	get isEnabled(): boolean {
		return this.enabled;
	}

	get hasActiveCommand(): boolean {
		return this.active.size > 0;
	}

	register(background: () => void): () => void {
		this.active.add(background);
		return () => this.active.delete(background);
	}

	backgroundCurrentCommand(): boolean {
		if (!this.enabled) return false;
		const mostRecent = [...this.active].at(-1);
		if (!mostRecent) return false;
		mostRecent();
		this.active.delete(mostRecent);
		return true;
	}
}

export interface DetachableShellOptions {
	onData: (data: Buffer) => unknown;
	signal?: AbortSignal;
	timeout?: number;
	env?: NodeJS.ProcessEnv;
}

/**
 * Stream the supervisor's capped log while foregrounded. On Ctrl+B, stop
 * awaiting that SAME child PID and leave its supervisor writing the log.
 * Aborts, timeouts and output callback errors still kill foreground jobs.
 */
export async function executeDetachableShell(
	command: string,
	cwd: string,
	shellConfig: ShellConfig,
	options: DetachableShellOptions,
	controller: ManualBackgroundController,
	prefix: string,
): Promise<{ exitCode: number | null; background?: BackgroundedProcess }> {
	if (options.signal?.aborted) throw new Error("aborted");
	const timeout = options.timeout;
	if (timeout !== undefined && (!Number.isFinite(timeout) || timeout <= 0)) {
		throw new Error("Invalid timeout: must be a finite number of seconds");
	}
	const startedAt = Date.now();
	const { pid, outputPath } = await startBackgroundShell(
		command,
		cwd,
		shellConfig,
		options.env ?? process.env,
		prefix,
	);
	trackDetachedChildPid(pid);
	let requested = false;
	let completed = false;
	const unregister = controller.register(() => {
		requested = true;
	});
	try {
		const stream = await open(outputPath, "r");
		try {
			let offset = 0;
			for (;;) {
				if (requested) {
					return { exitCode: 0, background: { pid, outputPath } };
				}
				if (options.signal?.aborted) throw new Error("aborted");
				if (timeout !== undefined && Date.now() - startedAt >= timeout * 1000) {
					throw new Error(`timeout:${timeout}`);
				}

				const size = (await stream.stat()).size;
				while (offset < size) {
					const chunk = Buffer.allocUnsafe(Math.min(64 * 1024, size - offset));
					const { bytesRead } = await stream.read(chunk, 0, chunk.length, offset);
					if (bytesRead === 0) break;
					offset += bytesRead;
					await options.onData(chunk.subarray(0, bytesRead));
					if (requested) break;
				}
				if (requested) return { exitCode: 0, background: { pid, outputPath } };

				const state = JSON.parse(await readFile(join(dirname(outputPath), "state.json"), "utf8")) as {
					status?: string;
					exitCode?: number | null;
					error?: string | null;
				};
				if (state.status === "completed" || state.status === "failed") {
					// Drain any data written just before the supervisor committed its final status.
					const finalSize = (await stream.stat()).size;
					if (offset < finalSize) continue;
					if (state.error) throw new Error(`Background command failed: ${state.error}`);
					completed = true;
					return { exitCode: state.exitCode ?? 1 };
				}
				await new Promise((resolve) => setTimeout(resolve, 50));
			}
		} finally {
			await stream.close();
		}
	} catch (error) {
		if (!requested && !completed) killProcessTree(pid);
		throw error;
	} finally {
		unregister();
		untrackDetachedChildPid(pid);
	}
}
