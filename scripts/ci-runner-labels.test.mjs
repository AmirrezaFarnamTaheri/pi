import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import YAML from "yaml";

const root = join(import.meta.dirname, "..");

test("macOS ARM64 daemon, environment, and release jobs use the alternative hosted runner pool", () => {
  const workflows = join(root, ".github", "workflows");
  const daemons = YAML.parse(readFileSync(join(workflows, "env-daemons.yml"), "utf8"));
  const daemonArm = daemons.jobs.build.strategy.matrix.include.find((row) => row.name === "darwin-arm64");
  assert.ok(daemonArm, "ARM64 daemon target must exist");
  assert.equal(daemonArm.runner, "macos-26");

  const env = YAML.parse(readFileSync(join(workflows, "env.yml"), "utf8"));
  assert.ok(env.jobs.tests.strategy.matrix.os.includes("macos-26"), "environment test must run on Apple Silicon");
  const releaseArm = env.jobs["release-daemons"].strategy.matrix.include.find((row) => row.name === "darwin-arm64");
  assert.ok(releaseArm);
  assert.equal(releaseArm.os, "macos-26");

  const binaryRelease = YAML.parse(readFileSync(join(workflows, "fork-github-release.yml"), "utf8"));
  const binaryArm = binaryRelease.jobs["build-and-publish"].strategy.matrix.include.find(
    (row) => row.platform === "darwin-arm64",
  );
  assert.ok(binaryArm);
  assert.equal(binaryArm.runner, "macos-26");

  // Keep Intel jobs native on Intel; do not silently cross-run ARM64 artifacts.
  assert.equal(
    binaryRelease.jobs["build-and-publish"].strategy.matrix.include.find(
      (row) => row.platform === "darwin-x64",
    ).runner,
    "macos-15-intel",
  );
});
