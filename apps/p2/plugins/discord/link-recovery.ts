/** Durable, retryable compensation/roll-forward for Discord-to-session link mutations. */
import type { SessionLock } from "@p2/app/v1";
import type { Binding, Pending, Wake } from "./contract.ts";

export type LinkRepair = {
  kind: "link" | "unlink" | "update";
  session: string;
  /** Prior lock for failed link, desired lock for unlink/update. */
  lock: SessionLock | null;
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
  setLock: (session: string, lock: SessionLock | null) => Promise<void>,
): Promise<void> {
  for (const [session, repair] of Object.entries(state.value().repairs)) {
    if (repair.session !== session) throw new Error(`Discord repair session mismatch: ${session}`);
    switch (repair.kind) {
      case "link": {
        // A fully committed binding is authoritative; do not weaken its live lock.
        const isLinked = Object.values(state.value().bindings).some((binding) => binding.session === session);
        if (!isLinked) await setLock(session, repair.lock);
        break;
      }
      case "unlink":
        // Drop relay access *before* removing the sandbox/tool lock.
        await state.change((draft) => removeSessionBinding(draft, session));
        await setLock(session, null);
        break;
      case "update":
        if (!repair.wake) throw new Error(`Discord repair missing wake policy: ${session}`);
        if (!Object.values(state.value().bindings).some((binding) => binding.session === session)) {
          throw new Error(`Discord repair cannot update unlinked session ${session}`);
        }
        await setLock(session, repair.lock);
        await state.change((draft) => {
          for (const binding of Object.values(draft.bindings)) {
            if (binding.session === session) binding.wake = repair.wake!;
          }
        });
        break;
      default:
        throw new Error(`Unknown Discord repair kind: ${String((repair as { kind: unknown }).kind)}`);
    }
    await state.change((draft) => { delete draft.repairs[session]; });
  }
}
