import assert from "node:assert/strict";
import { it } from "node:test";
import { resumeLinkRepairs } from "../../plugins/discord/link-recovery.ts";

const fakeState = (initial: object) => {
  let saved = structuredClone(initial) as any;
  const store = {
    value: () => saved,
    change: async (edit: (draft: any) => void) => {
      const draft = structuredClone(saved);
      edit(draft);
      saved = draft;
    },
  };
  const locks = new Map<string, any>();
  return { store, locks };
};

it("restores prior session lock after interrupted link and clears its repair", async () => {
  const prior = { mcp: [], projectMcp: false, instructions: false, capabilities: [] };
  const { store, locks } = fakeState({ bindings: {}, pending: {}, repairs: { s1: { session: "s1", kind: "link", lock: prior, proposedLock: { mcp: ["proposed"], projectMcp: false, instructions: false, capabilities: [] } } } });
  locks.set("s1", { mcp: ["unexpected"] });
  await resumeLinkRepairs(store, async (session, lock) => { locks.set(session, lock); });
  assert.deepEqual(locks.get("s1"), prior);
  assert.deepEqual(store.value().repairs, {});
});

it("completes interrupted unlink, retaining intent if clearing lock fails", async () => {
  const { store, locks } = fakeState({
    bindings: { c1: { session: "s1" } },
    pending: { p1: { session: "s1" } },
    repairs: { s1: { session: "s1", kind: "unlink", lock: null } },
  });
  await assert.rejects(resumeLinkRepairs(store, async () => { throw Error("write error"); }), /write error/);
  assert.deepEqual(store.value().bindings, {});
  assert.deepEqual(store.value().pending, {});
  assert.ok(store.value().repairs.s1, "retry intent retained");
  await resumeLinkRepairs(store, async (session, lock) => { locks.set(session, lock); });
  assert.equal(locks.get("s1"), null);
  assert.deepEqual(store.value().repairs, {});
});

it("finishes interrupted update of lock and wake policy", async () => {
  const wake = { anyone: false, users: ["owner"], roles: [] };
  const { store, locks } = fakeState({
    bindings: { c1: { session: "s1", wake: { anyone: true, users: [], roles: [] } } },
    pending: {},
    repairs: { s1: { session: "s1", kind: "update", lock: null, wake } },
  });
  await resumeLinkRepairs(store, async (session, lock) => { locks.set(session, lock); });
  assert.deepEqual(store.value().bindings.c1.wake, wake);
  assert.equal(locks.get("s1"), null);
  assert.deepEqual(store.value().repairs, {});
});

it("keeps a committed link and does not overwrite its live lock during recovery", async () => {
  const { store } = fakeState({
    bindings: { c1: { session: "s1" } }, pending: {},
    repairs: { s1: { session: "s1", kind: "link", lock: null } },
  });
  let writes = 0;
  await resumeLinkRepairs(store, async () => { writes++; });
  assert.equal(writes, 0);
  assert.deepEqual(store.value().repairs, {});
});

it("does not restore a stale lock when another owner modified it after an interrupted link", async () => {
  const previous = { mcp: ["wide"], projectMcp: true, instructions: true, capabilities: ["tools"] };
  const proposed = { mcp: [], projectMcp: false, instructions: false, capabilities: [] };
  const current = { mcp: [], projectMcp: false, instructions: false, capabilities: ["narrow"] };
  const { store } = fakeState({
    bindings: {}, pending: {},
    repairs: { s1: { session: "s1", kind: "link", lock: previous, proposedLock: proposed } },
  });
  let applied = 0;
  await resumeLinkRepairs(store, async (_session, _prior, expected) => {
    assert.deepEqual(expected, proposed);
    applied++;
    return false; // SessionLocks.compareAndSet rejected a newer lock.
  });
  assert.equal(applied, 1);
  assert.deepEqual(store.value().repairs, {});
  assert.deepEqual(current.capabilities, ["narrow"]);
});

it("does not release a lock until in-flight messages have drained", async () => {
  const { store } = fakeState({
    bindings: { c1: { session: "s1" } }, pending: {},
    repairs: { s1: { session: "s1", kind: "unlink", lock: null } },
  });
  let drain!: () => void;
  const gate = new Promise<void>((resolve) => { drain = resolve; });
  let unlocked = false;
  const repairing = resumeLinkRepairs(store, async () => { unlocked = true; }, {
    beforeUnlock: async () => gate,
  });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(unlocked, false);
  assert.deepEqual(store.value().bindings, {});
  drain();
  await repairing;
  assert.equal(unlocked, true);
});

it("keeps an unlink repair durable when notifying its worker fails, then retries it", async () => {
  const { store } = fakeState({
    bindings: { c1: { session: "s1" } }, pending: {},
    repairs: { s1: { session: "s1", kind: "unlink", lock: null } },
  });
  let notifications = 0;
  const notifyUnlinked = async () => {
    if (++notifications === 1) throw Error("worker unavailable");
  };
  await assert.rejects(resumeLinkRepairs(store, async () => {}, { notifyUnlinked }), /worker unavailable/);
  assert(store.value().repairs.s1, "failed worker notification retains retry intent");
  await resumeLinkRepairs(store, async () => {}, { notifyUnlinked });
  assert.equal(notifications, 2);
  assert.deepEqual(store.value().repairs, {});
});

it("restores prior lock only if the interrupted link's write identity is still current", async () => {
  const prior = { mcp: ["all"], projectMcp: false, instructions: true, capabilities: [] };
  const restrictive = { mcp: [], projectMcp: false, instructions: false, capabilities: [] };
  const { store } = fakeState({ bindings: {}, pending: {}, repairs: {
    s1: { session: "s1", kind: "link", lock: prior, proposedLock: restrictive,
      expectedWriteId: "original", writeId: "link-attempt" },
  } });
  let current = { lock: restrictive, writeId: "link-attempt" };
  await resumeLinkRepairs(store, async (_, lock, expected, newWriteId) => {
    if (expected !== current.writeId) return false;
    current = { lock, writeId: newWriteId };
    return true;
  }, { readLock: async () => current });
  assert.deepEqual(current.lock, prior);
  assert.notEqual(current.writeId, "link-attempt");
  assert.deepEqual(store.value().repairs, {});
});

it("never restores a broad old lock after B-C-B owner edits with the same value", async () => {
  const oldWide = { mcp: ["*"], projectMcp: true, instructions: true, capabilities: [] };
  const narrow = { mcp: [], projectMcp: false, instructions: false, capabilities: [] };
  const { store } = fakeState({ bindings: {}, pending: {}, repairs: {
    s1: { session: "s1", kind: "link", lock: oldWide, proposedLock: narrow,
      expectedWriteId: "old", writeId: "link" },
  } });
  let called = false;
  await resumeLinkRepairs(store, async () => { called = true; return false; },
    { readLock: async () => ({ lock: narrow, writeId: "owner-reapplied-B" }) });
  assert.equal(called, false);
  assert.deepEqual(store.value().repairs, {});
});

it("rolls wake policy forward after lock CAS succeeded but before binding write", async () => {
  const narrow = { mcp: [], projectMcp: false, instructions: false, capabilities: [] };
  const wake = { anyone: false, users: ["owner"], roles: [] };
  const { store } = fakeState({ bindings: {
    c1: { session: "s1", wake: { anyone: true, users: [], roles: [] } },
  }, pending: {}, repairs: {
    s1: { session: "s1", kind: "update", lock: narrow, wake,
      expectedWriteId: "old", writeId: "committed" },
  } });
  let calls = 0;
  await resumeLinkRepairs(store, async () => { calls++; throw new Error("must not repeat CAS"); },
    { readLock: async () => ({ lock: narrow, writeId: "committed" }) });
  assert.equal(calls, 0);
  assert.deepEqual(store.value().bindings.c1.wake, wake);
  assert.deepEqual(store.value().repairs, {});
});

it("reports a conflicting owner lock update instead of claiming wake policy succeeded", async () => {
  const wideWake = { anyone: true, users: [], roles: [] };
  const { store } = fakeState({ bindings: { c1: { session: "s1", wake: wideWake } },
    pending: {}, repairs: { s1: { session: "s1", kind: "update", lock: null,
      wake: { anyone: false, users: ["owner"], roles: [] },
      expectedWriteId: "before", writeId: "ours" } } });
  await assert.rejects(resumeLinkRepairs(store, async () => { throw Error("must not mutate lock"); },
    { readLock: async () => ({ lock: null, writeId: "another-owner" }) }), /conflict/i);
  assert.deepEqual(store.value().bindings.c1.wake, wideWake);
  assert.deepEqual(store.value().repairs, {});
});

it("does not unlock until worker has canceled queued and running Discord turns", async () => {
  const { store } = fakeState({ bindings: { c1: { session: "s1" } }, pending: {},
    repairs: { s1: { session: "s1", kind: "unlink", lock: null,
      expectedWriteId: "locked", writeId: "unlocked" } } });
  let release!: () => void;
  const cancellation = new Promise<void>((resolve) => { release = resolve; });
  let locked = true;
  const running = resumeLinkRepairs(store, async () => {
    locked = false; return true;
  }, {
    readLock: async () => ({ lock: null, writeId: "locked" }),
    notifyUnlinked: async () => cancellation,
  });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(locked, true, "running turn is still protected");
  release();
  await running;
  assert.equal(locked, false);
});
