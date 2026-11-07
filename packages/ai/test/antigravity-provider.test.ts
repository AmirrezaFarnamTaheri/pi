import { describe, expect, it, vi } from "vitest";
import { antigravityProvider, discoverAntigravityModels, normalizeAntigravityGatewayUrl } from "../src/providers/antigravity.ts";

describe("built-in Antigravity Manager gateway", () => {
	it("registers as a native provider with an interactive login", async () => {
		const provider = antigravityProvider();
		expect(provider.id).toBe("antigravity-manager");
		expect(provider.auth.oauth).toBeUndefined();
		const answers = ["http://127.0.0.1:8045", "test-local-secret"];
		const credential = await provider.auth.apiKey!.login!({
			signal: new AbortController().signal,
			prompt: async () => answers.shift()!,
			notify() {},
		});
		expect(credential).toEqual({
			type: "api_key",
			key: "test-local-secret",
			env: { ANTIGRAVITY_MANAGER_BASE_URL: "http://127.0.0.1:8045/v1" },
		});
		const resolution = await provider.auth.apiKey!.resolve({
			ctx: { env: async () => undefined, fileExists: async () => false },
			credential,
			signal: new AbortController().signal,
		});
		expect(resolution?.auth).toEqual({
			apiKey: "test-local-secret",
			baseUrl: "http://127.0.0.1:8045/v1",
		});
		expect(resolution?.env).toEqual({ ANTIGRAVITY_MANAGER_BASE_URL: "http://127.0.0.1:8045/v1" });
	});

	it("defaults to loopback and requires HTTPS for non-loopback URLs", () => {
		expect(normalizeAntigravityGatewayUrl("")).toBe("http://127.0.0.1:8045/v1");
		expect(normalizeAntigravityGatewayUrl("https://gateway.example/v1/")).toBe("https://gateway.example/v1");
		expect(normalizeAntigravityGatewayUrl("http://localhost:8045/")).toBe("http://localhost:8045/v1");
		expect(() => normalizeAntigravityGatewayUrl("http://gateway.example/v1")).toThrow(/HTTPS/);
		expect(() => normalizeAntigravityGatewayUrl("http://user:pass@127.0.0.1:8045")).toThrow(/credentials/);
	});

	it("never treats a keyless gateway as authenticated", async () => {
		const provider = antigravityProvider();
		const context = { env: async () => undefined, fileExists: async () => false };
		expect(await provider.auth.apiKey!.resolve({ ctx: context, signal: new AbortController().signal }))
			.toBeUndefined();
	});

	it("uses explicit gateway model capacities and modalities, rejecting unsafe model identifiers", async () => {
		const originalFetch = globalThis.fetch;
		globalThis.fetch = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) => new Response(JSON.stringify({ data: [
			{ id: "gemini-3-pro", context_length: 1_048_576, max_output_tokens: 65_536,
				input_modalities: ["text", "image"], reasoning: true },
			{ id: "bad\nmodel", context_window: 128_000 },
		] }), { status: 200 }));
		try {
			const models = await discoverAntigravityModels("http://127.0.0.1:8045/v1", "test", new AbortController().signal);
			expect(models.map((model) => model.id)).toEqual(["gemini-3-pro"]);
			expect(models[0]).toMatchObject({
				contextWindow: 1_048_576, maxTokens: 65_536, reasoning: true,
				input: ["text", "image"],
			});
			expect((globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0]![1]).toMatchObject({ redirect: "error" });
		} finally {
			globalThis.fetch = originalFetch;
		}
	});

	it("limits oversized streamed catalogs even when the gateway omits Content-Length", async () => {
		const oldFetch = globalThis.fetch;
		globalThis.fetch = vi.fn(async () => new Response(new ReadableStream({
			start(controller) {
				controller.enqueue(new Uint8Array(4_000_001));
				controller.close();
			},
		}), { status: 200 }));
		try {
			await expect(discoverAntigravityModels("http://127.0.0.1:8045/v1", "local", new AbortController().signal))
				.rejects.toThrow(/too large/i);
		} finally {
			globalThis.fetch = oldFetch;
		}
	});

	it("discovers gateway models with a scoped key and preserves model IDs", async () => {
		const provider = antigravityProvider();
		const oldFetch = globalThis.fetch;
		const fetcher = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) => new Response(JSON.stringify({
			object: "list",
			data: [
				{ id: "gemini-3.1-pro-high", name: "Gemini Pro" },
				{ id: "claude-sonnet-4-6" },
				{ id: "claude-sonnet-4-6" },
				{ id: "" },
			],
		}), { status: 200, headers: { "content-type": "application/json" } }));
		globalThis.fetch = fetcher;
		try {
			await provider.refreshModels!({
				credential: { type: "api_key", key: "local-token", env: { ANTIGRAVITY_MANAGER_BASE_URL: "http://127.0.0.1:8045/v1" } },
				allowNetwork: true,
				signal: new AbortController().signal,
				publish: async ({ update }) => { update?.(); return true; },
			});
			expect(fetcher).toHaveBeenCalledTimes(1);
			expect(fetcher.mock.calls[0]![0]).toBe("http://127.0.0.1:8045/v1/models");
			const init = fetcher.mock.calls[0]![1] as RequestInit;
			expect(init.headers).toMatchObject({ authorization: "Bearer local-token" });
			expect(provider.getModels().map((model) => model.id)).toEqual(["gemini-3.1-pro-high", "claude-sonnet-4-6"]);
			expect(provider.getModels()[0]).toMatchObject({
				provider: "antigravity-manager", api: "openai-completions", baseUrl: "http://127.0.0.1:8045/v1",
				contextWindow: 32_768, maxTokens: 8_192,
			});
		} finally {
			globalThis.fetch = oldFetch;
		}
	});
});
