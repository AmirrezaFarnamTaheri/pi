/** Bounded, source-ordered async job scheduler for independent tool calls. */
export const DEFAULT_PARALLEL_TOOL_LIMIT = 8;
export const HARD_PARALLEL_TOOL_LIMIT = 32;

export function configuredParallelToolLimit(value: number | undefined = undefined): number {
	if (value === undefined) return DEFAULT_PARALLEL_TOOL_LIMIT;
	if (!Number.isSafeInteger(value) || value < 1 || value > HARD_PARALLEL_TOOL_LIMIT) {
		throw new RangeError(`maxParallelToolExecutions must be an integer between 1 and ${HARD_PARALLEL_TOOL_LIMIT}`);
	}
	return value;
}

/** Collect outputs in input order, despite differing completion times. */
export async function executeBoundedInOrder<T>(
	entries: readonly (T | (() => Promise<T>))[],
	maxConcurrent: number = DEFAULT_PARALLEL_TOOL_LIMIT,
): Promise<T[]> {
	const limit = configuredParallelToolLimit(maxConcurrent);
	if (entries.length === 0) return [];
	const results = new Array<T>(entries.length);
	let nextIndex = 0;
	let failed = false;
	const worker = async () => {
		while (!failed) {
			const index = nextIndex++;
			if (index >= entries.length) return;
			const entry = entries[index]!;
			try {
				results[index] = typeof entry === "function" ? await (entry as () => Promise<T>)() : (entry as T);
			} catch (error) {
				failed = true;
				throw error;
			}
		}
	};
	// A failed worker stops new jobs, but all already-running tools must settle
	// before the agent loop can report the batch finished.
	const outcomes = await Promise.allSettled(Array.from({ length: Math.min(limit, entries.length) }, worker));
	const failure = outcomes.find((outcome): outcome is PromiseRejectedResult => outcome.status === "rejected");
	if (failure) throw failure.reason;
	return results;
}
