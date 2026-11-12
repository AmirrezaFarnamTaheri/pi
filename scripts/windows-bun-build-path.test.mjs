import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

test("Windows Bun compiler output uses a native Windows path under Git Bash", () => {
  const build = readFileSync(join(import.meta.dirname, "build-binaries.sh"), "utf8");
  assert.match(build, /cygpath -w "\$outfile"/, "Bun.exe needs a drive-qualified outfile path on Git Bash");
  assert.match(build, /--outfile "\$outfile"/, "Bun must use the translated path");
  assert.match(build, /if \[\[ "\$platform" == windows-\* \]\]/, "Unix builds must keep their Unix paths");
});
