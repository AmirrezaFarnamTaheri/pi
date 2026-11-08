import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { verifyPinnedCatalogBytes, pinnedCatalogUrl, hydratePinnedModelData } from "./hydrate-fork-model-data.mjs";

const digest = (data) => `sha256-${createHash("sha256").update(data).digest("hex")}`;

describe("immutable fork model data", () => {
  it("accepts only a catalog whose bytes match the committed revision", () => {
    const data = Buffer.from('{"provider":[]}');
    assert.equal(verifyPinnedCatalogBytes(data, digest(data)), digest(data));
    assert.throws(() => verifyPinnedCatalogBytes(Buffer.from("{}"), digest(data)), /digest mismatch/i);
  });

  it("rejects invalid revision strings before constructing a URL", () => {
    assert.throws(() => pinnedCatalogUrl("latest"), /invalid pin/i);
    assert.throws(() => pinnedCatalogUrl("sha256-" + "0".repeat(63) + "x"), /invalid pin/i);
    assert.equal(
      pinnedCatalogUrl(digest("abc")),
      `https://pi.dev/api/models/revisions/${digest("abc")}?types=chat,image,classifier`,
    );
  });
});

describe("fork model-data hydration entry point", () => {
  const setup = () => {
    const root = mkdtempSync(join(tmpdir(), "pi-fork-hydrate-test-"));
    mkdirSync(join(root, "nix"));
    mkdirSync(join(root, "packages", "ai"), { recursive: true });
    mkdirSync(join(root, "staging"));
    const bytes = Buffer.from('{"model":[]}');
    writeFileSync(join(root, "nix", "model-catalog.json"), JSON.stringify({ revision: digest(bytes) }));
    return { root, bytes };
  };
  it("refuses HTTP failures and digest mismatches before any disk hydration", async () => {
    const { root, bytes } = setup();
    let calls = 0;
    try {
      const options = { root, tempRoot: join(root, "staging"), hydrate: async () => { calls++; } };
      await assert.rejects(hydratePinnedModelData({ ...options, fetchCatalog: async () => new Response("missing", { status: 503 }) }), /HTTP 503/);
      await assert.rejects(hydratePinnedModelData({ ...options, fetchCatalog: async () => new Response("{}") }), /digest mismatch/i);
      assert.equal(calls, 0);
      assert.deepEqual(readdirSync(join(root, "staging")), []);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
  it("cleans temporary downloaded bytes on a failed hydration step", async () => {
    const { root, bytes } = setup();
    try {
      let checked = false;
      await assert.rejects(hydratePinnedModelData({
        root, tempRoot: join(root, "staging"),
        fetchCatalog: async () => new Response(bytes),
        hydrate: async (_packageRoot, input) => {
          checked = true;
          assert.deepEqual(readFileSync(input), bytes);
          throw new Error("hydrate failed");
        },
      }), /hydrate failed/);
      assert(checked);
      assert.deepEqual(readdirSync(join(root, "staging")), []);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
