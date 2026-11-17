/** Inspect and control ordinary local shell jobs without trusting caller-supplied paths or PIDs. */
import { lstat, open, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { JsonValue } from "@earendil-works/pi-ai";
import { type Static, Type } from "typebox";
import type { ExtensionContext, ToolDefinition } from "../extensions/types.ts";
import { backgroundJobScope } from "./background-shell.ts";
import { type TypeBoxAgentTool, wrapToolDefinition } from "./tool-definition-wrapper.ts";

const jobSchema = Type.Object({
	action: Type.Union([
		Type.Literal("list"),
		Type.Literal("status"),
		Type.Literal("tail"),
		Type.Literal("wait"),
		Type.Literal("stop"),
	]),
	job_id: Type.Optional(Type.String({ description: "Opaque job ID returned by bash or PowerShell" })),
	cursor: Type.Optional(Type.Number({ description: "Byte cursor for tail; omit to read the most recent output" })),
	max_bytes: Type.Optional(Type.Number({ description: "Maximum bytes for tail (1-65536; default 16384)" })),
	timeout_ms: Type.Optional(Type.Number({ description: "Maximum wait time in milliseconds (0-120000)" })),
	limit: Type.Optional(Type.Number({ description: "Maximum list entries (1-50; default 20)" })),
});
export type BackgroundJobToolInput = Static<typeof jobSchema>;
export type BackgroundJobState = "running" | "completed" | "failed" | "canceled" | "lost";
export type BackgroundJobStatus = {
	job_id: string;
	status: BackgroundJobState;
	created_at: number;
	updated_at: number;
	exit_code?: number | null;
	output_truncated: boolean;
};
export interface BackgroundJobToolOutput {
	job_id?: string;
	status?: BackgroundJobState;
	exit_code?: number | null;
	jobs?: BackgroundJobStatus[];
	output?: string;
	next_cursor?: number;
	output_truncated?: boolean;
	timed_out?: boolean;
	cancel_requested?: boolean;
}
interface StoredState {
	version: number;
	jobId: string;
	scope: string;
	createdAt: number;
	updatedAt: number;
	status: "running" | "completed" | "failed" | "canceled";
	exitCode?: number | null;
	outputTruncated: boolean;
	error?: string | null;
}
const JOB_ID = /^pi-(?:bash|powershell|shell)-[a-zA-Z0-9]{6}$/u;
const TERMINAL = new Set<BackgroundJobState>(["completed", "failed", "canceled", "lost"]);
const MAX_TAIL = 65_536;
const DEFAULT_TAIL = 16_384;
const STALE_MS = 10_000;

/** Read the supervisor's atomic checkpoint only within the requesting workspace. */
async function inspect(jobId: string, cwd: string): Promise<{ folder: string; info: BackgroundJobStatus }> {
	if (!JOB_ID.test(jobId)) throw new Error("Invalid background job ID");
	const folder = join(tmpdir(), jobId);
	const directory = await lstat(folder);
	if (!directory.isDirectory() || (directory.mode & 0o077) !== 0) throw new Error("Unsafe background job directory");
	if (process.getuid && directory.uid !== process.getuid()) throw new Error("Background job not found in this workspace");
	const file = join(folder, "state.json");
	const checkpoint = await lstat(file);
	if (!checkpoint.isFile()) throw new Error("Unsafe background job state file");
	// state.json is a local supervisor checkpoint and a filesystem trust boundary.
	const state = JSON.parse(await readFile(file, "utf8")) as StoredState;
	if (state.version !== 2 || state.jobId !== jobId || state.scope !== backgroundJobScope(cwd)) {
		throw new Error("Background job not found in this workspace");
	}
	if (!["running", "completed", "failed", "canceled"].includes(state.status)) {
		throw new Error("Invalid background job state");
	}
	const status: BackgroundJobState =
		state.status === "running" && Date.now() - state.updatedAt > STALE_MS ? "lost" : state.status;
	return {
		folder,
		info: {
			job_id: jobId,
			status,
			created_at: state.createdAt,
			updated_at: state.updatedAt,
			...(state.exitCode === undefined ? {} : { exit_code: state.exitCode }),
			output_truncated: state.outputTruncated,
		},
	};
}

async function list(cwd: string, limit: number): Promise<BackgroundJobStatus[]> {
	const names = await readdir(tmpdir());
	const jobs: BackgroundJobStatus[] = [];
	for (const name of names) {
		if (!JOB_ID.test(name)) continue;
		try {
			jobs.push((await inspect(name, cwd)).info);
		} catch (error) {
			// A private job can belong to another workspace or have finished cleanup mid-list.
			if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
			if (error instanceof Error && error.message === "Background job not found in this workspace") continue;
			throw error;
		}
	}
	return jobs.toSorted((a, b) => b.created_at - a.created_at).slice(0, limit);
}

async function tail(folder: string, cursor: number | undefined, maxBytes: number): Promise<{ output: string; cursor: number }> {
	const file = join(folder, "output.log");
	const fileInfo = await lstat(file);
	if (!fileInfo.isFile()) throw new Error("Unsafe background output log");
	const reader = await open(file, "r");
	try {
		const size = (await reader.stat()).size;
		const start = cursor ?? Math.max(0, size - maxBytes);
		const bytes = Math.min(maxBytes, Math.max(0, size - start));
		const buffer = Buffer.alloc(bytes);
		const { bytesRead } = await reader.read(buffer, 0, bytes, start);
		return { output: buffer.subarray(0, bytesRead).toString("utf8"), cursor: start + bytesRead };
	} finally {
		await reader.close();
	}
}

/** Return a JSON-compatible payload without optional undefined keys from branch unions. */
function reply(text: string, data: Record<string, JsonValue>) {
	return { content: [{ type: "text" as const, text }], details: undefined, structuredContent: data };
}

/** The host keeps running jobs independent of a tool invocation; waiting never starts another process. */
export function createBackgroundJobToolDefinition(cwd: string): ToolDefinition<typeof jobSchema> {
	return {
		name: "background_job",
		label: "background_job",
		description:
			"List, inspect, tail, wait for, or stop local background shell jobs. Use the opaque background_job_id returned by bash or PowerShell. A running job is not successful until it has completed with exit code 0. Never pass a PID or path as a job ID.",
		promptSnippet: "Inspect and manage ordinary local background shell jobs",
		promptGuidelines: [
			"Use background_job wait or status to verify a required background result before using it or claiming success.",
			"Use background_job tail for bounded incremental output; stop is idempotent and does not restart work.",
		],
		parameters: jobSchema,
		async execute(_toolCallId, params, signal?: AbortSignal, _onUpdate?, ctx?: ExtensionContext) {
			const currentCwd = ctx?.cwd || cwd;
			if (signal?.aborted) throw new Error("Background job operation aborted");
			if (params.action === "list") {
				const limit = params.limit ?? 20;
				if (!Number.isSafeInteger(limit) || limit < 1 || limit > 50)
					throw new Error("Invalid background job limit");
				const jobs = await list(currentCwd, limit);
				return reply(
					jobs.length ? jobs.map((job) => `${job.job_id}: ${job.status}`).join("\n") : "(no background jobs)",
					{
						jobs: jobs.map((job) => ({
							job_id: job.job_id,
							status: job.status,
							created_at: job.created_at,
							updated_at: job.updated_at,
							exit_code: job.exit_code ?? null,
							output_truncated: job.output_truncated,
						})),
					},
				);
			}
			if (!params.job_id) throw new Error("background_job requires job_id for this action");
			const jobId = params.job_id;
			if (params.action === "wait") {
				const timeout = params.timeout_ms ?? 30_000;
				if (!Number.isSafeInteger(timeout) || timeout < 0 || timeout > 120_000)
					throw new Error("Invalid background wait timeout");
				const startedAt = Date.now();
				for (;;) {
					if (signal?.aborted) throw new Error("Background job wait aborted");
					const { info } = await inspect(jobId, currentCwd);
					if (TERMINAL.has(info.status)) {
						return reply(`${jobId}: ${info.status} (exit ${info.exit_code ?? "unknown"})`, {
							job_id: jobId, status: info.status, exit_code: info.exit_code ?? null,
						});
					}
					if (Date.now() - startedAt >= timeout) {
						return reply(`${jobId}: still running; wait timed out, not completed`, {
							job_id: jobId, status: info.status, timed_out: true,
						});
					}
					await new Promise<void>((resolve) =>
						setTimeout(resolve, Math.max(0, Math.min(100, timeout - (Date.now() - startedAt)))),
					);
				}
			}
			const { folder, info } = await inspect(jobId, currentCwd);
			if (params.action === "tail") {
				const maxBytes = params.max_bytes ?? DEFAULT_TAIL;
				if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > MAX_TAIL)
					throw new Error("Invalid tail byte limit");
				const cursor = params.cursor;
				if (cursor !== undefined && (!Number.isSafeInteger(cursor) || cursor < 0))
					throw new Error("Invalid background log cursor");
				const result = await tail(folder, cursor, maxBytes);
				return reply(result.output || "(no new output)", {
					job_id: jobId, status: info.status, output: result.output,
					next_cursor: result.cursor, output_truncated: info.output_truncated,
				});
			}
			if (params.action === "stop") {
				if (!TERMINAL.has(info.status)) {
					try {
						await writeFile(join(folder, "stop"), "", { flag: "wx", mode: 0o600 });
					} catch (error) {
						if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
					}
				}
				return reply(
					TERMINAL.has(info.status) ? `${jobId}: ${info.status}` : `${jobId}: cancellation requested`,
					{ job_id: jobId, status: info.status, cancel_requested: !TERMINAL.has(info.status) },
				);
			}
			return reply(
				`${jobId}: ${info.status}${info.exit_code === undefined ? "" : ` (exit ${info.exit_code})`}`,
				{
					job_id: jobId, status: info.status,
					exit_code: info.exit_code ?? null, output_truncated: info.output_truncated,
				},
			);
		}
		},
	};
}

/** Register the inspector with the same tool pipeline as bash; it never spawns work. */
export function createBackgroundJobTool(cwd: string): TypeBoxAgentTool<typeof jobSchema> {
	return wrapToolDefinition(createBackgroundJobToolDefinition(cwd));
}
