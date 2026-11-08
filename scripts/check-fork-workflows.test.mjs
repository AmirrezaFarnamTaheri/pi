import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";
import { auditForkWorkflows } from "./check-fork-workflows.mjs";

test("fork workflow policy accepts this repository's workflow set", () => {
  assert.deepEqual(auditForkWorkflows(), []);
});

test("fork workflow policy rejects upstream publishers and undocumented workflows", () => {
  const root = mkdtempSync(join(tmpdir(), "pi-fork-workflows-"));
  try {
    const directory = join(root, ".github", "workflows");
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, "publish-model-catalog.yml"), "name: Upstream\non: push\njobs:\n  publish:\n    runs-on: ubuntu-latest\n");
    const errors = auditForkWorkflows(root);
    assert.ok(errors.some((error) => error.includes("Upstream-specific workflow")));
    assert.ok(errors.some((error) => error.includes("Missing required fork workflow")));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
