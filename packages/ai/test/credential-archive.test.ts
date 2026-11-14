import { describe, expect, it } from "vitest";
import { parseCredentialArchive, serializeCredentialArchive } from "../src/auth/credential-archive.ts";

describe("credential archive", () => {
	it("keeps legacy single-credential JSON unchanged", () => {
		const data = { first: { type: "api_key" as const, key: "one-key" } };
		const serialized = serializeCredentialArchive(data);
		expect(JSON.parse(serialized)).toEqual(data);
		expect(parseCredentialArchive(JSON.parse(serialized))).toEqual(data);
	});

	it("deduplicates equal API-key values without sharing per-provider settings", () => {
		const data = {
			one: { type: "api_key" as const, key: "same-key", env: { REGION: "eu" } },
			two: { type: "api_key" as const, key: "same-key", env: { REGION: "us" } },
		};
		const serialized = serializeCredentialArchive(data);
		expect(serialized.split("same-key").length - 1).toBe(1);
		expect(parseCredentialArchive(JSON.parse(serialized))).toEqual(data);
	});

	it("preserves optional OAuth fields and deduplicates credentials independent of object order", () => {
		const one = {
			type: "oauth" as const,
			refresh: "same-refresh",
			access: "same-access",
			expires: 500,
			extra: { org: "test", zone: 1 },
		};
		const two = {
			type: "oauth" as const,
			access: "same-access",
			expires: 500,
			extra: { zone: 1, org: "test" },
			refresh: "same-refresh",
		};
		const serialized = serializeCredentialArchive({ one, two });
		expect(serialized.split("same-refresh").length - 1).toBe(1);
		const hydrated = parseCredentialArchive(JSON.parse(serialized));
		expect(hydrated.one).toEqual(one);
		expect(hydrated.two).toEqual(one);
		expect(hydrated.one).not.toBe(hydrated.two);
	});

	it("inlines single remaining credentials and removes unused pools", () => {
		const before = serializeCredentialArchive({
			one: { type: "api_key", key: "shared" },
			two: { type: "api_key", key: "shared" },
		});
		const surviving = parseCredentialArchive(JSON.parse(before));
		delete surviving.one;
		expect(JSON.parse(serializeCredentialArchive(surviving))).toEqual({
			two: { type: "api_key", key: "shared" },
		});
	});

	it("rejects corrupt references, invalid keys, and reserved provider IDs", () => {
		expect(() => parseCredentialArchive({ one: { "$piOAuthRef": "missing" } })).toThrow(/reference/i);
		expect(() =>
			parseCredentialArchive({
				one: { type: "api_key", key: { "$piApiKeyRef": "missing" } },
				"$piSharedCredentials": { version: 1, apiKeys: {}, oauth: {} },
			}),
		).toThrow(/reference/i);
		expect(() => parseCredentialArchive({ one: { type: "api_key", key: 100 } })).toThrow();
		expect(() =>
			serializeCredentialArchive({
				"$piSharedCredentials": { type: "api_key", key: "forbidden" },
			}),
		).toThrow(/reserved/i);
	});
});
