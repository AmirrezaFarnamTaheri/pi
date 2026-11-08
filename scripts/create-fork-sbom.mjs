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

/**
 * Follow only runtime dependencies of an installed artifact. Workspace links
 * resolve to their checked-in package entries; unrelated monorepo dev/test
 * packages are excluded. Fail closed on a missing nonoptional lock dependency.
 */
function dependencyClosure(packages, rootPath) {
  if (!Object.hasOwn(packages, rootPath)) throw new Error(`Missing artifact root in npm lock: ${rootPath}`);
  const visited = new Set();
  const pending = [rootPath];
  const workspaceNames = new Map();
  for (const [path, entry] of Object.entries(packages)) {
    if (entry?.link && typeof entry.resolved === "string") {
      workspaceNames.set(entry.resolved, packageName(path, entry));
    }
  }
  const resolveDependency = (path, name) => {
    let prefix = path;
    for (;;) {
      const candidate = `${prefix ? prefix + "/" : ""}node_modules/${name}`;
      if (Object.hasOwn(packages, candidate)) return candidate;
      const marker = prefix.lastIndexOf("/node_modules/");
      if (marker >= 0) {
        prefix = prefix.slice(0, marker);
      } else if (prefix.startsWith("node_modules/") || prefix) {
        prefix = "";
      } else break;
    }
    return undefined;
  };
  while (pending.length) {
    let path = pending.shift();
    if (visited.has(path)) continue;
    const entry = packages[path];
    if (!entry) throw new Error(`Missing locked dependency: ${path}`);
    if (entry.link) {
      if (!entry.resolved || !Object.hasOwn(packages, entry.resolved)) {
        throw new Error(`Broken lock workspace link: ${path}`);
      }
      pending.push(entry.resolved);
      continue;
    }
    visited.add(path);
    const dependencies = {
      ...(entry.dependencies ?? {}),
      ...(entry.optionalDependencies ?? {}),
      ...(entry.peerDependencies ?? {}),
    };
    for (const name of Object.keys(dependencies).sort()) {
      const resolved = resolveDependency(path, name);
      if (resolved) pending.push(resolved);
      else if (!Object.hasOwn(entry.optionalDependencies ?? {}, name) &&
        !entry.peerDependenciesMeta?.[name]?.optional) {
        throw new Error(`Missing locked runtime dependency ${name} from ${path || "<root>"}`);
      }
    }
  }
  return { paths: [...visited].filter((path) => path !== rootPath), workspaceNames };
}

/** Build a deterministic CycloneDX 1.5 SBOM from the reviewed npm lockfile. */
export function createCycloneDxBom(lock, { sourceSha = "", sourceDateEpoch = 0, rootPath } = {}) {
  if (lock?.lockfileVersion !== 3 || !lock.packages || typeof lock.packages !== "object") {
    throw new Error("Expected a version 3 npm package-lock with packages");
  }
  const scope = rootPath === undefined ? undefined : dependencyClosure(lock.packages, rootPath);
  const entries = scope
    ? scope.paths.map((path) => [path, lock.packages[path]])
    : Object.entries(lock.packages);
  const components = new Map();
  for (const [path, entry] of entries) {
    if (!entry || typeof entry !== "object" || entry.link === true) continue;
    if (rootPath === undefined && !path.includes("node_modules/")) continue;
    const name = scope?.workspaceNames.get(path) ?? packageName(path, entry);
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
        type: "application",
        name: rootPath === undefined ? (lock.name || "pi-fork")
          : (scope.workspaceNames.get(rootPath) ?? lock.packages[rootPath].name ?? lock.name ?? rootPath),
        version: rootPath === undefined ? (lock.version || "unknown")
          : (lock.packages[rootPath].version ?? lock.version ?? "unknown"),
        ...(source ? { properties: [{ name: "pi:source-git-sha", value: source }] } : {}),
      },
    },
    components: [...components.values()].sort((a, b) => a["bom-ref"].localeCompare(b["bom-ref"], "en")),
  };
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  if (process.argv.length !== 4 && process.argv.length !== 5) throw new Error("Usage: create-fork-sbom.mjs <package-lock.json> <out.json> [<artifact-root-path>]");
  const lock = JSON.parse(readFileSync(process.argv[2], "utf8"));
  writeFileSync(process.argv[3], `${JSON.stringify(createCycloneDxBom(lock, {
    sourceSha: process.env.GITHUB_SHA,
    sourceDateEpoch: process.env.SOURCE_DATE_EPOCH,
    ...(process.argv[4] === undefined ? {} : { rootPath: process.argv[4] }),
  }), null, 2)}\n`);
}
