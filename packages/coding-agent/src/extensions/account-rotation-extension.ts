/** Optional per-request account/key rotation extension for Pi. */

import { createHmac, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { Provider } from "@earendil-works/pi-ai";
import { AssistantMessageEventStream } from "@earendil-works/pi-ai/utils/event-stream";
import { RotationPool, type RotationHealth, type RotationStrategy, type RotationTarget } from "./account-rotation-policy.ts";

export interface RotationMember extends RotationTarget {
	/** Environment variable name holding an API key, never its value. */
	apiKeyEnv?: string;
	/** Catalog provider whose physical model metadata the alias copies. */
	sourceProvider?: string;
}

export interface RotationGroup {
	id: string;
	name?: string;
	cooldownMs?: number;
	strategy?: RotationStrategy;
	members: RotationMember[];
}

export interface RotationConfiguration {
	pools: RotationGroup[];
}

function record(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function rejectUnexpectedKeys(value: Record<string, unknown>, allowed: readonly string[], label: string): void {
	const unexpected = Object.keys(value).find((key) => !allowed.includes(key));
	if (unexpected) throw new Error(`Unexpected ${label} field: ${unexpected}`);
}

/** Parse user-controlled configuration, rejecting plaintext credentials and ambiguous aliases. */
export function parseRotationConfiguration(value: unknown): RotationConfiguration {
	if (!record(value) || !Array.isArray(value.pools)) throw new Error("account-rotation.json must contain pools[]");
	rejectUnexpectedKeys(value, ["pools"], "rotation configuration");
	if (value.pools.length > 32) throw new Error("Too many account rotation pools");
	const ids = new Set<string>();
	const aliases = new Map<string, string>();
	const keyIdentities = new Map<string, string>();
	const pools: RotationGroup[] = [];
	for (const raw of value.pools) {
		if (!record(raw) || typeof raw.id !== "string" || !/^[a-z][a-z0-9_-]{0,63}$/.test(raw.id)) {
			throw new Error("Rotation pool id must use lowercase letters, numbers, _ or -");
		}
		rejectUnexpectedKeys(raw, ["id", "name", "cooldownMs", "strategy", "members"], "pool");
		if (ids.has(raw.id)) throw new Error("Duplicate rotation pool id");
		ids.add(raw.id);
		if (!Array.isArray(raw.members) || raw.members.length === 0 || raw.members.length > 64) {
			throw new Error(`Rotation pool ${raw.id} needs between 1 and 64 account slots`);
		}
		const cooldownMs = raw.cooldownMs;
		if (cooldownMs !== undefined && (typeof cooldownMs !== "number" || !Number.isSafeInteger(cooldownMs) || cooldownMs < 1 || cooldownMs > 86_400_000)) {
			throw new Error(`Rotation pool ${raw.id} has an invalid cooldownMs`);
		}
		if (raw.name !== undefined && typeof raw.name !== "string") throw new Error(`Rotation pool ${raw.id} has an invalid name`);
		if (raw.strategy !== undefined && (typeof raw.strategy !== "string" ||
			!["round-robin", "sticky", "random", "hybrid"].includes(raw.strategy))) {
			throw new Error(`Rotation pool ${raw.id} has an invalid strategy`);
		}
		const members: RotationMember[] = [];
		const slots = new Set<string>();
		const credentials = new Set<string>();
		for (const member of raw.members) {
			if (!record(member) || typeof member.provider !== "string" || !/^[a-z][a-z0-9_-]{0,63}$/.test(member.provider) ||
				typeof member.model !== "string" || member.model.length === 0 || member.model.length > 256) {
				throw new Error(`Rotation pool ${raw.id} has an invalid account slot`);
			}
			if (Object.hasOwn(member, "apiKey") || Object.hasOwn(member, "key")) {
				throw new Error("Literal API keys are not allowed in rotation config; use apiKeyEnv");
			}
			rejectUnexpectedKeys(member, ["provider", "model", "apiKeyEnv", "sourceProvider"], "account slot");
			const slot = `${member.provider}\u0000${member.model}`;
			if (slots.has(slot)) throw new Error(`Rotation pool ${raw.id} has a duplicate account slot`);
			slots.add(slot);
			if (credentials.has(member.provider)) throw new Error(`Rotation pool ${raw.id} has duplicate credentials`);
			credentials.add(member.provider);
			const target: RotationMember = { provider: member.provider, model: member.model };
			if (member.apiKeyEnv !== undefined) {
				if (typeof member.apiKeyEnv !== "string" || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(member.apiKeyEnv) ||
					typeof member.sourceProvider !== "string" || !/^[a-z][a-z0-9_-]{0,63}$/.test(member.sourceProvider) ||
					member.provider === member.sourceProvider) {
					throw new Error("Key slots require distinct provider alias, sourceProvider and apiKeyEnv name");
				}
				
				const identity = `${member.sourceProvider}\u0000${member.apiKeyEnv}`;
				const previousAlias = keyIdentities.get(identity);
				if (previousAlias && previousAlias !== member.provider) {
					throw new Error("Duplicate API key credential used by different account aliases");
				}
				keyIdentities.set(identity, member.provider);
				target.apiKeyEnv = member.apiKeyEnv;
				target.sourceProvider = member.sourceProvider;
			} else if (member.sourceProvider !== undefined) {
				if (typeof member.sourceProvider !== "string" || !/^[a-z][a-z0-9_-]{0,63}$/.test(member.sourceProvider) || member.provider === member.sourceProvider) {
					throw new Error("OAuth slots require a distinct provider alias and sourceProvider");
				}
				target.sourceProvider = member.sourceProvider;
			}
			if (target.sourceProvider) {
				const description = `${target.sourceProvider}\u0000${target.apiKeyEnv ?? "oauth"}`;
				const existing = aliases.get(target.provider);
				if (existing && existing !== description) throw new Error("Account alias has conflicting authentication");
				aliases.set(target.provider, description);
			}
			members.push(target);
		}
		pools.push({ id: raw.id, ...(raw.name === undefined ? {} : { name: raw.name }),
			...(cooldownMs === undefined ? {} : { cooldownMs: cooldownMs as number }),
			...(raw.strategy === undefined ? {} : { strategy: raw.strategy as RotationStrategy }), members });
	}
	return { pools };
}

/** Keep the original provider identity for upstream SDK compatibility, then restore the
 * account alias on Pi-visible responses (including partial streaming events). */
function accountStream(stream: AssistantMessageEventStream, id: string): AssistantMessageEventStream {
	const output = new AssistantMessageEventStream();
	void (async () => {
		try {
			let terminal = false;
			for await (const event of stream) {
				if ("partial" in event) {
					output.push({ ...event, partial: { ...event.partial, provider: id } });
				} else if (event.type === "done") {
					terminal = true;
					output.push({ ...event, message: { ...event.message, provider: id } });
				} else if (event.type === "error") {
					terminal = true;
					output.push({ ...event, error: { ...event.error, provider: id } });
				}
			}
			if (!terminal) output.end({ ...(await stream.result()), provider: id });
		} catch (error) {
			output.fail(error);
		}
	})();
	return output;
}

/** Preserve source provider's custom stream, auth-header and transport behavior. */
function accountAlias(source: Provider, id: string, auth: Provider["auth"]): Provider {
	const { refreshModels: _refreshModels, ...rest } = source;
	return {
		...rest, id, name: `${source.name} (${id})`, auth,
		getModels: () => source.getModels().map((model) => ({ ...model, provider: id })),
		getAllModels: () => (source.getAllModels?.() ?? source.getModels()).map((model) => ({ ...model, provider: id })),
		stream: (model, context, options) => accountStream(
			source.stream({ ...model, provider: source.id }, context, options), id),
		streamSimple: (model, context, options) => accountStream(
			source.streamSimple({ ...model, provider: source.id }, context, options), id),
		...(source.fetchDeferred ? { fetchDeferred: (model: Parameters<NonNullable<Provider["fetchDeferred"]>>[0],
			handle: Parameters<NonNullable<Provider["fetchDeferred"]>>[1],
			options: Parameters<NonNullable<Provider["fetchDeferred"]>>[2]) =>
			accountStream(source.fetchDeferred!({ ...model, provider: source.id }, handle, options), id) } : {}),
		...(source.cancelDeferred ? { cancelDeferred: (model: Parameters<NonNullable<Provider["cancelDeferred"]>>[0],
			handle: Parameters<NonNullable<Provider["cancelDeferred"]>>[1],
			options: Parameters<NonNullable<Provider["cancelDeferred"]>>[2]) =>
			source.cancelDeferred!({ ...model, provider: source.id }, handle, options) } : {}),
		...(source.generateImages ? { generateImages: async (model: Parameters<NonNullable<Provider["generateImages"]>>[0],
			context: Parameters<NonNullable<Provider["generateImages"]>>[1],
			options: Parameters<NonNullable<Provider["generateImages"]>>[2]) => ({
				...(await source.generateImages!({ ...model, provider: source.id }, context, options)), provider: id,
			}) } : {}),
		...(source.classify ? { classify: async (model: Parameters<NonNullable<Provider["classify"]>>[0],
			context: Parameters<NonNullable<Provider["classify"]>>[1],
			options: Parameters<NonNullable<Provider["classify"]>>[2]) => ({
				...(await source.classify!({ ...model, provider: source.id }, context, options)), provider: id,
			}) } : {}),
		...(source.filterModels ? { filterModels: (models: Parameters<NonNullable<Provider["filterModels"]>>[0],
			credential: Parameters<NonNullable<Provider["filterModels"]>>[1]) =>
				source.filterModels!(models.map((model) => ({ ...model, provider: source.id })), credential)
					.map((model) => ({ ...model, provider: id })) } : {}),
		...(source.filterAllModels ? { filterAllModels: (models: Parameters<NonNullable<Provider["filterAllModels"]>>[0],
			credential: Parameters<NonNullable<Provider["filterAllModels"]>>[1]) =>
				source.filterAllModels!(models.map((model) => ({ ...model, provider: source.id })), credential)
					.map((model) => ({ ...model, provider: id })) } : {}),
	};
}

/** A named provider with independent OAuth credentials and the source's native SDK. */
export function createOAuthAccountAlias(source: Provider, id: string, onLogin?: () => void): Provider {
	const oauth = source.auth.oauth;
	if (!oauth) throw new Error(`Provider ${source.id} does not support OAuth login`);
	return accountAlias(source, id, { oauth: {
		...oauth,
		login: async (interaction, options) => {
			const credentials = await oauth.login(interaction, options);
			onLogin?.();
			return credentials;
		},
	} });
}

/** Environment-backed identity that ignores stale credentials saved under its alias. */
export function createApiKeyAccountAlias(source: Provider, id: string, envVar: string): Provider {
	return accountAlias(source, id, {
		apiKey: {
			name: `${source.name} API key (${envVar})`,
			check: async ({ ctx, signal }) => {
				signal.throwIfAborted();
				return (await ctx.env(envVar)) ? { type: "api_key", source: envVar } : undefined;
			},
			resolve: async ({ ctx, signal }) => {
				signal.throwIfAborted();
				const key = await ctx.env(envVar);
				if (!key) return undefined;
				const original = source.auth.apiKey;
				if (original) {
					const resolved = await original.resolve({
						ctx, signal, credential: { type: "api_key", key },
					});
					if (resolved) return resolved;
				}
				return { auth: { apiKey: key }, source: envVar };
			},
		},
	});
}

/** Register virtual routing models and independently authenticated account aliases. */
export function registerAccountRotation(pi: ExtensionAPI, configuration: RotationConfiguration): void {
	const health = new Map<string, RotationHealth>();
	const ownedAliases = new Set<string>();
	// A keyed fingerprint detects API key replacement without storing plaintext keys.
	const salt = randomBytes(32);
	const keyFingerprints = new Map<string, string | null>();
	const onReauthenticated = (provider: string) => {
		for (const { group, pool } of state) {
			const member = group.members.find((entry) => entry.provider === provider);
			if (member) pool.markReauthenticated(member);
		}
	};
	const state = configuration.pools.map((group) => {
		const pool = new RotationPool(group.members, group.cooldownMs, group.strategy, Math.random, health);
		return {
			group, pool,
			get(_active: RotationTarget[]): RotationPool { return pool; },
			reset() { pool.reset(); },
			status() { return pool.status(); },
			withAccount(provider: string, fn: (pool: RotationPool, target: RotationTarget) => void): void {
				const match = group.members.find((member) => member.provider === provider);
				if (!match) throw new Error(`Unknown account: ${provider}`);
				fn(pool, match);
			},
		};
	});

	pi.on("session_start", async (_event, ctx) => {
		let added = false;
		for (const { group } of state) {
			for (const member of group.members) {
				if (!member.sourceProvider || ownedAliases.has(member.provider)) continue;
				// Never clobber a built-in or another extension's provider.
				if (ctx.modelRegistry.getProvider(member.provider)) {
					throw new Error(`Rotation account alias conflicts with existing provider: ${member.provider}`);
				}
				const source = ctx.modelRegistry.getProvider(member.sourceProvider);
				if (!source) continue;
				const alias = member.apiKeyEnv
					? createApiKeyAccountAlias(source, member.provider, member.apiKeyEnv)
					: createOAuthAccountAlias(source, member.provider, () => onReauthenticated(member.provider));
				pi.registerProvider(alias);
				ownedAliases.add(member.provider);
				added = true;
			}
		}
		if (added) await ctx.modelRegistry.refresh({ allowNetwork: false });
	});
	for (const entry of state) {
		const { group } = entry;
		pi.registerVirtualModel<{ active: RotationTarget }>({
			provider: "account-rotation",
			id: group.id,
			name: group.name ?? `Account rotation (${group.id})`,
			thinkingLevels: ["off", "minimal", "low", "medium", "high", "xhigh", "max"],
			async route(request, ctx) {
				if (request.signal?.aborted) throw new Error("Account rotation request cancelled");
				for (const member of group.members) {
					if (member.apiKeyEnv) {
						const key = process.env[member.apiKeyEnv];
						const fingerprint = key ? createHmac("sha256", salt).update(key).digest("hex") : null;
						const previousFingerprint = keyFingerprints.get(member.provider);
						if (keyFingerprints.has(member.provider) && previousFingerprint !== fingerprint && key) {
							onReauthenticated(member.provider);
						}
						keyFingerprints.set(member.provider, fingerprint);
					}
					const model = ctx.modelRegistry.find(member.provider, member.model);
					entry.pool.setAvailable(member, model !== undefined &&
						model.api !== "pi-virtual" &&
						(!member.apiKeyEnv || !!process.env[member.apiKeyEnv]) &&
						ctx.modelRegistry.hasConfiguredAuth(model));
				}
				const pool = entry.pool;
				const failed = request.failed;
				const hasOutput = failed?.message.content.some((block) =>
					block.type === "toolCall" || (block.type === "text" && block.text.length > 0) ||
					(block.type === "thinking" && block.thinking.length > 0)) ?? false;
				const choice = pool.choose({
					reason: request.reason,
					previous: request.previous && { provider: request.previous.model.provider, model: request.previous.model.id },
					active: request.state?.active,
					failed: failed && { target: { provider: failed.model.provider, model: failed.model.id },
						errorMessage: failed.message.errorMessage ?? "", hasOutput },
				});
				const model = ctx.modelRegistry.find(choice.target.provider, choice.target.model);
				if (!model) throw new Error(`Account rotation ${group.id}: selected model is unavailable`);
				const previous = request.state;
				const same = previous?.active.provider === choice.target.provider && previous.active.model === choice.target.model;
				return { model, thinkingLevel: request.thinkingLevel,
					state: same ? previous : { active: choice.target } };
			},
		});
	}

	// A successful physical response restores the credential's health after failures.
	// This event never reads, copies, or exposes OAuth tokens.
	pi.on("message_end", async (event) => {
		const message = event.message;
		if (message.role !== "assistant" ||
			!["stop", "length", "toolUse"].includes(message.stopReason)) return;
		for (const entry of state) {
			const status = entry.status();
			const match = status.find((candidate) =>
				candidate.target.provider === message.provider && candidate.target.model === message.model);
			if (match) entry.pool.markSuccess(match.target);
		}
	});

	pi.registerCommand("account-rotation", {
		description: "Inspect, pin, enable, disable, or update quota for authenticated account pools",
		async handler(args, ctx) {
			const [command = "status", poolId, provider, fraction, resetTime] = args.trim().split(/\s+/);
			const notify = (message: string, level: "info" | "warning" = "info") => {
				if (ctx.hasUI) ctx.ui.notify(message, level);
			};
			if (!command || command === "status") {
				const lines = state.flatMap(({ group, status }) => [
					`${group.id} (${group.strategy ?? "round-robin"}):`,
					...(status().length > 0 ? status().map((entry) => {
						const details = [
							entry.enabled ? "enabled" : "disabled",
							`health ${entry.healthScore}`,
							...(entry.quotaRemaining === undefined ? [] : [`quota ${Math.round(entry.quotaRemaining * 100)}%`]),
							...(entry.quotaBlocked && !Number.isFinite(entry.readyInMs)
								? ["quota exhausted (reset unknown)"]
								: entry.readyInMs ? [`ready in ${Math.ceil(entry.readyInMs / 1_000)}s`] : []),
							...(entry.available ? [] : ["login or model unavailable"]),
							...(entry.pinned ? ["pinned"] : []),
						];
						return `  ${entry.target.provider}: ${details.join(", ")}`;
					}) : [`  ${group.members.map((member) => member.provider).join(", ")} (not yet selected)`]),
				]);
				notify(lines.join("\n") || "No rotation pools configured");
				return;
			}
			const entry = state.find(({ group }) => group.id === poolId);
			if (command === "reset") {
				if (poolId && !entry) { notify(`Unknown rotation pool: ${poolId}`, "warning"); return; }
				for (const item of poolId ? [entry!] : state) item.reset();
				notify(`Account rotation health and cooldown state reset${poolId ? ` for ${poolId}` : ""}`);
				return;
			}
			if (!entry) { notify("Specify a known account pool", "warning"); return; }
			try {
				if (command === "unpin") {
					entry.withAccount(entry.status()[0]?.target.provider ?? "", (pool) => { pool.unpin(); });
				} else if (command === "disable" || command === "enable" || command === "pin") {
					if (!provider) throw new Error("Specify an account alias");
					entry.withAccount(provider, (pool, target) => {
						if (command === "pin") pool.pin(target);
						else pool.setEnabled(target, command === "enable");
					});
				} else if (command === "quota") {
					if (!provider || fraction === undefined) throw new Error("Use: quota <pool> <account> <fraction> [reset-epoch-ms]");
					const remaining = Number(fraction);
					const resetAt = resetTime === undefined ? undefined : Number(resetTime);
					entry.withAccount(provider, (pool, target) => { pool.reportQuota(target, remaining, resetAt); });
				} else {
					throw new Error("Usage: /account-rotation [status|reset [pool]|enable|disable|pin|unpin|quota]");
				}
				notify(`Account rotation ${command} applied to pool ${entry.group.id}`);
			} catch (error) {
				notify(error instanceof Error ? error.message : String(error), "warning");
			}
		},
	});
}

/** Load trusted global rotation config; without a file, this extension is inert. */
export default function accountRotation(pi: ExtensionAPI): void {
	const path = join(getAgentDir(), "account-rotation.json");
	let raw: string;
	try {
		raw = readFileSync(path, "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
		throw error;
	}
	registerAccountRotation(pi, parseRotationConfiguration(JSON.parse(raw)));
}
