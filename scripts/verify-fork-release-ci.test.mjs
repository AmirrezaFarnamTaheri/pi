import assert from "node:assert/strict";
import { test } from "node:test";
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
