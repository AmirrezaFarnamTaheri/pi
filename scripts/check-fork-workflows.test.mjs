import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
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

test("sync proposal retries verification after a previous failure even when its SHA is unchanged", () => {
  const workflow = readFileSync(join(import.meta.dirname, "..", ".github", "workflows", "sync-upstream.yml"), "utf8");
  const unchanged = workflow.match(/if \[ "\$\(git rev-parse HEAD\)" = "\$previous_head" \]; then([\s\S]*?)\n          fi/);
  assert.ok(unchanged, "an unchanged proposal must be considered explicitly");
  assert.doesNotMatch(unchanged[1], /changed=false|exit 0/, "do not skip verification of existing proposed SHA");
  assert.match(workflow, /echo "proposed_sha=\$\(git rev-parse HEAD\)"/);
  assert.match(workflow, /echo "changed=true"/);
});

test("root validation is read-only and formatting fixes are explicit", () => {
  const pkg = JSON.parse(readFileSync(join(import.meta.dirname, "..", "package.json"), "utf8"));
  assert.doesNotMatch(pkg.scripts.check, /biome-check\.mjs --write/);
  assert.match(pkg.scripts.check, /biome-check\.mjs/);
  assert.match(pkg.scripts.format, /biome-check\.mjs --write/);
});
