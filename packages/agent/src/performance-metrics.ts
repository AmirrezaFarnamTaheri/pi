/** Opt-in, content-free telemetry for a single agent run. */
import type { AgentEvent } from "./types.ts";
import type { Agent } from "./agent.ts";
import type { Usage } from "@earendil-works/pi-ai/compat";

export interface AgentTurnMetrics {
	index: number;
	durationMs: number;
	requests: number;
	toolCalls: number;
	toolErrors: number;
	costUsd: number;
	tokens: { input: number; output: number; cacheRead: number; cacheWrite: number; reasoning: number; total: number };
}

export interface AgentRunMetrics {
	status: "idle" | "running" | "finished" | "error" | "aborted";
	durationMs: number;
	timeToFirstTextMs?: number;
	requestCount: number;
	turnCount: number;
	/** Per-turn provider usage and latency. */
	turns: AgentTurnMetrics[];
	toolCalls: number;
	toolErrors: number;
	toolExecutionMs: number;
	toolResultBytes: number;
	retryCount: number;
	tokens: {
		input: number;
		output: number;
		cacheRead: number;
		cacheWrite: number;
		/** Subset of output, never added a second time to total. */
		reasoning: number;
		reasoningReported: boolean;
		total: number;
	};
	cacheReadFraction: number | null;
	costUsd: number;
	/** Subset of costUsd reported by a provider, rather than estimated from a catalog. */
	providerBilledCostUsd: number;
	/** Subset of costUsd from tool-result nested agent calls. */
	nestedUsageCostUsd: number;
}

export interface AgentEvaluationResult {
	id: string;
	/** External task grading, not inferred from stopReason. */
	passed: boolean;
	metrics: Pick<AgentRunMetrics, "costUsd"> & { tokens: Pick<AgentRunMetrics["tokens"], "total"> };
}

/** Metrics alone cannot determine if an agent solved the requested task. */
export function summarizeAgentEvaluations(results: readonly AgentEvaluationResult[]): {
	cases: number;
	successes: number;
	passRate: number | null;
	totalCostUsd: number;
	totalTokens: number;
	costPerSuccessUsd: number | null;
	tokensPerSuccess: number | null;
} {
	const successes = results.filter((item) => item.passed).length;
	const totalCostUsd = results.reduce((value, item) => value + item.metrics.costUsd, 0);
	const totalTokens = results.reduce((value, item) => value + item.metrics.tokens.total, 0);
	// Stable JSON reporting avoids floating-point noise for common micro-dollar totals.
	const roundMoney = (value: number) => Math.round(value * 1e12) / 1e12;
	return {
		cases: results.length,
		successes,
		passRate: results.length > 0 ? successes / results.length : null,
		totalCostUsd: roundMoney(totalCostUsd),
		totalTokens,
		costPerSuccessUsd: successes > 0 ? roundMoney(totalCostUsd / successes) : null,
		tokensPerSuccess: successes > 0 ? totalTokens / successes : null,
	};
}

export class AgentPerformanceMonitor {
	private readonly now: () => number;
	private startedAt: number | undefined;
	private endedAt: number | undefined;
	private firstTextAt: number | undefined;
	private lastStopReason: string | undefined;
	private requestCount = 0;
	private turnCount = 0;
	private activeTurn: { at: number; requests: number; calls: number; errors: number; input: number; output: number; read: number; write: number; reasoning: number; cost: number } | undefined;
	private readonly finishedTurns: AgentTurnMetrics[] = [];
	private toolCalls = 0;
	private toolErrors = 0;
	private toolExecutionMs = 0;
	private toolResultBytes = 0;
	private retryCount = 0;
	private input = 0;
	private output = 0;
	private cacheRead = 0;
	private cacheWrite = 0;
	private reasoning = 0;
	private reasoningReported = false;
	private costUsd = 0;
	private providerBilledCostUsd = 0;
	private nestedUsageCostUsd = 0;
	private readonly startedTools = new Map<string, number>();

	constructor(options: { now?: () => number } = {}) {
		this.now = options.now ?? (() => performance.now());
	}

	/** Register a retry reported by the caller (core AgentEvent has no retry event). */
	noteRetry(): void {
		if (this.startedAt !== undefined && this.endedAt === undefined) this.retryCount++;
	}

	/** Never retains user prompts, assistant content, tool arguments, or tool output. */
	record(event: AgentEvent): void {
		if (event.type === "agent_start") {
			this.reset();
			this.startedAt = this.now();
			return;
		}
		if (this.startedAt === undefined || this.endedAt !== undefined) return;
		const now = this.now();
		switch (event.type) {
			case "turn_start":
				this.activeTurn = { at: now, requests: this.requestCount, calls: this.toolCalls, errors: this.toolErrors,
					input: this.input, output: this.output, read: this.cacheRead, write: this.cacheWrite,
					reasoning: this.reasoning, cost: this.costUsd };
				break;
			case "message_update": {
				const delta = event.assistantMessageEvent;
				if (delta.type === "text_delta" && delta.delta.length > 0 && this.firstTextAt === undefined) {
					this.firstTextAt = now;
				}
				break;
			}
			case "message_end": {
				const message = event.message;
				if (message.role === "assistant") {
					this.requestCount++;
					this.lastStopReason = message.stopReason;
					this.addUsage(message.usage);
				} else if (message.role === "toolResult") {
					this.toolResultBytes += message.content.reduce(
						(sum, part) => sum + (part.type === "text" ? Buffer.byteLength(part.text, "utf8") : 0),
						0,
					);
					if (message.usage) {
						this.nestedUsageCostUsd += message.usage.cost.total;
						this.addUsage(message.usage);
					}
				}
				break;
			}
			case "tool_execution_start":
				this.toolCalls++;
				this.startedTools.set(event.toolCallId, now);
				break;
			case "tool_execution_end": {
				if (event.isError) this.toolErrors++;
				const started = this.startedTools.get(event.toolCallId);
				if (event.durationMs !== undefined) this.toolExecutionMs += event.durationMs;
				else if (started !== undefined) this.toolExecutionMs += Math.max(0, now - started);
				this.startedTools.delete(event.toolCallId);
				break;
			}
			case "turn_end": {
				this.turnCount++;
				const started = this.activeTurn;
				if (started) {
					const tokens = {
						input: this.input - started.input, output: this.output - started.output,
						cacheRead: this.cacheRead - started.read, cacheWrite: this.cacheWrite - started.write,
						reasoning: this.reasoning - started.reasoning,
						total: (this.input - started.input) + (this.output - started.output) +
							(this.cacheRead - started.read) + (this.cacheWrite - started.write),
					};
					this.finishedTurns.push({ index: this.turnCount, durationMs: Math.max(0, now - started.at),
						requests: this.requestCount - started.requests, toolCalls: this.toolCalls - started.calls,
						toolErrors: this.toolErrors - started.errors,
						costUsd: Math.round((this.costUsd - started.cost) * 1e12) / 1e12, tokens });
					this.activeTurn = undefined;
				}
				break;
			}
			case "agent_end":
				this.endedAt = now;
				this.startedTools.clear();
				break;
		}
	}

	report(): AgentRunMetrics {
		const status = this.startedAt === undefined ? "idle" : this.endedAt === undefined ? "running"
			: this.lastStopReason === "aborted" ? "aborted"
			: this.lastStopReason === "error" ? "error" : "finished";
		const tokens = {
			input: this.input,
			output: this.output,
			cacheRead: this.cacheRead,
			cacheWrite: this.cacheWrite,
			reasoning: this.reasoning,
			reasoningReported: this.reasoningReported,
			total: this.input + this.output + this.cacheRead + this.cacheWrite,
		};
		const inputTotal = this.input + this.cacheRead + this.cacheWrite;
		return {
			status,
			durationMs: this.startedAt === undefined ? 0 : Math.max(0, (this.endedAt ?? this.now()) - this.startedAt),
			...(this.firstTextAt === undefined || this.startedAt === undefined
				? {} : { timeToFirstTextMs: Math.max(0, this.firstTextAt - this.startedAt) }),
			requestCount: this.requestCount,
			turnCount: this.turnCount,
			turns: this.finishedTurns.map((turn) => ({ ...turn, tokens: { ...turn.tokens } })),
			toolCalls: this.toolCalls,
			toolErrors: this.toolErrors,
			toolExecutionMs: this.toolExecutionMs,
			toolResultBytes: this.toolResultBytes,
			retryCount: this.retryCount,
			tokens,
			cacheReadFraction: inputTotal > 0 ? this.cacheRead / inputTotal : null,
			costUsd: this.costUsd,
			providerBilledCostUsd: this.providerBilledCostUsd,
			nestedUsageCostUsd: this.nestedUsageCostUsd,
		};
	}

	private addUsage(usage: Usage): void {
		this.input += usage.input;
		this.output += usage.output;
		this.cacheRead += usage.cacheRead;
		this.cacheWrite += usage.cacheWrite;
		if (usage.reasoning !== undefined) {
			this.reasoning += usage.reasoning;
			this.reasoningReported = true;
		}
		this.costUsd += usage.cost.total;
		if (usage.cost.totalFromProvider === true) this.providerBilledCostUsd += usage.cost.total;
	}

	private reset(): void {
		this.startedAt = undefined;
		this.endedAt = undefined;
		this.firstTextAt = undefined;
		this.lastStopReason = undefined;
		this.requestCount = 0;
		this.turnCount = 0;
		this.activeTurn = undefined;
		this.finishedTurns.length = 0;
		this.toolCalls = 0;
		this.toolErrors = 0;
		this.toolExecutionMs = 0;
		this.toolResultBytes = 0;
		this.retryCount = 0;
		this.input = 0;
		this.output = 0;
		this.cacheRead = 0;
		this.cacheWrite = 0;
		this.reasoning = 0;
		this.reasoningReported = false;
		this.costUsd = 0;
		this.providerBilledCostUsd = 0;
		this.nestedUsageCostUsd = 0;
		this.startedTools.clear();
	}
}

/** Subscribe only when profiling is requested; the normal Agent path is unaffected. */
export function monitorAgent(agent: Pick<Agent, "subscribe">, options: { now?: () => number } = {}): {
	monitor: AgentPerformanceMonitor;
	unsubscribe: () => void;
} {
	const monitor = new AgentPerformanceMonitor(options);
	const unsubscribe = agent.subscribe((event) => monitor.record(event));
	return { monitor, unsubscribe };
}
