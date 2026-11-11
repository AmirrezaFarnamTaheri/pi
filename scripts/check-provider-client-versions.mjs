/**
 * Read-only release check for client identities whose minimum supported version can
 * change independently of pi's npm dependencies. Run weekly, not in the PR gate.
 * Update source pins and run provider OAuth/API regression tests before shipping.
 */
import { appendFileSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

export function compareVersions(a, b) {
  const semver = /^\d+\.\d+\.\d+$/;
  if (!semver.test(a) || !semver.test(b)) throw new Error(`Invalid stable version: ${a} or ${b}`);
  const lhs = a.split(".").map(Number), rhs = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    if (lhs[i] < rhs[i]) return -1;
    if (lhs[i] > rhs[i]) return 1;
  }
  return 0;
}

export function readPinnedVersion(source, variable) {
  if (!/^[a-zA-Z_$][\w$]*$/.test(variable)) throw new Error("Invalid variable name");
  const match = new RegExp(`\\bconst\\s+${variable}\\s*=\\s*["'](\\d+\\.\\d+\\.\\d+)["']`).exec(source);
  if (!match) throw new Error(`Version constant ${variable} not found`);
  return match[1];
}

export function identifyStale(entries) {
  return entries.flatMap(({ label, installed, latest, url }) => {
    const released = latest.replace(/^v/, "");
    return compareVersions(installed, released) < 0 ? [{ label, installed, latest: released, url }] : [];
  });
}

async function latestRelease(repo) {
  const token = process.env.GITHUB_TOKEN;
  const response = await fetch(`https://api.github.com/repos/${repo}/releases/latest`, {
    headers: {
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    signal: AbortSignal.timeout(15000),
  });
  if (!response.ok) throw new Error(`Cannot audit ${repo}: HTTP ${response.status}`);
  const data = await response.json();
  if (typeof data?.tag_name !== "string") throw new Error(`No release tag for ${repo}`);
  return data.tag_name;
}

export async function run() {
  const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
  const anthropic = readFileSync(resolve(root, "packages/ai/src/api/anthropic-messages.ts"), "utf8");
  const copilot = readFileSync(resolve(root, "packages/ai/src/auth/oauth/github-copilot.ts"), "utf8");
  const sources = [
    { label: "Claude Code", installed: readPinnedVersion(anthropic, "claudeCodeVersion"), repo: "anthropics/claude-code" },
    { label: "Copilot Chat", installed: readPinnedVersion(copilot, "COPILOT_CHAT_VERSION"), repo: "microsoft/vscode-copilot-chat" },
    { label: "VS Code", installed: readPinnedVersion(copilot, "VSCODE_VERSION"), repo: "microsoft/vscode" },
  ];
  const releases = await Promise.all(sources.map(async (entry) => ({
    label: entry.label,
    installed: entry.installed,
    latest: await latestRelease(entry.repo),
    url: `https://github.com/${entry.repo}/releases/latest`,
  })));
  const stale = identifyStale(releases);
  const summary = [
    "## Provider client identity audit",
    "",
    "This is a version-drift signal, not a proof that updating protocol headers is safe.",
    "",
    "| Client | Pinned | Latest stable |",
    "| --- | --- | --- |",
    ...releases.map((item) => `| ${item.label} | ${item.installed} | ${item.latest.replace(/^v/, "")} |`),
    "",
    stale.length
      ? "Review the provider's current minimum client version and update the pinned request headers with tests."
      : "All tested client identity pins match the latest stable releases.",
  ].join("\n") + "\n";
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary);
  else process.stdout.write(summary);
  for (const entry of stale) {
    console.error(`::warning::${entry.label}: pinned ${entry.installed}; released ${entry.latest}; ${entry.url}`);
  }
  if (stale.length > 0) process.exitCode = 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await run();
}
