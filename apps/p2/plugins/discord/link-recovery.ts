/** Durable, retryable compensation/roll-forward for Discord-to-session link mutations. */

import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type { SessionLock } from "@p2/app/v1";
import type { Binding, Pending, Wake } from "./contract.ts";

export type LinkRepair = {
	kind: "link" | "unlink" | "update";
	session: string;
	/** Prior lock for failed link, desired lock for unlink/update. */
	lock: SessionLock | null;
	/** Lock expected before applying a link or update repair; used for atomic fencing. */
	expectedLock?: SessionLock | null;
	/** Identity of the previously committed owner lock write, not its potentially reused value. */
	expectedWriteId?: string | null;
	/** Unique identity assigned to this repair's intended lock write, persisted before CAS. */
	writeId?: string;
	/** Lock installed by an interrupted link, if any. Never revert unrelated lock writes. */
	proposedLock?: SessionLock | null;
	/** Desired wake policy on update. */
	wake?: Wake;
};
export type LinkRepairState = {
	bindings: Record<string, Binding>;
	pending: Record<string, Pending>;
	repairs: Record<string, LinkRepair>;
};
export type RepairStore = {
	value(): LinkRepairState;
	change(update: (draft: LinkRepairState) => void): Promise<void>;
};

export function removeSessionBinding(draft: LinkRepairState, session: string): void {
	for (const [channel, binding] of Object.entries(draft.bindings)) {
		if (binding.session === session) delete draft.bindings[channel];
	}
	for (const [id, pending] of Object.entries(draft.pending)) {
		if (pending.session === session) delete draft.pending[id];
	}
}

/**
 * Recovery is idempotent: each intent stays durable until all side effects succeed.
 * It must execute under the same serial queue as owner link/unlink/update requests.
 */
export async function resumeLinkRepairs(
	state: RepairStore,
	setLock: (
		session: string,
		lock: SessionLock | null,
		expectedWriteId?: string | null,
		writeId?: string,
	) => Promise<boolean | undefined>,
	options: {
		readLock?: (session: string) => Promise<{ lock: SessionLock | null; writeId: string | null }>;
		beforeUnlock?: (session: string) => Promise<void>;
		/** Must cancel or await *submitted turns*, not merely their admission RPCs. */
		notifyUnlinked?: (session: string) => Promise<void>;
	} = {},
): Promise<void> {
	for (const [session, repair] of Object.entries(state.value().repairs)) {
		if (repair.session !== session) throw new Error(`Discord repair session mismatch: ${session}`);
		const conflict = async (): Promise<never> => {
			// Retire a superseded intent; leaving it indefinitely would keep relay
			// startup blocked. The newer owner policy is left untouched.
			await state.change((draft) => {
				delete draft.repairs[session];
			});
			throw new Error(
				`Discord ${repair.kind} conflict: session ${session} lock changed; retry with the current policy`,
			);
		};
		const current = async () => {
			if (!options.readLock) throw new Error("Identity-fenced Discord recovery requires current lock state");
			return options.readLock(session);
		};
		switch (repair.kind) {
			case "link": {
				// A committed binding wins; failed link compensation may only undo
				// the write that *this* link installed, never an intervening owner edit.
				const isLinked = Object.values(state.value().bindings).some((binding) => binding.session === session);
				if (!isLinked && repair.writeId) {
					const observed = await current();
					if (observed.writeId === repair.writeId && isDeepStrictEqual(observed.lock, repair.proposedLock)) {
						const applied = await setLock(session, repair.lock, repair.writeId, randomUUID());
						if (applied === false) throw new Error("Link compensation lost a lock race; retry");
					}
				}
				// Legacy link intents had no write identity. Fail closed, leaving the
				// sandbox lock untouched instead of potentially restoring a broader lock.
				break;
			}
			case "unlink": {
				// Revoke ingress first, then drain admitted RPCs and cancel/await all
				// submitted turns *before* lifting the sandbox/tool policy.
				await state.change((draft) => removeSessionBinding(draft, session));
				await options.beforeUnlock?.(session);
				await options.notifyUnlinked?.(session);
				if (!repair.writeId) break; // Legacy unlink: leave restrictive lock for manual owner action.
				const observed = await current();
				if (observed.writeId === repair.writeId) break; // Previous unlink CAS succeeded before crash.
				if (observed.writeId !== (repair.expectedWriteId ?? null)) await conflict();
				if ((await setLock(session, null, repair.expectedWriteId ?? null, repair.writeId)) === false)
					await conflict();
				break;
			}
			case "update": {
				if (!repair.wake) throw new Error(`Discord repair missing wake policy: ${session}`);
				if (!Object.values(state.value().bindings).some((binding) => binding.session === session)) await conflict();
				if (!repair.writeId) await conflict(); // Legacy un-fenced intent cannot safely widen wake permissions.
				const observed = await current();
				if (observed.writeId === repair.writeId) {
					// CAS already committed in the previous attempt. Finish the wake
					// change rather than treating our own write as a conflicting owner.
					if (!isDeepStrictEqual(observed.lock, repair.lock)) await conflict();
				} else {
					if (observed.writeId !== (repair.expectedWriteId ?? null)) await conflict();
					if ((await setLock(session, repair.lock, repair.expectedWriteId ?? null, repair.writeId)) === false)
						await conflict();
				}
				await state.change((draft) => {
					for (const binding of Object.values(draft.bindings))
						if (binding.session === session) binding.wake = repair.wake!;
				});
				break;
			}
			default:
				throw new Error(`Unknown Discord repair kind: ${String((repair as { kind: unknown }).kind)}`);
		}
		await state.change((draft) => {
			delete draft.repairs[session];
		});
	}
}
