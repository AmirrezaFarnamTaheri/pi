#!/usr/bin/env node
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const PIN_FORMAT = /^sha256-[0-9a-f]{64}$/;

/** The network location is fixed; only the pinned revision can vary. */
export function pinnedCatalogUrl(revision) {
  if (typeof revision !== "string" || !PIN_FORMAT.test(revision)) {
    throw new Error("Invalid pin: expected a sha256-<64 lowercase hex> revision");
  }
  return `https://pi.dev/api/models/revisions/${revision}?types=chat,image,classifier`;
}

/** Fail closed if upstream's response changed at the same immutable revision. */
export function verifyPinnedCatalogBytes(bytes, revision) {
  pinnedCatalogUrl(revision);
  const actual = `sha256-${createHash("sha256").update(bytes).digest("hex")}`;
  if (actual !== revision) throw new Error(`Pinned model catalog digest mismatch: expected ${revision}, got ${actual}`);
  return actual;
}

/** Network and file I/O can be injected so failures are tested without live credentials. */
export async function hydratePinnedModelData({
  root = resolve(dirname(fileURLToPath(import.meta.url)), ".."),
  tempRoot = tmpdir(),
  fetchCatalog = fetch,
  hydrate,
} = {}) {
  const { revision } = JSON.parse(readFileSync(join(root, "nix/model-catalog.json"), "utf8"));
  const url = pinnedCatalogUrl(revision);
  const response = await fetchCatalog(url, { signal: AbortSignal.timeout(60_000) });
  if (!response.ok) throw new Error(`Pinned model catalog fetch failed: HTTP ${response.status}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  verifyPinnedCatalogBytes(bytes, revision);
  const temporary = mkdtempSync(join(tempRoot, "pi-fork-model-catalog-"));
  try {
    const catalog = join(temporary, "models.all.json");
    writeFileSync(catalog, bytes);
    if (hydrate) await hydrate(join(root, "packages/ai"), catalog);
    else {
      const { hydrateModelCatalog } = await import("../packages/ai/scripts/hydrate-model-catalog.ts");
      hydrateModelCatalog(join(root, "packages/ai"), catalog);
    }
    return revision;
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}

async function main() {
  const revision = await hydratePinnedModelData();
  console.log(`Hydrated immutable model catalog ${revision}`);
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
