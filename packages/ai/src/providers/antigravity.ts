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
const GATEWAY_URL_ENV = "ANTIGRAVITY_MANAGER_BASE_URL";
const GATEWAY_KEY_ENV = "ANTIGRAVITY_MANAGER_API_KEY";
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
	const path = url.pathname.replace(/\/+$/u, "");
	url.pathname = path.endsWith("/v1") ? path : `${path}/v1`;
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
		return {
			auth: { apiKey: key, baseUrl },
			env: { [GATEWAY_URL_ENV]: baseUrl },
			source: credential?.key ? "stored gateway key" : GATEWAY_KEY_ENV,
		};
	},
};

type GatewayModelData = {
	id?: unknown;
	name?: unknown;
	context_window?: unknown;
	context_length?: unknown;
	max_tokens?: unknown;
	max_output_tokens?: unknown;
	input_modalities?: unknown;
	reasoning?: unknown;
};

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
		redirect: "error",
		signal: AbortSignal.any([signal, AbortSignal.timeout(15_000)]),
	});
	if (!response.ok) throw new Error(`Antigravity model discovery failed (HTTP ${response.status})`);
	const contentLength = Number(response.headers.get("content-length") ?? 0);
	if (contentLength > 4_000_000) throw new Error("Antigravity models response is too large");
	const reader = response.body?.getReader();
	if (!reader) throw new Error("Antigravity gateway returned no model data");
	const chunks: Uint8Array[] = [];
	let total = 0;
	try {
		while (true) {
			signal.throwIfAborted();
			const chunk = await reader.read();
			if (chunk.done) break;
			total += chunk.value.byteLength;
			if (total > 4_000_000) {
				await reader.cancel().catch(() => {});
				throw new Error("Antigravity models response is too large");
			}
			chunks.push(chunk.value);
		}
	} finally {
		reader.releaseLock();
	}
	const body = new Uint8Array(total);
	let offset = 0;
	for (const chunk of chunks) {
		body.set(chunk, offset);
		offset += chunk.byteLength;
	}
	let json: unknown;
	try {
		json = JSON.parse(new TextDecoder().decode(body));
	} catch {
		throw new Error("Antigravity gateway returned invalid models JSON");
	}
	if (!json || typeof json !== "object" || !("data" in json) || !Array.isArray(json.data)) {
		throw new Error("Antigravity gateway returned an invalid models response");
	}
	const models: Model<"openai-completions">[] = [];
	const seen = new Set<string>();
	for (const item of json.data as GatewayModelData[]) {
		if (!item || typeof item.id !== "string" || !item.id.trim() ||
			item.id.length > 256 || /[\x00-\x1f\x7f]/u.test(item.id) || seen.has(item.id)) continue;
		if (models.length >= MAX_MODELS) break;
		seen.add(item.id);
		const contextWindow = modelNumber(item.context_window ?? item.context_length, 32_768);
		const maxTokens = Math.min(contextWindow, modelNumber(item.max_output_tokens ?? item.max_tokens, 8_192));
		const modalities = Array.isArray(item.input_modalities) && item.input_modalities.every(
			(value: unknown) => typeof value === "string",
		) ? item.input_modalities as string[] : [];
		const hasLimits = typeof item.context_window === "number" || typeof item.context_length === "number";
		models.push({
			id: item.id,
			name: `${typeof item.name === "string" && item.name.trim() ? item.name : item.id}${hasLimits ? "" : " (estimated limits)"}`,
			provider: "antigravity-manager",
			api: "openai-completions",
			baseUrl: url,
			// Advertise extra capabilities only when the manager explicitly reports them.
			input: modalities.includes("image") ? ["text", "image"] : ["text"],
			reasoning: item.reasoning === true,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			// Conservative fallback when /models has no limits; prominently marked in the name.
			contextWindow,
			maxTokens,
		});
	}
	return models;
}

/** Connect to Antigravity Manager's local OpenAI-compatible relay. */
export function antigravityProvider(): Provider<"openai-completions"> {
	let models: Model<"openai-completions">[] = [];
	const streams = openAICompletionsApi();
	return {
		id: "antigravity-manager",
		name: "Antigravity Manager",
		baseUrl: DEFAULT_GATEWAY,
		auth: { apiKey: gatewayAuth },
		getModels: () => models,
		refreshModels: async (context: RefreshModelsContext) => {
			if (context.stored) {
				const restored = context.stored.models.filter(
					(model) => model.provider === "antigravity-manager" && model.api === "openai-completions",
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
