/**
 * TokenDance's OpenAI-compatible model gateway.
 * Provider login is adapted from Penguin Harness; model metadata is a small
 * conservative snapshot of that fork's TokenDance catalog (September 2026).
 */
import { openAICompletionsApi } from "../api/openai-completions.lazy.ts";
import { envApiKeyAuth, lazyOAuth } from "../auth/helpers.ts";
import { loadTokenDanceOAuth } from "../auth/oauth/load.ts";
import { createProvider, type Provider } from "../models.ts";
import type { Model } from "../types.ts";

const BASE_URL = "https://tokendance.space/gateway/v1";

/** TokenDance quotes CNY per million tokens, at the source catalog's 7:1 conversion. */
function gatewayModel(
	id: string,
	name: string,
	contextWindow: number,
	vision: boolean,
	cacheReadCny: number,
	inputCny: number,
	outputCny: number,
	discount = 0,
): Model<"openai-completions"> {
	const factor = (1 - discount) / 7;
	return {
		id,
		name,
		provider: "tokendance",
		api: "openai-completions",
		baseUrl: BASE_URL,
		input: vision ? ["text", "image"] : ["text"],
		cost: {
			input: inputCny * factor,
			output: outputCny * factor,
			cacheRead: cacheReadCny * factor,
			cacheWrite: inputCny * factor,
		},
		reasoning: true,
		contextWindow,
		maxTokens: 16384,
	};
}

const MODELS: readonly Model<"openai-completions">[] = [
	gatewayModel("deepseek-v4-flash-0731", "DeepSeek V4 Flash 0731", 1048576, false, 0.1, 3, 9, 0.2),
	gatewayModel("glm-5.3-flash", "GLM-5.3 Flash", 1000000, true, 0.23, 0.8, 2.8, 0.1),
	gatewayModel("kimi-k3", "Kimi K3", 1048576, true, 2, 20, 100, 0.2),
	gatewayModel("qwen3.8-flash", "Qwen 3.8 Flash", 1000000, true, 0.1, 0.8, 2.7),
	gatewayModel("seed-2.1-pro", "Seed-2.1-Pro", 256000, true, 1.2, 6, 30, 0.5),
];

export function tokendanceProvider(): Provider<"openai-completions"> {
	return createProvider({
		id: "tokendance",
		name: "TokenDance",
		baseUrl: BASE_URL,
		auth: {
			apiKey: envApiKeyAuth("TokenDance API key", ["TOKENDANCE_API_KEY"]),
			oauth: lazyOAuth({
				name: "TokenDance API-key authorization",
				loginLabel: "Sign in with TokenDance",
				load: loadTokenDanceOAuth,
			}),
		},
		models: MODELS,
		api: openAICompletionsApi(),
	});
}
