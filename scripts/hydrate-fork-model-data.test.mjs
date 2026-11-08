import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { describe, it } from "node:test";
import { verifyPinnedCatalogBytes, pinnedCatalogUrl } from "./hydrate-fork-model-data.mjs";

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
