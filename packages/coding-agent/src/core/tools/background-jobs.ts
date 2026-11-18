/** Workspace-scoped records for detached local shell commands. No command or credentials are persisted. */
import { access, open, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { backgroundJobsRoot } from "./background-shell.ts";

export type BackgroundJobStatus = "starting" | "running" | "completed" | "failed" | "canceled" | "lost";

interface JobOwner {
	version: 1;
	cwd: string;
	createdAt: number;
	captureForegroundOutput?: boolean;
}

interface SupervisorState {
	workerPid?: number;
	childPid?: number | null;
	status?: "running" | "completed" | "failed" | "canceled";
	exitCode?: number | null;
	signal?: string | null;
	error?: string | null;
	updatedAt?: number;
	finishedAt?: number;
	outputTruncated?: boolean;
}

export type BackgroundJobState = {
	jobId: string;
	status: BackgroundJobStatus;
	pid: number | null;
	exitCode: number | null;
	signal: string | null;
	error: string | null;
	createdAt: number;
	updatedAt: number;
	finishedAt: number | null;
	outputTruncated: boolean;
};

const JOB_ID = /^job_[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u;
const FINISHED = new Set<BackgroundJobStatus>(["completed", "failed", "canceled", "lost"]);
const RETAIN_FINISHED_MS = 7 * 24 * 60 * 60 * 1000;
/** A reused PID never proves that a stopped supervisor is still running. */
const SUPERVISOR_HEARTBEAT_STALE_MS = 30_000;

/** Resolve only registry-owned IDs; arbitrary log paths and PIDs are never accepted. */
export function backgroundJobFolder(jobId: string): string {
	if (!JOB_ID.test(jobId)) throw new Error("Invalid background job ID");
	return join(backgroundJobsRoot(), jobId);
}

async function ownerOf(jobId: string, cwd: string): Promise<{ folder: string; owner: JobOwner }> {
	const folder = backgroundJobFolder(jobId);
	let owner: JobOwner;
	try {
		owner = JSON.parse(await readFile(join(folder, "owner.json"), "utf8")) as JobOwner;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT")
			throw new Error("Background job not found or access denied");
		throw error;
	}
	if (owner.version !== 1 || owner.cwd !== resolve(cwd)) throw new Error("Background job not found or access denied");
	return { folder, owner };
}

function alive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
}

/** Read the supervisor's durable terminal result; a disappeared worker never becomes success. */
export async function backgroundJobStatus(jobId: string, cwd: string): Promise<BackgroundJobState> {
	const { folder, owner } = await ownerOf(jobId, cwd);
	let state: SupervisorState;
	try {
		state = JSON.parse(await readFile(join(folder, "state.json"), "utf8")) as SupervisorState;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		state = {};
	}
	const status: BackgroundJobStatus = state.status
		? state.status === "running" &&
			(!state.workerPid ||
				!alive(state.workerPid) ||
				Date.now() - (state.updatedAt ?? owner.createdAt) >= SUPERVISOR_HEARTBEAT_STALE_MS)
			? "lost"
			: state.status
		: Date.now() - owner.createdAt >= 10_000
			? "lost"
			: "starting";
	return {
		jobId,
		status,
		pid: state.childPid ?? null,
		exitCode: state.exitCode ?? null,
		signal: state.signal ?? null,
		error: state.error ?? null,
		createdAt: owner.createdAt,
		updatedAt: state.updatedAt ?? owner.createdAt,
		finishedAt: state.finishedAt ?? null,
		outputTruncated: state.outputTruncated ?? false,
	};
}

/** List recent jobs from this workspace only, pruning old completed records, never active ones. */
export async function listBackgroundJobs(cwd: string, limit = 25): Promise<BackgroundJobState[]> {
	const root = backgroundJobsRoot();
	let names: string[];
	try {
		names = await readdir(root);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
		throw error;
	}
	const jobs: BackgroundJobState[] = [];
	for (const name of names) {
		if (!JOB_ID.test(name)) continue;
		try {
			const { folder, owner } = await ownerOf(name, cwd);
			// Foreground commands are only managed jobs after Ctrl+B creates the detach marker.
			if (owner.captureForegroundOutput) {
				try {
					await access(join(folder, "detached"));
				} catch (error) {
					if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
					throw error;
				}
			}
			const job = await backgroundJobStatus(name, cwd);
			if (FINISHED.has(job.status) && Date.now() - (job.finishedAt ?? job.updatedAt) > RETAIN_FINISHED_MS) {
				await rm(join(root, name), { recursive: true, force: true });
				continue;
			}
			jobs.push(job);
		} catch (error) {
			if (error instanceof Error && /not found or access denied/.test(error.message)) continue;
			throw error;
		}
	}
	return jobs.sort((a, b) => b.createdAt - a.createdAt).slice(0, Math.max(1, Math.min(100, Math.floor(limit))));
}

/** Return a bounded UTF-8 output chunk and byte cursor, never a caller-supplied path. */
export async function tailBackgroundJob(
	jobId: string,
	cwd: string,
	cursor = 0,
	maxBytes = 16_384,
): Promise<{ text: string; cursor: number; more: boolean; truncated: boolean }> {
	const { folder } = await ownerOf(jobId, cwd);
	if (!Number.isSafeInteger(cursor) || cursor < 0) throw new Error("Invalid background log cursor");
	const sizeLimit = Math.max(1, Math.min(65_536, Math.floor(maxBytes)));
	const output = join(folder, "output.log");
	const handle = await open(output, "r");
	try {
		const size = (await handle.stat()).size;
		const start = Math.min(cursor, size);
		const bytes = Math.min(sizeLimit, size - start);
		const buffer = Buffer.alloc(bytes);
		const { bytesRead } = await handle.read(buffer, 0, bytes, start);
		const state = await backgroundJobStatus(jobId, cwd);
		return {
			text: buffer.subarray(0, bytesRead).toString("utf8"),
			cursor: start + bytesRead,
			more: start + bytesRead < size,
			truncated: state.outputTruncated,
		};
	} finally {
		await handle.close();
	}
}

/** Await a terminal result without changing the underlying run or claiming success on timeout. */
export async function waitBackgroundJob(
	jobId: string,
	cwd: string,
	timeoutMs = 30_000,
	signal?: AbortSignal,
): Promise<BackgroundJobState> {
	if (!Number.isFinite(timeoutMs) || timeoutMs < 0 || timeoutMs > 120_000)
		throw new Error("Invalid background wait timeout");
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		if (signal?.aborted) throw new Error("Background wait aborted");
		const current = await backgroundJobStatus(jobId, cwd);
		if (FINISHED.has(current.status) || Date.now() >= deadline) return current;
		await new Promise<void>((resolve) => setTimeout(resolve, Math.min(100, deadline - Date.now())));
	}
}

/** Request cancellation through the exact supervisor's private marker, not a reusable PID. */
export async function stopBackgroundJob(jobId: string, cwd: string): Promise<BackgroundJobState> {
	const { folder } = await ownerOf(jobId, cwd);
	const current = await backgroundJobStatus(jobId, cwd);
	if (FINISHED.has(current.status)) return current;
	try {
		await writeFile(join(folder, "cancel"), "", { flag: "wx", mode: 0o600 });
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
	}
	return waitBackgroundJob(jobId, cwd, 10_000);
}
