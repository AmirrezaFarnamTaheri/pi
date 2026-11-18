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
export type CredentialFailure = "rate-limit" | "quota" | "auth" | "overload";

/**
 * Recognize failures that are safe to retry on another identity before output.
 * Adapted from Penguin's distinct credential, quota, throttling and capacity
 * classifications. A bare 403 is a request rejection, not a bad credential.
 */
export function classifyCredentialFailure(message: string): CredentialFailure | undefined {
	if (/content[ -]?policy|safety|moderation|context[ _-]?(length|window)|invalid request/i.test(message)) {
		return undefined;
	}
	if (
		/\b401\b|invalid[ _-]?(api[ _-]?)?key|invalid_token|expired_token|token_expired|authentication_error|unauthorized|authentication (failed|error|invalid)/i.test(
			message,
		)
	) {
		return "auth";
	}
	const quota =
		/insufficient[ _-]?(user[ _-]?)?quota|quota[ _-]?(exceeded|exhausted|reset)|billing[ _-]hard[ _-]limit[ _-]reached|exceeded[ _-]current[ _-]quota|daily quota|out of credits/i.test(
			message,
		);
	if (/\b403\b/.test(message) && !quota) return undefined;
	if (/\b50[0-4]\b|\b529\b|overload(?:ed|ing)?|server busy|service unavailable|capacity exceeded/i.test(message)) {
		return "overload";
	}
	if (quota) return "quota";
	if (
		/\b429\b|rate[ -_]?limit|usage limit reached|resource[ _-]exhausted|too many requests|tokens per minute|requests per minute/i.test(
			message,
		)
	) {
		return "rate-limit";
	}
	return undefined;
}

const MAX_COOLDOWN_MS = 86_400_000;
const UNITS: Record<string, number> = {
	second: 1_000,
	minute: 60_000,
	hour: 3_600_000,
	day: 86_400_000,
};

/** Parse explicit provider reset hints, never infer a quota window from a model's output. */
export function quotaResetDelayMs(error: string): number | undefined {
	const withinLimit = (ms: number): number | undefined =>
		Number.isFinite(ms) && ms >= 0 ? Math.min(MAX_COOLDOWN_MS, ms) : undefined;
	const numeric = /\bretry-after\s*:\s*(\d+(?:\.\d+)?)\b/i.exec(error);
	if (numeric) return withinLimit(Number(numeric[1]) * 1_000);

	const seconds = /\breset_after[:\s]+(\d+(?:\.\d+)?)\s*s?\b/i.exec(error);
	if (seconds) return withinLimit(Number(seconds[1]) * 1_000);

	// Penguin reports compact reset windows such as "Resets in 1h2m3s".
	const compact = /\bresets? in ((?:\d+h)?(?:\d+m)?(?:\d+s)?)\b/i.exec(error);
	if (compact?.[1]) {
		const parsed = /^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/i.exec(compact[1]);
		if (parsed) {
			return withinLimit(
				(Number(parsed[1] ?? 0) * 3600 + Number(parsed[2] ?? 0) * 60 + Number(parsed[3] ?? 0)) * 1000,
			);
		}
	}
	const relative =
		/\b(?:limit will )?reset in ((?:\d+\s*(?:days?|hours?|minutes?|seconds?)(?:\s*,\s*|\s+and\s+|\s*)?)+)/i.exec(
			error,
		);
	if (!relative) return undefined;
	let delay = 0;
	for (const match of relative[1]!.matchAll(/(\d+)\s*(day|hour|minute|second)s?/gi)) {
		delay += Number(match[1]) * UNITS[match[2]!.toLowerCase()]!;
	}
	return delay > 0 ? withinLimit(delay) : undefined;
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
	/** Lifetime counters for this model and account, excluding provider outages. */
	successfulRequests: number;
	failedRequests: number;
	authRejected: boolean;
	lastSuccessAt?: number;
	lastFailureAt?: number;
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
	/** A rejected credential stays unavailable until re-login, success, or explicit reset. */
	authRejected?: boolean;
	successfulRequests?: number;
	failedRequests?: number;
	lastSuccessAt?: number;
	lastFailureAt?: number;
	lastUsedAt?: number;
	quota?: { remaining: number; resetAt?: number };
}

/** Health summary for one account rotation fleet; never includes credentials. */
export interface RotationFleetHealth {
	total: number;
	ready: number;
	cooling: number;
	quotaBlocked: number;
	authRejected: number;
	disabled: number;
	unavailable: number;
}

/** Partition accounts by their immediate availability, avoiding double-counting. */
export function summarizeRotationHealth(statuses: readonly RotationStatus[]): RotationFleetHealth {
	const summary: RotationFleetHealth = {
		total: statuses.length,
		ready: 0,
		cooling: 0,
		quotaBlocked: 0,
		authRejected: 0,
		disabled: 0,
		unavailable: 0,
	};
	for (const status of statuses) {
		if (!status.available) summary.unavailable++;
		else if (!status.enabled) summary.disabled++;
		else if (status.authRejected) summary.authRejected++;
		else if (status.quotaBlocked) summary.quotaBlocked++;
		else if (status.readyInMs > 0) summary.cooling++;
		else summary.ready++;
	}
	return summary;
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
		if (!["round-robin", "sticky", "random", "hybrid"].includes(strategy))
			throw new Error("Invalid rotation strategy");
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
				if (category === "overload") {
					// A provider outage is not a credential failure. Try one other
					// identity without poisoning cooldown, quota, or health metrics.
					if (this.#pinned >= 0) throw new Error("Pinned account failed; unpin it or retry later");
					return this.#pick((failedIndex + 1) % this.#targets.length, now, true, "round-robin", failedIndex);
				}
				const slot = category === "auth" ? this.#credential(failedIndex) : this.#slot(failedIndex);
				const count = (slot.failures ?? 0) + 1;
				slot.failures = count;
				slot.failedRequests = (slot.failedRequests ?? 0) + 1;
				slot.lastFailureAt = now;
				if (category === "auth") {
					// Revoked or invalid credentials do not recover on a timer.
					slot.authRejected = true;
				} else if (category === "quota") {
					const resetMs = failed!.retryAfterMs ?? quotaResetDelayMs(failed!.errorMessage);
					slot.quota = {
						remaining: 0,
						...(resetMs === undefined ? {} : { resetAt: now + Math.min(MAX_COOLDOWN_MS, Math.max(0, resetMs)) }),
					};
					delete slot.cooldownUntil;
				} else {
					const exponential = Math.min(MAX_COOLDOWN_MS, this.#cooldownMs * 2 ** Math.min(count - 1, 20));
					const explicit = failed!.retryAfterMs ?? quotaResetDelayMs(failed!.errorMessage);
					const duration = Math.min(MAX_COOLDOWN_MS, Math.max(exponential, explicit ?? 0));
					slot.cooldownUntil = now + duration;
				}
				// Manual pinning remains an identity boundary even when a key fails.
				if (this.#pinned >= 0) throw new Error("Pinned account failed; unpin it or wait for its cooldown");
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
			const fromRequest =
				this.#indexOf(input.active) >= 0 ? this.#indexOf(input.active) : this.#indexOf(input.previous);
			const sticky = fromRequest >= 0 ? fromRequest : this.#sticky;
			if (sticky >= 0 && this.#eligible(sticky, now)) return this.#choice(sticky);
		}
		const chosen = this.#pick(this.#cursor, now, true, this.#strategy);
		if (this.#strategy === "sticky") this.#sticky = chosen.index;
		this.#slot(chosen.index).lastUsedAt = now;
		return chosen;
	}

	/** A successful physical response proves this model and credential work again. */
	markSuccess(target: RotationTarget, now = Date.now()): void {
		const index = this.#requireIndex(target);
		const slot = this.#slot(index);
		delete slot.failures;
		delete slot.cooldownUntil;
		if (slot.quota?.remaining === 0) delete slot.quota;
		slot.successfulRequests = (slot.successfulRequests ?? 0) + 1;
		slot.lastSuccessAt = now;
		slot.lastUsedAt = now;
		const credential = this.#credential(index);
		delete credential.authRejected;
		delete credential.failures;
	}

	/** Re-login replaces the credential, clearing stale health for every model using it. */
	markReauthenticated(target: RotationTarget): void {
		const index = this.#requireIndex(target);
		const provider = this.#targets[index]!.provider;
		const credential = this.#credential(index);
		delete credential.authRejected;
		delete credential.failures;
		const prefix = `[${JSON.stringify(provider)},`;
		for (const [key, slot] of this.#health) {
			if (!key.startsWith(prefix)) continue;
			delete slot.failures;
			delete slot.cooldownUntil;
			delete slot.quota;
		}
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
		if (resetAt !== undefined && (!Number.isFinite(resetAt) || resetAt < 0))
			throw new Error("Invalid quota reset time");
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
		for (let index = 0; index < this.#targets.length; index++) {
			this.#health.delete(this.#key(index));
			this.#health.delete(this.#credentialKey(index));
		}
		this.#sticky = -1;
		this.#pinned = -1;
	}

	status(now = Date.now()): RotationStatus[] {
		return this.#targets.map((target, index) => {
			const quota = this.#quotaAt(index, now);
			const quotaWait =
				quota?.remaining === 0
					? quota.resetAt === undefined
						? Number.POSITIVE_INFINITY
						: Math.max(0, quota.resetAt - now)
					: 0;
			const slot = this.#slot(index);
			const credential = this.#credential(index);
			const failures = (slot.failures ?? 0) + (credential.failures ?? 0);
			return {
				index,
				target: { ...target },
				readyInMs: Math.max(
					0,
					(slot.cooldownUntil ?? 0) - now,
					quotaWait,
					credential.authRejected ? Number.POSITIVE_INFINITY : 0,
				),
				available: !this.#unavailable.has(index),
				quotaBlocked: quota?.remaining === 0,
				authRejected: credential.authRejected === true,
				enabled: !slot.disabled,
				pinned: this.#pinned === index,
				failureCount: failures,
				successfulRequests: slot.successfulRequests ?? 0,
				failedRequests: (slot.failedRequests ?? 0) + (credential.failedRequests ?? 0),
				healthScore: Math.max(0, 100 - failures * 20),
				...(quota ? { quotaRemaining: quota.remaining } : {}),
				...(slot.lastUsedAt === undefined ? {} : { lastUsedAt: slot.lastUsedAt }),
				...(slot.lastSuccessAt === undefined ? {} : { lastSuccessAt: slot.lastSuccessAt }),
				...((slot.lastFailureAt ?? credential.lastFailureAt) === undefined
					? {}
					: { lastFailureAt: Math.max(slot.lastFailureAt ?? 0, credential.lastFailureAt ?? 0) }),
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
		if (
			this.#unavailable.has(index) ||
			slot.disabled ||
			this.#credential(index).authRejected ||
			(slot.cooldownUntil ?? 0) > now
		) {
			return false;
		}
		return (this.#quotaAt(index, now)?.remaining ?? 1) > 0;
	}

	#key(index: number): string {
		const target = this.#targets[index]!;
		// JSON-tuples cannot collide even when a model ID contains punctuation.
		return JSON.stringify([target.provider, target.model]);
	}

	#credentialKey(index: number): string {
		return JSON.stringify([this.#targets[index]!.provider]);
	}

	#slot(index: number): RotationHealth {
		return this.#healthAt(this.#key(index));
	}

	#credential(index: number): RotationHealth {
		return this.#healthAt(this.#credentialKey(index));
	}

	#healthAt(key: string): RotationHealth {
		let slot = this.#health.get(key);
		if (!slot) {
			slot = {};
			this.#health.set(key, slot);
		}
		return slot;
	}

	#indexOf(target: RotationTarget | undefined): number {
		if (!target) return -1;
		return this.#targets.findIndex(
			(candidate) => candidate.provider === target.provider && candidate.model === target.model,
		);
	}

	#requireIndex(target: RotationTarget): number {
		const index = this.#indexOf(target);
		if (index < 0) throw new Error("Unknown account in rotation pool");
		return index;
	}

	#choice(index: number): RotationChoice {
		return { index, target: { ...this.#targets[index]! } };
	}

	#pick(start: number, now: number, advance: boolean, strategy: RotationStrategy, exclude = -1): RotationChoice {
		const eligible: number[] = [];
		for (let offset = 0; offset < this.#targets.length; offset++) {
			const index = (start + offset) % this.#targets.length;
			if (index !== exclude && this.#eligible(index, now)) eligible.push(index);
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
