import { mkdtempSync, rmSync, writeFileSync, mkdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { parseBenchmarkArgs, measureWorkload } from "./bench-runtime-metrics.mjs";

const options = parseBenchmarkArgs(process.argv.slice(2));
// Execute real production session APIs after "npm run build:offline".
const { SessionManager, loadEntriesFromFile } =
  await import("../packages/coding-agent/dist/core/session-manager.js");
const directory = mkdtempSync(join(tmpdir(), "pi-runtime-bench-"));

try {
  const session = SessionManager.inMemory();
  let midpoint;
  for (let i = 0; i < options.entries; i++) {
    const id = session.appendCustomEntry("benchmark", { seq: i, payload: "x".repeat(80) });
    if (i === Math.floor(options.entries / 2)) midpoint = id;
  }
  session.branch(midpoint);
  for (let i = 0; i < Math.min(500, Math.max(1, options.entries / 10)); i++) {
    session.appendCustomEntry("benchmark-alt", { seq: i });
  }

  const file = join(directory, "session.jsonl");
  const records = [session.getHeader(), ...session.getEntries()];
  writeFileSync(file, records.map((record) => JSON.stringify(record)).join("\n") + "\n");

  const config = { samples: options.samples, warmups: options.warmups };
  const workloads = [
    await measureWorkload("session.getBranch", () => session.getBranch(), config),
    await measureWorkload("session.getTree", () => session.getTree(), config),
    await measureWorkload("session.getChildren", () => session.getChildren(midpoint), config),
    await measureWorkload("loadEntriesFromFile", () => loadEntriesFromFile(file), config),
  ];

  const report = {
    schemaVersion: 1,
    runAt: new Date().toISOString(),
    commit: process.env.GITHUB_SHA ?? null,
    node: process.version,
    platform: process.platform,
    arch: process.arch,
    fixtures: { sessionEntries: session.getEntryCount(), jsonlBytes: statSync(file).size },
    workloads,
  };
  const serialized = JSON.stringify(report, null, 2) + "\n";
  if (options.output) {
    const output = resolve(options.output);
    mkdirSync(dirname(output), { recursive: true });
    writeFileSync(output, serialized);
    console.log("Wrote runtime benchmark report: " + output);
  } else {
    process.stdout.write(serialized);
  }
} finally {
  rmSync(directory, { recursive: true, force: true });
}
