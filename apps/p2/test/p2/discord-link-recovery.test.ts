import assert from "node:assert/strict";
import { it } from "node:test";
import type { SessionLock } from "@p2/app/v1";
import { type LinkRepairState, resumeLinkRepairs } from "../../plugins/discord/link-recovery.ts";

const fakeState = (initial: object) => {
	let saved = structuredClone(initial) as unknown as LinkRepairState;
	const store = {
		value: () => saved,
		change: async (edit: (draft: LinkRepairState) => void) => {
			const draft = structuredClone(saved);
			edit(draft);
			saved = draft;
		},
	};
	return { store };
};

it("restores the previous lock only when the interrupted link CAS still owns it", async () => {
	const prior = { mcp: [], projectMcp: false, instructions: false, capabilities: [] };
	const proposed = { mcp: ["proposed"], projectMcp: false, instructions: false, capabilities: [] };
	const { store } = fakeState({
		bindings: {},
		pending: {},
		repairs: {
			s1: {
				session: "s1",
				kind: "link",
				lock: prior,
				proposedLock: proposed,
				expectedWriteId: "old",
				writeId: "link",
			},
		},
	});
	let current: { lock: SessionLock | null; writeId: string } = { lock: proposed, writeId: "link" };
	await resumeLinkRepairs(
		store,
		async (_, lock, expected, id) => {
			assert.equal(expected, current.writeId);
			current = { lock: lock!, writeId: id! };
			return true;
		},
		{ readLock: async () => current },
	);
	assert.deepEqual(current.lock, prior);
	assert.deepEqual(store.value().repairs, {});
});

it("retains a failed unlink journal, and clears the lock after retry succeeds", async () => {
	const { store } = fakeState({
		bindings: { c1: { session: "s1" } },
		pending: { p1: { session: "s1" } },
		repairs: { s1: { session: "s1", kind: "unlink", lock: null, expectedWriteId: "locked", writeId: "released" } },
	});
	let first = true;
	const write = async (_session: string, _lock: unknown, expected: unknown, id?: string) => {
		assert.equal(expected, "locked");
		assert.equal(id, "released");
		if (first) {
			first = false;
			throw Error("write error");
		}
		return true;
	};
	const readLock = async () => ({ lock: null, writeId: "locked" });
	await assert.rejects(resumeLinkRepairs(store, write, { readLock }), /write error/);
	assert.deepEqual(store.value().bindings, {});
	assert.deepEqual(store.value().pending, {});
	assert.ok(store.value().repairs.s1);
	await resumeLinkRepairs(store, write, { readLock });
	assert.deepEqual(store.value().repairs, {});
});

it("finishes a first-attempt lock CAS and writes the desired wake policy", async () => {
	const wake = { anyone: false, users: ["owner"], roles: [] };
	const { store } = fakeState({
		bindings: { c1: { session: "s1", wake: { anyone: true, users: [], roles: [] } } },
		pending: {},
		repairs: { s1: { session: "s1", kind: "update", lock: null, wake, expectedWriteId: "old", writeId: "new" } },
	});
	let writes = 0;
	await resumeLinkRepairs(
		store,
		async () => {
			writes++;
			return true;
		},
		{ readLock: async () => ({ lock: null, writeId: "old" }) },
	);
	assert.equal(writes, 1);
	assert.deepEqual(store.value().bindings.c1.wake, wake);
	assert.deepEqual(store.value().repairs, {});
});

it("keeps a committed link and does not alter its lock during recovery", async () => {
	const { store } = fakeState({
		bindings: { c1: { session: "s1" } },
		pending: {},
		repairs: {
			s1: { session: "s1", kind: "link", lock: null, proposedLock: null, expectedWriteId: "old", writeId: "link" },
		},
	});
	let writes = 0;
	await resumeLinkRepairs(store, async () => {
		writes++;
		return true;
	});
	assert.equal(writes, 0);
	assert.deepEqual(store.value().repairs, {});
});

it("does not revert a lock the owner changed after an interrupted link", async () => {
	const prior = { mcp: ["wide"], projectMcp: true, instructions: true, capabilities: ["tools"] };
	const proposed = { mcp: [], projectMcp: false, instructions: false, capabilities: [] };
	const { store } = fakeState({
		bindings: {},
		pending: {},
		repairs: {
			s1: {
				session: "s1",
				kind: "link",
				lock: prior,
				proposedLock: proposed,
				expectedWriteId: "old",
				writeId: "link",
			},
		},
	});
	let writes = 0;
	await resumeLinkRepairs(
		store,
		async () => {
			writes++;
			return false;
		},
		{ readLock: async () => ({ lock: proposed, writeId: "owner" }) },
	);
	assert.equal(writes, 0);
	assert.deepEqual(store.value().repairs, {});
});

it("waits for in-flight admissions before release of the session lock", async () => {
	const { store } = fakeState({
		bindings: { c1: { session: "s1" } },
		pending: {},
		repairs: {
			s1: { session: "s1", kind: "unlink", lock: null, expectedWriteId: "old", writeId: "new" },
		},
	});
	let drain!: () => void;
	const gate = new Promise<void>((resolve) => {
		drain = resolve;
	});
	let unlocked = false;
	const running = resumeLinkRepairs(
		store,
		async () => {
			unlocked = true;
			return true;
		},
		{ readLock: async () => ({ lock: null, writeId: "old" }), beforeUnlock: async () => gate },
	);
	await new Promise<void>((resolve) => setImmediate(resolve));
	assert.equal(unlocked, false);
	drain();
	await running;
	assert.equal(unlocked, true);
});

it("keeps unlink repair durable when the worker cannot be notified, then retries", async () => {
	const { store } = fakeState({
		bindings: { c1: { session: "s1" } },
		pending: {},
		repairs: { s1: { session: "s1", kind: "unlink", lock: null, expectedWriteId: "old", writeId: "new" } },
	});
	let notices = 0;
	const notifyUnlinked = async () => {
		if (++notices === 1) throw Error("worker unavailable");
	};
	const readLock = async () => ({ lock: null, writeId: "old" });
	await assert.rejects(
		resumeLinkRepairs(store, async () => true, { notifyUnlinked, readLock }),
		/worker unavailable/,
	);
	assert.ok(store.value().repairs.s1);
	await resumeLinkRepairs(store, async () => true, { notifyUnlinked, readLock });
	assert.equal(notices, 2);
	assert.deepEqual(store.value().repairs, {});
});

it("restores prior lock only if the interrupted link's write identity is still current", async () => {
	const prior = { mcp: ["all"], projectMcp: false, instructions: true, capabilities: [] };
	const restrictive = { mcp: [], projectMcp: false, instructions: false, capabilities: [] };
	const { store } = fakeState({
		bindings: {},
		pending: {},
		repairs: {
			s1: {
				session: "s1",
				kind: "link",
				lock: prior,
				proposedLock: restrictive,
				expectedWriteId: "original",
				writeId: "link-attempt",
			},
		},
	});
	let current: { lock: SessionLock | null; writeId: string } = { lock: restrictive, writeId: "link-attempt" };
	await resumeLinkRepairs(
		store,
		async (_, lock, expected, newWriteId) => {
			if (expected !== current.writeId) return false;
			assert.ok(newWriteId);
			current = { lock: lock!, writeId: newWriteId };
			return true;
		},
		{ readLock: async () => current },
	);
	assert.deepEqual(current.lock, prior);
	assert.notEqual(current.writeId, "link-attempt");
	assert.deepEqual(store.value().repairs, {});
});

it("never restores a broad old lock after B-C-B owner edits with the same value", async () => {
	const oldWide = { mcp: ["*"], projectMcp: true, instructions: true, capabilities: [] };
	const narrow = { mcp: [], projectMcp: false, instructions: false, capabilities: [] };
	const { store } = fakeState({
		bindings: {},
		pending: {},
		repairs: {
			s1: {
				session: "s1",
				kind: "link",
				lock: oldWide,
				proposedLock: narrow,
				expectedWriteId: "old",
				writeId: "link",
			},
		},
	});
	let called = false;
	await resumeLinkRepairs(
		store,
		async () => {
			called = true;
			return false;
		},
		{ readLock: async () => ({ lock: narrow, writeId: "owner-reapplied-B" }) },
	);
	assert.equal(called, false);
	assert.deepEqual(store.value().repairs, {});
});

it("rolls wake policy forward after lock CAS succeeded but before binding write", async () => {
	const narrow = { mcp: [], projectMcp: false, instructions: false, capabilities: [] };
	const wake = { anyone: false, users: ["owner"], roles: [] };
	const { store } = fakeState({
		bindings: {
			c1: { session: "s1", wake: { anyone: true, users: [], roles: [] } },
		},
		pending: {},
		repairs: {
			s1: { session: "s1", kind: "update", lock: narrow, wake, expectedWriteId: "old", writeId: "committed" },
		},
	});
	let calls = 0;
	await resumeLinkRepairs(
		store,
		async () => {
			calls++;
			throw new Error("must not repeat CAS");
		},
		{ readLock: async () => ({ lock: narrow, writeId: "committed" }) },
	);
	assert.equal(calls, 0);
	assert.deepEqual(store.value().bindings.c1.wake, wake);
	assert.deepEqual(store.value().repairs, {});
});

it("reports a conflicting owner lock update instead of claiming wake policy succeeded", async () => {
	const wideWake = { anyone: true, users: [], roles: [] };
	const { store } = fakeState({
		bindings: { c1: { session: "s1", wake: wideWake } },
		pending: {},
		repairs: {
			s1: {
				session: "s1",
				kind: "update",
				lock: null,
				wake: { anyone: false, users: ["owner"], roles: [] },
				expectedWriteId: "before",
				writeId: "ours",
			},
		},
	});
	await assert.rejects(
		resumeLinkRepairs(
			store,
			async () => {
				throw Error("must not mutate lock");
			},
			{ readLock: async () => ({ lock: null, writeId: "another-owner" }) },
		),
		/conflict/i,
	);
	assert.deepEqual(store.value().bindings.c1.wake, wideWake);
	assert.deepEqual(store.value().repairs, {});
});

it("does not unlock until worker has canceled queued and running Discord turns", async () => {
	const { store } = fakeState({
		bindings: { c1: { session: "s1" } },
		pending: {},
		repairs: { s1: { session: "s1", kind: "unlink", lock: null, expectedWriteId: "locked", writeId: "unlocked" } },
	});
	let release!: () => void;
	const cancellation = new Promise<void>((resolve) => {
		release = resolve;
	});
	let locked = true;
	const running = resumeLinkRepairs(
		store,
		async () => {
			locked = false;
			return true;
		},
		{
			readLock: async () => ({ lock: null, writeId: "locked" }),
			notifyUnlinked: async () => cancellation,
		},
	);
	await new Promise<void>((resolve) => setImmediate(resolve));
	assert.equal(locked, true, "running turn is still protected");
	release();
	await running;
	assert.equal(locked, false);
});
