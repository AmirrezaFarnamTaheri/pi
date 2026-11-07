/**
 * Built-in connection to an independently running Antigravity Manager gateway.
 *
 * This is an OpenAI-compatible gateway integration, NOT a Google Antigravity
 * OAuth client. Pi never reads another application's Google session or tokens.
 * The gateway must be running and configured by its operator.
 */
import { openAICompletionsApi } from "../api/openai-completions.lazy.ts";
import type { ApiKeyAuth, ApiKeyCredential } from "../auth/types.ts";
import type { Provider, RefreshModelsContext } from "../models.ts";
import type { Model } from "../types.ts";

const DEFAULT_GATEWAY = "http://127.0.0.1:8045/v1";
const GATEWAY_URL_ENV = "ANTIGRAVITY_BASE_URL";
const GATEWAY_KEY_ENV = "ANTIGRAVITY_API_KEY";
const MAX_MODELS = 512;

/** Local HTTP is allowed; all non-loopback gateways must use HTTPS. */
export function normalizeAntigravityGatewayUrl(input: string): string {
	const raw = input.trim() || DEFAULT_GATEWAY;
	let url: URL;
	try {
		url = new URL(raw);
	} catch {
		throw new Error("Invalid Antigravity gateway URL");
	}
	if (url.username || url.password) throw new Error("Gateway URL must not contain credentials");
	if (url.search || url.hash) throw new Error("Gateway URL must not contain a query or fragment");
	const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname.toLowerCase());
	if (url.protocol !== "https:" && !(url.protocol === "http:" && local)) {
		throw new Error("HTTPS is required for non-loopback Antigravity gateways");
	}
	url.pathname = url.pathname.replace(/\/+$/u, "");
	if (!url.pathname.endsWith("/v1")) url.pathname += "/v1";
	return url.toString().replace(/\/+$/u, "");
}

function gatewayFor(credential: ApiKeyCredential | undefined): string {
	return normalizeAntigravityGatewayUrl(credential?.env?.[GATEWAY_URL_ENV] ?? DEFAULT_GATEWAY);
}

const gatewayAuth: ApiKeyAuth = {
	name: "Antigravity Manager gateway access key",
	login: async (interaction) => {
		const endpoint = normalizeAntigravityGatewayUrl(await interaction.prompt({
			type: "text",
			message: "Antigravity Manager gateway URL (default http://127.0.0.1:8045/v1)",
			placeholder: DEFAULT_GATEWAY,
		}));
		interaction.signal.throwIfAborted();
		const key = (await interaction.prompt({
			type: "secret",
			message: "Antigravity Manager gateway access key",
		})).trim();
		if (!key) throw new Error("Antigravity Manager gateway access key is required");
		interaction.signal.throwIfAborted();
		return { type: "api_key", key, env: { [GATEWAY_URL_ENV]: endpoint } };
	},
	check: async ({ ctx, credential, signal }) => {
		signal.throwIfAborted();
		if (credential?.key || (await ctx.env(GATEWAY_KEY_ENV))) return { type: "api_key", source: "Antigravity gateway" };
		return undefined;
	},
	resolve: async ({ ctx, credential, signal }) => {
		signal.throwIfAborted();
		const key = credential?.key ?? (await ctx.env(GATEWAY_KEY_ENV));
		if (!key) return undefined;
		const baseUrl = normalizeAntigravityGatewayUrl(
			credential?.env?.[GATEWAY_URL_ENV] ?? (await ctx.env(GATEWAY_URL_ENV)) ?? DEFAULT_GATEWAY,
		);
		signal.throwIfAborted();
		return { auth: { apiKey: key, baseUrl }, source: credential?.key ? "stored gateway key" : GATEWAY_KEY_ENV };
	},
};

type GatewayModelData = { id?: unknown; name?: unknown; context_window?: unknown; max_tokens?: unknown };

function modelNumber(value: unknown, fallback: number): number {
	return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : fallback;
}

/** Model discovery is intentionally read-only and never accesses Google sessions. */
export async function discoverAntigravityModels(
	baseUrl: string,
	key: string,
	signal: AbortSignal,
): Promise<Model<"openai-completions">[]> {
	const url = normalizeAntigravityGatewayUrl(baseUrl);
	const response = await fetch(`${url}/models`, {
		headers: { accept: "application/json", authorization: `Bearer ${key}` },
		signal: AbortSignal.any([signal, AbortSignal.timeout(15_000)]),
	});
	if (!response.ok) throw new Error(`Antigravity model discovery failed (HTTP ${response.status})`);
	const json: unknown = await response.json();
	if (!json || typeof json !== "object" || !("data" in json) || !Array.isArray(json.data)) {
		throw new Error("Antigravity gateway returned an invalid models response");
	}
	const models: Model<"openai-completions">[] = [];
	const seen = new Set<string>();
	for (const item of json.data as GatewayModelData[]) {
		if (!item || typeof item.id !== "string" || !item.id.trim() || seen.has(item.id)) continue;
		if (models.length >= MAX_MODELS) break;
		seen.add(item.id);
		models.push({
			id: item.id,
			name: typeof item.name === "string" && item.name.trim() ? item.name : item.id,
			provider: "antigravity",
			api: "openai-completions",
			baseUrl: url,
			// /v1/models does not guarantee multimodal or reasoning support.
			input: ["text"],
			reasoning: false,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: modelNumber(item.context_window, 0),
			maxTokens: modelNumber(item.max_tokens, 0),
		});
	}
	return models;
}

/** Connect to Antigravity Manager's local OpenAI-compatible relay. */
export function antigravityProvider(): Provider<"openai-completions"> {
	let models: Model<"openai-completions">[] = [];
	const streams = openAICompletionsApi();
	return {
		id: "antigravity",
		name: "Antigravity Manager",
		baseUrl: DEFAULT_GATEWAY,
		auth: { apiKey: gatewayAuth },
		getModels: () => models,
		refreshModels: async (context: RefreshModelsContext) => {
			if (context.stored) {
				const restored = context.stored.models.filter(
					(model) => model.provider === "antigravity" && model.api === "openai-completions",
				) as Model<"openai-completions">[];
				if (!(await context.publish({ update: () => { models = restored; } }))) return;
			}
			if (!context.allowNetwork || context.signal.aborted) return;
			const credential = context.credential;
			const key = credential?.type === "api_key" ? credential.key : undefined;
			if (!key) return;
			const url = gatewayFor(credential?.type === "api_key" ? credential : undefined);
			const next = await discoverAntigravityModels(url, key, context.signal);
			if (context.signal.aborted) return;
			await context.publish({
				persist: { models: next, checkedAt: Date.now() },
				update: () => { models = next; },
			});
		},
		stream: (model, context, options) => streams.stream(model, context, options),
		streamSimple: (model, context, options) => streams.streamSimple(model, context, options),
	};
}
