/** An explicit, opt-in reduction of historical provider-visible context. */
import type { AgentMessage } from "./types.ts";

export interface HistoricalToolResultBudget {
	/** Maximum UTF-16 characters in a shortened older tool-result text block. */
	maxCharsPerToolResult: number;
	/** Most recent tool-result messages that must remain unchanged. Defaults to two. */
	keepRecentResults?: number;
}
export interface HistoricalToolResultBudgetResult {
	messages: AgentMessage[];
	/** UTF-16 characters saved after adding the marker, not actual provider tokens. */
	savedChars: number;
	trimmedResults: number;
}

const ABBREVIATION = "\n[... older tool output omitted; rerun the tool for full results ...]\n";

/**
 * Only abbreviates older, successful, single-text tool results. Errors,
 * recent results, images and the original transcript are never changed.
 * The caller must explicitly install this as a context transform.
 */
export function compactHistoricalToolResults(
	messages: AgentMessage[],
	options: HistoricalToolResultBudget,
): HistoricalToolResultBudgetResult {
	const { maxCharsPerToolResult, keepRecentResults = 2 } = options;
	if (!Number.isSafeInteger(maxCharsPerToolResult) || maxCharsPerToolResult < 128) {
		throw new RangeError("maxCharsPerToolResult must be an integer >= 128");
	}
	if (!Number.isSafeInteger(keepRecentResults) || keepRecentResults < 0) {
		throw new RangeError("keepRecentResults must be a nonnegative integer");
	}
	let remainingRecent = keepRecentResults;
	const eligible = new Set<number>();
	for (let index = messages.length - 1; index >= 0; index--) {
		const message = messages[index]!;
		if (message.role !== "toolResult") continue;
		if (remainingRecent-- > 0 || message.isError) continue;
		if (message.content.length !== 1 || message.content[0]?.type !== "text") continue;
		if (message.content[0].text.length <= maxCharsPerToolResult) continue;
		eligible.add(index);
	}
	if (eligible.size === 0) return { messages, savedChars: 0, trimmedResults: 0 };
	const shortened = messages.slice();
	let savedChars = 0;
	for (const index of eligible) {
		const original = messages[index]!;
		if (original.role !== "toolResult" || original.content[0]?.type !== "text") continue;
		const raw = original.content[0].text;
		const available = maxCharsPerToolResult - ABBREVIATION.length;
		let head = raw.slice(0, Math.ceil(available / 2));
		let tail = raw.slice(-Math.floor(available / 2));
		// Avoid splitting a UTF-16 surrogate pair at a cut boundary.
		if (head.length > 0 && /[\uD800-\uDBFF]$/.test(head)) head = head.slice(0, -1);
		if (tail.length > 0 && /^[\uDC00-\uDFFF]/.test(tail)) tail = tail.slice(1);
		const text = head + ABBREVIATION + tail;
		shortened[index] = { ...original, content: [{ type: "text", text }] };
		savedChars += raw.length - text.length;
	}
	return { messages: shortened, savedChars, trimmedResults: eligible.size };
}
