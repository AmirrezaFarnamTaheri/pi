/**
 * The wire format of auth.json. Keep legacy provider -> Credential entries
 * readable, but store repeated API key strings and identical OAuth logins once.
 *
 * Logical account IDs remain independent. Shared entries are storage-only:
 * callers always receive full, separately cloned Credential objects.
 */
import type { Credential, OAuthCredential } from "./types.ts";

export const SHARED_AUTH_CREDENTIALS_KEY = "$piSharedCredentials";
const API_KEY_REF = "$piApiKeyRef";
const OAUTH_REF = "$piOAuthRef";

type JsonRecord = Record<string, unknown>;

function record(value: unknown): value is JsonRecord {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function validateCredential(value: unknown): Credential {
	if (!record(value)) throw new Error("Invalid auth.json credential");
	if (value.type === "api_key") {
		if (value.key !== undefined && typeof value.key !== "string") {
			throw new Error("Invalid auth.json API key");
		}
		if (
			value.env !== undefined &&
			(!record(value.env) || Object.values(value.env).some((entry) => typeof entry !== "string"))
		) {
			throw new Error("Invalid auth.json credential environment");
		}
		return value as unknown as Credential;
	}
	if (
		value.type === "oauth" &&
		typeof value.access === "string" &&
		typeof value.refresh === "string" &&
		typeof value.expires === "number" &&
		Number.isFinite(value.expires)
	) {
		return value as unknown as Credential;
	}
	throw new Error("Invalid auth.json credential");
}

function archiveEntries(value: unknown, name: string): JsonRecord {
	if (!record(value)) throw new Error(`Invalid auth.json shared ${name}`);
	return value;
}

/** Stable comparison without logging or exposing any secret-derived fingerprint. */
function canonicalCredential(value: Credential): string {
	return JSON.stringify(value, (_key, entry: unknown) =>
		record(entry) ? Object.fromEntries(Object.entries(entry).sort(([a], [b]) => a.localeCompare(b))) : entry,
	);
}

export function sameStoredCredential(a: Credential, b: Credential): boolean {
	return canonicalCredential(a) === canonicalCredential(b);
}

/**
 * Resolve legacy and compact auth.json formats into ordinary credentials.
 * Reject dangling, unknown, or malformed references; never fall back to ambient auth.
 */
export function parseCredentialArchive(value: unknown): Record<string, Credential> {
	if (!record(value)) throw new Error("Invalid auth.json: expected an object");
	const source = value;
	const rawPool = source[SHARED_AUTH_CREDENTIALS_KEY];
	let keys: JsonRecord = {};
	let oauth: JsonRecord = {};
	if (rawPool !== undefined) {
		if (!record(rawPool) || rawPool.version !== 1) {
			throw new Error("Unsupported auth.json shared credential format");
		}
		keys = archiveEntries(rawPool.apiKeys, "API keys");
		oauth = archiveEntries(rawPool.oauth, "OAuth credentials");
		for (const secret of Object.values(keys)) {
			if (typeof secret !== "string") throw new Error("Invalid shared API key");
		}
		for (const secret of Object.values(oauth)) {
			if (validateCredential(secret).type !== "oauth") throw new Error("Invalid shared OAuth credential");
		}
	}
	const entries: Array<[string, Credential]> = [];
	for (const [providerId, raw] of Object.entries(source)) {
		if (providerId === SHARED_AUTH_CREDENTIALS_KEY) continue;
		if (!record(raw)) throw new Error(`Invalid auth.json credential for "${providerId}"`);
		if (Object.hasOwn(raw, OAUTH_REF)) {
			if (
				Object.keys(raw).length !== 1 ||
				typeof raw[OAUTH_REF] !== "string" ||
				!Object.hasOwn(oauth, raw[OAUTH_REF])
			) {
				throw new Error(`Invalid shared OAuth reference for "${providerId}"`);
			}
			entries.push([providerId, structuredClone(oauth[raw[OAUTH_REF]] as OAuthCredential)]);
			continue;
		}
		if (raw.type === "api_key" && record(raw.key) && Object.hasOwn(raw.key, API_KEY_REF)) {
			const keyRef = raw.key;
			if (
				Object.keys(keyRef).length !== 1 ||
				typeof keyRef[API_KEY_REF] !== "string" ||
				!Object.hasOwn(keys, keyRef[API_KEY_REF])
			) {
				throw new Error(`Invalid shared API key reference for "${providerId}"`);
			}
			entries.push([providerId, validateCredential({ ...raw, key: keys[keyRef[API_KEY_REF]] })]);
			continue;
		}
		entries.push([providerId, validateCredential(raw)]);
	}
	return Object.fromEntries(entries);
}

/**
 * Preserve the old flat format when nothing is shared. Only repeated secrets
 * create a pool; single remaining references are automatically inlined.
 */
export function serializeCredentialArchive(credentials: Record<string, Credential>): string {
	if (Object.hasOwn(credentials, SHARED_AUTH_CREDENTIALS_KEY)) {
		throw new Error("Reserved auth.json credential ID");
	}
	const entries = Object.entries(credentials);
	const keyCounts = new Map<string, number>();
	const oauthCounts = new Map<string, number>();
	for (const [, candidate] of entries) {
		const credential = validateCredential(candidate);
		if (credential.type === "api_key" && credential.key !== undefined) {
			keyCounts.set(credential.key, (keyCounts.get(credential.key) ?? 0) + 1);
		} else if (credential.type === "oauth") {
			const fingerprint = canonicalCredential(credential);
			oauthCounts.set(fingerprint, (oauthCounts.get(fingerprint) ?? 0) + 1);
		}
	}
	const apiKeys: Record<string, string> = {};
	const oauth: Record<string, OAuthCredential> = {};
	const keyRefs = new Map<string, string>();
	const oauthRefs = new Map<string, string>();
	const serialized: Array<[string, unknown]> = [];
	for (const [providerId, credential] of entries) {
		if (credential.type === "api_key" && credential.key !== undefined && (keyCounts.get(credential.key) ?? 0) > 1) {
			let ref = keyRefs.get(credential.key);
			if (!ref) {
				ref = `k${keyRefs.size + 1}`;
				keyRefs.set(credential.key, ref);
				apiKeys[ref] = credential.key;
			}
			serialized.push([providerId, { ...credential, key: { [API_KEY_REF]: ref } }]);
		} else if (credential.type === "oauth") {
			const fingerprint = canonicalCredential(credential);
			if ((oauthCounts.get(fingerprint) ?? 0) > 1) {
				let ref = oauthRefs.get(fingerprint);
				if (!ref) {
					ref = `o${oauthRefs.size + 1}`;
					oauthRefs.set(fingerprint, ref);
					oauth[ref] = credential;
				}
				serialized.push([providerId, { [OAUTH_REF]: ref }]);
			} else {
				serialized.push([providerId, credential]);
			}
		} else {
			serialized.push([providerId, credential]);
		}
	}
	if (keyRefs.size > 0 || oauthRefs.size > 0) {
		serialized.push([SHARED_AUTH_CREDENTIALS_KEY, { version: 1, apiKeys, oauth }]);
	}
	return JSON.stringify(Object.fromEntries(serialized), null, 2);
}
