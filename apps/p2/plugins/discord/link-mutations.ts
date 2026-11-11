/** Serializes Discord link updates across remote I/O and state transactions. */
export class LinkMutationQueue {
	#tail: Promise<void> = Promise.resolve();

	run<T>(action: () => Promise<T>): Promise<T> {
		const operation = this.#tail.then(action, action);
		// One failed link must not leave the queue permanently rejected.
		this.#tail = operation.then(
			() => {},
			() => {},
		);
		return operation;
	}
}
