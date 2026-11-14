import { strict as assert } from "node:assert";
import type { Provider } from "@earendil-works/pi-ai";
import { test } from "vitest";
import { createStoredAccountAlias } from "../src/core/account-aliases.ts";

test("independent API account refuses to authenticate using only source ambient keys", async () => {
	const source: Provider = {
		id: "ambient-source",
		name: "Ambient source",
		auth: {
			apiKey: {
				name: "Original",
				login: async () => ({ type: "api_key", env: { ENDPOINT: "https://example.test" } }),
				resolve: async () => ({ auth: { apiKey: "source-ambient-key" }, source: "environment" }),
			},
		},
		getModels: () => [],
		stream: () => {
			throw new Error("unused");
		},
		streamSimple: () => {
			throw new Error("unused");
		},
	};
	const alias = createStoredAccountAlias(source, "account-ambient-source-1");
	assert.equal(alias.name, source.name, "an account alias keeps the real provider brand");
	const apiKey = alias.auth.apiKey!;
	const signal = new AbortController().signal;
	const ctx = { env: async () => "source-ambient-key", fileExists: async () => true } as never;
	assert.equal(await apiKey.resolve({ signal, ctx }), undefined);
	assert.equal(
		await apiKey.resolve({ signal, ctx, credential: { type: "api_key", env: { ENDPOINT: "https://example.test" } } }),
		undefined,
	);
	await assert.rejects(
		() =>
			apiKey.login!({
				signal,
				prompt: async () => "",
				notify: () => {},
			} as never),
		/require a stored key/i,
	);
});
