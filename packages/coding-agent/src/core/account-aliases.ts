/** Shared provider-alias adapters. Credentials remain scoped to each unique provider ID. */
import type { AnyModel, Api, Model, Provider } from "@earendil-works/pi-ai";
import { AssistantMessageEventStream } from "@earendil-works/pi-ai/utils/event-stream";

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
	let accountModels: readonly AnyModel[] | undefined;
	const toAlias = <T extends AnyModel>(model: T): T => ({ ...model, provider: id });
	return {
		...rest,
		id,
		name: `${source.name} (${id})`,
		auth,
		getModels: () =>
			(accountModels
				? accountModels.filter(
						(model): model is Model<Api> => model.type !== "image" && model.type !== "classifier",
					)
				: source.getModels()
			).map(toAlias),
		getAllModels: () => (accountModels ?? source.getAllModels?.() ?? source.getModels()).map(toAlias),
		...(source.refreshModels
			? {
					refreshModels: async (context: Parameters<NonNullable<Provider["refreshModels"]>>[0]) => {
						// Dynamic provider refreshes publish through a shared source instance.
						// Remap its persisted catalog to this alias without ever applying its update
						// callback to the original account's in-memory model list.
						const stored = context.stored
							? {
									...context.stored,
									models: context.stored.models.map((model) => ({ ...model, provider: source.id })),
								}
							: undefined;
						await source.refreshModels!({
							...context,
							stored,
							publish: async (publication) => {
								const models = publication.persist?.models ?? context.stored?.models;
								const mapped = models?.map(toAlias);
								if (context.allowNetwork && !mapped && publication.update) {
									// Applying the source update would mutate another account's catalog.
									throw new Error("Dynamic source did not publish an isolated per-account model catalog");
								}
								return context.publish({
									...(publication.persist ? { persist: { ...publication.persist, models: mapped! } } : {}),
									update: () => {
										if (mapped) accountModels = mapped;
									},
								});
							},
						});
					},
				}
			: {}),
		stream: (model, context, options) =>
			accountStream(source.stream({ ...model, provider: source.id }, context, options), id),
		streamSimple: (model, context, options) =>
			accountStream(source.streamSimple({ ...model, provider: source.id }, context, options), id),
		...(source.fetchDeferred
			? {
					fetchDeferred: (
						model: Parameters<NonNullable<Provider["fetchDeferred"]>>[0],
						handle: Parameters<NonNullable<Provider["fetchDeferred"]>>[1],
						options: Parameters<NonNullable<Provider["fetchDeferred"]>>[2],
					) => accountStream(source.fetchDeferred!({ ...model, provider: source.id }, handle, options), id),
				}
			: {}),
		...(source.cancelDeferred
			? {
					cancelDeferred: (
						model: Parameters<NonNullable<Provider["cancelDeferred"]>>[0],
						handle: Parameters<NonNullable<Provider["cancelDeferred"]>>[1],
						options: Parameters<NonNullable<Provider["cancelDeferred"]>>[2],
					) => source.cancelDeferred!({ ...model, provider: source.id }, handle, options),
				}
			: {}),
		...(source.generateImages
			? {
					generateImages: async (
						model: Parameters<NonNullable<Provider["generateImages"]>>[0],
						context: Parameters<NonNullable<Provider["generateImages"]>>[1],
						options: Parameters<NonNullable<Provider["generateImages"]>>[2],
					) => ({
						...(await source.generateImages!({ ...model, provider: source.id }, context, options)),
						provider: id,
					}),
				}
			: {}),
		...(source.classify
			? {
					classify: async (
						model: Parameters<NonNullable<Provider["classify"]>>[0],
						context: Parameters<NonNullable<Provider["classify"]>>[1],
						options: Parameters<NonNullable<Provider["classify"]>>[2],
					) => ({
						...(await source.classify!({ ...model, provider: source.id }, context, options)),
						provider: id,
					}),
				}
			: {}),
		...(source.filterModels
			? {
					filterModels: (
						models: Parameters<NonNullable<Provider["filterModels"]>>[0],
						credential: Parameters<NonNullable<Provider["filterModels"]>>[1],
					) =>
						source.filterModels!(
							models.map((model) => ({ ...model, provider: source.id })),
							credential,
						).map((model) => ({ ...model, provider: id })),
				}
			: {}),
		...(source.filterAllModels
			? {
					filterAllModels: (
						models: Parameters<NonNullable<Provider["filterAllModels"]>>[0],
						credential: Parameters<NonNullable<Provider["filterAllModels"]>>[1],
					) =>
						source.filterAllModels!(
							models.map((model) => ({ ...model, provider: source.id })),
							credential,
						).map((model) => ({ ...model, provider: id })),
				}
			: {}),
	};
}

/** A named provider with independent OAuth credentials and the source's native SDK. */
export function createOAuthAccountAlias(source: Provider, id: string, onLogin?: () => void): Provider {
	const oauth = source.auth.oauth;
	if (!oauth) throw new Error(`Provider ${source.id} does not support OAuth login`);
	return accountAlias(source, id, {
		oauth: {
			...oauth,
			login: async (interaction, options) => {
				const credentials = await oauth.login(interaction, options);
				onLogin?.();
				return credentials;
			},
		},
	});
}

/** Environment-backed identity that ignores stale credentials saved under its alias. */
export function createApiKeyAccountAlias(source: Provider, id: string, envVar: string): Provider {
	if (!source.auth.apiKey) throw new Error(`Source provider ${source.id} does not support API-key authentication`);
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
				const resolved = await source.auth.apiKey!.resolve({
					ctx,
					signal,
					credential: { type: "api_key", key },
				});
				return resolved ? { ...resolved, source: envVar } : undefined;
			},
		},
	});
}

/**
 * A separate sign-in identity. Unlike a provider's original auth, this API-key
 * adapter must NEVER fall back to ambient environment keys or models.json keys.
 * Only credentials explicitly stored under this alias may authorize requests.
 */
export function createStoredAccountAlias(source: Provider, id: string, name?: string): Provider {
	if (!source.auth.oauth && !source.auth.apiKey?.login) {
		throw new Error(`Provider ${source.id} cannot add an independent login`);
	}
	const apiKey = source.auth.apiKey;
	const isolatedApiKey = apiKey?.login
		? {
				...apiKey,
				login: async (interaction: Parameters<NonNullable<typeof apiKey.login>>[0]) => {
					const credential = await apiKey.login!(interaction);
					if (!credential.key) throw new Error("Independent API-key accounts require a stored key");
					return credential;
				},
				check: async (input: Parameters<NonNullable<typeof apiKey.check>>[0]) => {
					if (!input.credential?.key) return undefined;
					if (apiKey.check) return apiKey.check(input);
					return (await apiKey.resolve(input))
						? { type: "api_key" as const, source: "stored credential" }
						: undefined;
				},
				resolve: async (input: Parameters<typeof apiKey.resolve>[0]) => {
					if (!input.credential?.key) return undefined;
					return apiKey.resolve(input);
				},
			}
		: undefined;
	const alias = accountAlias(source, id, {
		...(isolatedApiKey ? { apiKey: isolatedApiKey } : {}),
		...(source.auth.oauth ? { oauth: source.auth.oauth } : {}),
	});
	return name ? { ...alias, name } : alias;
}
