/**
 * TokenDance API-key minting through PKCE (ported from Penguin Harness).
 * Reuses Pi's one-shot OAuth callback server and credential storage contract.
 * TokenDance's exchanged key is permanent; it is not an OAuth refresh token.
 */
import { getProviderEnvValue } from "../../utils/provider-env.ts";
import type { OAuthAuth, OAuthCredential, ProviderAuthInteraction } from "../types.ts";
import { startOAuthCallbackServer, waitForCallbackOrManualInput } from "./callback-server.ts";
import { generatePKCE } from "./pkce.ts";

const AUTHORIZE_URL = "https://tokendance.space/auth";
const EXCHANGE_URL = "https://tokendance.space/portal/api/v1/auth/keys";
const APP_URL = "https://github.com/AmirrezaFarnamTaheri/pi";
const LOGIN_TIMEOUT_MS = 10 * 60 * 1_000;
const EXCHANGE_TIMEOUT_MS = 30_000;

function authorizationCode(input: string): string | undefined {
	const value = input.trim();
	if (!value) return undefined;
	try {
		return new URL(value).searchParams.get("code") ?? undefined;
	} catch {
		return value.includes("code=") ? new URLSearchParams(value).get("code") ?? undefined : value;
	}
}

async function exchangeCode(code: string, verifier: string, signal: AbortSignal): Promise<OAuthCredential> {
	if (signal.aborted) throw new Error("Login cancelled");
	const exchangeSignal = AbortSignal.any([signal, AbortSignal.timeout(EXCHANGE_TIMEOUT_MS)]);
	let response: Response;
	try {
		response = await fetch(EXCHANGE_URL, {
			method: "POST",
			headers: { accept: "application/json", "content-type": "application/json" },
			body: JSON.stringify({ code, code_verifier: verifier, code_challenge_method: "S256" }),
			signal: exchangeSignal,
		});
	} catch {
		if (signal.aborted) throw new Error("Login cancelled");
		// Do not include transport errors: they can quote the URL or secret code.
		throw new Error("TokenDance API-key exchange is unavailable or timed out");
	}
	if (!response.ok) throw new Error(`TokenDance API-key exchange failed (HTTP ${response.status})`);

	let payload: unknown;
	try {
		payload = await response.json();
	} catch {
		throw new Error("TokenDance API-key exchange returned invalid JSON");
	}
	if (
		payload === null ||
		typeof payload !== "object" ||
		!("key" in payload) ||
		typeof payload.key !== "string" ||
		payload.key.length === 0
	) {
		throw new Error("TokenDance API-key exchange response carries no key");
	}
	return { type: "oauth", access: payload.key, refresh: "", expires: Number.MAX_SAFE_INTEGER };
}

async function login(interaction: ProviderAuthInteraction): Promise<OAuthCredential> {
	interaction.signal.throwIfAborted();
	const method = await interaction.prompt({
		type: "select",
		message: "How would you like to authorize TokenDance?",
		options: [
			{ id: "callback", label: "Sign in with browser" },
			{ id: "manual", label: "Paste one-time authorization code" },
		],
	});
	interaction.signal.throwIfAborted();

	const { verifier, challenge } = await generatePKCE();
	const callback =
		method === "callback"
			? await startOAuthCallbackServer({
					providerName: "TokenDance",
					host: getProviderEnvValue("PI_OAUTH_CALLBACK_HOST") || "127.0.0.1",
					port: 0,
					path: `/oauth/callback/${crypto.randomUUID()}`,
					complete: (code) => exchangeCode(code, verifier, interaction.signal),
					signal: interaction.signal,
					timeoutMs: LOGIN_TIMEOUT_MS,
				})
			: undefined;

	try {
		const url = new URL(AUTHORIZE_URL);
		const params = new URLSearchParams({
			code_challenge: challenge,
			code_challenge_method: "S256",
			app_url: APP_URL,
			key_name: "Pi",
		});
		if (callback) params.set("callback_url", callback.redirectUri);
		url.search = params.toString();
		interaction.notify({
			type: "auth_url",
			url: url.toString(),
			instructions: callback
				? "Authorize the new API key in your browser. For remote sessions, paste the final redirect URL."
				: "Authorize the new API key, then paste the one-time code.",
		});

		const result = await waitForCallbackOrManualInput(interaction, callback, {
			message: "Paste the TokenDance authorization code or redirect URL:",
			placeholder: callback?.redirectUri ?? "One-time authorization code",
		});
		if (result.type === "callback") return result.value;
		const code = authorizationCode(result.input);
		if (!code) throw new Error("Missing authorization code");
		interaction.notify({ type: "progress", message: "Exchanging one-time code for TokenDance API key..." });
		return await exchangeCode(code, verifier, interaction.signal);
	} finally {
		callback?.close();
	}
}

export const tokenDanceOAuth: OAuthAuth = {
	name: "TokenDance API-key authorization",
	loginLabel: "Sign in with TokenDance",
	login,
	async refresh(credential) {
		return credential;
	},
	async toAuth(credential) {
		return { apiKey: credential.access };
	},
};
