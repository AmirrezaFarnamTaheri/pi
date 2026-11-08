#!/usr/bin/env node
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

function packageName(path, entry) {
  if (typeof entry.name === "string" && entry.name) return entry.name;
  const last = path.lastIndexOf("node_modules/");
  if (last < 0) return undefined;
  const parts = path.slice(last + "node_modules/".length).split("/");
  return parts[0]?.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0];
}

function verifiedHashes(integrity) {
  if (typeof integrity !== "string") return undefined;
  const token = integrity.split(" ").find((value) => /^sha(256|384|512)-[A-Za-z0-9+/]+={0,2}$/.test(value));
  if (!token) return undefined;
  const [algo, base64] = token.split("-");
  return [{ alg: algo.toUpperCase().replace("SHA", "SHA-"), content: Buffer.from(base64, "base64").toString("hex") }];
}

/** Build a deterministic CycloneDX 1.5 SBOM from the reviewed npm lockfile. */
export function createCycloneDxBom(lock, { sourceSha = "", sourceDateEpoch = 0 } = {}) {
  if (lock?.lockfileVersion !== 3 || !lock.packages || typeof lock.packages !== "object") {
    throw new Error("Expected a version 3 npm package-lock with packages");
  }
  const components = new Map();
  for (const [path, entry] of Object.entries(lock.packages)) {
    if (!path.includes("node_modules/") || !entry || typeof entry !== "object" || entry.link === true) continue;
    const name = packageName(path, entry);
    if (!name || typeof entry.version !== "string" || !entry.version) continue;
    const id = `${name}@${entry.version}`;
    const hashes = verifiedHashes(entry.integrity);
    const component = {
      type: "library", "bom-ref": id, name, version: entry.version,
      purl: `pkg:npm/${encodeURIComponent(name)}@${encodeURIComponent(entry.version)}`,
      ...(hashes ? { hashes } : {}),
    };
    if (components.has(id) && JSON.stringify(components.get(id)) !== JSON.stringify(component)) {
      throw new Error(`Conflicting lock integrity for ${id}`);
    }
    components.set(id, component);
  }
  const source = String(sourceSha);
  if (source && !/^[0-9a-f]{6,40}$/.test(source)) throw new Error("Invalid source Git SHA");
  const date = new Date(Number(sourceDateEpoch) * 1000);
  if (!Number.isFinite(date.getTime())) throw new Error("Invalid source timestamp");
  return {
    bomFormat: "CycloneDX", specVersion: "1.5",
    serialNumber: "urn:uuid:00000000-0000-4000-8000-000000000000", version: 1,
    metadata: {
      timestamp: date.toISOString(),
      component: {
        type: "application", name: lock.name || "pi-fork", version: lock.version || "unknown",
        ...(source ? { properties: [{ name: "pi:source-git-sha", value: source }] } : {}),
      },
    },
    components: [...components.values()].sort((a, b) => a["bom-ref"].localeCompare(b["bom-ref"], "en")),
  };
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  if (process.argv.length !== 4) throw new Error("Usage: create-fork-sbom.mjs <package-lock.json> <out.json>");
  const lock = JSON.parse(readFileSync(process.argv[2], "utf8"));
  writeFileSync(process.argv[3], `${JSON.stringify(createCycloneDxBom(lock, {
    sourceSha: process.env.GITHUB_SHA,
    sourceDateEpoch: process.env.SOURCE_DATE_EPOCH,
  }), null, 2)}\n`);
}
