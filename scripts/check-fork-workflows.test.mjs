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

test("P2 CI runs the full test-file set in isolated bounded shards", () => {
  const workflows = join(import.meta.dirname, "..", ".github", "workflows");
  const core = readFileSync(join(workflows, "ci.yml"), "utf8");
  assert.doesNotMatch(core, /^  p2-(?:virtual-list|check-test|check|test):/m,
    "P2 browser CI must remain a separate, visible workflow");

  const p2 = readFileSync(join(workflows, "p2-ci.yml"), "utf8");
  assert.match(p2, /^  p2-virtual-list:/m, "retain P2 virtual-list tests");
  assert.match(p2, /^  p2-check:/m, "retain P2 types and formatting checks");
  assert.match(p2, /^  p2-test:/m, "retain full P2 suite");

  const check = p2.slice(p2.indexOf("  p2-check:"), p2.indexOf("  p2-test:"));
  const generation = check.indexOf("run: npm run generate:models");
  const typecheck = check.indexOf("run: npm run check --workspace apps/p2");
  assert.ok(generation >= 0 && typecheck > generation, "generate models before typechecking P2");

  const full = p2.slice(p2.indexOf("  p2-test:"));
  assert.ok(full.includes("fail-fast: false"), "report every shard failure");
  assert.ok(full.includes("shard: [0, 1, 2, 3]"), "run all four shards");
  assert.ok(full.includes("find test -type f -name"), "enumerate all P2 test files");
  assert.ok(full.includes("*.test.ts"), "do not omit a test-file class");
  assert.ok(full.includes("((NR-1)%total)==shard"), "assign each file to exactly one shard");
  assert.ok(full.includes("for file in"), "run every selected file");
  assert.ok(full.includes("timeout --signal=TERM"), "bound hangs without dropping tests");
  assert.ok(full.includes("node --import ./src/source.ts --test"), "use the native P2 test harness");
  assert.ok(full.includes("exit ") && full.includes("failures"), "propagate all per-file failures");
  assert.doesNotMatch(full, /--test-skip-pattern|--test-name-pattern/, "do not filter failing tests");
});

test("fork prerelease verifies exact main P2 CI and smoke-tests all six native architectures", () => {
  const release = readFileSync(join(import.meta.dirname, "..", ".github/workflows/fork-github-release.yml"), "utf8");
  const build = release.slice(release.indexOf("  build:"), release.indexOf("  smoke-test:"));
  assert.match(build, /actions\\/workflows\\/ci\\.yml\\/runs/, "verify exact-SHA core CI");
  assert.match(build, /actions\\/workflows\\/p2-ci\\.yml\\/runs/, "verify exact-SHA P2 extended CI");
  assert.equal((build.match(/verify-fork-release-ci\\.mjs "\\$GITHUB_SHA"/g) ?? []).length, 2, "verify both suites");
  const smoke = release.slice(release.indexOf("  smoke-test:"), release.indexOf("  publish-github-release:"));
  const required = [
    ["ubuntu-latest", "linux-x64", "X64"],
    ["ubuntu-24.04-arm", "linux-arm64", "ARM64"],
    ["macos-15-intel", "darwin-x64", "X64"],
    ["macos-15", "darwin-arm64", "ARM64"],
    ["windows-latest", "win32-x64", "X64"],
    ["windows-11-arm", "win32-arm64", "ARM64"],
  ];
  for (const [runner, platform, arch] of required) {
    const row = smoke.includes(`runner: ${runner}\\n`) && smoke.includes(`platform: ${platform}\\n`) && smoke.includes(`arch: ${arch}\\n`);
    assert.ok(row, `missing smoke matrix runner ${runner} for ${platform} (${arch})`);
  }
  assert.equal((smoke.match(/^\\s+- runner:/gm) ?? []).length, required.length);
  assert.match(smoke, /matrix\\.platform/, "use the selected platform archive");
  assert.match(smoke, /RUNNER_ARCH/, "verify native runner architecture");
});
