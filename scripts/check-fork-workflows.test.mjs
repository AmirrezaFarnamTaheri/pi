import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import assert from "node:assert/strict";
import { auditForkWorkflows } from "./check-fork-workflows.mjs";
import YAML from "yaml";

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

test("platform release assets are hashed separately and verified before upload", () => {
  const release = readFileSync(join(import.meta.dirname, "..", ".github/workflows/fork-github-release.yml"), "utf8");
  const publish = release.slice(release.indexOf("  build-and-publish:"));
  assert.match(publish, /SHA256SUMS-\$RELEASE_PLATFORM/);
  assert.match(publish, /sha256sum -c/);
  assert.match(publish, /shasum -a 256 -c/);
  assert.match(publish, /gh release upload/);
  assert.doesNotMatch(publish, /needs:\s*\[build, smoke-test\]/);
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

test("fork prerelease verifies exact-SHA CI and publishes six installable platforms independently", () => {
  const release = readFileSync(join(import.meta.dirname, "..", ".github/workflows/fork-github-release.yml"), "utf8");
  const parsed = YAML.parse(release);
  const prepare = release.slice(release.indexOf("  prepare:"), release.indexOf("  build-and-publish:"));
  assert.match(prepare, /actions\/workflows\/ci\.yml\/runs/);
  assert.match(prepare, /actions\/workflows\/p2-ci\.yml\/runs/);
  assert.equal((prepare.match(/verify-fork-release-ci\.mjs "\$GITHUB_SHA"/g) ?? []).length, 2);
  const job = parsed.jobs["build-and-publish"];
  assert.equal(job.needs, "prepare");
  assert.equal(job.strategy["fail-fast"], false);
  assert.deepEqual(job.strategy.matrix.include, [
    { runner: "ubuntu-latest", platform: "linux-x64", arch: "X64" },
    { runner: "ubuntu-24.04-arm", platform: "linux-arm64", arch: "ARM64" },
    { runner: "macos-15-intel", platform: "darwin-x64", arch: "X64" },
    { runner: "macos-15", platform: "darwin-arm64", arch: "ARM64" },
    { runner: "windows-latest", platform: "windows-x64", arch: "X64" },
    { runner: "windows-11-arm", platform: "windows-arm64", arch: "ARM64" },
  ]);
  const platform = release.slice(release.indexOf("  build-and-publish:"));
  assert.match(platform, /RUNNER_ARCH/);
  assert.match(platform, /install\.sh/);
  assert.match(platform, /install\.ps1/);
  assert.match(platform, /smoke-test-codemode-binary\.mjs/);
  assert.match(platform, /gh release upload/);
  assert.doesNotMatch(release, /^  publish-github-release:/m);
});
