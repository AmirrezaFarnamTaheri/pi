import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createModels, type Provider } from "@earendil-works/pi-ai";
import { afterEach, expect, test, vi } from "vitest";
import { AuthStorage, ReadOnlyAuthStorage, readStoredCredential } from "../src/core/auth-storage.ts";

const files: string[] = [];
afterEach(() => {
	for (const dir of files.splice(0)) rmSync(dir, { force: true, recursive: true });
});

function fixture() {
	const dir = mkdtempSync(join(tmpdir(), "pi-dedup-auth-"));
	files.push(dir);
	const path = join(dir, "auth.json");
	return { path, storage: AuthStorage.create(path) };
}

test("stores repeated API keys once while keeping account-specific settings and identities", async () => {
	const { path, storage } = fixture();
	await storage.modify("anthropic", async () => ({
		type: "api_key",
		key: "same-opaque-api-key",
		env: { REGION: "eu" },
	}));
	await storage.modify("account-anthropic-1", async () => ({
		type: "api_key",
		key: "same-opaque-api-key",
		env: { REGION: "us" },
	}));
	const raw = readFileSync(path, "utf8");
	expect(raw.split("same-opaque-api-key").length - 1).toBe(1);
	expect(await storage.list()).toEqual([
		{ providerId: "anthropic", type: "api_key" },
		{ providerId: "account-anthropic-1", type: "api_key" },
	]);
	expect(await storage.read("anthropic")).toEqual({
		type: "api_key",
		key: "same-opaque-api-key",
		env: { REGION: "eu" },
	});
	expect(await AuthStorage.create(path).read("account-anthropic-1")).toEqual({
		type: "api_key",
		key: "same-opaque-api-key",
		env: { REGION: "us" },
	});
	expect(await new ReadOnlyAuthStorage(path).read("account-anthropic-1")).toMatchObject({
		key: "same-opaque-api-key",
		env: { REGION: "us" },
	});
	expect(readStoredCredential("anthropic", path)).toMatchObject({ key: "same-opaque-api-key" });
});

test("replacing and deleting a shared API key only affects the selected identity", async () => {
	const { path, storage } = fixture();
	await storage.modify("one", async () => ({ type: "api_key", key: "reused-key" }));
	await storage.modify("two", async () => ({ type: "api_key", key: "reused-key" }));
	await storage.modify("one", async () => ({ type: "api_key", key: "new-independent-key" }));
	expect(await storage.read("two")).toEqual({ type: "api_key", key: "reused-key" });
	await storage.delete("one");
	expect(await storage.read("two")).toEqual({ type: "api_key", key: "reused-key" });
	expect(readFileSync(path, "utf8")).not.toContain("new-independent-key");
	await storage.delete("two");
	expect(readFileSync(path, "utf8")).not.toContain("reused-key");
	expect(await storage.list()).toEqual([]);
});

test("identical OAuth sign-ins are stored once and token refresh updates every shared reference", async () => {
	const { path, storage } = fixture();
	const expired = { type: "oauth" as const, access: "reused-access", refresh: "reused-refresh", expires: 0 };
	await storage.modify("main", async () => expired);
	await storage.modify("account-main-1", async () => ({ ...expired }));
	let raw = readFileSync(path, "utf8");
	expect(raw.split("reused-refresh").length - 1).toBe(1);
	expect(raw.split("reused-access").length - 1).toBe(1);
	const refresh = vi.fn(async (current: typeof expired) => ({
		...current,
		access: "rotated-access",
		refresh: "rotated-refresh",
		expires: Date.now() + 3_600_000,
	}));
	const models = createModels({ credentials: storage });
	for (const id of ["main", "account-main-1"]) {
		const provider: Provider = {
			id,
			name: "Test provider",
			auth: {
				oauth: {
					name: "Test OAuth",
					login: async () => expired,
					refresh,
					toAuth: async (credential) => ({ apiKey: credential.access }),
				},
			},
			getModels: () => [],
			stream: () => { throw new Error("not needed"); },
			streamSimple: () => { throw new Error("not needed"); },
		};
		models.setProvider(provider);
	}
	expect((await models.getAuth("main"))?.auth.apiKey).toBe("rotated-access");
	expect(await storage.read("account-main-1")).toMatchObject({
		access: "rotated-access",
		refresh: "rotated-refresh",
	});
	expect((await models.getAuth("account-main-1"))?.auth.apiKey).toBe("rotated-access");
	expect(refresh).toHaveBeenCalledTimes(1);
	raw = readFileSync(path, "utf8");
	expect(raw.split("rotated-refresh").length - 1).toBe(1);
	expect(raw).not.toContain("reused-refresh");
});

test("re-login to one OAuth account detaches its shared secret without changing the other", async () => {
	const { path, storage } = fixture();
	const initial = { type: "oauth" as const, access: "old-access", refresh: "old-refresh", expires: 123456 };
	await storage.modify("one", async () => initial);
	await storage.modify("two", async () => initial);
	await storage.modify("two", async () => ({
		type: "oauth", access: "new-access", refresh: "new-refresh", expires: 654321,
	}));
	expect(await storage.read("one")).toEqual(initial);
	expect(await storage.read("two")).toMatchObject({ refresh: "new-refresh" });
	await storage.delete("two");
	expect(await storage.read("one")).toEqual(initial);
	const raw = readFileSync(path, "utf8");
	expect(raw).not.toContain("new-refresh");
	expect(raw.split("old-refresh").length - 1).toBe(1);
});

test("malformed or dangling shared-secret references fail closed instead of being overwritten", async () => {
	const { path, storage } = fixture();
	writeFileSync(path, JSON.stringify({
		account: { "$piOAuthRef": "missing" },
		"$piSharedCredentials": { version: 1, apiKeys: {}, oauth: {} },
	}));
	const original = readFileSync(path, "utf8");
	await expect(storage.read("account", { signal: new AbortController().signal })).rejects.toThrow();
	await expect(storage.modify("another", async () => ({ type: "api_key", key: "not-written" }))).rejects.toThrow();
	expect(readFileSync(path, "utf8")).toBe(original);
});
