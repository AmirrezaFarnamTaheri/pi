import { type Api, type AssistantMessage, InMemoryModelsStore, type Model, type Provider } from "@earendil-works/pi-ai";
import { AssistantMessageEventStream } from "@earendil-works/pi-ai/utils/event-stream";
import { describe, expect, it } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.ts";
import type { ExtensionAPI } from "../src/core/extensions/types.ts";
import { ModelRegistry } from "../src/core/model-registry.ts";
import { ModelRuntime } from "../src/core/model-runtime.ts";
import {
	createApiKeyAccountAlias,
	createOAuthAccountAlias,
	parseRotationConfiguration,
	registerAccountRotation,
} from "../src/extensions/account-rotation-extension.ts";

function sourceProvider(): Provider {
	const model: Model<"openai-completions"> = {
		provider: "rotation-test",
		id: "test-model",
		name: "Test model",
		api: "openai-completions",
		baseUrl: "https://example.invalid/v1",
		input: ["text"],
		reasoning: false,
		contextWindow: 1000,
		maxTokens: 100,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	};
	const unused = () => {
		throw new Error("no provider requests in login tests");
	};
	return {
		id: "rotation-test",
		name: "Rotation login test",
		auth: {
			oauth: {
				name: "Test OAuth account",
				login: async ({ prompt }) => {
					const id = await prompt({ type: "text", message: "Account label" });
					return { type: "oauth", access: id, refresh: `refresh-${id}`, expires: Date.now() + 3_600_000 };
				},
				refresh: async (credential) => ({
					...credential,
					access: `${credential.access}-new`,
					expires: Date.now() + 3_600_000,
				}),
				toAuth: async (credential) => ({ apiKey: credential.access }),
			},
		},
		getModels: () => [model],
		stream: unused,
		streamSimple: unused,
	};
}

describe("account alias provider transport isolation", () => {
	it("reactivates the account after its own successful interactive OAuth login", async () => {
		let logins = 0;
		const alias = createOAuthAccountAlias(sourceProvider(), "work-login", () => {
			logins++;
		});
		await alias.auth.oauth!.login({
			signal: new AbortController().signal,
			prompt: async () => "work",
			notify() {},
		});
		expect(logins).toBe(1);
	});

	it("forwards the original upstream provider identity and restores the alias in streaming events", async () => {
		const source = sourceProvider();
		const model = source.getModels()[0]!;
		const requests: string[] = [];
		const message: AssistantMessage = {
			role: "assistant",
			content: [{ type: "text", text: "hello" }],
			provider: source.id,
			model: model.id,
			api: model.api,
			stopReason: "stop",
			timestamp: Date.now(),
			usage: {
				input: 1,
				output: 1,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 2,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
		};
		const streamProvider = {
			...source,
			streamSimple: (requestModel: Model<"openai-completions">) => {
				requests.push(requestModel.provider);
				const stream = new AssistantMessageEventStream();
				stream.push({ type: "start", partial: { ...message, content: [] } });
				stream.push({ type: "done", reason: "stop", message: { ...message } });
				return stream;
			},
		} as Provider;
		const alias = createOAuthAccountAlias(streamProvider, "oauth-account-alias");
		expect(alias.getModels()[0]?.provider).toBe("oauth-account-alias");
		const events = alias.streamSimple(alias.getModels()[0]!, { messages: [] } as never);
		const values = [];
		for await (const event of events) values.push(event);
		expect(requests).toEqual(["rotation-test"]);
		expect(values[0]).toMatchObject({ type: "start", partial: { provider: "oauth-account-alias" } });
		expect((await events.result()).provider).toBe("oauth-account-alias");
	});

	it("isolates a dynamic source's per-account model refresh without mutating the source catalog", async () => {
		let sourceModels: Model<Api>[] = [];
		const base = sourceProvider();
		const dynamic = {
			...base,
			getModels: () => sourceModels,
			refreshModels: async (context: Parameters<NonNullable<Provider["refreshModels"]>>[0]) => {
				const name = context.credential?.type === "oauth" ? context.credential.access : "unknown";
				const model = { ...base.getModels()[0]!, id: name, provider: "rotation-test" };
				await context.publish({
					persist: { models: [model], checkedAt: Date.now() },
					update: () => {
						sourceModels = [model];
					},
				});
			},
		} as Provider;
		const alias = createOAuthAccountAlias(dynamic, "work-models");
		let saved: string | undefined;
		await alias.refreshModels!({
			credential: { type: "oauth", access: "work-only", refresh: "r", expires: Date.now() + 10000 },
			allowNetwork: true,
			signal: new AbortController().signal,
			publish: async ({ persist, update }) => {
				saved = persist?.models[0]?.provider;
				update?.();
				return true;
			},
		});
		expect(saved).toBe("work-models");
		expect(alias.getModels().map((model) => model.id)).toEqual(["work-only"]);
		expect(alias.getModels()[0]?.provider).toBe("work-models");
		expect(dynamic.getModels()).toEqual([]);
	});

	it("rejects an API-key alias when its source provider is OAuth-only", () => {
		expect(() => createApiKeyAccountAlias(sourceProvider(), "not-a-key", "UNUSED_ENV")).toThrow(
			/API.key authentication/i,
		);
	});

	it("rejects an unisolatable dynamic source refresh rather than changing the original account catalog", async () => {
		const source = sourceProvider();
		let mutated = false;
		const dynamic = {
			...source,
			refreshModels: async (ctx: Parameters<NonNullable<Provider["refreshModels"]>>[0]) => {
				await ctx.publish({
					update: () => {
						mutated = true;
					},
				});
			},
		} as Provider;
		const alias = createOAuthAccountAlias(dynamic, "unisolatable-account");
		await expect(
			alias.refreshModels!({
				credential: { type: "oauth", access: "work", refresh: "r", expires: Date.now() + 60_000 },
				allowNetwork: true,
				signal: new AbortController().signal,
				publish: async () => true,
			}),
		).rejects.toThrow(/per.account model catalog/i);
		expect(mutated).toBe(false);
	});

	it("never inherits stored credentials for an environment-only API key alias", async () => {
		const source = sourceProvider();
		const keySource: Provider = {
			...source,
			auth: {
				...source.auth,
				apiKey: {
					name: "Key source",
					resolve: async ({ credential }) =>
						credential?.key ? { auth: { apiKey: credential.key }, source: "explicit key" } : undefined,
				},
			},
		};
		const alias = createApiKeyAccountAlias(keySource, "env-account", "ROTATION_TEST_SECRET");
		const resolve = alias.auth.apiKey!.resolve;
		const credential = { type: "api_key" as const, key: "wrong-stored-token" };
		const unavailable = await resolve({
			ctx: { env: async () => undefined, fileExists: async () => false },
			credential,
			signal: new AbortController().signal,
		});
		expect(unavailable).toBeUndefined();
		const available = await resolve({
			ctx: { env: async () => "expected-env-token", fileExists: async () => false },
			credential,
			signal: new AbortController().signal,
		});
		expect(available?.auth.apiKey).toBe("expected-env-token");
	});
});

describe("account rotation native OAuth login", () => {
	it("isolates two logins of an extension-registered Google OAuth provider", async () => {
		const credentials = AuthStorage.inMemory();
		const runtime = await ModelRuntime.create({
			credentials,
			modelsPath: null,
			modelsStore: new InMemoryModelsStore(),
			allowModelNetwork: false,
		});
		runtime.registerProvider("plugin-google", {
			name: "Third-party Google OAuth extension",
			api: "google-generative-ai",
			baseUrl: "https://example.invalid/google",
			models: [
				{
					id: "gemini",
					name: "Gemini",
					input: ["text"],
					reasoning: false,
					contextWindow: 1000,
					maxTokens: 200,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				},
			],
			oauth: {
				name: "Google OAuth extension",
				login: async (callbacks) => {
					const access = await callbacks.onPrompt({ message: "Choose account" });
					return { access, refresh: `refresh-${access}`, expires: Date.now() + 3_600_000 };
				},
				refreshToken: async (credential) => ({
					...credential,
					access: `${credential.access}-refreshed`,
					expires: Date.now() + 3_600_000,
				}),
				getApiKey: (credential) => credential.access,
			},
			streamSimple: () => {
				throw new Error("streaming is not needed for credential tests");
			},
		});
		const listeners = new Map<string, (...args: never[]) => Promise<void>>();
		const pi = {
			on: (event: string, handler: (...args: never[]) => Promise<void>) => {
				listeners.set(event, handler);
			},
			registerProvider: (provider: Provider) => runtime.registerNativeProvider(provider),
			registerVirtualModel: (definition: Parameters<ExtensionAPI["registerVirtualModel"]>[0]) =>
				runtime.registerVirtualModel({
					...definition,
					route: (request) => definition.route(request, { modelRegistry: new ModelRegistry(runtime) } as never),
				}),
			registerCommand() {},
		} as unknown as ExtensionAPI;
		registerAccountRotation(
			pi,
			parseRotationConfiguration({
				pools: [
					{
						id: "plugin-accounts",
						members: [
							{ provider: "google-work", sourceProvider: "plugin-google", model: "gemini" },
							{ provider: "google-personal", sourceProvider: "plugin-google", model: "gemini" },
						],
					},
				],
			}),
		);
		await listeners.get("session_start")!(
			{ type: "session_start" } as never,
			{
				modelRegistry: new ModelRegistry(runtime),
			} as never,
		);
		for (const [provider, label] of [
			["google-work", "work"],
			["google-personal", "personal"],
		] as const) {
			expect(runtime.getProvider(provider)?.auth.oauth?.name).toBe("Google OAuth extension");
			await runtime.login(provider, "oauth", { prompt: async () => label, notify() {} });
		}
		expect(await credentials.read("plugin-google")).toBeUndefined();
		expect(await credentials.read("google-work")).toMatchObject({ type: "oauth", access: "work" });
		expect(await credentials.read("google-personal")).toMatchObject({ type: "oauth", access: "personal" });
		await credentials.modify("google-work", async (current) =>
			current?.type === "oauth" ? { ...current, expires: 0 } : current,
		);
		expect((await runtime.getAuth("google-work"))?.auth.apiKey).toBe("work-refreshed");
		expect((await runtime.getAuth("google-personal"))?.auth.apiKey).toBe("personal");
	});

	it("logs in to two independent aliases, refreshes only the expired one, and rotates their models", async () => {
		const credentials = AuthStorage.inMemory();
		const runtime = await ModelRuntime.create({
			credentials,
			modelsPath: null,
			modelsStore: new InMemoryModelsStore(),
			allowModelNetwork: false,
		});
		runtime.registerNativeProvider(sourceProvider());
		const handlers = new Map<string, (...args: never[]) => Promise<void>>();
		const pi = {
			on: (name: string, handler: (...args: never[]) => Promise<void>) => {
				handlers.set(name, handler);
			},
			registerProvider: (provider: Provider) => runtime.registerNativeProvider(provider),
			registerVirtualModel: (definition: Parameters<ExtensionAPI["registerVirtualModel"]>[0]) =>
				runtime.registerVirtualModel({
					...definition,
					route: (request) => definition.route(request, { modelRegistry: new ModelRegistry(runtime) } as never),
				}),
			registerCommand() {},
		} as unknown as ExtensionAPI;
		registerAccountRotation(
			pi,
			parseRotationConfiguration({
				pools: [
					{
						id: "two-logins",
						members: [
							{ provider: "login-a", sourceProvider: "rotation-test", model: "test-model" },
							{ provider: "login-b", sourceProvider: "rotation-test", model: "test-model" },
						],
					},
				],
			}),
		);
		await handlers.get("session_start")!(
			{ type: "session_start" } as never,
			{
				modelRegistry: new ModelRegistry(runtime),
			} as never,
		);

		for (const [provider, label] of [
			["login-a", "first"],
			["login-b", "second"],
		] as const) {
			expect(runtime.getProvider(provider)?.auth.oauth?.name).toBe("Test OAuth account");
			expect(runtime.getProvider(provider)?.auth.apiKey).toBeUndefined();
			await runtime.login(provider, "oauth", { prompt: async () => label, notify() {} });
		}
		expect(await credentials.read("rotation-test")).toBeUndefined();
		expect(await credentials.read("login-a")).toMatchObject({ type: "oauth", access: "first" });
		expect(await credentials.read("login-b")).toMatchObject({ type: "oauth", access: "second" });

		await credentials.modify("login-a", async (current) =>
			current?.type === "oauth" ? { ...current, expires: 0 } : current,
		);
		expect((await runtime.getAuth("login-a"))?.auth.apiKey).toBe("first-new");
		expect((await runtime.getAuth("login-b"))?.auth.apiKey).toBe("second");
		expect(await credentials.read("login-b")).toMatchObject({ type: "oauth", access: "second" });

		const virtual = runtime.getModel("account-rotation", "two-logins");
		expect(virtual).toBeDefined();
		const options = { reason: "user" as const, thinkingLevel: "off" as const };
		const first = await runtime.resolveModel(virtual!, [], options);
		const second = await runtime.resolveModel(virtual!, [], options);
		expect([first.model.provider, second.model.provider]).toEqual(["login-a", "login-b"]);
	});
});
