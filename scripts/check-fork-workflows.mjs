/**
 * Static policy for the fork's GitHub Actions workflows.
 * Do not reintroduce upstream-owned publishers, issue bots or release triggers.
 */
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import YAML from "yaml";

export const upstreamWorkflowNames = new Set([
  "approve-contributor.yml",
  "build-binaries.yml",
  "issue-analysis.yml",
  "issue-gate.yml",
  "issue-triage-labels.yml",
  "nix.yml",
  "p2-cloud-bundle.yml",
  "pr-gate.yml",
  "preview-packages.yml",
  "publish-model-catalog.yml",
  "remove-inprogress-on-close.yml",
]);

const upstreamEndpoints = /pkg\.earendil\.com|PI_ARTIFACTS_R2_|EARENDIL_ORG_READ_TOKEN|npm-publish|api\/report-install/;

export function auditForkWorkflows(root = resolve(fileURLToPath(new URL("..", import.meta.url)))) {
  const directory = join(root, ".github", "workflows");
  const violations = [];
  for (const required of ["ci.yml", "fork-github-release.yml", "sync-upstream.yml"]) {
    if (!existsSync(join(directory, required))) violations.push("Missing required fork workflow: " + required);
  }
  if (!existsSync(directory)) return violations;
  for (const file of readdirSync(directory).filter((name) => name.endsWith(".yml") || name.endsWith(".yaml"))) {
    const path = join(directory, file);
    const source = readFileSync(path, "utf8");
    if (upstreamWorkflowNames.has(file)) violations.push("Upstream-specific workflow still active: " + file);
    if (upstreamEndpoints.test(source)) violations.push("Upstream publication endpoint or token in: " + file);
    try {
      const parsed = YAML.parse(source);
      if (!parsed || typeof parsed !== "object" || !parsed.jobs) {
        violations.push("Missing jobs in workflow: " + file);
      }
    } catch (error) {
      violations.push("Invalid YAML in " + file + ": " + String(error));
    }
  }
  const sync = join(directory, "sync-upstream.yml");
  if (existsSync(sync)) {
    const body = readFileSync(sync, "utf8");
    if (!body.includes("gh pr create") || !body.includes("git merge --no-edit")) {
      violations.push("Upstream sync must propose a merge through a pull request");
    }
    if (/gh pr merge|git push origin main|git push --force/.test(body)) {
      violations.push("Upstream sync must not auto-merge or force-push main");
    }
    const prepare = body.split(/^  verify:/m)[0];
    if (/npm (ci|run|test)|bun run|node scripts\//.test(prepare)) {
      violations.push("Upstream code must not execute in the sync job with write permissions");
    }
    if (!body.includes("  verify:") || !body.includes("      contents: read") ||
        !body.includes("persist-credentials: false")) {
      violations.push("Upstream verification must run in a separate read-only job");
    }
  }
  return violations;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const errors = auditForkWorkflows();
  for (const message of errors) console.error(message);
  if (errors.length > 0) process.exitCode = 1;
  else console.log("Fork workflow policy: OK");
}
