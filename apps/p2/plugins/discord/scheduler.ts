/**
 * Bound concurrency per Discord channel: ordinary mentions preserve channel order, while
 * independent channels run concurrently and owner control commands bypass slow deliveries.
 * When saturated, recover non-command events from Discord history instead of using
 * unbounded memory. Priority commands are bounded separately and are never queued behind
 * ordinary deliveries.
 */
export type ScheduledDiscordEvent = {
	bot: string;
	key: string;
	priority: boolean;
	run(): Promise<void>;
};

export class DiscordScheduler {
	readonly #normal: ScheduledDiscordEvent[] = [];
	readonly #priority: ScheduledDiscordEvent[] = [];
	readonly #normalActive = new Set<string>();
	readonly #priorityActive = new Set<string>();
	readonly #idle = new Set<() => void>();
	readonly #overflow: (bot: string) => void;
	readonly #error: (error: unknown) => void;
	readonly #maxNormal: number;
	readonly #maxPending: number;
	readonly #maxPriority: number;
	readonly #maxPendingPriority: number;
	#stopped = false;

	constructor(
		overflow: (bot: string) => void,
		error: (error: unknown) => void,
		maxNormal = 32,
		maxPending = 512,
		maxPriority = 16,
		maxPendingPriority = 256,
	) {
		if (![maxNormal, maxPending, maxPriority, maxPendingPriority].every(
			(value) => Number.isSafeInteger(value) && value > 0,
		)) throw new Error("Discord scheduler limits must be positive integers");
		this.#overflow = overflow;
		this.#error = error;
		this.#maxNormal = maxNormal;
		this.#maxPending = maxPending;
		this.#maxPriority = maxPriority;
		this.#maxPendingPriority = maxPendingPriority;
	}

	enqueue(event: ScheduledDiscordEvent): boolean {
		if (this.#stopped) return false;
		const queue = event.priority ? this.#priority : this.#normal;
		const limit = event.priority ? this.#maxPendingPriority : this.#maxPending;
		if (queue.length >= limit) {
			if (event.priority) this.#error(new Error("Discord control command backlog saturated"));
			else this.#overflow(event.bot);
			return false;
		}
		queue.push(event);
		this.#drain();
		return true;
	}

	/** Stops accepting work. In-flight operations may settle normally. */
	stop(): void {
		this.#stopped = true;
		this.#normal.length = 0;
		this.#priority.length = 0;
		this.#notifyIdle();
	}

	/** For tests and orderly cleanup: wait for all active work and queued jobs to settle. */
	idle(): Promise<void> {
		if (this.#isIdle()) return Promise.resolve();
		return new Promise((resolve) => this.#idle.add(resolve));
	}

	#isIdle(): boolean {
		return this.#normal.length === 0 && this.#priority.length === 0 &&
			this.#normalActive.size === 0 && this.#priorityActive.size === 0;
	}

	#notifyIdle(): void {
		if (!this.#isIdle()) return;
		for (const resolve of this.#idle) resolve();
		this.#idle.clear();
	}

	#start(queue: ScheduledDiscordEvent[], active: Set<string>, limit: number): void {
		while (active.size < limit) {
			// Do not occupy every worker with queued work from one busy channel.
			const index = queue.findIndex((event) => !active.has(event.key));
			if (index < 0) break;
			const event = queue.splice(index, 1)[0]!;
			active.add(event.key);
			void Promise.resolve()
				.then(() => event.run())
				.catch((error: unknown) => {
					try { this.#error(error); } catch { /* Logging must not halt the dispatcher. */ }
				})
				.finally(() => {
					active.delete(event.key);
					this.#drain();
				});
		}
	}

	#drain(): void {
		if (!this.#stopped) {
			this.#start(this.#priority, this.#priorityActive, this.#maxPriority);
			this.#start(this.#normal, this.#normalActive, this.#maxNormal);
		}
		this.#notifyIdle();
	}
}
