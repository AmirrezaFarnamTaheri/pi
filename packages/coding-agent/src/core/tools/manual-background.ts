/**
 * Detach an ALREADY-running local shell command; never restart its process or
 * start another agent. A detached supervisor preserves a capped output log,
 * while the foreground uses a separate lossless spool until Ctrl+B is pressed.
 */
import { open, readFile, rm, writeFile } from "node:fs/promises";
import { constants as osConstants } from "node:os";
import { dirname, join } from "node:path";
import {
	getShellEnv,
	killProcessTree,
	type ShellConfig,
	trackDetachedChildPid,
	untrackDetachedChildPid,
} from "../../utils/shell.ts";
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

const DETACHED = Symbol("detached");

/**
 * Stream unlimited foreground output to onData, then either wait for the real
 * exit status or release the SAME process to its detached supervisor on Ctrl+B.
 * A hung asynchronous onData must not disable abort, timeout or manual detach.
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
	if (timeout !== undefined && (!Number.isFinite(timeout) || timeout <= 0 || timeout * 1_000 > 2_147_483_647)) {
		throw new Error("Invalid timeout: must be a finite number of seconds within the supported range");
	}
	const { pid, outputPath, foregroundOutputPath } = await startBackgroundShell(
		command,
		cwd,
		shellConfig,
		options.env ?? getShellEnv(),
		prefix,
		{ captureForegroundOutput: true },
	);
	if (!foregroundOutputPath) {
		killProcessTree(pid);
		throw new Error("Detachable shell requires a lossless foreground output spool");
	}
	trackDetachedChildPid(pid);
	let requested = false;
	let completed = false;
	let resolveDetach!: (value: typeof DETACHED) => void;
	let rejectInterruption!: (error: Error) => void;
	const interruption = new Promise<typeof DETACHED>((resolve, reject) => {
		resolveDetach = resolve;
		rejectInterruption = reject;
	});
	// This can be rejected by cancellation before the first output read.
	void interruption.catch(() => {});
	const unregister = controller.register(() => {
		requested = true;
		resolveDetach(DETACHED);
	});
	const onAbort = () => rejectInterruption(new Error("aborted"));
	options.signal?.addEventListener("abort", onAbort, { once: true });
	if (options.signal?.aborted) onAbort();
	const timeoutHandle =
		timeout !== undefined
			? setTimeout(() => rejectInterruption(new Error(`timeout:${timeout}`)), timeout * 1_000)
			: undefined;
	let stream: Awaited<ReturnType<typeof open>> | undefined;
	try {
		stream = await open(foregroundOutputPath, "r");
		let offset = 0;
		for (;;) {
			if (requested) {
				await writeFile(join(dirname(outputPath), "detached"), "", { flag: "w", mode: 0o600 });
				return { exitCode: null, background: { pid, outputPath } };
			}
			if (options.signal?.aborted) throw new Error("aborted");
			const size = (await stream.stat()).size;
			while (offset < size) {
				const chunk = Buffer.allocUnsafe(Math.min(64 * 1_024, size - offset));
				const { bytesRead } = await stream.read(chunk, 0, chunk.length, offset);
				if (!bytesRead) break;
				offset += bytesRead;
				const outcome = await Promise.race([
					Promise.resolve(options.onData(chunk.subarray(0, bytesRead))),
					interruption,
				]);
				if (outcome === DETACHED) break;
			}
			if (requested) continue;
			const state = JSON.parse(await readFile(join(dirname(outputPath), "state.json"), "utf8")) as {
				status?: "running" | "completed" | "failed";
				exitCode?: number | null;
				signal?: string | null;
				error?: string | null;
				outputTruncated?: boolean;
				foregroundOutputTruncated?: boolean;
			};
			if (state.status === "completed" || state.status === "failed") {
				// outputTruncated applies ONLY to the retained background log. Foreground
				// callers received the full uncapped foreground spool instead.
				if (state.foregroundOutputTruncated) {
					throw new Error("Foreground command output was incomplete");
				}
				if (offset < (await stream.stat()).size) continue;
				completed = true;
				if (state.error) throw new Error(`Background command failed: ${state.error}`);
				if (typeof state.exitCode === "number") return { exitCode: state.exitCode };
				const signalCode = osConstants.signals[state.signal as keyof typeof osConstants.signals];
				return { exitCode: typeof signalCode === "number" ? 128 + signalCode : 1 };
			}
			const outcome = await Promise.race([
				new Promise<null>((resolve) => setTimeout(() => resolve(null), 50)),
				interruption,
			]);
			if (outcome === DETACHED) continue;
		}
	} catch (error) {
		if (!requested && !completed) killProcessTree(pid);
		throw error;
	} finally {
		unregister();
		options.signal?.removeEventListener("abort", onAbort);
		if (timeoutHandle !== undefined) clearTimeout(timeoutHandle);
		await stream?.close();
		// The supervisor has stopped writing the foreground spool on completion,
		// or observes the detached marker and closes it before continuing.
		await rm(foregroundOutputPath, { force: true }).catch(() => {});
		untrackDetachedChildPid(pid);
	}
}
