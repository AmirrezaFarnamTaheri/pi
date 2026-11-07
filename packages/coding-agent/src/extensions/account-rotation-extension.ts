/** Optional per-request account/key rotation extension for Pi. */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI, ProviderModelConfig } from "@earendil-works/pi-coding-agent";
import type { Provider } from "@earendil-works/pi-ai";
import { RotationPool, type RotationTarget } from "./account-rotation-policy.ts";

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
	members: RotationMember[];
}

export interface RotationConfiguration {
	pools: RotationGroup[];
}

function record(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Parse user-controlled configuration, rejecting plaintext credentials and ambiguous aliases. */
export function parseRotationConfiguration(value: unknown): RotationConfiguration {
	if (!record(value) || !Array.isArray(value.pools)) throw new Error("account-rotation.json must contain pools[]");
	if (value.pools.length > 32) throw new Error("Too many account rotation pools");
	const ids = new Set<string>();
	const aliases = new Map<string, string>();
	const pools: RotationGroup[] = [];
	for (const raw of value.pools) {
		if (!record(raw) || typeof raw.id !== "string" || !/^[a-z][a-z0-9_-]{0,63}$/.test(raw.id)) {
			throw new Error("Rotation pool id must use lowercase letters, numbers, _ or -");
		}
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
			...(cooldownMs === undefined ? {} : { cooldownMs: cooldownMs as number }), members });
	}
	return { pools };
}

/** A named provider with its own credential and the source provider\'s native OAuth methods. */
export function createOAuthAccountAlias(source: Provider, id: string): Provider {
	if (!source.auth.oauth) throw new Error(`Provider ${source.id} does not support OAuth login`);
	const { refreshModels: _refreshModels, ...rest } = source;
	return {
		...rest, id, name: `${source.name} (${id})`, auth: { oauth: source.auth.oauth },
		getModels: () => source.getModels().map((model) => ({ ...model, provider: id })),
		getAllModels: () => (source.getAllModels?.() ?? source.getModels()).map((model) => ({ ...model, provider: id })),
		...(source.filterModels ? { filterModels: (models: Parameters<NonNullable<Provider["filterModels"]>>[0], credential: Parameters<NonNullable<Provider["filterModels"]>>[1]) =>
			source.filterModels!(models.map((model) => ({ ...model, provider: source.id })), credential).map((model) => ({ ...model, provider: id })) } : {}),
		...(source.filterAllModels ? { filterAllModels: (models: Parameters<NonNullable<Provider["filterAllModels"]>>[0], credential: Parameters<NonNullable<Provider["filterAllModels"]>>[1]) =>
			source.filterAllModels!(models.map((model) => ({ ...model, provider: source.id })), credential).map((model) => ({ ...model, provider: id })) } : {}),
	};
}
/** Register virtual routing models and independently authenticated account aliases. */
export function registerAccountRotation(pi: ExtensionAPI, configuration: RotationConfiguration): void {
	const state = configuration.pools.map((group) => {
		let pool: RotationPool | undefined;
		let fingerprint = "";
		return { group, get(active: RotationTarget[]): RotationPool {
			const next = active.map((target) => `${target.provider}\u0000${target.model}`).join("\u0001");
			if (!pool || fingerprint !== next) {
				if (active.length === 0) throw new Error(`Account rotation ${group.id}: no configured accounts`);
				pool = new RotationPool(active, group.cooldownMs);
				fingerprint = next;
			}
			return pool;
		}, reset() { pool?.reset(); }, status() { return pool?.status() ?? []; } };
	});

	pi.on("session_start", async (_event, ctx) => {
		let added = false;
		const registered = new Set<string>();
		for (const { group } of state) {
			for (const member of group.members) {
				if (!member.sourceProvider || registered.has(member.provider)) continue;
				if (!member.apiKeyEnv) {
									const source = ctx.modelRegistry.getProvider(member.sourceProvider);
									if (!source) continue;
									pi.registerProvider(createOAuthAccountAlias(source, member.provider));
									registered.add(member.provider);
									added = true;
									continue;
								}
				if (!process.env[member.apiKeyEnv]) continue;
				const source = ctx.modelRegistry.find(member.sourceProvider, member.model);
				if (!source || source.api === "pi-virtual") continue;
				const model: ProviderModelConfig = {
					id: source.id,
					name: source.name,
					input: [...source.input],
					api: source.api,
					cost: source.cost,
					reasoning: source.reasoning,
					contextWindow: source.contextWindow,
					maxTokens: source.maxTokens,
					...(source.thinkingLevelMap ? { thinkingLevelMap: source.thinkingLevelMap } : {}),
					...(source.inputLimits ? { inputLimits: source.inputLimits } : {}),
					...(source.promptCache ? { promptCache: source.promptCache } : {}),
					...(source.compat ? { compat: source.compat } : {}),
				};
				pi.registerProvider(member.provider, {
					name: `${member.provider} (rotation)`,
					api: source.api,
					baseUrl: source.baseUrl,
					apiKey: `$${member.apiKeyEnv}`,
					authHeader: source.api === "openai-completions" || source.api === "openai-responses",
					models: [model],
				});
				registered.add(member.provider);
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
				const available = group.members.filter((member) => {
					const model = ctx.modelRegistry.find(member.provider, member.model);
					return model !== undefined && ctx.modelRegistry.hasConfiguredAuth(model);
				});
				const pool = entry.get(available);
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

	pi.registerCommand("account-rotation", {
		description: "Show account/key rotation pools, or reset their cooldowns",
		async handler(args, ctx) {
			const command = args.trim();
			if (command === "reset") {
				for (const entry of state) entry.reset();
				if (ctx.hasUI) ctx.ui.notify("Account rotation cooldowns cleared", "info");
				return;
			}
			if (command && command !== "status") {
				if (ctx.hasUI) ctx.ui.notify("Usage: /account-rotation [status|reset]", "warning");
				return;
			}
			const lines = state.flatMap(({ group, status }) => [
				`${group.id}: ${group.members.map((member) => member.provider).join(", ")}`,
				...status().filter((candidate) => candidate.readyInMs > 0)
					.map((candidate) => `  ${candidate.target.provider}: cooling down for ${Math.ceil(candidate.readyInMs / 1_000)}s`),
			]);
			if (ctx.hasUI) ctx.ui.notify(lines.join("\n") || "No rotation pools configured", "info");
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
