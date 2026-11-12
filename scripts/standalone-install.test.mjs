import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, chmodSync, existsSync, lstatSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const root = join(import.meta.dirname, "..");

test("Unix installer installs executable and companion assets without npm or privileged paths", () => {
  if (process.platform === "win32") return;
  const temporary = mkdtempSync(join(tmpdir(), "pi-fork-standalone-install-"));
  try {
    const archive = join(temporary, "archive", "pi");
    mkdirSync(join(archive, "theme"), { recursive: true });
    writeFileSync(join(archive, "pi"), "#!/bin/sh\necho standalone-ok\n");
    chmodSync(join(archive, "pi"), 0o755);
    writeFileSync(join(archive, "theme", "default.json"), "{}");
    const install = join(root, "scripts", "install-standalone.sh");
    const installDir = join(temporary, "installed", "pi");
    const binDir = join(temporary, "installed", "bin");
    const env = { ...process.env, PI_INSTALL_DIR: installDir, PI_BIN_DIR: binDir };
    for (let attempt = 0; attempt < 2; attempt++) {
      const result = spawnSync("bash", [install], { cwd: archive, env, encoding: "utf8" });
      // Standalone installation uses the script's directory, not the caller's cwd.
      assert.notEqual(result.status, 0, "installer must reject a path missing its adjacent pi binary");
      writeFileSync(join(archive, "install.sh"), readFileSync(install));
      const installed = spawnSync("bash", [join(archive, "install.sh")], { cwd: temporary, env, encoding: "utf8" });
      assert.equal(installed.status, 0, installed.stderr);
      assert.ok(lstatSync(join(binDir, "pi")).isSymbolicLink());
      assert.equal(spawnSync(join(binDir, "pi"), [], { encoding: "utf8" }).stdout.trim(), "standalone-ok");
      assert.equal(readFileSync(join(installDir, "theme", "default.json"), "utf8"), "{}");
    }
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
});

test("Windows installer uses a user-local target and supports smoke tests without PATH writes", () => {
  const source = readFileSync(join(root, "scripts", "install-standalone.ps1"), "utf8");
  assert.match(source, /LOCALAPPDATA/);
  assert.match(source, /NoPathUpdate/);
  assert.match(source, /Copy-Item/);
  assert.match(source, /pi\.exe/);
});

test("binary archives contain their native installation script", () => {
  const source = readFileSync(join(root, "scripts", "build-binaries.sh"), "utf8");
  assert.match(source, /install-standalone\.sh/);
  assert.match(source, /install-standalone\.ps1/);
  const archive = readFileSync(join(root, "scripts", "create-source-archive.sh"), "utf8");
  assert.match(archive, /scripts\/install-standalone\.sh/);
  assert.match(archive, /scripts\/install-standalone\.ps1/);
});
