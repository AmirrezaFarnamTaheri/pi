/** Credential-slot selection for an opt-in Pi virtual model. Never stores key material. */

export interface RotationTarget {
	provider: string;
	model: string;
}

export interface FailedRoute {
	target: RotationTarget;
	errorMessage: string;
	/** A request that produced text, reasoning or tool output must not be replayed on another account. */
	hasOutput: boolean;
}

export interface RouteInput {
	reason: "user" | "continuation" | "retry" | "direct";
	previous?: RotationTarget;
	active?: RotationTarget;
	failed?: FailedRoute;
	now?: number;
}

export type CredentialFailure = "rate-limit" | "auth" | "overload";

/** Identify provider failures that may be caused by one credential rather than the request. */
export function classifyCredentialFailure(message: string): CredentialFailure | undefined {
	if (/content[ -]?policy|safety|moderation|context[ _-]?(length|window)|invalid request/i.test(message)) {
		return undefined;
	}
	if (/\b429\b|rate[ -]?limit|quota[ _-]?(exceeded|exhausted)|insufficient[ _-]?quota|resource[ _-]?exhausted|out of credits/i.test(message)) {
		return "rate-limit";
	}
	if (/\b401\b|invalid[ _-]?(api[ _-]?)?key|unauthorized|authentication (failed|error|invalid)/i.test(message)) {
		return "auth";
	}
	if (/\b50[234]\b|overloaded|service unavailable/i.test(message)) return "overload";
	return undefined;
}

export interface RotationChoice {
	index: number;
	target: RotationTarget;
}

export interface RotationStatus extends RotationChoice {
	readyInMs: number;
}

/** Round-robin among distinct authenticated provider/model slots, with per-slot cooldowns. */
export class RotationPool {
	readonly #targets: readonly RotationTarget[];
	readonly #cooldownMs: number;
	readonly #cooldowns = new Map<number, number>();
	#cursor = 0;

	constructor(targets: readonly RotationTarget[], cooldownMs = 60_000) {
		if (targets.length === 0) throw new Error("Rotation pool must have at least one credential slot");
		if (!Number.isSafeInteger(cooldownMs) || cooldownMs < 1) throw new Error("Invalid credential cooldown");
		const seen = new Set<string>();
		for (const target of targets) {
			const key = `${target.provider}\0${target.model}`;
			if (seen.has(key)) throw new Error("Duplicate credential slot in rotation pool");
			seen.add(key);
		}
		this.#targets = targets.map((target) => ({ ...target }));
		this.#cooldownMs = cooldownMs;
	}

	choose(input: RouteInput): RotationChoice {
		const now = input.now ?? Date.now();
		const failed = input.failed;
		const failedIndex = failed ? this.#indexOf(failed.target) : -1;
		if (input.reason === "retry" && failedIndex >= 0) {
			const category = classifyCredentialFailure(failed!.errorMessage);
			if (category && !failed!.hasOutput) {
				// Invalid logins need a longer quarantine than transient service pressure.
				const duration = category === "auth" ? Math.max(3_600_000, this.#cooldownMs) : this.#cooldownMs;
				this.#cooldowns.set(failedIndex, now + duration);
				return this.#pick((failedIndex + 1) % this.#targets.length, now, true);
			}
			return this.#choice(failedIndex);
		}
		if (input.reason === "continuation" || input.reason === "retry") {
			const previous = this.#indexOf(input.previous);
			const sticky = previous >= 0 ? previous : this.#indexOf(input.active);
			if (sticky >= 0) return this.#choice(sticky);
		}
		if (input.reason === "direct") return this.#pick(this.#cursor, now, false);
		return this.#pick(this.#cursor, now, true);
	}

	reset(): void {
		this.#cooldowns.clear();
	}

	status(now = Date.now()): RotationStatus[] {
		return this.#targets.map((target, index) => ({
			index,
			target: { ...target },
			readyInMs: Math.max(0, (this.#cooldowns.get(index) ?? 0) - now),
		}));
	}

	#indexOf(target: RotationTarget | undefined): number {
		if (!target) return -1;
		return this.#targets.findIndex((candidate) => candidate.provider === target.provider && candidate.model === target.model);
	}

	#choice(index: number): RotationChoice {
		return { index, target: { ...this.#targets[index]! } };
	}

	#pick(start: number, now: number, advance: boolean): RotationChoice {
		for (let offset = 0; offset < this.#targets.length; offset++) {
			const index = (start + offset) % this.#targets.length;
			if ((this.#cooldowns.get(index) ?? 0) > now) continue;
			if (advance) this.#cursor = (index + 1) % this.#targets.length;
			return this.#choice(index);
		}
		throw new Error("All account credentials are cooling down; retry after the cooldown expires");
	}
}
