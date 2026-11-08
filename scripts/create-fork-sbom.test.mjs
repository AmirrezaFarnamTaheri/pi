import assert from "node:assert/strict";
import { test } from "node:test";
import { createCycloneDxBom } from "./create-fork-sbom.mjs";

test("CycloneDX lists each distinct locked npm package once and is deterministic", () => {
  const lock = {
    name: "fork", version: "1.5.0", lockfileVersion: 3, packages: {
      "": { name: "fork", version: "1.5.0" },
      "node_modules/a": { version: "1.0.0" },
      "node_modules/b/node_modules/a": { version: "1.0.0" },
      "node_modules/@scope/z": { version: "2.0.0", integrity: "sha512-" + Buffer.from("test").toString("base64") },
      "packages/ai": { name: "fork-ai", version: "1.5.0" },
    },
  };
  const bom = createCycloneDxBom(lock, { sourceSha: "123456", sourceDateEpoch: 5 });
  assert.equal(bom.specVersion, "1.5");
  assert.equal(bom.components.length, 2);
  assert.deepEqual(bom.components.map((part) => part.name), ["@scope/z", "a"]);
  assert.deepEqual(bom.components[0].hashes, [{ alg: "SHA-512", content: Buffer.from("test").toString("hex") }]);
  assert.equal(bom.metadata.timestamp, "1970-01-01T00:00:05.000Z");
  assert.equal(JSON.stringify(bom), JSON.stringify(createCycloneDxBom(lock, { sourceSha: "123456", sourceDateEpoch: 5 })));
});
