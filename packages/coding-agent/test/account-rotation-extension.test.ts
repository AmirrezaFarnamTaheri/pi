import { describe, expect, it } from "vitest";
import type { AssistantMessage, Provider } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "../src/core/extensions/types.ts";
import { parseRotationConfiguration, registerAccountRotation } from "../src/extensions/account-rotation-extension.ts";

const config = { pools: [{ id: "claude", cooldownMs: 1_000, members: [
	{ provider: "anthropic", model: "sonnet" },
	{ provider: "anthropic-key-2", model: "sonnet", apiKeyEnv: "PI_TEST_ALT_KEY", sourceProvider: "anthropic" },
] }] };

function createHarness(configuration: unknown) {
	const physical = {
		provider: "anthropic", id: "sonnet", name: "Test Sonnet", api: "anthropic-messages",
		baseUrl: "https://example.invalid", input: ["text"],
		cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
		reasoning: true, contextWindow: 10_000, maxTokens: 1_000,
	};
	const models = new Map<string, typeof physical>([["anthropic/sonnet", physical]]);
	const providers = new Map<string, Provider>();
	providers.set("anthropic", {
		id: "anthropic", name: "Anthropic test source", auth: {
			apiKey: { name: "Key", resolve: async ({ credential }) => credential?.key
				? { auth: { apiKey: credential.key }, source: "stored" } : undefined },
		},
		getModels: () => [physical as never],
		stream: () => { throw new Error("no streaming in this test"); },
		streamSimple: () => { throw new Error("no streaming in this test"); },
	});
	const handlers = new Map<string, (...args: never[]) => Promise<void>>();
	const registered: Array<{ provider: string; apiKey?: string }> = [];
	const commands = new Map<string, { handler: (args: string, context: unknown) => Promise<void> }>();
	let virtual: { route: (request: Record<string, unknown>, context: unknown) => Promise<{ model: typeof physical }>; shouldRetry?: (message: AssistantMessage) => boolean } | undefined;
	const pi = {
		on(event: string, handler: (...args: never[]) => Promise<void>) { handlers.set(event, handler); },
		registerProvider(provider: Provider) {
			registered.push({ provider: provider.id });
			providers.set(provider.id, provider);
			models.set(`${provider.id}/sonnet`, { ...physical, provider: provider.id });
		},
		registerVirtualModel(value: typeof virtual) { virtual = value; },
		registerCommand(name: string, command: { handler: (args: string, context: unknown) => Promise<void> }) { commands.set(name, command); },
	} as unknown as ExtensionAPI;
	const ctx = { modelRegistry: {
		find(provider: string, id: string) { return models.get(`${provider}/${id}`); },
		getProvider(provider: string) { return providers.get(provider); },
		hasConfiguredAuth(_model: { provider: string }) { return true; },
		async refresh() {},
	} };
	registerAccountRotation(pi, parseRotationConfiguration(configuration));
	return { handlers, registered, providers, commands, ctx, virtual: () => virtual! };
}

describe("account rotation extension", () => {
	it("rejects literal key material and duplicate accounts", () => {
		expect(() => parseRotationConfiguration({ pools: [{ id: "x", members: [
			{ provider: "anthropic", model: "sonnet", apiKey: "secret" },
		] }] })).toThrow(/literal api keys/i);
		expect(() => parseRotationConfiguration({ pools: [{ id: "x", members: [
			{ provider: "anthropic", model: "sonnet" },
			{ provider: "anthropic", model: "sonnet" },
		] }] })).toThrow(/duplicate/i);
	});

	it("rejects alias collisions, reuse of the same physical API key, and credentials in arbitrary fields", () => {
		expect(() => parseRotationConfiguration({ pools: [{ id: "x", members: [
			{ provider: "key-a", sourceProvider: "anthropic", model: "sonnet", apiKeyEnv: "SAME_KEY" },
			{ provider: "key-b", sourceProvider: "anthropic", model: "sonnet", apiKeyEnv: "SAME_KEY" },
		] }] })).toThrow(/duplicate.*(key|credential)/i);
		expect(() => parseRotationConfiguration({ pools: [{ id: "x", members: [
			{ provider: "account", model: "sonnet", token: "a-plain-secret" },
		] }] })).toThrow(/unknown|token|secret/i);
	});

	it("rejects two environment variables that contain the same physical account key", async () => {
		const previous = [process.env.PI_TEST_KEY_A, process.env.PI_TEST_KEY_B];
		process.env.PI_TEST_KEY_A = "same-physical-credential";
		process.env.PI_TEST_KEY_B = "same-physical-credential";
		try {
			const app = createHarness({ pools: [{ id: "reuse", members: [
				{ provider: "account-a", sourceProvider: "anthropic", model: "sonnet", apiKeyEnv: "PI_TEST_KEY_A" },
				{ provider: "account-b", sourceProvider: "anthropic", model: "sonnet", apiKeyEnv: "PI_TEST_KEY_B" },
			] }] });
			await expect(app.handlers.get("session_start")!({ type: "session_start" } as never, app.ctx as never))
				.rejects.toThrow(/duplicate.*(credential|key)/i);
			expect(app.registered).toEqual([]);
		} finally {
			if (previous[0] === undefined) delete process.env.PI_TEST_KEY_A;
			else process.env.PI_TEST_KEY_A = previous[0];
			if (previous[1] === undefined) delete process.env.PI_TEST_KEY_B;
			else process.env.PI_TEST_KEY_B = previous[1];
		}
	});

	it("accepts OAuth account aliases while rejecting duplicate credential slots", () => {
		const config = parseRotationConfiguration({ pools: [{ id: "oauth", members: [
			{ provider: "account-one", sourceProvider: "anthropic", model: "sonnet" },
			{ provider: "account-two", sourceProvider: "anthropic", model: "sonnet" },
		] }] });
		expect(config.pools[0]?.members).toHaveLength(2);
		expect(() => parseRotationConfiguration({ pools: [{ id: "bad", members: [
			{ provider: "anthropic", model: "sonnet" },
			{ provider: "anthropic", model: "opus" },
		] }] })).toThrow(/duplicate/i);
		expect(() => parseRotationConfiguration({ pools: [{ id: "bad", members: [
			{ provider: "anthropic", sourceProvider: "anthropic", model: "sonnet" },
		] }] })).toThrow(/distinct|alias/i);
	});

	it("retries unauthorized and exhausted-quota accounts only before any output", () => {
		const app = createHarness(config);
		const failure = (provider: string, errorMessage: string, content: AssistantMessage["content"] = []): AssistantMessage => ({
			role: "assistant", provider, model: "sonnet", api: "anthropic-messages",
			content, stopReason: "error", errorMessage, timestamp: Date.now(),
			usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
		});
		expect(app.virtual().shouldRetry!(failure("anthropic", "HTTP 401 Unauthorized"))).toBe(true);
		expect(app.virtual().shouldRetry!(failure("anthropic-key-2", "insufficient_quota"))).toBe(true);
		expect(app.virtual().shouldRetry!(failure("anthropic", "HTTP 503 overloaded"))).toBe(true);
		expect(app.virtual().shouldRetry!(failure("anthropic", "HTTP 429 rate limited",
			[{ type: "text", text: "partial output" }]))).toBe(false);
		expect(app.virtual().shouldRetry!(failure("anthropic", "403 content policy"))).toBe(false);
		expect(app.virtual().shouldRetry!(failure("unrelated", "HTTP 401 Unauthorized"))).toBe(false);
	});

	it("validates and retains configurable account-selection strategies", () => {
		const parsed = parseRotationConfiguration({ pools: [{
			id: "google", strategy: "hybrid", members: [{ provider: "antigravity", model: "gemini" }],
		}] });
		expect(parsed.pools[0]?.strategy).toBe("hybrid");
		expect(() => parseRotationConfiguration({ pools: [{
			id: "bad", strategy: "unsupported", members: [{ provider: "antigravity", model: "gemini" }],
		}] })).toThrow(/strategy/i);
	});

	it("enables account controls and success healing without exposing secret material", async () => {
		const previous = process.env.PI_TEST_ALT_KEY;
		process.env.PI_TEST_ALT_KEY = "test-secret-command";
		try {
			const app = createHarness(config);
			await app.handlers.get("session_start")!({ type: "session_start" } as never, app.ctx as never);
			const route = { reason: "user", thinkingLevel: "off", messages: [] };
			await app.virtual().route(route, app.ctx);
			const command = app.commands.get("account-rotation")!;
			const notices: string[] = [];
			const ui = { hasUI: true, ui: { notify: (message: string) => { notices.push(message); } } };
			await command.handler("disable claude anthropic", ui);
			expect((await app.virtual().route(route, app.ctx)).model.provider).toBe("anthropic-key-2");
			await command.handler("enable claude anthropic", ui);
			await command.handler("pin claude anthropic", ui);
			expect((await app.virtual().route(route, app.ctx)).model.provider).toBe("anthropic");
			await command.handler("quota claude anthropic 0.5", ui);
			await command.handler("status", ui);
			expect(notices.join("\n")).toContain("quota 50%");
			expect(notices.join("\n")).not.toContain("test-secret-command");
			await command.handler("unpin claude", ui);
			await command.handler("reset claude", ui);
		} finally {
			if (previous === undefined) delete process.env.PI_TEST_ALT_KEY;
			else process.env.PI_TEST_ALT_KEY = previous;
		}
	});

	it("registers alias by env-variable reference without copying the secret", async () => {
		const before = process.env.PI_TEST_ALT_KEY;
		process.env.PI_TEST_ALT_KEY = "test-secret-must-not-leak";
		try {
			const app = createHarness(config);
			await app.handlers.get("session_start")!({ type: "session_start" } as never, app.ctx as never);
			expect(app.registered).toEqual([{ provider: "anthropic-key-2" }]);
			const auth = app.providers.get("anthropic-key-2")!.auth.apiKey!;
			const resolved = await auth.resolve({
				ctx: { env: async (name) => process.env[name], fileExists: async () => false },
				credential: { type: "api_key", key: "stale-stored-key" },
				signal: new AbortController().signal,
			});
			expect(resolved?.auth.apiKey).toBe("test-secret-must-not-leak");
			expect(resolved?.auth.apiKey).not.toBe("stale-stored-key");
			expect(JSON.stringify(app.registered)).not.toContain("test-secret-must-not-leak");
		} finally {
			if (before === undefined) delete process.env.PI_TEST_ALT_KEY;
			else process.env.PI_TEST_ALT_KEY = before;
		}
	});

	it("clears an API-key account quarantine when its environment key is replaced", async () => {
		const old = process.env.PI_TEST_ALT_KEY;
		process.env.PI_TEST_ALT_KEY = "first-key";
		try {
			const app = createHarness(config);
			await app.handlers.get("session_start")!({ type: "session_start" } as never, app.ctx as never);
			const request = { reason: "user", thinkingLevel: "off", messages: [] };
			await app.virtual().route(request, app.ctx);
			const second = await app.virtual().route(request, app.ctx);
			expect(second.model.provider).toBe("anthropic-key-2");
			await app.virtual().route({ ...request, reason: "retry", failed: {
				model: second.model, message: { content: [], errorMessage: "HTTP 429", stopReason: "error" },
			} }, app.ctx);
			await app.commands.get("account-rotation")!.handler("disable claude anthropic",
				{ hasUI: true, ui: { notify() {} } });
			process.env.PI_TEST_ALT_KEY = "second-key";
			expect((await app.virtual().route(request, app.ctx)).model.provider).toBe("anthropic-key-2");
		} finally {
			if (old === undefined) delete process.env.PI_TEST_ALT_KEY;
			else process.env.PI_TEST_ALT_KEY = old;
		}
	});

	it("rejects provider collisions and never registers an alias twice after session reload", async () => {
		const collision = createHarness({ pools: [{ id: "collision", members: [
			{ provider: "anthropic", sourceProvider: "another-provider", model: "sonnet" },
		] }] });
		await expect(collision.handlers.get("session_start")!({ type: "session_start" } as never, collision.ctx as never))
			.rejects.toThrow(/conflicts with existing provider/i);
		const app = createHarness(config);
		await app.handlers.get("session_start")!({ type: "session_start" } as never, app.ctx as never);
		await app.handlers.get("session_start")!({ type: "session_start" } as never, app.ctx as never);
		expect(app.registered).toEqual([{ provider: "anthropic-key-2" }]);
	});

	it("fails closed when the original account loses authentication during a tool continuation", async () => {
		const app = createHarness(config);
		await app.handlers.get("session_start")!({ type: "session_start" } as never, app.ctx as never);
		const request = { reason: "user", thinkingLevel: "off", messages: [] };
		const first = await app.virtual().route(request, app.ctx);
		app.ctx.modelRegistry.hasConfiguredAuth = (model: { provider: string }) => model.provider !== "anthropic";
		await expect(app.virtual().route({
			...request, reason: "continuation", previous: { model: first.model },
		}, app.ctx)).rejects.toThrow(/original account.*unavailable/i);
	});

	it("rotates user turns, holds account for tools and fails over on pre-output 429", async () => {
		const before = process.env.PI_TEST_ALT_KEY;
		process.env.PI_TEST_ALT_KEY = "test-secret";
		try {
			const app = createHarness(config);
			await app.handlers.get("session_start")!({ type: "session_start" } as never, app.ctx as never);
			const request = { reason: "user", thinkingLevel: "medium", messages: [] };
			const first = await app.virtual().route(request, app.ctx);
			expect(first.model.provider).toBe("anthropic");
			const continuation = await app.virtual().route({
				...request, reason: "continuation", previous: { model: first.model },
			}, app.ctx);
			expect(continuation.model.provider).toBe("anthropic");
			const second = await app.virtual().route(request, app.ctx);
			expect(second.model.provider).toBe("anthropic-key-2");
			const failed = await app.virtual().route({
				...request, reason: "retry", failed: {
					model: second.model, message: { content: [], errorMessage: "HTTP 429", stopReason: "error" },
				},
			}, app.ctx);
			expect(failed.model.provider).toBe("anthropic");
		} finally {
			if (before === undefined) delete process.env.PI_TEST_ALT_KEY;
			else process.env.PI_TEST_ALT_KEY = before;
		}
	});

	it("uses pre-registered account aliases without duplicating provider authentication", async () => {
		const app = createHarness({ pools: [{ id: "oauth", members: [{ provider: "anthropic", model: "sonnet" }] }] });
		await app.handlers.get("session_start")!({ type: "session_start" } as never, app.ctx as never);
		expect(app.registered).toEqual([]);
		const first = await app.virtual().route({ reason: "user", thinkingLevel: "low", messages: [] }, app.ctx);
		expect(first.model.provider).toBe("anthropic");
	});
});
