/** Status, bounded output and cancellation of local shell jobs by opaque job ID. */
import { type Static, Type } from "typebox";
import type { ToolDefinition } from "../extensions/types.ts";
import {
	listBackgroundJobs,
	readBackgroundJob,
	readBackgroundJobOutput,
	stopBackgroundJob,
	waitForBackgroundJob,
} from "./background-jobs.ts";
import { type TypeBoxAgentTool, wrapToolDefinition } from "./tool-definition-wrapper.ts";

const schema = Type.Object({
	action: Type.Union([
		Type.Literal("list"),
		Type.Literal("status"),
		Type.Literal("tail"),
		Type.Literal("wait"),
		Type.Literal("stop"),
	]),
	jobId: Type.Optional(Type.String({ description: "Opaque ID returned by a background bash or powershell run" })),
	limit: Type.Optional(Type.Number({ description: "List at most this many recent jobs, 1-100" })),
	cursor: Type.Optional(Type.Number({ description: "Byte cursor for tail, starting at 0" })),
	maxBytes: Type.Optional(Type.Number({ description: "Tail at most 65536 bytes" })),
	timeoutMs: Type.Optional(Type.Number({ description: "Wait at most 60000 ms, returns running on timeout" })),
});
export type BackgroundJobToolInput = Static<typeof schema>;

/** Expose only jobs of the same local workspace, without accepting a PID or filesystem path. */
export function createBackgroundJobToolDefinition(cwd: string): ToolDefinition<typeof schema> {
	return {
		name: "background_job",
		label: "background_job",
		description:
			"Inspect, list, tail, wait for or stop a local background shell job by its ID. A running job is not a successful job; check terminal status and exitCode before using its result.",
		promptSnippet: "Manage background shell jobs returned by bash or powershell",
		promptGuidelines: [
			"Background independent work only; dependent test and build gates must finish before the next decision.",
			"Use status, tail and wait to observe completion; a job that started is not successful until it exits with code zero.",
			"Use stop to cancel the original supervisor; never kill a job by a PID copied from a stale log.",
		],
		parameters: schema,
		async execute(_toolCallId, args, signal, _onUpdate, ctx) {
			const scope = ctx?.cwd ?? cwd;
			const id = args.jobId;
			const requireId = (): string => {
				if (!id) throw new Error("jobId is required for this action");
				return id;
			};
			switch (args.action) {
				case "list": {
					const jobs = await listBackgroundJobs(scope, args.limit);
					return { content: [{ type: "text", text: JSON.stringify(jobs) }], structuredContent: { jobs } };
				}
				case "status": {
					const job = await readBackgroundJob(requireId(), scope);
					return { content: [{ type: "text", text: JSON.stringify(job) }], structuredContent: job };
				}
				case "tail": {
					const output = await readBackgroundJobOutput(requireId(), scope, args.cursor, args.maxBytes);
					return { content: [{ type: "text", text: output.output || "(no new output)" }], structuredContent: output };
				}
				case "wait": {
					const job = await waitForBackgroundJob(requireId(), scope, args.timeoutMs, signal);
					return { content: [{ type: "text", text: JSON.stringify(job) }], structuredContent: job };
				}
				case "stop": {
					const job = await stopBackgroundJob(requireId(), scope);
					return { content: [{ type: "text", text: JSON.stringify(job) }], structuredContent: job };
				}
			}
		},
	};
}

export function createBackgroundJobTool(cwd: string): TypeBoxAgentTool<typeof schema> {
	return wrapToolDefinition(createBackgroundJobToolDefinition(cwd));
}
