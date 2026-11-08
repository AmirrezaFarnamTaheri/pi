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
  const { store, locks } = fakeState({ bindings: {}, pending: {}, repairs: { s1: { session: "s1", kind: "link", lock: prior } } });
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
