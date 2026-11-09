import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
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
  const tail = workflow.slice(workflow.indexOf(unchanged[0]) + unchanged[0].length, workflow.indexOf("\n  verify:"));
  assert.match(tail, /echo "changed=true"/, "unchanged sync proposals must still run verification");
  assert.match(tail, /echo "proposed_sha=/);
});

test("root validation is read-only and formatting fixes are explicit", () => {
  const pkg = JSON.parse(readFileSync(join(import.meta.dirname, "..", "package.json"), "utf8"));
  assert.doesNotMatch(pkg.scripts.check, /biome-check\.mjs --write|npm run format|npm run fix|biome format --write/);
  assert.match(pkg.scripts.check, /biome-check\.mjs/);
  assert.match(pkg.scripts.format, /biome-check\.mjs --write/);
});

test("fork root scripts cannot publish into upstream-controlled package namespace", () => {
  const pkg = JSON.parse(readFileSync(join(import.meta.dirname, "..", "package.json"), "utf8"));
  for (const script of ["publish", "publish:dry", "release:patch", "release:minor", "release:major"]) {
    assert.equal(pkg.scripts[script], "node scripts/reject-upstream-release.mjs", script + " must fail closed");
  }
});

test("fork release uses hash-pinned catalog and requires a successful CI run for the exact source commit", () => {
  const root = join(import.meta.dirname, "..");
  const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  assert.equal(pkg.scripts["hydrate:fork-model-data"], "node scripts/hydrate-fork-model-data.mjs");
  const release = readFileSync(join(root, ".github/workflows/fork-github-release.yml"), "utf8");
  assert.doesNotMatch(release, /npm run hydrate:model-data/);
  assert.match(release, /npm run hydrate:fork-model-data/);
  assert.match(release, /actions\/workflows\/ci\.yml\/runs/);
  assert.match(release, /GITHUB_SHA/);
  assert.match(release, /git merge-base --is-ancestor/);
  assert.match(release, /sha256sum -c/);
});

test("corrupted release assets fail checksum verification before publication", () => {
  const root = mkdtempSync(join(tmpdir(), "pi-fork-checksum-"));
  try {
    const filename = "release-asset.tar.gz";
    writeFileSync(join(root, filename), "valid");
    const hash = createHash("sha256").update("valid").digest("hex");
    writeFileSync(join(root, "SHA256SUMS"), hash + "  " + filename + "\n");
    const available = spawnSync("sha256sum", ["--version"], { encoding: "utf8" });
    if (available.error && available.error.code === "ENOENT") {
      // macOS and Windows may not ship GNU coreutils; hosted Linux CI must.
      assert.notEqual(process.platform, "linux", "Linux CI requires sha256sum");
      return;
    }
    assert.equal(spawnSync("sha256sum", ["-c", "SHA256SUMS"], { cwd: root }).status, 0);
    writeFileSync(join(root, filename), "corrupted");
    assert.notEqual(spawnSync("sha256sum", ["-c", "SHA256SUMS"], { cwd: root }).status, 0);
    const release = readFileSync(join(import.meta.dirname, "..", ".github", "workflows", "fork-github-release.yml"), "utf8");
    const publish = release.slice(release.indexOf("  publish-github-release:"));
    assert.match(publish, /set -euo pipefail[\s\S]*sha256sum -c SHA256SUMS[\s\S]*gh release create/);
    assert.doesNotMatch(publish.slice(0, publish.indexOf("gh release create")), /sha256sum -c SHA256SUMS\s*\|\|\s*true/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("fork release supports an explicit manual rerun on the verified release branch only", () => {
  const release = readFileSync(
    join(import.meta.dirname, "..", ".github", "workflows", "fork-github-release.yml"), "utf8",
  );
  assert.match(release, /^on:\s*\n(?:\s*#.*\n)*\s*workflow_dispatch:\s*\n(?:\s*#.*\n)*\s*push:/m);
  assert.match(
    release,
    /if:\s*github\.repository == 'AmirrezaFarnamTaheri\/pi' && startsWith\(github\.ref, 'refs\/heads\/release\/fork-v'\)/,
    "manual dispatch must not build or publish arbitrary branches",
  );
  assert.match(release, /git merge-base --is-ancestor/);
  assert.match(release, /verify-fork-release-ci\.mjs/);
});
