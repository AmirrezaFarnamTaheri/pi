import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";

/**
 * Exercise the launcher's actual hostPath implementation, without booting a
 * Gondolin VM or importing the top-level CLI (which runs immediately).
 */
function fromLauncher(home: string): (path: string, readonly: boolean) => string {
	const filename = fileURLToPath(new URL("../../plugins/envs/sandbox/p2-sandbox.mjs", import.meta.url));
	const source = readFileSync(filename, "utf8");
	const start = source.indexOf("function hostPath(");
	const end = source.indexOf("\n// --- Clients", start);
	assert(start >= 0 && end > start, "launcher hostPath source must be present");
	return runInNewContext(`${source.slice(start, end)}\nhostPath`, {
		homedir: () => home,
		isAbsolute,
		basename,
		dirname,
		join,
		resolve,
		existsSync,
		mkdirSync,
		realpathSync,
	}) as (path: string, readonly: boolean) => string;
}

describe("sandbox protected writable host mounts", () => {
	it("blocks direct and symlink-aliased access to ~/.pi while permitting read-only access", () => {
		const base = mkdtempSync(join(tmpdir(), "pi-sandbox-mount-"));
		try {
			const home = join(base, "home");
			mkdirSync(join(home, ".pi", "secrets"), { recursive: true });
			symlinkSync(join(home, ".pi"), join(base, "alias"));
			const hostPath = fromLauncher(home);
			assert.throws(() => hostPath(join(home, ".pi"), false), /writable folder/i);
			assert.throws(() => hostPath(join(base, "alias"), false), /writable folder/i);
			assert.throws(() => hostPath(join(base, "alias", "secrets"), false), /writable folder/i);
			assert.throws(() => hostPath(join(base, "alias", "new-child"), false), /writable folder/i);
			assert.equal(existsSync(join(home, ".pi", "new-child")), false, "a rejected mount creates nothing protected");
			assert.throws(() => hostPath(home, false), /writable folder/i);
			assert.equal(hostPath(join(base, "alias", "secrets"), true), realpathSync(join(home, ".pi", "secrets")));
			assert.equal(hostPath(join(base, "safe-mount"), false), join(base, "safe-mount"));
		} finally {
			rmSync(base, { recursive: true, force: true });
		}
	});

	it("rejects writable ancestors of a symlinked ~/.pi directory", () => {
		const base = mkdtempSync(join(tmpdir(), "pi-sandbox-protected-"));
		try {
			const home = join(base, "home");
			const sensitive = join(base, "private-state");
			mkdirSync(home, { recursive: true });
			mkdirSync(sensitive, { recursive: true });
			symlinkSync(sensitive, join(home, ".pi"));
			const hostPath = fromLauncher(home);
			assert.throws(() => hostPath(base, false), /writable folder/i);
			assert.throws(() => hostPath(sensitive, false), /writable folder/i);
			assert.throws(() => hostPath(join(home, ".pi"), false), /writable folder/i);
			assert.equal(hostPath(sensitive, true), realpathSync(sensitive));
		} finally {
			rmSync(base, { recursive: true, force: true });
		}
	});
});
