// Session locks (server): every locked session's picked resources, persisted, and the remote view the owner sets them
// through and each session's worker follows its own lock with.
import { obj } from "@earendil-works/pi-schema";
import { isDeepStrictEqual } from "node:util";
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
	schema: obj({ locks: record(SessionLockSchema) }),
	version: 1,
	initial: () => ({ locks: {} }),
	persist: true,
	checkpointWhen: () => true,
});

export function serveLocks(host: FacetHost): void {
	host.serve(SessionLocks, (_params, self) => {
		const state = self.state(Locks);
		return {
			locks: deriveTyped(self, [state], ([value]) => value.locks),
			set: async ({ session, lock }, ctx) => {
				await state.change((draft) => {
					if (lock === null) delete draft.locks[session];
					else draft.locks[session] = lock;
				}, ctx);
				return null;
			},
			compareAndSet: async ({ session, previous, lock }, ctx) => {
				let applied = false;
				await state.change((draft) => {
					const current = draft.locks[session] ?? null;
					if (!isDeepStrictEqual(current, previous)) return;
					applied = true;
					if (lock === null) delete draft.locks[session];
					else draft.locks[session] = lock;
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
