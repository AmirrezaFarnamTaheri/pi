import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { SessionEntry, SessionManager } from "./session-manager.ts";

/**
 * Prompt-cache TTL: idle gaps longer than this are worth mentioning as the
 * likely cause of a miss. Anthropic's default cache TTL is 5 minutes.
 */
export const CACHE_TTL_MS = 5 * 60 * 1000;

/** Per-turn misses at or below this are cache breakpoint granularity noise. */
const NOISE_FLOOR_TOKENS = 1024;

/** A counted cache miss on a single assistant message. */
export interface CacheMiss {
	/** Prompt tokens that were in the previous turn's prompt but not read from cache. */
	missedTokens: number;
	/** Extra dollars paid vs. a full cache hit; 0 when pricing is unknown. */
	missedCost: number;
	/** Milliseconds since the previous request (which last refreshed the cache). */
	idleMs: number;
	/** True when the model changed relative to the previous request. */
	modelChanged: boolean;
}

export interface CacheWasteTotals {
	missedTokens: number;
	missedCost: number;
	/** Number of counted misses (turns above the noise floor). */
	missCount: number;
}

/** Minimal pricing lookup, satisfied by ModelRuntime. Cost is $/million tokens. */
export interface ModelPriceSource {
	getModel(provider: string, modelId: string): { cost: { cacheRead: number } } | undefined;
}

/** The last request seen by the scan; everything in its prompt should be cached. */
interface PreviousRequest {
	promptTokens: number;
	modelKey: string;
	timestamp: number;
	/**
	 * Sticky: some earlier request in this scan segment reported cache activity.
	 * Distinguishes a total miss on a cache-read-only provider (OpenAI-style,
	 * writes unreported) from a provider that never reports caching at all.
	 */
	reportedCache: boolean;
}

/**
 * Compute the cache miss for one assistant message relative to the previous
 * request. Returns undefined when nothing is counted: first turn, after a
 * reset, no cache activity ever reported (provider without cache support), or
 * miss below the noise floor.
 */
function detectMiss(
	prev: PreviousRequest | undefined,
	message: AssistantMessage,
	models: ModelPriceSource,
): CacheMiss | undefined {
	const usage = message.usage;
	const promptTokens = usage.input + usage.cacheRead + usage.cacheWrite;
	// A zero-cache turn only counts when cache activity was reported before:
	// on cache-read-only providers that is a total miss, while on providers
	// that never report caching it means nothing.
	if (!prev || promptTokens <= 0 || (usage.cacheRead + usage.cacheWrite === 0 && !prev.reportedCache)) {
		return undefined;
	}

	const missedTokens = Math.min(prev.promptTokens, promptTokens) - usage.cacheRead;
	if (missedTokens <= NOISE_FLOOR_TOKENS) return undefined;

	// Extra cost = missed tokens billed at the actual paid rate (input/cacheWrite,
	// incl. write premium) instead of the cache-read rate. Missed tokens can only
	// land in the input or cacheWrite buckets, so the paid rate comes straight
	// from this message's own cost breakdown.
	const paidTokens = usage.input + usage.cacheWrite;
	const paidPerToken = paidTokens > 0 ? (usage.cost.input + usage.cost.cacheWrite) / paidTokens : 0;
	const readPerToken =
		usage.cacheRead > 0
			? usage.cost.cacheRead / usage.cacheRead
			: (models.getModel(message.provider, message.model)?.cost.cacheRead ?? 0) / 1_000_000;

	return {
		missedTokens,
		missedCost: missedTokens * Math.max(0, paidPerToken - readPerToken),
		idleMs: Math.max(0, message.timestamp - prev.timestamp),
		modelChanged: `${message.provider}/${message.model}` !== prev.modelKey,
	};
}

function asPreviousRequest(message: AssistantMessage, reportedCache: boolean): PreviousRequest | undefined {
	const usage = message.usage;
	const promptTokens = usage.input + usage.cacheRead + usage.cacheWrite;
	if (promptTokens <= 0) return undefined;
	return {
		promptTokens,
		modelKey: `${message.provider}/${message.model}`,
		timestamp: message.timestamp,
		reportedCache: reportedCache || usage.cacheRead + usage.cacheWrite > 0,
	};
}

function scan(
	entries: SessionEntry[],
	models: ModelPriceSource,
): { prev: PreviousRequest | undefined; totals: CacheWasteTotals; misses: Map<AssistantMessage, CacheMiss> } {
	let prev: PreviousRequest | undefined;
	const totals: CacheWasteTotals = { missedTokens: 0, missedCost: 0, missCount: 0 };
	const misses = new Map<AssistantMessage, CacheMiss>();

	for (const entry of entries) {
		if (entry.type === "compaction" || entry.type === "branch_summary") {
			// The context legitimately changed; the next turn's prompt is new content,
			// not re-billed content. Model switches are NOT exempt: they re-bill the
			// full prompt and should be counted.
			prev = undefined;
			continue;
		}
		if (entry.type === "usage" && entry.kind === "cache_warm") {
			const promptTokens = entry.usage.input + entry.usage.cacheRead + entry.usage.cacheWrite;
			if (promptTokens > 0) {
				prev = {
					promptTokens,
					modelKey: `${entry.provider}/${entry.model}`,
					timestamp: Date.parse(entry.timestamp),
					reportedCache: true,
				};
			}
		} else if (entry.type === "message" && entry.message.role === "assistant") {
			const miss = detectMiss(prev, entry.message, models);
			if (miss) {
				totals.missedTokens += miss.missedTokens;
				totals.missedCost += miss.missedCost;
				totals.missCount += 1;
				misses.set(entry.message, miss);
			}
			prev = asPreviousRequest(entry.message, prev?.reportedCache ?? false) ?? prev;
		}
	}
	return { prev, totals, misses };
}

/**
 * Cumulative cache waste across a session: prompt tokens that should have been
 * cache reads (they were in the previous turn's prompt) but were re-billed.
 */
export function computeCacheWaste(entries: SessionEntry[], models: ModelPriceSource): CacheWasteTotals {
	return scan(entries, models).totals;
}

/**
 * All counted cache misses across a session, keyed by the assistant message
 * (by reference) that paid for them. Used to re-derive transcript notices when
 * rebuilding the chat from entries (resume, post-compaction rebuild).
 */
export function collectCacheMisses(
	entries: SessionEntry[],
	models: ModelPriceSource,
): Map<AssistantMessage, CacheMiss> {
	return scan(entries, models).misses;
}

/**
 * Replay token misses only along the active branch. Idle-time labels consider
 * intervening provider requests from other branches, which may have refreshed
 * a shared cache prefix before the current branch resumed.
 */
export function collectActiveBranchCacheMisses(
	session: Pick<SessionManager, "getBranch" | "getEntries">,
	models: ModelPriceSource,
): Map<AssistantMessage, CacheMiss> {
	const misses = collectCacheMisses(session.getBranch(), models);
	if (misses.size === 0) return misses;
	let latestRequestTime: number | undefined;
	for (const entry of session.getEntries()) {
		if (entry.type === "message" && entry.message.role === "assistant") {
			const message = entry.message;
			const miss = misses.get(message);
			if (miss && latestRequestTime !== undefined) {
				miss.idleMs = Math.min(miss.idleMs, Math.max(0, message.timestamp - latestRequestTime));
			}
			const usage = message.usage;
			if (usage.input + usage.cacheRead + usage.cacheWrite > 0 && Number.isFinite(message.timestamp)) {
				latestRequestTime = Math.max(latestRequestTime ?? -Infinity, message.timestamp);
			}
		} else if (entry.type === "usage" && entry.kind === "cache_warm") {
			const usage = entry.usage;
			const time = Date.parse(entry.timestamp);
			if (usage.input + usage.cacheRead + usage.cacheWrite > 0 && Number.isFinite(time)) {
				latestRequestTime = Math.max(latestRequestTime ?? -Infinity, time);
			}
		}
	}
	return misses;
}

/**
 * The latest request's cache-miss inputs can normally be found at the tail:
 * a recent cache-reading or cache-writing turn provides all sticky cache
 * evidence. Unlike scan(), this does not collect a map or totals for every
 * historical turn. It visits older entries only when cache support has not
 * yet been established in the current compaction segment.
 */
function lastRequestForMiss(entries: SessionEntry[]): PreviousRequest | undefined {
	let latest: PreviousRequest | undefined;
	let reportedCache = false;
	for (let index = entries.length - 1; index >= 0; index--) {
		const entry = entries[index]!;
		if (entry.type === "compaction" || entry.type === "branch_summary") break;
		if (entry.type === "usage" && entry.kind === "cache_warm") {
			const promptTokens = entry.usage.input + entry.usage.cacheRead + entry.usage.cacheWrite;
			if (promptTokens > 0) {
				if (!latest) latest = {
					promptTokens,
					modelKey: `${entry.provider}/${entry.model}`,
					timestamp: Date.parse(entry.timestamp),
					reportedCache: true,
				};
				reportedCache = true;
			}
		} else if (entry.type === "message" && entry.message.role === "assistant") {
			const request = asPreviousRequest(entry.message, false);
			if (request) {
				latest ??= request;
				if (request.reportedCache) reportedCache = true;
			}
		}
		if (latest && reportedCache) break;
	}
	return latest ? { ...latest, reportedCache } : undefined;
}

/**
 * The last known request for each ancestry node is immutable for an append-only
 * session. Only previously unseen nodes are visited after each append or branch.
 */
const requestStatesBySession = new WeakMap<SessionManager, WeakMap<SessionEntry, PreviousRequest | undefined>>();

function lastRequestForSession(session: SessionManager): PreviousRequest | undefined {
	let states = requestStatesBySession.get(session);
	if (!states) {
		states = new WeakMap();
		requestStatesBySession.set(session, states);
	}
	const unseen: SessionEntry[] = [];
	let current = session.getLeafEntry();
	let remaining = session.getEntryCount();
	while (current && !states.has(current)) {
		if (remaining-- === 0) throw new Error("Cycle detected in session entry parent chain");
		unseen.push(current);
		current = current.parentId ? session.getEntry(current.parentId) : undefined;
	}
	let prev = current ? states.get(current) : undefined;
	for (let index = unseen.length - 1; index >= 0; index--) {
		const entry = unseen[index]!;
		if (entry.type === "compaction" || entry.type === "branch_summary") {
			prev = undefined;
		} else if (entry.type === "usage" && entry.kind === "cache_warm") {
			const promptTokens = entry.usage.input + entry.usage.cacheRead + entry.usage.cacheWrite;
			if (promptTokens > 0) {
				prev = {
					promptTokens,
					modelKey: `${entry.provider}/${entry.model}`,
					timestamp: Date.parse(entry.timestamp),
					reportedCache: true,
				};
			}
		} else if (entry.type === "message" && entry.message.role === "assistant") {
			prev = asPreviousRequest(entry.message, prev?.reportedCache ?? false) ?? prev;
		}
		states.set(entry, prev);
	}
	return prev;
}

/** Detect the next message's miss without building the full active branch. */
export function detectCacheMissForSession(
	session: SessionManager,
	message: AssistantMessage,
	models: ModelPriceSource,
): CacheMiss | undefined {
	const miss = detectMiss(lastRequestForSession(session), message, models);
	const latestRequestTime = session.getLatestProviderRequestTimestamp();
	if (miss && latestRequestTime !== undefined) {
		miss.idleMs = Math.min(miss.idleMs, Math.max(0, message.timestamp - latestRequestTime));
	}
	return miss;
}

/**
 * Detect a cache miss on a just-completed assistant message.
 * `entries` must not yet contain `message` (message_end fires before persistence).
 */
export function detectCacheMiss(
	entries: SessionEntry[],
	message: AssistantMessage,
	models: ModelPriceSource,
): CacheMiss | undefined {
	return detectMiss(lastRequestForMiss(entries), message, models);
}
