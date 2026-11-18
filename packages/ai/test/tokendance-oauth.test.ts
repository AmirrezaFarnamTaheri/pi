import { afterEach, describe, expect, it, vi } from "vitest";
import { InMemoryCredentialStore } from "../src/auth/credential-store.ts";
import { tokenDanceOAuth } from "../src/auth/oauth/tokendance.ts";
import { createModels } from "../src/models.ts";
import { tokendanceProvider } from "../src/providers/tokendance.ts";

const EXCHANGE_URL = "https://tokendance.space/portal/api/v1/auth/keys";
const nativeFetch = globalThis.fetch;
const signal = new AbortController().signal;

function jsonResponse(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

describe.sequential("TokenDance model login and API-key minting", () => {
	afterEach(() => {
		vi.unstubAllGlobals();
		vi.unstubAllEnvs();
	});

	it("offers browser login and manual API-key input through Pi's existing auth system", async () => {
		const provider = tokendanceProvider();
		expect(provider.id).toBe("tokendance");
		expect(provider.baseUrl).toBe("https://tokendance.space/gateway/v1");
		expect(provider.auth.oauth?.loginLabel).toBe("Sign in with TokenDance");
		expect(provider.auth.apiKey?.login).toBeTypeOf("function");
	});

	it("uses PKCE S256 to mint a permanent API key through a one-use browser callback", async () => {
		let exchangeBody: Record<string, unknown> | undefined;
		const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
			const url = input instanceof Request ? input.url : String(input);
			if (url !== EXCHANGE_URL) return nativeFetch(input, init);
			exchangeBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
			return jsonResponse({ key: "tk-browser-secret" });
		});
		vi.stubGlobal("fetch", fetchMock);

		let authorization: URL | undefined;
		let callbackResponse: Promise<Response> | undefined;
		const credential = await tokenDanceOAuth.login({
			signal,
			prompt: (prompt) => (prompt.type === "select" ? Promise.resolve("callback") : new Promise<string>(() => {})),
			notify: (event) => {
				if (event.type !== "auth_url") return;
				authorization = new URL(event.url);
				const callback = new URL(authorization.searchParams.get("callback_url") ?? "");
				callback.searchParams.set("code", "one-time-code");
				callbackResponse = nativeFetch(callback);
			},
		});

		expect(credential).toEqual({
			type: "oauth",
			access: "tk-browser-secret",
			refresh: "",
			expires: Number.MAX_SAFE_INTEGER,
		});
		expect((await callbackResponse)?.status).toBe(200);
		expect(authorization?.origin).toBe("https://tokendance.space");
		expect(authorization?.pathname).toBe("/auth");
		expect(authorization?.searchParams.get("code_challenge_method")).toBe("S256");
		expect(authorization?.searchParams.get("key_name")).toBe("Pi");
		expect(authorization?.searchParams.get("app_url")).toBe("https://github.com/AmirrezaFarnamTaheri/pi");
		expect(authorization?.searchParams.get("callback_url")).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/oauth\/callback\//);
		expect(exchangeBody).toMatchObject({
			code: "one-time-code",
			code_challenge_method: "S256",
		});
		const verifier = exchangeBody?.code_verifier;
		expect(typeof verifier).toBe("string");
		const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(String(verifier)));
		const challenge = Buffer.from(digest).toString("base64url");
		expect(authorization?.searchParams.get("code_challenge")).toBe(challenge);
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	it("supports remote/headless manual code login without a callback or a leaked verifier", async () => {
		let exchangeBody: Record<string, unknown> | undefined;
		const fetchMock = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
			exchangeBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
			return jsonResponse({ key: "tk-manual-secret" });
		});
		vi.stubGlobal("fetch", fetchMock);
		let authorization: URL | undefined;
		const credential = await tokenDanceOAuth.login({
			signal,
			prompt: async (prompt) => {
				if (prompt.type === "select") return "manual";
				if (prompt.type === "manual_code") return "  one-time-manual-code  ";
				throw new Error("Unexpected prompt");
			},
			notify: (event) => {
				if (event.type === "auth_url") authorization = new URL(event.url);
			},
		});
		expect(credential.access).toBe("tk-manual-secret");
		expect(authorization?.searchParams.has("callback_url")).toBe(false);
		expect(authorization?.searchParams.get("code_challenge_method")).toBe("S256");
		expect(authorization?.toString()).not.toContain(String(exchangeBody?.code_verifier));
		expect(exchangeBody?.code).toBe("one-time-manual-code");
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	it("stores a minted key with Pi's normal credential store and resolves it for requests", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => jsonResponse({ key: "tk-stored-secret" })),
		);
		const store = new InMemoryCredentialStore();
		const models = createModels({ credentials: store });
		models.setProvider(tokendanceProvider());
		await models.login("tokendance", "oauth", {
			signal,
			prompt: async (prompt) => (prompt.type === "select" ? "manual" : "authorization-code"),
			notify: () => {},
		});
		expect(await store.read("tokendance")).toMatchObject({
			type: "oauth",
			access: "tk-stored-secret",
		});
		expect((await models.getAuth("tokendance"))?.auth.apiKey).toBe("tk-stored-secret");
	});

	it("does not save credentials if the exchange rejects a one-time code", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => jsonResponse({ error: "invalid code" }, 403)),
		);
		const store = new InMemoryCredentialStore();
		const models = createModels({ credentials: store });
		models.setProvider(tokendanceProvider());
		await expect(
			models.login("tokendance", "oauth", {
				signal,
				prompt: async (prompt) => (prompt.type === "select" ? "manual" : "private-code"),
				notify: () => {},
			}),
		).rejects.toThrow("TokenDance API-key exchange failed (HTTP 403)");
		expect(await store.read("tokendance")).toBeUndefined();
	});

	it("rejects an exchange response without a key without persisting one", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => jsonResponse({ user_id: "no-key" })),
		);
		await expect(
			tokenDanceOAuth.login({
				signal,
				prompt: async (prompt) => (prompt.type === "select" ? "manual" : "one-time-code"),
				notify: () => {},
			}),
		).rejects.toThrow("TokenDance API-key exchange response carries no key");
	});

	it("refuses empty authorization codes and aborted logins before any exchange", async () => {
		const fetchMock = vi.fn(async () => jsonResponse({ key: "unexpected" }));
		vi.stubGlobal("fetch", fetchMock);
		await expect(
			tokenDanceOAuth.login({
				signal,
				prompt: async (prompt) => (prompt.type === "select" ? "manual" : "  "),
				notify: () => {},
			}),
		).rejects.toThrow("Missing authorization code");
		const controller = new AbortController();
		controller.abort();
		await expect(
			tokenDanceOAuth.login({
				signal: controller.signal,
				prompt: async () => {
					throw new Error("Cancelled flow must not prompt");
				},
				notify: () => {},
			}),
		).rejects.toThrow("Login cancelled");
		expect(fetchMock).not.toHaveBeenCalled();
	});
});
