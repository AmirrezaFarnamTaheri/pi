// Session locks (server): every locked session's picked resources, persisted, and the remote view the owner sets them
// through and each session's worker follows its own lock with.
import { obj, str } from "@earendil-works/pi-schema";
import { randomUUID } from "node:crypto";
import {
	defineState,
	deriveTyped,
	type FacetHost,
	forbidden,
	isOwner,
	isWorker,
	record,
	SessionLockSchema,
} from "@p2/app/v1";
import { SessionLock, SessionLocks } from "./contract.ts";

const Locks = defineState("p2.session-locks", {
	schema: obj({ locks: record(SessionLockSchema), writeIds: record(str()) }),
	version: 2,
	migrate: (old, from) => {
		if (from !== 1) throw new Error(`Unknown session lock state version ${from}`);
		return { ...(old as { locks: Record<string, unknown> }), writeIds: {} } as never;
	},
	initial: () => ({ locks: {}, writeIds: {} }),
	persist: true,
	checkpointWhen: () => true,
});

export function serveLocks(host: FacetHost): void {
	host.serve(SessionLocks, (_params, self) => {
		const state = self.state(Locks);
		return {
			locks: deriveTyped(self, [state], ([value]) => value.locks),
			writeIds: deriveTyped(self, [state], ([value]) => value.writeIds),
			set: async ({ session, lock }, ctx) => {
				await state.change((draft) => {
					if (lock === null) delete draft.locks[session];
					else draft.locks[session] = lock;
					// Every write, even A -> B -> A, gets a different durable identity.
					draft.writeIds[session] = randomUUID();
				}, ctx);
				return null;
			},
			compareAndSet: async ({ session, expectedWriteId, lock, writeId }, ctx) => {
				let applied = false;
				await state.change((draft) => {
					if ((draft.writeIds[session] ?? null) !== expectedWriteId) return;
					applied = true;
					if (lock === null) delete draft.locks[session];
					else draft.locks[session] = lock;
					draft.writeIds[session] = writeId;
				}, ctx);
				return { applied };
			},
		};
	});
	host.serve(SessionLock, (_params, principal, self) => {
		const locks = self.get(SessionLocks, {});
		if (isWorker(principal)) {
			const session = principal.session;
			return {
				variant: "worker",
				members: { lock: deriveTyped(self, [locks.locks], ([all]) => all[session] ?? null) },
			};
		}
		if (!isOwner(principal)) throw forbidden("session locks are the owner's");
		return { variant: "owner", members: { locks: locks.locks, set: (args, ctx) => locks.set(args, ctx) } };
	});
}
