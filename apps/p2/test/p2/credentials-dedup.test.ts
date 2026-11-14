import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { FileCredentials } from "../../plugins/models/credentials.ts";

test("P2 persists and reads shared API keys without joining unrelated providers", async () => {
	const directory = mkdtempSync(join(tmpdir(), "p2-credential-dedup-"));
	const path = join(directory, "auth.json");
	const store = new FileCredentials(path);
	try {
		await store.modify("one", async () => ({ type: "api_key", key: "same-key", env: { REGION: "eu" } }));
		await store.modify("two", async () => ({ type: "api_key", key: "same-key", env: { REGION: "us" } }));
		assert.equal(readFileSync(path, "utf8").split("same-key").length - 1, 1);
		assert.deepEqual(await store.list(), [
			{ providerId: "one", type: "api_key" },
			{ providerId: "two", type: "api_key" },
		]);
		assert.deepEqual(await store.read("two"), { type: "api_key", key: "same-key", env: { REGION: "us" } });
		await store.delete("one");
		assert.deepEqual(await store.read("two"), { type: "api_key", key: "same-key", env: { REGION: "us" } });
	} finally {
		await store.close();
		rmSync(directory, { recursive: true, force: true });
	}
});

test("P2 propagates an explicit OAuth refresh but not an independent login", async () => {
	const directory = mkdtempSync(join(tmpdir(), "p2-oauth-dedup-"));
	const path = join(directory, "auth.json");
	const store = new FileCredentials(path);
	try {
		const previous = { type: "oauth" as const, refresh: "shared-refresh", access: "shared-access", expires: 0 };
		await store.modify("one", async () => previous);
		await store.modify("two", async () => previous);
		await store.modify(
			"one",
			async () => ({ type: "oauth", refresh: "rotated-refresh", access: "rotated-access", expires: 9999999999999 }),
			{ propagateSharedOAuthRefresh: true },
		);
		assert.equal((await store.read("two"))?.type, "oauth");
		assert.equal((await store.read("two") as { refresh?: string })?.refresh, "rotated-refresh");
		await store.modify("two", async () => ({
			type: "oauth",
			refresh: "separate-refresh",
			access: "separate-access",
			expires: 9999999999999,
		}));
		assert.equal((await store.read("one") as { refresh?: string })?.refresh, "rotated-refresh");
	} finally {
		await store.close();
		rmSync(directory, { recursive: true, force: true });
	}
});
