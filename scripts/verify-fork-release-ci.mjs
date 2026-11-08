#!/usr/bin/env node
// Gate GitHub-only fork releases on the exact checked-in main-branch push commit.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

export function assertSuccessfulMainPush(response, sha) {
  if (!/^[0-9a-f]{40}$/.test(sha)) throw new Error("Invalid source Git SHA");
  if (!response || !Array.isArray(response.workflow_runs)) throw new Error("Invalid CI workflow-run response");
  const matched = response.workflow_runs.some((run) =>
    run.head_sha === sha &&
    run.head_branch === "main" &&
    run.event === "push" &&
    run.status === "completed" &&
    run.conclusion === "success"
  );
  if (!matched) throw new Error("No successful main push CI run exists for this exact source commit");
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try {
    const sha = process.argv[2];
    if (!sha || process.argv.length !== 3) throw new Error("Usage: verify-fork-release-ci.mjs <full-git-sha>");
    assertSuccessfulMainPush(JSON.parse(readFileSync(0, "utf8")), sha);
    console.log("Exact main push CI run verified");
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
