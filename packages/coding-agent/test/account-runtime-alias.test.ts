import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { ModelRuntime } from "../src/core/model-runtime.ts";

test("account aliases persist and do not replace the source provider or each other", async () => {
	const directory = mkdtempSync(join(tmpdir(), "pi-account-runtime-"));
	try {
		const path = join(directory, "account-profiles.json");
		const options = {
			credentials: AuthStorage.inMemory(),
			modelsPath: null,
			accountProfilesPath: path,
			allowModelNetwork: false,
			refreshOnCreate: false,
		};
		const runtime = await ModelRuntime.create(options);
		const primary = runtime.getProvider("antigravity-manager");
		assert.ok(primary?.auth.apiKey, "Antigravity Manager is exposed as a regular login provider");
		const work = runtime.addAccountAlias("antigravity-manager", "Antigravity Work");
		const personal = runtime.addAccountAlias("antigravity-manager", "Antigravity Personal");
		assert.notEqual(work.id, personal.id);
		assert.equal(runtime.getProvider(work.id)?.name, "Antigravity Work");
		assert.equal(runtime.getProvider(personal.id)?.name, "Antigravity Personal");
		assert.equal(runtime.getProvider("antigravity-manager"), primary);
		assert.deepEqual(runtime.getAccountProfiles(), [work, personal]);
		assert.throws(() => runtime.addAccountAlias(work.id), /original provider/);
		const restarted = await ModelRuntime.create(options);
		assert.ok(restarted.getProvider(work.id)?.auth.apiKey);
		assert.ok(restarted.getProvider(personal.id)?.auth.apiKey);
		assert.equal(restarted.getAccountProfiles().length, 2);
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
});
