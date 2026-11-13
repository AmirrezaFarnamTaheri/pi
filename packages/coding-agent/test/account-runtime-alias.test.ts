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
		assert.throws(() => runtime.unregisterProvider(work.id), /managed account/i);
		assert.equal(runtime.getProvider(work.id)?.name, "Antigravity Work");
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

test("offers opt-in automatic rotation only when an independent account exists", async () => {
	const directory = mkdtempSync(join(tmpdir(), "pi-rotation-runtime-"));
	try {
		const runtime = await ModelRuntime.create({
			credentials: AuthStorage.inMemory(),
			modelsPath: null,
			accountProfilesPath: join(directory, "account-profiles.json"),
			allowModelNetwork: false,
			refreshOnCreate: false,
		});
		assert.equal(runtime.getModel("account-profiles", "antigravity-manager"), undefined);
		const account = runtime.addAccountAlias("antigravity-manager", "Backup");
		const rotation = runtime.getModel("account-profiles", "antigravity-manager");
		assert.ok(rotation);
		assert.equal(rotation?.api, "pi-virtual");
		assert.match(rotation?.name ?? "", /rotate|account/i);
		const failure = {
			role: "assistant" as const,
			provider: account.id,
			model: "example",
			api: "openai-completions" as const,
			stopReason: "error" as const,
			timestamp: Date.now(),
			errorMessage: "HTTP 429",
			content: [{ type: "text" as const, text: "already returned" }],
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
		};
		assert.equal(runtime.shouldRetryVirtualFailure(rotation!, failure), false);
		await runtime.removeAccountAlias(account.id);
		assert.equal(runtime.getModel("account-profiles", "antigravity-manager"), undefined);
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
});

test("restores an account whose extension source provider is registered after runtime initialization", async () => {
	const directory = mkdtempSync(join(tmpdir(), "pi-late-provider-"));
	try {
		const profilesPath = join(directory, "account-profiles.json");
		const { addAccountProfile } = await import("../src/core/account-profiles.ts");
		const profile = addAccountProfile(profilesPath, "late-test-provider", [], "Delayed sign-in");
		const runtime = await ModelRuntime.create({
			credentials: AuthStorage.inMemory(),
			modelsPath: null,
			accountProfilesPath: profilesPath,
			allowModelNetwork: false,
			refreshOnCreate: false,
		});
		assert.equal(runtime.getProvider(profile.id), undefined);
		assert.equal(runtime.getAccountProfiles().length, 1);
		runtime.registerNativeProvider({
			id: "late-test-provider",
			name: "Late test provider",
			auth: {
				apiKey: {
					name: "Test",
					login: async () => ({ type: "api_key", key: "fixture" }),
					resolve: async () => ({ auth: {}, source: "test" }),
				},
			},
			getModels: () => [],
			stream: () => {
				throw new Error("unused");
			},
			streamSimple: () => {
				throw new Error("unused");
			},
		});
		assert.equal(runtime.getProvider(profile.id)?.name, "Delayed sign-in");
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
});

test("does not reuse an original provider's ambient API key in an added account", async () => {
	const directory = mkdtempSync(join(tmpdir(), "pi-isolated-account-"));
	const oldKey = process.env.ANTIGRAVITY_MANAGER_API_KEY;
	process.env.ANTIGRAVITY_MANAGER_API_KEY = "original-account-only";
	try {
		const runtime = await ModelRuntime.create({
			credentials: AuthStorage.inMemory(),
			modelsPath: null,
			accountProfilesPath: join(directory, "profiles.json"),
			allowModelNetwork: false,
			refreshOnCreate: false,
		});
		const profile = runtime.addAccountAlias("antigravity-manager", "Separate login");
		assert.equal(await runtime.getAuth(profile.id), undefined);
		assert.equal((await runtime.getAuth("antigravity-manager"))?.auth.apiKey, "original-account-only");
	} finally {
		if (oldKey === undefined) delete process.env.ANTIGRAVITY_MANAGER_API_KEY;
		else process.env.ANTIGRAVITY_MANAGER_API_KEY = oldKey;
		rmSync(directory, { recursive: true, force: true });
	}
});

test("two gateway logins retain distinct keys and endpoints without replacing each other", async () => {
	const directory = mkdtempSync(join(tmpdir(), "pi-independent-gateway-"));
	try {
		const runtime = await ModelRuntime.create({
			credentials: AuthStorage.inMemory(),
			modelsPath: null,
			accountProfilesPath: join(directory, "profiles.json"),
			allowModelNetwork: false,
			refreshOnCreate: false,
		});
		const login = (providerId: string, key: string, endpoint: string) =>
			runtime.login(providerId, "api_key", {
				signal: new AbortController().signal,
				prompt: async (prompt) => (prompt.type === "secret" ? key : endpoint),
				notify: () => {},
			});
		await login("antigravity-manager", "original-gateway-key", "http://127.0.0.1:8045/v1");
		const alternate = runtime.addAccountAlias("antigravity-manager", "Second gateway");
		await login(alternate.id, "separate-gateway-key", "https://example.test/relay/v1");
		const first = await runtime.getAuth("antigravity-manager");
		const second = await runtime.getAuth(alternate.id);
		assert.equal(first?.auth.apiKey, "original-gateway-key");
		assert.equal(second?.auth.apiKey, "separate-gateway-key");
		assert.equal(first?.auth.baseUrl, "http://127.0.0.1:8045/v1");
		assert.equal(second?.auth.baseUrl, "https://example.test/relay/v1");
		assert.deepEqual(
			runtime.getAccountProfiles().map((profile) => profile.id),
			[alternate.id],
		);
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
});

test("renamed accounts persist across restarts without replacing providers or stored account IDs", async () => {
	const directory = mkdtempSync(join(tmpdir(), "pi-account-rename-runtime-"));
	try {
		const options = {
			credentials: AuthStorage.inMemory(),
			modelsPath: null,
			accountProfilesPath: join(directory, "account-profiles.json"),
			allowModelNetwork: false,
			refreshOnCreate: false,
		};
		const runtime = await ModelRuntime.create(options);
		const original = runtime.getProvider("antigravity-manager");
		const work = runtime.addAccountAlias("antigravity-manager", "Account 1");
		const personal = runtime.addAccountAlias("antigravity-manager", "Account 2");
		assert.equal(runtime.renameAccount(work.id, "  Company gateway  "), "Company gateway");
		assert.equal(runtime.renameAccount("antigravity-manager", "  Main gateway  "), "Main gateway");
		assert.equal(runtime.getAccountLabel(work.id), "Company gateway");
		assert.equal(runtime.getProvider(work.id)?.name, "Company gateway");
		assert.equal(runtime.getAccountLabel("antigravity-manager"), "Main gateway");
		assert.equal(runtime.getProvider("antigravity-manager"), original);
		assert.equal(runtime.getProvider(personal.id)?.name, "Account 2");

		const reopened = await ModelRuntime.create(options);
		assert.equal(reopened.getAccountLabel(work.id), "Company gateway");
		assert.equal(reopened.getProvider(work.id)?.name, "Company gateway");
		assert.equal(reopened.getAccountLabel("antigravity-manager"), "Main gateway");
		assert.deepEqual(reopened.getAccountProfiles().map((account) => account.id), [work.id, personal.id]);

		await reopened.removeAccountAlias(work.id);
		assert.equal(reopened.getProvider(work.id), undefined);
		assert.equal(reopened.getProvider(personal.id)?.name, "Account 2");
		const again = await ModelRuntime.create(options);
		assert.equal(again.getAccountLabel("antigravity-manager"), "Main gateway");
		assert.deepEqual(again.getAccountProfiles().map((account) => account.id), [personal.id]);
		assert.throws(() => again.renameAccount(work.id, "Deleted"), /unknown/i);
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
});

test("deleting an account also clears credentials if its extension is unavailable", async () => {
	const directory = mkdtempSync(join(tmpdir(), "pi-account-orphan-cleanup-"));
	try {
		const path = join(directory, "account-profiles.json");
		const { addAccountProfile } = await import("../src/core/account-profiles.ts");
		const account = addAccountProfile(path, "unloaded-provider", [], "Old account");
		const credentials = AuthStorage.inMemory();
		await credentials.modify(account.id, async () => ({ type: "api_key", key: "stale-key" }));
		const runtime = await ModelRuntime.create({
			credentials,
			modelsPath: null,
			accountProfilesPath: path,
			allowModelNetwork: false,
			refreshOnCreate: false,
		});
		assert.equal(runtime.getProvider(account.id), undefined);
		await runtime.removeAccountAlias(account.id);
		assert.equal(await credentials.read(account.id), undefined);
		assert.deepEqual(runtime.getAccountProfiles(), []);
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
});
