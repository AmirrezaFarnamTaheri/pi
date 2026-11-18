/** Tool to inspect and control the current workspace's local background shell runs. */
import { type Static, Type } from "typebox";
import type { ExtensionContext, ToolDefinition } from "../extensions/types.ts";
import {
	backgroundJobStatus,
	listBackgroundJobs,
	stopBackgroundJob,
	tailBackgroundJob,
	waitBackgroundJob,
} from "./background-jobs.ts";
import { type TypeBoxAgentTool, wrapToolDefinition } from "./tool-definition-wrapper.ts";

const backgroundJobSchema = Type.Object({
	action: Type.Union([
		Type.Literal("list"),
		Type.Literal("status"),
		Type.Literal("tail"),
		Type.Literal("wait"),
		Type.Literal("stop"),
	]),
	jobId: Type.Optional(Type.String({ description: "Opaque job ID returned by bash, not a PID or file path" })),
	limit: Type.Optional(Type.Number({ description: "Maximum jobs to list, 1-100" })),
	cursor: Type.Optional(Type.Number({ description: "Byte cursor when tailing a log" })),
	maxBytes: Type.Optional(Type.Number({ description: "Log bytes per tail request, maximum 65536" })),
	timeoutMs: Type.Optional(Type.Number({ description: "Wait timeout in milliseconds, maximum 120000" })),
});

export type BackgroundJobInput = Static<typeof backgroundJobSchema>;

/** Managed status, bounded logs, waiting and cancellation for local background shell jobs. */
export function createBackgroundJobToolDefinition(
	cwd: string,
): ToolDefinition<typeof backgroundJobSchema, undefined> {
	return {
		name: "background_job",
		label: "background_job",
		description:
			"Manage independent local shell commands started with bash background: true or detached by Ctrl+B. " +
			"Use list/status/tail/wait/stop with their job ID. A running or timed-out job is not a successful job; " +
			"check completed status and exit code before depending on its output. Only jobs in this workspace are accessible.",
		promptSnippet: "Inspect, await or cancel local background shell jobs",
		parameters: backgroundJobSchema,
		async execute(
			_toolCallId,
			{ action, jobId, limit, cursor, maxBytes, timeoutMs }: BackgroundJobInput,
			signal?: AbortSignal,
			_onUpdate?,
			ctx?: ExtensionContext,
		) {
			if (signal?.aborted) throw new Error("Operation aborted");
			const scope = ctx?.cwd ?? cwd;
			if (action === "list") {
				const jobs = await listBackgroundJobs(scope, limit);
				return {
					content: [{ type: "text", text: jobs.length ? jobs.map((j) => j.jobId + " " + j.status).join("\n") : "(no background jobs)" }],
					details: undefined,
					structuredContent: { jobs },
				};
			}
			if (!jobId) throw new Error("A background job ID is required");
			if (action === "tail") {
				const output = await tailBackgroundJob(jobId, scope, cursor, maxBytes);
				return {
					content: [{ type: "text", text: output.text }],
					details: undefined,
					structuredContent: output,
				};
			}
			const state =
				action === "status"
					? await backgroundJobStatus(jobId, scope)
					: action === "wait"
						? await waitBackgroundJob(jobId, scope, timeoutMs, signal)
						: await stopBackgroundJob(jobId, scope);
			return {
				content: [{ type: "text", text: JSON.stringify(state) }],
				details: undefined,
				structuredContent: state,
			};
		},
	};
}

/** Direct agent-tool form of the workspace-scoped background job manager. */
export function createBackgroundJobTool(cwd: string): TypeBoxAgentTool<typeof backgroundJobSchema> {
	return wrapToolDefinition(createBackgroundJobToolDefinition(cwd));
}
