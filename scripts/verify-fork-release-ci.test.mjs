import assert from "node:assert/strict";
import { test } from "node:test";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { assertSuccessfulMainPush } from "./verify-fork-release-ci.mjs";

const sha = "a".repeat(40);
test("release gate accepts only an exact-SHA successful main push run", () => {
  const expected = { head_sha: sha, head_branch: "main", event: "push", status: "completed", conclusion: "success" };
  assert.doesNotThrow(() => assertSuccessfulMainPush({ workflow_runs: [expected] }, sha));
  for (const fields of [
    { event: "pull_request" },
    { head_branch: "topic-branch" },
    { head_sha: "b".repeat(40) },
    { conclusion: "skipped" },
    { conclusion: "failure" },
    { status: "in_progress" },
  ]) assert.throws(() => assertSuccessfulMainPush({ workflow_runs: [{ ...expected, ...fields }] }, sha), /successful main push/i);
  assert.throws(() => assertSuccessfulMainPush({ workflow_runs: [] }, sha), /successful main push/i);
});

test("release verifier CLI accepts a successful exact main push from stdin", () => {
  const run = { head_sha: sha, head_branch: "main", event: "push", status: "completed", conclusion: "success" };
  const cli = fileURLToPath(new URL("./verify-fork-release-ci.mjs", import.meta.url));
  const result = spawnSync(process.execPath, [cli, sha], {
    input: JSON.stringify({ workflow_runs: [run] }), encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /verified/i);
});

test("release verifier CLI fails closed for PR runs, missing checks, bad SHA or invalid stdin", () => {
  const cli = fileURLToPath(new URL("./verify-fork-release-ci.mjs", import.meta.url));
  for (const [argv, input] of [
    [[sha], JSON.stringify({ workflow_runs: [] })],
    [[sha], JSON.stringify({ workflow_runs: [
      { head_sha: sha, head_branch: "main", event: "pull_request",
        status: "completed", conclusion: "success" },
    ] })],
    [["not-a-sha"], JSON.stringify({ workflow_runs: [] })],
    [[sha], "not valid json"],
    [[], JSON.stringify({ workflow_runs: [] })],
  ]) {
    const result = spawnSync(process.execPath, [cli, ...argv], { input, encoding: "utf8" });
    assert.notEqual(result.status, 0, `unsafe release gate accepted ${argv.join(" ")}: ${input}`);
    assert.notEqual(result.stderr.trim(), "", "CLI must explain rejected releases");
  }
});
