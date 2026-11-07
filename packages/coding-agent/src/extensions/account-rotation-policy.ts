/**
 * Credential-slot selection for opt-in Pi virtual models.
 * Adapts the quota/cooldown and strategy ideas used by pi-antigravity-auth,
 * CortexKit's account selector, and realagy's quota-reset notices.
 * All state is per credential alias. No tokens or secrets are stored here.
 */
export interface RotationTarget {
	provider: string;
	model: string;
}

export interface FailedRoute {
	target: RotationTarget;
	errorMessage: string;
	/** A request that has produced output must never be replayed on another account. */
	hasOutput: boolean;
	/** Optional trusted Retry-After duration from the transport, in milliseconds. */
	retryAfterMs?: number;
}

export interface RouteInput {
	reason: "user" | "continuation" | "retry" | "direct";
	previous?: RotationTarget;
	active?: RotationTarget;
	failed?: FailedRoute;
	now?: number;
}

export type RotationStrategy = "round-robin" | "sticky" | "random" | "hybrid";
export type CredentialFailure = "rate-limit" | "auth" | "overload";

export function classifyCredentialFailure(message: string): CredentialFailure | undefined {
	if (/content[ -]?policy|safety|moderation|context[ _-]?(length|window)|invalid request/i.test(message)) {
		return undefined;
	}
	if (/\b429\b|rate[ -]?limit|usage limit reached|quota[ _-]?(exceeded|exhausted)|insufficient[ _-]?quota|resource[ _-]?exhausted|out of credits/i.test(message)) {
		return "rate-limit";
	}
	if (/\b401\b|invalid[ _-]?(api[ _-]?)?key|unauthorized|authentication (failed|error|invalid)/i.test(message)) {
		return "auth";
	}
	if (/\b50[234]\b|overloaded|service unavailable/i.test(message)) return "overload";
	return undefined;
}

const MAX_COOLDOWN_MS = 86_400_000;
const UNITS: Record<string, number> = {
	second: 1_000,
	minute: 60_000,
	hour: 3_600_000,
	day: 86_400_000,
};

/** Use only explicit reset hints in provider errors; never infer quota from model output. */
export function quotaResetDelayMs(error: string): number | undefined {
	const numeric = /\bretry-after\s*:\s*(\d+)\b/i.exec(error);
	if (numeric) return Math.min(MAX_COOLDOWN_MS, Number(numeric[1]) * 1_000);
	const relative = /\b(?:limit will )?reset in ((?:\d+\s*(?:days?|hours?|minutes?|seconds?)(?:\s*,\s*|\s+and\s+|\s*)?)+)/i.exec(error);
	if (!relative) return undefined;
	let delay = 0;
	for (const match of relative[1]!.matchAll(/(\d+)\s*(day|hour|minute|second)s?/gi)) {
		delay += Number(match[1]) * UNITS[match[2]!.toLowerCase()]!;
	}
	return delay > 0 && Number.isFinite(delay) ? Math.min(MAX_COOLDOWN_MS, delay) : undefined;
}

export interface RotationChoice {
	index: number;
	target: RotationTarget;
}

export interface RotationStatus extends RotationChoice {
	/** Credential may disappear while a turn is in progress. */
	available: boolean;
	/** Zero remaining quota with no reset hint remains blocked until refreshed. */
	quotaBlocked: boolean;
	readyInMs: number;
	enabled: boolean;
	pinned: boolean;
	failureCount: number;
	healthScore: number;
	quotaRemaining?: number;
	lastUsedAt?: number;
}

/** Account-scoped, in-memory selection with no credentials in state or logs. */
/** Shared by pools that reference the same independently authenticated provider alias. */
export interface RotationHealth {
	cooldownUntil?: number;
	failures?: number;
	disabled?: boolean;
	lastUsedAt?: number;
	quota?: { remaining: number; resetAt?: number };
}

export class RotationPool {
	readonly #targets: readonly RotationTarget[];
	readonly #cooldownMs: number;
	readonly #strategy: RotationStrategy;
	readonly #random: () => number;
	readonly #health: Map<string, RotationHealth>;
	readonly #unavailable = new Set<number>();
	#cursor = 0;
	#sticky = -1;
	#pinned = -1;

	constructor(
		targets: readonly RotationTarget[],
		cooldownMs = 60_000,
		strategy: RotationStrategy = "round-robin",
		random: () => number = Math.random,
		sharedHealth: Map<string, RotationHealth> = new Map(),
	) {
		if (targets.length === 0) throw new Error("Rotation pool must have at least one credential slot");
		if (!Number.isSafeInteger(cooldownMs) || cooldownMs < 1) throw new Error("Invalid credential cooldown");
		if (!["round-robin", "sticky", "random", "hybrid"].includes(strategy)) throw new Error("Invalid rotation strategy");
		const seen = new Set<string>();
		for (const target of targets) {
			const key = `${target.provider}\0${target.model}`;
			if (seen.has(key)) throw new Error("Duplicate credential slot in rotation pool");
			seen.add(key);
		}
		this.#targets = targets.map((target) => ({ ...target }));
		this.#cooldownMs = cooldownMs;
		this.#strategy = strategy;
		this.#random = random;
		this.#health = sharedHealth;
	}

	choose(input: RouteInput): RotationChoice {
		const now = input.now ?? Date.now();
		const failed = input.failed;
		const failedIndex = failed ? this.#indexOf(failed.target) : -1;
		if (failed && failedIndex < 0) throw new Error("Failed account no longer belongs to this pool");
		if (input.reason === "retry" && failedIndex >= 0) {
			const category = classifyCredentialFailure(failed!.errorMessage);
			if (category && !failed!.hasOutput) {
				const slot = this.#slot(failedIndex);
				const count = (slot.failures ?? 0) + 1;
				slot.failures = count;
				const exponential = Math.min(MAX_COOLDOWN_MS, this.#cooldownMs * (2 ** Math.min(count - 1, 20)));
				const authDuration = category === "auth" ? Math.max(3_600_000, exponential) : exponential;
				const explicit = failed!.retryAfterMs;
				const hinted = quotaResetDelayMs(failed!.errorMessage);
				const duration = Math.min(MAX_COOLDOWN_MS, Math.max(authDuration,
					typeof explicit === "number" && Number.isFinite(explicit) && explicit > 0 ? explicit : 0,
					hinted ?? 0));
				slot.cooldownUntil = now + duration;
				// Never choose the same failed identity, regardless of sticky/manual strategy.
				return this.#pick((failedIndex + 1) % this.#targets.length, now, true, "round-robin");
			}
			return this.#choice(failedIndex);
		}
		if (input.reason === "continuation" || input.reason === "retry") {
			const previous = this.#indexOf(input.previous);
			const sticky = previous >= 0 ? previous : this.#indexOf(input.active);
			// Keep a continuation on its original credential, including when manually disabled;
			// missing authentication must fail closed rather than expose the transcript to another account.
			if (sticky >= 0) {
				if (this.#unavailable.has(sticky)) throw new Error("Original account is unavailable during continuation");
				return this.#choice(sticky);
			}
			if (input.previous || input.active) throw new Error("Original account is no longer in this pool");
		}
		if (this.#pinned >= 0) {
			if (!this.#eligible(this.#pinned, now)) throw new Error("Pinned account is unavailable; unpin it or wait");
			return this.#choice(this.#pinned);
		}
		if (input.reason === "direct") {
			const active = this.#indexOf(input.active) >= 0 ? this.#indexOf(input.active) : this.#indexOf(input.previous);
			if (active >= 0) {
				if (!this.#eligible(active, now)) throw new Error("Direct request account is unavailable");
				return this.#choice(active);
			}
			return this.#pick(this.#cursor, now, false, this.#strategy);
		}
		if (this.#strategy === "sticky") {
			const fromRequest = this.#indexOf(input.active) >= 0 ? this.#indexOf(input.active) : this.#indexOf(input.previous);
			const sticky = fromRequest >= 0 ? fromRequest : this.#sticky;
			if (sticky >= 0 && this.#eligible(sticky, now)) return this.#choice(sticky);
		}
		const chosen = this.#pick(this.#cursor, now, true, this.#strategy);
		if (this.#strategy === "sticky") this.#sticky = chosen.index;
		this.#slot(chosen.index).lastUsedAt = now;
		return chosen;
	}

	/** Record a successful physical response to recover the identity's health score. */
	markSuccess(target: RotationTarget): void {
		const slot = this.#slot(this.#requireIndex(target));
		delete slot.failures;
		delete slot.cooldownUntil;
		// A successful request proves a previously reported zero quota is no longer current.
		if (slot.quota?.remaining === 0) delete slot.quota;
	}

	/** Called when the user logs in again; keep explicit disable/pin preferences. */
	markReauthenticated(target: RotationTarget): void {
		const slot = this.#slot(this.#requireIndex(target));
		delete slot.failures;
		delete slot.cooldownUntil;
		delete slot.quota;
	}

	/** Model/auth discovery may change without resetting cooldowns and manual controls. */
	setAvailable(target: RotationTarget, available: boolean): void {
		const index = this.#requireIndex(target);
		if (available) this.#unavailable.delete(index);
		else this.#unavailable.add(index);
	}

	/** Apply a provider-reported remaining quota fraction, never raw token balances. */
	reportQuota(target: RotationTarget, remaining: number, resetAt?: number): void {
		const index = this.#requireIndex(target);
		if (!Number.isFinite(remaining) || remaining < 0 || remaining > 1) throw new Error("Invalid quota fraction");
		if (resetAt !== undefined && (!Number.isFinite(resetAt) || resetAt < 0)) throw new Error("Invalid quota reset time");
		this.#slot(index).quota = { remaining, ...(resetAt === undefined ? {} : { resetAt }) };
	}

	setEnabled(target: RotationTarget, enabled: boolean): void {
		const index = this.#requireIndex(target);
		this.#slot(index).disabled = !enabled;
	}

	pin(target: RotationTarget): void {
		this.#pinned = this.#requireIndex(target);
	}

	unpin(): void {
		this.#pinned = -1;
	}

	reset(): void {
		for (let index = 0; index < this.#targets.length; index++) this.#health.delete(this.#key(index));
		this.#sticky = -1;
		this.#pinned = -1;
	}

	status(now = Date.now()): RotationStatus[] {
		return this.#targets.map((target, index) => {
			const quota = this.#quotaAt(index, now);
			const quotaWait = quota?.remaining === 0
				? quota.resetAt === undefined ? Number.POSITIVE_INFINITY : Math.max(0, quota.resetAt - now)
				: 0;
			const slot = this.#slot(index);
			return {
				index,
				target: { ...target },
				readyInMs: Math.max(0, (slot.cooldownUntil ?? 0) - now, quotaWait),
				available: !this.#unavailable.has(index),
				quotaBlocked: quota?.remaining === 0,
				enabled: !slot.disabled,
				pinned: this.#pinned === index,
				failureCount: slot.failures ?? 0,
				healthScore: Math.max(0, 100 - (slot.failures ?? 0) * 20),
				...(quota ? { quotaRemaining: quota.remaining } : {}),
				...(slot.lastUsedAt === undefined ? {} : { lastUsedAt: slot.lastUsedAt }),
			};
		});
	}

	#quotaAt(index: number, now: number): { remaining: number; resetAt?: number } | undefined {
		const quota = this.#slot(index).quota;
		if (quota?.resetAt !== undefined && now >= quota.resetAt) return { remaining: 1 };
		return quota;
	}

	#eligible(index: number, now: number): boolean {
		const slot = this.#slot(index);
		if (this.#unavailable.has(index) || slot.disabled || (slot.cooldownUntil ?? 0) > now) return false;
		return (this.#quotaAt(index, now)?.remaining ?? 1) > 0;
	}

	#key(index: number): string {
		return this.#targets[index]!.provider;
	}

	#slot(index: number): RotationHealth {
		const key = this.#key(index);
		let slot = this.#health.get(key);
		if (!slot) {
			slot = {};
			this.#health.set(key, slot);
		}
		return slot;
	}

	#indexOf(target: RotationTarget | undefined): number {
		if (!target) return -1;
		return this.#targets.findIndex((candidate) => candidate.provider === target.provider && candidate.model === target.model);
	}

	#requireIndex(target: RotationTarget): number {
		const index = this.#indexOf(target);
		if (index < 0) throw new Error("Unknown account in rotation pool");
		return index;
	}

	#choice(index: number): RotationChoice {
		return { index, target: { ...this.#targets[index]! } };
	}

	#pick(start: number, now: number, advance: boolean, strategy: RotationStrategy): RotationChoice {
		const eligible: number[] = [];
		for (let offset = 0; offset < this.#targets.length; offset++) {
			const index = (start + offset) % this.#targets.length;
			if (this.#eligible(index, now)) eligible.push(index);
		}
		if (eligible.length === 0) throw new Error("All account credentials are cooling down, exhausted, or disabled");
		let index = eligible[0]!;
		if (strategy === "random") {
			const random = this.#random();
			const unit = Number.isFinite(random) ? Math.min(1 - Number.EPSILON, Math.max(0, random)) : 0;
			index = eligible[Math.min(eligible.length - 1, Math.floor(unit * eligible.length))]!;
		} else if (strategy === "hybrid") {
			// Health, quota and round-robin tie-breaker; never read credentials here.
			let best = -Infinity;
			for (const candidate of eligible) {
				const quota = this.#quotaAt(candidate, now)?.remaining ?? 1;
				const health = Math.max(0, 100 - (this.#slot(candidate).failures ?? 0) * 20);
				const score = quota * 100 + health;
				if (score > best) {
					best = score;
					index = candidate;
				}
			}
		}
		if (advance) this.#cursor = (index + 1) % this.#targets.length;
		return this.#choice(index);
	}
}
