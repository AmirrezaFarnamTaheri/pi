import type { AssistantMessage, AssistantMessageEvent } from "../types.ts";

/**
 * "result-only" omits progress events produced when nobody is iterating.
 * It is intended for callers that await only result(), not for replayable streams.
 * The default "all" mode preserves the existing lossless replay contract.
 */
export interface EventStreamOptions {
	retention?: "all" | "result-only";
}

class FifoQueue<T> {
	private incoming: T[] = [];
	private outgoing: T[] = [];

	/** Number of queued values. */
	get length(): number {
		return this.incoming.length + this.outgoing.length;
	}

	/** Add a value at the back. */
	enqueue(value: T): void {
		this.incoming.push(value);
	}

	/** Remove the oldest value, in amortized constant time. */
	dequeue(): T | undefined {
		if (this.outgoing.length === 0) {
			while (this.incoming.length > 0) {
				this.outgoing.push(this.incoming.pop()!);
			}
		}
		return this.outgoing.pop();
	}
}

// Generic event stream class for async iteration
export class EventStream<T, R = T> implements AsyncIterable<T> {
	private queue = new FifoQueue<T>();
	private waiting = new FifoQueue<(value: IteratorResult<T>) => void>();
	/** Producers are notified as buffered events are consumed. */
	private waitingForCapacity = new Set<() => void>();
	/** Only block a producer when there is an actual async iterator consuming events. */
	private activeIterators = 0;
	private readonly retainUnconsumedEvents: boolean;
	protected done = false;
	private finalResultPromise: Promise<R>;
	private resolveFinalResult!: (result: R) => void;
	private rejectFinalResult!: (reason: unknown) => void;
	private failure: unknown;
	private hasFailed = false;
	private isComplete: (event: T) => boolean;
	private extractResult: (event: T) => R;

	constructor(isComplete: (event: T) => boolean, extractResult: (event: T) => R, options: EventStreamOptions = {}) {
		if (options.retention !== undefined && options.retention !== "all" && options.retention !== "result-only") {
			throw new RangeError("Unsupported event stream retention mode");
		}
		this.retainUnconsumedEvents = options.retention !== "result-only";
		this.isComplete = isComplete;
		this.extractResult = extractResult;
		this.finalResultPromise = new Promise((resolve, reject) => {
			this.resolveFinalResult = resolve;
			this.rejectFinalResult = reject;
		});
		// Iteration-only consumers may not request result(); prevent unhandled rejections
		// while preserving the original rejected result promise for awaiting callers.
		void this.finalResultPromise.catch(() => {});
	}

	/** Wake only the oldest live capacity waiter, preserving FIFO producer fairness. */
	private wakeCapacityWaiter(): void {
		this.waitingForCapacity.values().next().value?.();
	}

	/** Terminal/iterator cancellation must release every pending producer. */
	private wakeAllCapacityWaiters(): void {
		for (const wake of this.waitingForCapacity) wake();
	}

	/** Publish an event without waiting for consumers; a terminal event resolves result(). */
	push(event: T): void {
		if (this.done) return;

		if (this.isComplete(event)) {
			this.done = true;
			this.resolveFinalResult(this.extractResult(event));
		}

		// Terminal events also release producers waiting on queue capacity. Consumers
		// can await result() without draining the remaining progress events.
		if (this.done) {
			this.wakeAllCapacityWaiters();
		}
		// Deliver to waiting consumer or queue it
		const waiter = this.waiting.dequeue();
		if (waiter) {
			waiter({ value: event, done: false });
		} else if (this.retainUnconsumedEvents || this.activeIterators > 0) {
			// Explicit result-only consumers need no backlog when nothing is
			// iterating. Active iterators remain lossless.
			this.queue.enqueue(event);
		}
	}

	/**
	 * Preserve every event while bounding the queue when an async iterator is active.
	 * Result-only callers may never pull an event, so we deliberately do not block
	 * them; blocking them would deadlock result() and change the EventStream contract.
	 *
	 * A producer that uses this API (rather than synchronous push()) is backpressured
	 * until the consumer dequeues an event. Its producer must await the returned promise.
	 */
	async pushWithBackpressure(event: T, maxBuffered = 128, signal?: AbortSignal): Promise<void> {
		if (!Number.isSafeInteger(maxBuffered) || maxBuffered < 1) {
			throw new RangeError("maxBuffered must be a positive integer");
		}
		if (signal?.aborted) throw new Error("Event stream publication aborted");
		while (this.activeIterators > 0 && !this.done && this.queue.length >= maxBuffered) {
			await new Promise<void>((resolve, reject) => {
				const wake = () => {
					if (!this.waitingForCapacity.delete(wake)) return;
					signal?.removeEventListener("abort", onAbort);
					resolve();
				};
				const onAbort = () => {
					if (!this.waitingForCapacity.delete(wake)) return;
					signal?.removeEventListener("abort", onAbort);
					reject(new Error("Event stream publication aborted"));
				};
				this.waitingForCapacity.add(wake);
				signal?.addEventListener("abort", onAbort, { once: true });
				if (signal?.aborted) onAbort();
			});
			if (signal?.aborted) {
				// Cancellation can race a capacity wake before the producer publishes.
				// Pass that freed slot to the next live producer instead of starving it.
				if (this.queue.length < maxBuffered) this.wakeCapacityWaiter();
				throw new Error("Event stream publication aborted");
			}
		}
		this.push(event);
	}

	/** Finish when a producer rejects before publishing its terminal event. */
	fail(error: unknown): void {
		if (this.done) return;
		this.hasFailed = true;
		this.failure = error;
		this.end();
		this.rejectFinalResult(error);
	}

	/** Finish the stream, release waiting consumers and producers, and optionally resolve result(). */
	end(result?: R): void {
		this.done = true;
		if (result !== undefined) {
			this.resolveFinalResult(result);
		}
		// Notify all waiting consumers that we're done
		while (this.waiting.length > 0) {
			const waiter = this.waiting.dequeue()!;
			waiter({ value: undefined as any, done: true });
		}
		// An ended stream must not strand producers blocked on queue capacity.
		this.wakeAllCapacityWaiters();
	}

	async *[Symbol.asyncIterator](): AsyncIterator<T> {
		this.activeIterators++;
		try {
			while (true) {
				if (this.queue.length > 0) {
					const next = this.queue.dequeue()!;
					this.wakeCapacityWaiter();
					yield next;
				} else if (this.done) {
					if (this.hasFailed) throw this.failure;
					return;
				} else {
					const result = await new Promise<IteratorResult<T>>((resolve) => this.waiting.enqueue(resolve));
					if (result.done) {
						if (this.hasFailed) throw this.failure;
						return;
					}
					yield result.value;
				}
			}
		} finally {
			this.activeIterators--;
			// Breaking out of for-await no longer requires future consumption.
			this.wakeAllCapacityWaiters();
		}
	}

	/** Promise for the final result; it rejects if the stream failed. */
	result(): Promise<R> {
		return this.finalResultPromise;
	}
}

/**
 * Event stream of one assistant response. It also times the response: the final message (`done` or `error` event, or
 * the result passed to `end()`) gets `durationMs`, measured with a monotonic clock from the stream's creation, unless
 * the message already has one or its `timestamp` predates the stream. A stream that forwards a response which started
 * elsewhere, such as a deferred result fetched later, therefore leaves it untimed.
 */
export class AssistantMessageEventStream extends EventStream<AssistantMessageEvent, AssistantMessage> {
	readonly #startedAt = Date.now();
	readonly #startedAtMonotonic = performance.now();

	constructor(options: EventStreamOptions = {}) {
		super(
			(event) => event.type === "done" || event.type === "error",
			(event) => {
				if (event.type === "done") {
					return event.message;
				} else if (event.type === "error") {
					return event.error;
				}
				throw new Error("Unexpected event type for final result");
			},
			options,
		);
	}

	override push(event: AssistantMessageEvent): void {
		if (event.type === "done") this.#time(event.message);
		else if (event.type === "error") this.#time(event.error);
		super.push(event);
	}

	override end(result?: AssistantMessage): void {
		if (result !== undefined) this.#time(result);
		super.end(result);
	}

	#time(message: AssistantMessage): void {
		if (this.done || message.durationMs !== undefined || message.timestamp < this.#startedAt) return;
		message.durationMs = Math.max(0, Math.round(performance.now() - this.#startedAtMonotonic));
	}
}

/** Factory function for AssistantMessageEventStream (for use in extensions) */
export function createAssistantMessageEventStream(options: EventStreamOptions = {}): AssistantMessageEventStream {
	return new AssistantMessageEventStream(options);
}
