import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { ProviderHeaders } from "@earendil-works/pi-ai/compat";
import { estimateTokens } from "./compaction/index.ts";

/** Parsed skill block from a user message */
export interface ParsedSkillBlock {
	name: string;
	location: string;
	content: string;
	userMessage: string | undefined;
}

/**
 * Parse a skill block from message text.
 * Returns null if the text doesn't contain a skill block.
 */
export function parseSkillBlock(text: string): ParsedSkillBlock | null {
	const match = text.match(/^<skill name="([^"]+)" location="([^"]+)">\n([\s\S]*?)\n<\/skill>(?:\n\n([\s\S]+))?$/);
	if (!match) return null;
	return {
		name: match[1],
		location: match[2],
		content: match[3],
		userMessage: match[4]?.trim() || undefined,
	};
}


export function withoutDeletedHeaders(headers: ProviderHeaders | undefined): Record<string, string> | undefined {
	return headers
		? Object.fromEntries(Object.entries(headers).filter((entry): entry is [string, string] => entry[1] !== null))
		: undefined;
}

export function estimateMessagesTokens(messages: AgentMessage[]): number {
	let tokens = 0;
	for (const message of messages) {
		tokens += estimateTokens(message);
	}
	return tokens;
}

/**
 * Index of the model to cycle to, or undefined when there is nothing to switch to.
 * When the current model is not in the list (currentIndex -1), forward picks the first
 * entry and backward the last, so a one-entry list still selects its only model.
 */
export function getNextCycleIndex(
	currentIndex: number,
	length: number,
	direction: "forward" | "backward",
): number | undefined {
	if (length === 0) return undefined;
	if (currentIndex === -1) return direction === "forward" ? 0 : length - 1;
	if (length === 1) return undefined;
	return direction === "forward" ? (currentIndex + 1) % length : (currentIndex - 1 + length) % length;
}

