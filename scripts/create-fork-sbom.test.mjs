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

test("artifact-scoped SBOM walks workspace and transitive runtime dependencies but excludes unrelated root packages", () => {
  const lock = {
    name: "monorepo", version: "0.1.0", lockfileVersion: 3,
    packages: {
      "": { name: "monorepo", version: "0.1.0", devDependencies: { unrelated: "1.0.0" } },
      "packages/coding-agent": { version: "1.5.0", dependencies: { "@scope/pi-ai": "1.5.0", "a": "1.0.0" } },
      "node_modules/@scope/pi-ai": { link: true, resolved: "packages/ai" },
      "packages/ai": { version: "1.5.0", dependencies: { "@scope/z": "2.0.0" } },
      "node_modules/a": { version: "1.0.0" },
      "node_modules/@scope/z": { version: "2.0.0" },
      "node_modules/unrelated": { version: "1.0.0" },
    },
  };
  const bom = createCycloneDxBom(lock, { rootPath: "packages/coding-agent", sourceSha: "123456" });
  assert.deepEqual(bom.components.map((part) => part.name), ["@scope/pi-ai", "@scope/z", "a"]);
  assert.equal(bom.metadata.component.name, "packages/coding-agent");
  assert.throws(() => createCycloneDxBom(lock, { rootPath: "packages/does-not-exist" }), /Missing artifact root/i);
});

test("installer SBOM includes only packages reachable from its install-lock root", () => {
  const lock = {
    name: "pi-installer", version: "1", lockfileVersion: 3,
    packages: {
      "": { name: "pi-installer", version: "1", dependencies: { "@scope/pi-coding-agent": "1" } },
      "node_modules/@scope/pi-coding-agent": { version: "1", dependencies: { "a": "2" } },
      "node_modules/a": { version: "2" },
      "node_modules/unrelated": { version: "3" },
    },
  };
  const bom = createCycloneDxBom(lock, { rootPath: "" });
  assert.deepEqual(bom.components.map((part) => part.name), ["@scope/pi-coding-agent", "a"]);
});
