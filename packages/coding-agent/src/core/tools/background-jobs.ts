/** Persisted, workspace-scoped identities for detached local shell runs. */
import type { Dirent } from "node:fs";
import { open, readFile, readdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { getAgentDir } from "../../config.ts";

export type BackgroundJobState = "starting" | "running" | "completed" | "failed" | "canceled" | "lost";

export type BackgroundJob = {
	id: string;
	cwd: string;
	createdAt: number;
	status: BackgroundJobState;
	pid?: number;
	exitCode?: number | null;
	signal?: string | null;
	error?: string | null;
	outputTruncated: boolean;
	updatedAt?: number;
	finishedAt?: number;
};

export type BackgroundJobOutput = {
	output: string;
	nextCursor: number;
	outputTruncated: boolean;
};

interface JobMetadata {
	version: 1;
	id: string;
	cwd: string;
	createdAt: number;
}

interface SupervisorState {
	status: "running" | "completed" | "failed" | "canceled";
	workerPid: number;
	childPid: number | null;
	exitCode?: number | null;
	signal?: string | null;
	error?: string | null;
	outputTruncated?: boolean;
	updatedAt: number;
	finishedAt?: number;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const LOST_AFTER_MS = 15_000;
const MAX_TAIL_BYTES = 65_536;
const MAX_WAIT_MS = 60_000;

/** Private storage shared across CLI restarts for ordinary local shell jobs. */
export function backgroundJobRoot(): string {
	return join(getAgentDir(), "background-jobs");
}

function folderFor(id: string): string {
	if (!UUID.test(id)) throw new Error("Unknown background job");
	return join(backgroundJobRoot(), id);
}

async function readMetadata(id: string, cwd: string): Promise<JobMetadata> {
	try {
		const meta = JSON.parse(await readFile(join(folderFor(id), "job.json"), "utf8")) as JobMetadata;
		if (meta.version !== 1 || meta.id !== id || meta.cwd !== resolve(cwd)) throw new Error("Unknown background job");
		return meta;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new Error("Unknown background job");
		throw error;
	}
}

/** Read a job's terminal outcome without interpreting its start as success. */
export async function readBackgroundJob(id: string, cwd: string): Promise<BackgroundJob> {
	const meta = await readMetadata(id, cwd);
	const base: BackgroundJob = {
		id,
		cwd: meta.cwd,
		createdAt: meta.createdAt,
		status: "starting",
		outputTruncated: false,
	};
	try {
		const state = JSON.parse(await readFile(join(folderFor(id), "state.json"), "utf8")) as SupervisorState;
		const terminal = state.status === "completed" || state.status === "failed" || state.status === "canceled";
		return {
			...base,
			status: terminal ? state.status : Date.now() - state.updatedAt > LOST_AFTER_MS ? "lost" : "running",
			...(state.childPid ? { pid: state.childPid } : {}),
			exitCode: state.exitCode,
			signal: state.signal,
			error: state.error,
			outputTruncated: state.outputTruncated ?? false,
			updatedAt: state.updatedAt,
			finishedAt: state.finishedAt,
		};
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		return { ...base, status: Date.now() - meta.createdAt > LOST_AFTER_MS ? "lost" : "starting" };
	}
}

/** Show recent jobs in the caller's workspace, without granting access to other working directories. */
export async function listBackgroundJobs(cwd: string, limit = 50): Promise<BackgroundJob[]> {
	if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error("limit must be 1-100");
	let entries: Dirent[];
	try {
		entries = await readdir(backgroundJobRoot(), { withFileTypes: true });
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
		throw error;
	}
	const jobs: BackgroundJob[] = [];
	for (const entry of entries) {
		if (!entry.isDirectory() || !UUID.test(entry.name)) continue;
		try {
			jobs.push(await readBackgroundJob(entry.name, cwd));
		} catch (error) {
			if (error instanceof Error && error.message === "Unknown background job") continue;
			throw error;
		}
	}
	return jobs.sort((a, b) => b.createdAt - a.createdAt).slice(0, limit);
}

/** Read at most 64 KiB of a bounded, private output log from an integer byte cursor. */
export async function readBackgroundJobOutput(
	id: string,
	cwd: string,
	cursor = 0,
	maxBytes = MAX_TAIL_BYTES,
): Promise<BackgroundJobOutput> {
	const job = await readBackgroundJob(id, cwd);
	if (!Number.isSafeInteger(cursor) || cursor < 0) throw new Error("Invalid background log cursor");
	if (!Number.isInteger(maxBytes) || maxBytes < 1 || maxBytes > MAX_TAIL_BYTES)
		throw new Error("maxBytes must be 1-65536");
	const outputPath = join(folderFor(id), "output.log");
	let handle: Awaited<ReturnType<typeof open>>;
	try {
		handle = await open(outputPath, "r");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT")
			return { output: "", nextCursor: cursor, outputTruncated: job.outputTruncated };
		throw error;
	}
	try {
		const size = (await handle.stat()).size;
		const buffer = Buffer.alloc(Math.min(maxBytes, Math.max(0, size - cursor)));
		const { bytesRead } = await handle.read(buffer, 0, buffer.length, cursor);
		return {
			output: buffer.subarray(0, bytesRead).toString("utf8"),
			nextCursor: cursor + bytesRead,
			outputTruncated: job.outputTruncated,
		};
	} finally {
		await handle.close();
	}
}

/** Wait only for a terminal outcome; a timeout returns the current running or starting state. */
export async function waitForBackgroundJob(
	id: string,
	cwd: string,
	timeoutMs = 30_000,
	signal?: AbortSignal,
): Promise<BackgroundJob> {
	if (!Number.isFinite(timeoutMs) || timeoutMs < 0 || timeoutMs > MAX_WAIT_MS)
		throw new Error("timeoutMs must be 0-60000");
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		signal?.throwIfAborted();
		const job = await readBackgroundJob(id, cwd);
		if (job.status !== "running" && job.status !== "starting") return job;
		const delay = Math.min(200, Math.max(0, deadline - Date.now()));
		if (delay === 0) return job;
		await new Promise((done) => setTimeout(done, delay));
	}
}

/** Ask the original detached supervisor to stop, never signal a possibly reused PID from the caller. */
export async function stopBackgroundJob(id: string, cwd: string): Promise<BackgroundJob> {
	const job = await readBackgroundJob(id, cwd);
	if (job.status === "running" || job.status === "starting") {
		try {
			await writeFile(join(folderFor(id), "cancel"), "", { flag: "wx", mode: 0o600 });
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
		}
	}
	return readBackgroundJob(id, cwd);
}
