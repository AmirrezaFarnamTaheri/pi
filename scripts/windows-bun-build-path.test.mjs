import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { test } from "node:test";

const scripts = import.meta.dirname;

function mockCompilerArguments(platform, outfile) {
  const root = mkdtempSync(join(tmpdir(), "pi-bun-outfile-"));
  try {
    const bin = join(root, "bin");
    mkdirSync(bin);
    const cygpath = join(bin, "cygpath");
    const bun = join(bin, "bun");
    const capture = join(root, "args.txt");
    writeFileSync(cygpath, "#!/bin/sh\n[ \"$1\" = '-w' ] || exit 4\nprintf '%s\\n' 'D:\\a\\pi\\binaries\\windows-x64\\pi.exe'\n");
    writeFileSync(bun, "#!/bin/sh\nprintf '%s\\n' \"$@\" > \"$CAPTURE_BUN_ARGS\"\n");
    chmodSync(cygpath, 0o755);
    chmodSync(bun, 0o755);
    const result = spawnSync("bash", ["-c", 'source "$HELPER"; pi_bun_compile "$PLATFORM" "$TARGET" "$OUTFILE"'], {
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: bin + delimiter + (process.env.PATH ?? ""),
        HELPER: join(scripts, "bun-compiler-path.sh"),
        PLATFORM: platform,
        TARGET: "bun-" + platform,
        OUTFILE: outfile,
        CAPTURE_BUN_ARGS: capture,
      },
    });
    assert.equal(result.status, 0, result.stderr);
    return readFileSync(capture, "utf8").trimEnd().split("\n");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test("Bun receives a drive-qualified Windows output path when invoked under Git Bash", () => {
  const args = mockCompilerArguments("windows-x64", "/d/a/pi/binaries/windows-x64/pi.exe");
  assert.equal(args.at(-2), "--outfile");
  assert.equal(args.at(-1), String.raw`D:\a\pi\binaries\windows-x64\pi.exe`);
});

test("Bun receives the original Unix path even when cygpath is installed", () => {
  const path = "/tmp/pi/binaries/linux-x64/pi";
  const args = mockCompilerArguments("linux-x64", path);
  assert.equal(args.at(-2), "--outfile");
  assert.equal(args.at(-1), path);
});

test("Release builder uses the tested compiler wrapper", () => {
  const build = readFileSync(join(scripts, "build-binaries.sh"), "utf8");
  assert.match(build, /source \.\.\/\.\.\/scripts\/bun-compiler-path\.sh/);
  assert.match(build, /pi_bun_compile "\$platform" "\$bun_target" "\$outfile"/);
});
