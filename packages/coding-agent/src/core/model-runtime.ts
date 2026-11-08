import { dirname, join } from "node:path";
import {
	type AnyModel,
	type Api,
	type ApiStreamOptions,
	type AssistantImages,
	type AssistantMessage,
	type AssistantMessageEventStream,
	type AuthCheck,
	type AuthInteraction,
	type AuthOperationOptions,
	type AuthResult,
	type AuthType,
	type ClassifierApi,
	type ClassifierContext,
	type ClassifierModel,
	type ClassifierOptions,
	type ClassifierResult,
	type Context,
	type Credential,
	type CredentialInfo,
	type CredentialStore,
	clampThinkingLevel,
	createModels,
	type DeferredCancelOptions,
	type DeferredFetchOptions,
	type DeferredHandle,
	getOpenCodeSessionHeaders,
	type ImageApi,
	type ImageModel,
	type ImagesContext,
	type ImagesOptions,
	type LoginOptions,
	lazyStream,
	type Message,
	type Model,
	type Models,
	type ModelsApiStreamOptions,
	type ModelsClassifierOptions,
	type ModelsDeferredCancelOptions,
	type ModelsDeferredFetchOptions,
	ModelsError,
	type ModelsImagesOptions,
	type ModelsRefreshOptions,
	type ModelsRefreshResult,
	type ModelsRequestTransforms,
	type ModelsSimpleStreamOptions,
	type ModelsStore,
	type ModelThinkingLevel,
	type ModelType,
	type ModelTypeMap,
	type MutableModels,
	normalizeContext,
	type Provider,
	type ProviderHeaders,
	type ProviderRequestOptions,
	type SimpleStreamOptions,
	type StreamOptions,
} from "@earendil-works/pi-ai";
import * as builtinProviderCatalog from "@earendil-works/pi-ai/providers/all";
import { personalizeOpenRouterCatalog } from "@earendil-works/pi-ai/providers/openrouter";
import {
	assertChatModel,
	assertClassifierInputSupported,
	assertClassifierModel,
	assertImageModel,
	classifierErrorResult,
	imageErrorResult,
} from "@earendil-works/pi-ai/utils/model-operations";
import { getAgentDir } from "../config.ts";
import { operationSignal, raceWithAbortSignal } from "../utils/abort.ts";
import { AuthStorage as DefaultAuthStorage } from "./auth-storage.ts";
import { RotationPool, classifyCredentialFailure } from "../extensions/account-rotation-policy.ts";
import { createStoredAccountAlias } from "./account-aliases.ts";
import { addAccountProfile, loadAccountProfiles, removeAccountProfile, type AccountProfile } from "./account-profiles.ts";
import { ModelConfig } from "./model-config.ts";
import { FileModelsStore, InMemoryCodingAgentModelsStore } from "./models-store.ts";
import {
	type AuthStatus,
	type CompatibilityRequestConfig,
	composeModelProvider,
	configuredRequestAuthStatus,
	type ProviderConfigInput,
	resolveCompatibilityRequestConfig,
	resolveConfiguredModelHeaders,
	validateExtensionProvider,
} from "./provider-composer.ts";
import { withPersonalizedCatalog, withRemoteCatalog } from "./remote-catalog-provider.ts";
import { RuntimeCredentials } from "./runtime-credentials.ts";
import {
	createVirtualModel,
	findLatestResponse,
	isVirtualModel,
	type ModelRoute,
	type ModelRouteReason,
	type VirtualModelDefinition,
	withVirtualModels,
} from "./virtual-models.ts";

interface RegisteredVirtualModel {
	model: Model<Api>;
	route: VirtualModelDefinition["route"];
	shouldRetry?: VirtualModelDefinition["shouldRetry"];
}

interface ModelRuntimeSnapshot {
	all: readonly Model<Api>[];
	available: readonly Model<Api>[];
	configuredProviders: ReadonlySet<string>;
	storedProviders: ReadonlySet<string>;
	auth: ReadonlyMap<string, AuthCheck | undefined>;
}

export interface CreateModelRuntimeOptions {
	/** Credential storage. Defaults to the file at authPath. */
	credentials?: CredentialStore;
	authPath?: string;
	modelsPath?: string | null;
	/** Defaults to account-profiles.json beside the normal auth configuration; null disables persistence. */
	accountProfilesPath?: string | null;
	modelsStore?: ModelsStore;
	modelsStorePath?: string;
	/** Allow create() to refresh model catalogs over the network. Defaults to false. */
	allowModelNetwork?: boolean;
	/** Timeout for the create-time network model refresh. */
	modelRefreshTimeoutMs?: number;
	catalogBaseUrl?: string;
	/** Optional caller cancellation for initial cache restoration and availability checks. */
	signal?: AbortSignal;
	/** Skip initial catalog and availability refresh. Static models remain available. */
	refreshOnCreate?: boolean;
}

export interface ModelRuntimeAuthOverrides extends AuthOperationOptions {
	apiKey?: string;
	env?: Record<string, string>;
	/** Require this much remaining OAuth-token validity; defaults to five minutes. */
	minOAuthValidityMs?: number;
}

export type CredentialSynchronizationOperation = "login" | "logout" | "setRuntimeApiKey" | "removeRuntimeApiKey";

/** Credentials changed successfully, but the local model/auth snapshot could not be synchronized. */
export class CredentialSynchronizationError extends Error {
	readonly providerId: string;
	readonly operation: CredentialSynchronizationOperation;
	readonly credential: Credential | undefined;

	constructor(
		providerId: string,
		operation: CredentialSynchronizationOperation,
		credential: Credential | undefined,
		options: ErrorOptions,
	) {
		super(`Credential ${operation} committed for ${providerId}, but local synchronization failed`, options);
		this.name = "CredentialSynchronizationError";
		this.providerId = providerId;
		this.operation = operation;
		this.credential = credential;
	}
}

function mergeHeaders(
	base: ProviderHeaders | undefined,
	override: ProviderHeaders | undefined,
): ProviderHeaders | undefined {
	if (!base && !override) return undefined;
	const merged = { ...base };
	for (const [name, value] of Object.entries(override ?? {})) {
		const lowerName = name.toLowerCase();
		for (const existingName of Object.keys(merged)) {
			if (existingName.toLowerCase() === lowerName) delete merged[existingName];
		}
		merged[name] = value;
	}
	return merged;
}

/** Configured pi-ai Models collection used by coding-agent and SDK consumers. */
export class ModelRuntime implements Models {
	private readonly models: MutableModels;
	private readonly credentials: RuntimeCredentials;
	private readonly defaultBuiltins: ReadonlyMap<string, Provider>;
	private readonly builtins = new Map<string, Provider>();
	private readonly nativeExtensionProviders = new Map<string, Provider>();
	private readonly extensionProviders = new Map<string, ProviderConfigInput>();
	/** Virtual models by provider id, then model id. */
	private readonly virtualModels = new Map<string, Map<string, RegisteredVirtualModel>>();
	private readonly compositionErrors = new Map<string, string>();
	private readonly modelsPath: string | undefined;
	private readonly accountProfilesPath: string | undefined;
	private readonly accountProfiles = new Map<string, AccountProfile>();
	private readonly modelNetworkEnabled: boolean;
	private config: ModelConfig;
	private snapshot: ModelRuntimeSnapshot = {
		all: [],
		available: [],
		configuredProviders: new Set(),
		storedProviders: new Set(),
		auth: new Map(),
	};
	private availabilityRefreshSeq = 0;
	private availabilityErrorSeq = 0;
	private readonly providerAvailabilitySeq = new Map<string, number>();
	private availabilityError: string | undefined;
	private readonly credentialOperations = new Map<string, Promise<unknown>>();
	private extensionRefreshQueued = false;

	private constructor(
		credentials: RuntimeCredentials,
		config: ModelConfig,
		modelsPath: string | undefined,
		accountProfilesPath: string | undefined,
		modelsStore: ModelsStore,
		providers: readonly Provider[],
		modelNetworkEnabled: boolean,
	) {
		this.credentials = credentials;
		this.config = config;
		this.modelsPath = modelsPath;
		this.accountProfilesPath = accountProfilesPath;
		this.modelNetworkEnabled = modelNetworkEnabled;
		this.defaultBuiltins = new Map(providers.map((provider) => [provider.id, provider]));
		for (const [providerId, provider] of this.defaultBuiltins) this.builtins.set(providerId, provider);
		this.models = createModels({ credentials, modelsStore });
		this.rebuildProviders();
	}

	static async create(options: CreateModelRuntimeOptions = {}): Promise<ModelRuntime> {
		const credentials = new RuntimeCredentials(options.credentials ?? DefaultAuthStorage.create(options.authPath));
		const modelsPath =
			options.modelsPath === null ? undefined : (options.modelsPath ?? join(getAgentDir(), "models.json"));
		const accountProfilesPath = options.accountProfilesPath === null ? undefined
			: options.accountProfilesPath ?? (options.modelsPath === null ? undefined
				: join(dirname(options.authPath ?? join(getAgentDir(), "auth.json")), "account-profiles.json"));
		const config = await ModelConfig.load(modelsPath);
		const modelsStore =
			options.modelsStore ??
			(modelsPath
				? new FileModelsStore(options.modelsStorePath ?? join(dirname(modelsPath), "models-store.json"))
				: new InMemoryCodingAgentModelsStore());
		const builtinModelDataGeneratedAt = builtinProviderCatalog.getBuiltinModelDataGeneratedAt();
		const providers = builtinProviderCatalog.builtinProviders().map((provider) => {
			if (provider.id === "radius") return provider;
			// OpenRouter narrows the catalog to the models, limits and prices of the user's key.
			if (provider.id === "openrouter") {
				return withPersonalizedCatalog(
					provider,
					personalizeOpenRouterCatalog,
					options.catalogBaseUrl,
					builtinModelDataGeneratedAt,
				);
			}
			return withRemoteCatalog(provider, options.catalogBaseUrl, builtinModelDataGeneratedAt);
		});
		const runtime = new ModelRuntime(
			credentials,
			config,
			modelsPath,
			accountProfilesPath,
			modelsStore,
			providers,
			process.env.PI_OFFLINE === undefined,
		);
		runtime.configureRadiusProviders();
		runtime.rebuildProviders();
		runtime.restoreAccountAliases();
		const refreshFromNetwork = runtime.modelNetworkEnabled && options.allowModelNetwork === true;
		const controller =
			refreshFromNetwork && options.modelRefreshTimeoutMs !== undefined ? new AbortController() : undefined;
		const timeout = controller ? setTimeout(() => controller.abort(), options.modelRefreshTimeoutMs) : undefined;
		const signal = controller
			? options.signal
				? AbortSignal.any([options.signal, controller.signal])
				: controller.signal
			: options.signal;
		try {
			if (options.refreshOnCreate !== false) {
				await runtime.refresh({ allowNetwork: refreshFromNetwork, signal });
			}
		} finally {
			if (timeout) clearTimeout(timeout);
		}
		runtime.configureAutomaticAccountRotation();
		return runtime;
	}

	private configureRadiusProviders(): void {
		this.builtins.clear();
		for (const [providerId, provider] of this.defaultBuiltins) this.builtins.set(providerId, provider);
		for (const providerId of this.config.getProviderIds()) {
			const config = this.config.getProvider(providerId);
			if (config?.oauth !== "radius" || !config.baseUrl) continue;
			this.builtins.set(
				providerId,
				builtinProviderCatalog.radiusProvider({
					id: providerId,
					name: config.name ?? providerId,
					gateway: config.baseUrl.replace(/\/v1\/?$/u, ""),
				}),
			);
		}
	}

	private providerIds(): Set<string> {
		return new Set([
			...this.builtins.keys(),
			...this.nativeExtensionProviders.keys(),
			...this.config.getProviderIds(),
			...this.extensionProviders.keys(),
			...this.virtualModels.keys(),
		]);
	}

	/** Returns the provider without virtual models, or undefined when only virtual models define it. */
	private recomposeProvider(providerId: string): Provider | undefined {
		const provider = this.composeProvider(providerId);
		const virtualModels = [...(this.virtualModels.get(providerId)?.values() ?? [])].map((entry) => entry.model);
		if (virtualModels.length > 0) this.models.setProvider(withVirtualModels(providerId, provider, virtualModels));
		else if (provider) this.models.setProvider(provider);
		else this.models.deleteProvider(providerId);
		return provider;
	}

	/** The provider without virtual models, or undefined when nothing defines it. */
	private composeProvider(providerId: string): Provider | undefined {
		const base = this.nativeExtensionProviders.get(providerId) ?? this.builtins.get(providerId);
		const extension = this.extensionProviders.get(providerId);
		if (!this.config.getProvider(providerId) && !extension) {
			// No overlays: use the builtin untouched so its auth/login/stream behavior is exact.
			this.compositionErrors.delete(providerId);
			return base;
		}
		try {
			const provider = composeModelProvider(providerId, base, this.config, extension);
			this.compositionErrors.delete(providerId);
			return provider;
		} catch (error) {
			this.compositionErrors.set(providerId, error instanceof Error ? error.message : String(error));
			return base;
		}
	}

	private rebuildProviders(): void {
		this.models.clearProviders();
		this.compositionErrors.clear();
		for (const providerId of this.providerIds()) this.recomposeProvider(providerId);
		this.updateModelSnapshot();
	}

	private updateModelSnapshot(): void {
		const all = [...this.models.getModels()];
		this.snapshot = {
			...this.snapshot,
			all,
			available: all.filter((model) => this.snapshot.configuredProviders.has(model.provider)),
		};
	}

	private async runAvailabilityRefresh(seq: number, errorSeq: number, signal: AbortSignal): Promise<void> {
		const providers = this.models.getProviders();
		const [available, checks, credentials] = await Promise.all([
			this.models.getAvailable(undefined, { signal }),
			Promise.all(
				providers.map(
					async (provider): Promise<[string, AuthCheck | undefined]> => [
						provider.id,
						await this.models.checkAuth(provider.id, { signal }),
					],
				),
			),
			this.credentials.list({ signal }),
		]);
		if (seq !== this.availabilityRefreshSeq) return;
		const auth = new Map(checks);
		const configuredProviders = new Set(
			checks
				.filter((entry): entry is [string, AuthCheck] => entry[1] !== undefined)
				.map(([providerId]) => providerId),
		);
		this.snapshot = {
			all: [...this.models.getModels()],
			available: [...available],
			configuredProviders,
			storedProviders: new Set(credentials.map((entry) => entry.providerId)),
			auth,
		};
		if (errorSeq === this.availabilityErrorSeq) this.availabilityError = undefined;
	}

	private queueAvailabilityRefresh(signal?: AbortSignal): Promise<void> {
		const seq = ++this.availabilityRefreshSeq;
		for (const [providerId, providerSeq] of this.providerAvailabilitySeq) {
			this.providerAvailabilitySeq.set(providerId, providerSeq + 1);
		}
		const errorSeq = ++this.availabilityErrorSeq;
		const effectiveSignal = operationSignal(signal);
		return this.runAvailabilityRefresh(seq, errorSeq, effectiveSignal).catch((error) => {
			if (errorSeq === this.availabilityErrorSeq && !effectiveSignal.aborted) {
				this.availabilityError = error instanceof Error ? error.message : String(error);
			}
			throw error;
		});
	}

	private async refreshProviderAvailability(providerId: string, signal: AbortSignal): Promise<void> {
		// Invalidate any full availability pass that started before this credential change.
		++this.availabilityRefreshSeq;
		const providerSeq = (this.providerAvailabilitySeq.get(providerId) ?? 0) + 1;
		this.providerAvailabilitySeq.set(providerId, providerSeq);
		const errorSeq = ++this.availabilityErrorSeq;
		try {
			const [available, auth, credential] = await Promise.all([
				this.models.getAvailable(providerId, { signal }),
				this.models.checkAuth(providerId, { signal }),
				this.credentials.read(providerId, { signal }),
			]);
			signal.throwIfAborted();
			if (this.providerAvailabilitySeq.get(providerId) !== providerSeq) return;
			const configuredProviders = new Set(this.snapshot.configuredProviders);
			const storedProviders = new Set(this.snapshot.storedProviders);
			const authByProvider = new Map(this.snapshot.auth);
			if (auth) {
				configuredProviders.add(providerId);
				authByProvider.set(providerId, auth);
			} else {
				configuredProviders.delete(providerId);
				authByProvider.delete(providerId);
			}
			if (credential) storedProviders.add(providerId);
			else storedProviders.delete(providerId);
			const all = [...this.models.getModels()];
			const availableById = new Map(
				[...this.snapshot.available.filter((model) => model.provider !== providerId), ...available].map((model) => [
					`${model.provider}\0${model.id}`,
					model,
				]),
			);
			this.snapshot = {
				all,
				available: all.flatMap((model) => availableById.get(`${model.provider}\0${model.id}`) ?? []),
				configuredProviders,
				storedProviders,
				auth: authByProvider,
			};
			if (errorSeq === this.availabilityErrorSeq) this.availabilityError = undefined;
		} catch (error) {
			if (
				this.providerAvailabilitySeq.get(providerId) === providerSeq &&
				errorSeq === this.availabilityErrorSeq &&
				!signal.aborted
			) {
				this.availabilityError = error instanceof Error ? error.message : String(error);
			}
			throw error;
		}
	}

	getProviders(): readonly Provider[] {
		return this.models.getProviders();
	}

	getProvider(providerId: string): Provider | undefined {
		return this.models.getProvider(providerId);
	}

	getModels(providerId?: string): readonly Model<Api>[] {
		return this.models.getModels(providerId);
	}

	getModel(providerId: string, modelId: string): Model<Api> | undefined {
		return this.models.getModel(providerId, modelId);
	}

	getModelsOfType<TType extends ModelType>(type: TType, providerId?: string): readonly ModelTypeMap[TType][] {
		return this.models.getModelsOfType(type, providerId);
	}

	getModelOfType<TType extends ModelType>(
		type: TType,
		providerId: string,
		modelId: string,
	): ModelTypeMap[TType] | undefined {
		return this.models.getModelOfType(type, providerId, modelId);
	}

	getAllModels(providerId?: string): readonly AnyModel[] {
		return this.models.getAllModels(providerId);
	}

	getAvailableOfType<TType extends ModelType>(
		type: TType,
		providerId?: string,
		options?: AuthOperationOptions,
	): Promise<readonly ModelTypeMap[TType][]> {
		return this.models.getAvailableOfType(type, providerId, options);
	}

	getAllAvailable(providerId?: string, options?: AuthOperationOptions): Promise<readonly AnyModel[]> {
		return this.models.getAllAvailable(providerId, options);
	}

	async checkAuth(providerId: string, options?: AuthOperationOptions): Promise<AuthCheck | undefined> {
		return this.models.checkAuth(providerId, options);
	}

	async getAvailable(providerId?: string, options?: AuthOperationOptions): Promise<readonly Model<Api>[]> {
		if (providerId) {
			const errorSeq = ++this.availabilityErrorSeq;
			try {
				const available = await this.models.getAvailable(providerId, options);
				if (errorSeq === this.availabilityErrorSeq) this.availabilityError = undefined;
				return available;
			} catch (error) {
				if (errorSeq === this.availabilityErrorSeq && !options?.signal?.aborted) {
					this.availabilityError = error instanceof Error ? error.message : String(error);
				}
				throw error;
			}
		}
		await this.queueAvailabilityRefresh(options?.signal);
		return this.snapshot.available;
	}

	getAvailableSnapshot(): readonly Model<Api>[] {
		return this.snapshot.available;
	}

	getError(): string | undefined {
		const errors: string[] = [];
		const configError = this.config.getError();
		if (configError) errors.push(configError);
		for (const [providerId, error] of this.compositionErrors) {
			errors.push(`Provider "${providerId}": ${error}`);
		}
		if (this.availabilityError) errors.push(`Availability refresh: ${this.availabilityError}`);
		return errors.length > 0 ? errors.join("\n\n") : undefined;
	}

	getRegisteredProviderConfig(providerId: string): ProviderConfigInput | undefined {
		return this.extensionProviders.get(providerId);
	}

	getRegisteredProviderIds(): readonly string[] {
		return [...new Set([...this.extensionProviders.keys(), ...this.nativeExtensionProviders.keys()])];
	}

	/** Profiles identify independently stored credentials; they never contain API keys or OAuth tokens. */
	getAccountProfiles(): readonly AccountProfile[] {
		return [...this.accountProfiles.values()];
	}

	private restoreAccountAliases(): void {
		if (!this.accountProfilesPath) return;
		for (const profile of loadAccountProfiles(this.accountProfilesPath)) {
			if (this.models.getProvider(profile.id)) throw new Error(`Account alias conflicts with provider: ${profile.id}`);
			const source = this.models.getProvider(profile.sourceProviderId);
			if (!source) throw new Error(`Account source provider is unavailable: ${profile.sourceProviderId}`);
			this.nativeExtensionProviders.set(profile.id, createStoredAccountAlias(source, profile.id, profile.label));
			this.accountProfiles.set(profile.id, profile);
			this.recomposeProvider(profile.id);
		}
		this.updateModelSnapshot();
	}

	/** Create a new, uniquely named provider identity without replacing any existing login. */
	addAccountAlias(sourceProviderId: string, label?: string): AccountProfile {
		const path = this.accountProfilesPath;
		if (!path) throw new Error("Account profile persistence is disabled for this runtime");
		if (this.accountProfiles.has(sourceProviderId)) {
			throw new Error("Select the original provider rather than an account alias");
		}
		const source = this.models.getProvider(sourceProviderId);
		if (!source || (!source.auth.oauth && !source.auth.apiKey)) {
			throw new Error(`Provider ${sourceProviderId} does not support login`);
		}
		const profile = addAccountProfile(path, sourceProviderId, [...this.providerIds()], label);
		try {
			if (this.models.getProvider(profile.id)) throw new Error("Account identity conflicts with an existing provider");
			const provider = createStoredAccountAlias(source, profile.id, profile.label);
			this.accountProfiles.set(profile.id, profile);
			this.registerNativeProvider(provider);
			this.configureAutomaticAccountRotation(sourceProviderId);
			return profile;
		} catch (error) {
			this.accountProfiles.delete(profile.id);
			removeAccountProfile(path, profile.id);
			throw error;
		}
	}

	/** Explicitly disconnect the selected identity before removing only its profile. */
	async removeAccountAlias(id: string): Promise<void> {
		const path = this.accountProfilesPath;
		if (!path || !this.accountProfiles.has(id)) return;
		// Fail closed: a failed logout must never leave an orphaned stored credential.
		await this.logout(id);
		removeAccountProfile(path, id);
		const sourceProviderId = this.accountProfiles.get(id)!.sourceProviderId;
		this.accountProfiles.delete(id);
		this.nativeExtensionProviders.delete(id);
		this.configureAutomaticAccountRotation(sourceProviderId);
		this.recomposeProvider(id);
		this.updateModelSnapshot();
		this.scheduleExtensionRefresh();
	}

	/** Build an opt-in virtual model per source, not a silent global credential switch. */
	private configureAutomaticAccountRotation(sourceFilter?: string): void {
		const sources = new Set(
			[...this.accountProfiles.values()].map((profile) => profile.sourceProviderId),
		);
		const candidates = sourceFilter ? [sourceFilter] : [...sources];
		for (const sourceId of candidates) {
			const aliases = [...this.accountProfiles.values()]
				.filter((profile) => profile.sourceProviderId === sourceId)
				.map((profile) => profile.id);
			const memberIds = [sourceId, ...aliases];
			if (aliases.length === 0) {
				if (this.virtualModels.get("account-profiles")?.has(sourceId)) {
					this.unregisterVirtualModel("account-profiles", sourceId);
				}
				continue;
			}
			const pools = new Map<string, RotationPool>();
			const memberSet = new Set(memberIds);
			this.registerVirtualModel({
				provider: "account-profiles",
				id: sourceId,
				name: `Rotate ${this.getProvider(sourceId)?.name ?? sourceId} (${memberIds.length} accounts)`,
				thinkingLevels: ["off", "minimal", "low", "medium", "high", "xhigh", "max"],
				shouldRetry: (message) =>
					message.stopReason === "error" && memberSet.has(message.provider) &&
					classifyCredentialFailure(message.errorMessage ?? "") !== undefined &&
					message.content.every((block) => block.type !== "toolCall" &&
						(block.type !== "text" || block.text.length === 0) &&
						(block.type !== "thinking" || block.thinking.length === 0)),
				route: (request) => {
					if (request.signal?.aborted) throw new Error("Account rotation cancelled");
					const previous = request.previous?.model;
					const failed = request.failed?.model;
					const state = (request.state as { active?: { provider: string; model: string } } | undefined)?.active;
					const retained = request.reason === "retry" ? failed : request.reason === "continuation" ? previous : undefined;
					const preferredId = retained && memberSet.has(retained.provider)
						? retained.id
						: state && memberSet.has(state.provider) ? state.model
						: previous && memberSet.has(previous.provider) ? previous.id : undefined;
					const primaryModelId = preferredId && memberIds.some((id) => !!this.getPhysicalModel(id, preferredId))
						? preferredId
						: memberIds.flatMap((id) => this.getModels(id)).find((model) => !isVirtualModel(model))?.id;
					if (!primaryModelId) throw new Error("No physical models found for these accounts");
					let pool = pools.get(primaryModelId);
					if (!pool) {
						pool = new RotationPool(memberIds.map((provider) => ({ provider, model: primaryModelId })));
						pools.set(primaryModelId, pool);
					}
					for (const provider of memberIds) {
						pool.setAvailable({ provider, model: primaryModelId },
							!!this.getPhysicalModel(provider, primaryModelId) && this.hasConfiguredAuth(provider));
					}
					const toTarget = (model: Model<Api> | undefined) =>
						model && memberSet.has(model.provider) && model.id === primaryModelId
							? { provider: model.provider, model: model.id } : undefined;
					const previousTarget = toTarget(previous);
					if (previousTarget && request.reason !== "retry") pool.markSuccess(previousTarget);
					const failedTarget = toTarget(failed);
					const failedMessage = request.failed?.message;
					const result = pool.choose({
						reason: request.reason,
						previous: previousTarget,
						active: state && state.model === primaryModelId && memberSet.has(state.provider) ? state : undefined,
						...(failedTarget && failedMessage ? { failed: {
							target: failedTarget,
							errorMessage: failedMessage.errorMessage ?? "",
							hasOutput: failedMessage.content.some((block) => block.type === "toolCall" ||
								(block.type === "text" && block.text.length > 0) ||
								(block.type === "thinking" && block.thinking.length > 0)),
						} } : {}),
					});
					const model = this.getPhysicalModel(result.target.provider, result.target.model);
					if (!model) throw new Error("Selected account model is no longer available");
					return { model, thinkingLevel: request.thinkingLevel, state: { active: result.target } };
				},
			});
		}
	}

	getRegisteredNativeProvider(providerId: string): Provider | undefined {
		return this.nativeExtensionProviders.get(providerId);
	}

	/** @internal Compatibility fallback for ModelRegistry when provider auth is unconfigured. */
	getCompatibilityRequestConfig(model: Model<Api>): CompatibilityRequestConfig {
		return resolveCompatibilityRequestConfig(
			model,
			this.config.getProvider(model.provider),
			this.extensionProviders.get(model.provider),
		);
	}

	isUsingOAuth(providerId: string): boolean {
		return this.snapshot.auth.get(providerId)?.type === "oauth";
	}

	isUsingSubscription(providerId: string): boolean {
		return this.isUsingOAuth(providerId) && this.models.getProvider(providerId)?.auth.oauth?.isSubscription === true;
	}

	hasConfiguredAuth(providerId: string): boolean {
		return this.snapshot.configuredProviders.has(providerId);
	}

	getAuth(providerId: string, overrides?: ModelRuntimeAuthOverrides): Promise<AuthResult | undefined>;
	getAuth(model: AnyModel, overrides?: ModelRuntimeAuthOverrides): Promise<AuthResult | undefined>;
	async getAuth(
		providerOrModel: string | AnyModel,
		overrides: ModelRuntimeAuthOverrides = {},
	): Promise<AuthResult | undefined> {
		if (typeof providerOrModel === "string") return this.models.getAuth(providerOrModel, overrides);
		const resolution = await this.models.getAuth(providerOrModel, overrides);
		if (!resolution) return undefined;
		const configuredHeaders = resolveConfiguredModelHeaders(
			providerOrModel,
			this.config.getProvider(providerOrModel.provider),
			this.extensionProviders.get(providerOrModel.provider),
			{ ...(resolution.env ?? {}), ...(overrides.env ?? {}) },
		);
		return {
			...resolution,
			auth: {
				...resolution.auth,
				headers: mergeHeaders(resolution.auth.headers, configuredHeaders),
			},
		};
	}

	private enqueueCredentialOperation<T>(providerId: string, signal: AbortSignal, task: () => Promise<T>): Promise<T> {
		const previous = this.credentialOperations.get(providerId) ?? Promise.resolve();
		let markStarted: (() => void) | undefined;
		const started = new Promise<void>((resolve) => {
			markStarted = resolve;
		});
		const operation = (async () => {
			await previous.catch(() => {});
			signal.throwIfAborted();
			markStarted?.();
			return task();
		})();
		const tail = operation.catch(() => {});
		this.credentialOperations.set(providerId, tail);
		void tail.then(() => {
			if (this.credentialOperations.get(providerId) === tail) this.credentialOperations.delete(providerId);
		});
		return raceWithAbortSignal(started, signal).then(() => operation);
	}

	private async synchronizeCredentialState(
		providerId: string,
		operation: CredentialSynchronizationOperation,
		credential: Credential | undefined,
		signal: AbortSignal,
	): Promise<void> {
		try {
			signal.throwIfAborted();
			this.recomposeProvider(providerId);
			const compositionError = this.compositionErrors.get(providerId);
			if (compositionError) throw new Error(compositionError);
			const result = await this.models.refresh({ allowNetwork: false, providers: [providerId], signal });
			if (result.aborted) signal.throwIfAborted();
			const refreshError = result.errors.get(providerId);
			if (refreshError) throw refreshError;
			this.updateModelSnapshot();
			await this.refreshProviderAvailability(providerId, signal);
		} catch (cause) {
			throw new CredentialSynchronizationError(providerId, operation, credential, { cause });
		}
	}

	setRuntimeApiKey(providerId: string, apiKey: string, options: AuthOperationOptions = {}): Promise<void> {
		const signal = operationSignal(options.signal);
		return this.enqueueCredentialOperation(providerId, signal, async () => {
			this.credentials.setRuntimeApiKey(providerId, apiKey);
			await this.synchronizeCredentialState(
				providerId,
				"setRuntimeApiKey",
				{ type: "api_key", key: apiKey },
				signal,
			);
		});
	}

	removeRuntimeApiKey(providerId: string, options: AuthOperationOptions = {}): Promise<void> {
		const signal = operationSignal(options.signal);
		return this.enqueueCredentialOperation(providerId, signal, async () => {
			this.credentials.removeRuntimeApiKey(providerId);
			await this.synchronizeCredentialState(providerId, "removeRuntimeApiKey", undefined, signal);
		});
	}

	/**
	 * Wait until credential writes already in progress finish, such as an OAuth refresh started by a
	 * background catalog refresh. Call before the process exits so a rotated token is not lost.
	 */
	settleCredentialWrites(): Promise<void> {
		return this.credentials.settled();
	}

	listCredentials(options?: AuthOperationOptions): Promise<readonly CredentialInfo[]> {
		return this.credentials.list(options);
	}

	getProviderAuthStatus(providerId: string): AuthStatus {
		if (this.credentials.hasRuntimeApiKey(providerId)) return { configured: true, source: "runtime" };
		if (this.snapshot.storedProviders.has(providerId)) return { configured: true, source: "stored" };
		const configured = configuredRequestAuthStatus(
			this.config.getProvider(providerId),
			this.extensionProviders.get(providerId),
		);
		if (configured) return configured;
		const check = this.snapshot.auth.get(providerId);
		return check ? { configured: true, source: "environment", label: check.source } : { configured: false };
	}

	private async prepareRequest<
		TModel extends AnyModel,
		TOptions extends ProviderRequestOptions<TModel> & ModelsRequestTransforms,
	>(
		model: TModel,
		options: TOptions | undefined,
	): Promise<{
		provider: Provider;
		model: TModel;
		options: Omit<TOptions, "transformHeaders"> & ProviderRequestOptions<TModel>;
	}> {
		const provider = this.models.getProvider(model.provider);
		if (!provider) throw new ModelsError("provider", `Unknown provider: ${model.provider}`);
		const resolution = await this.getAuth(model, {
			apiKey: options?.apiKey,
			env: options?.env,
			signal: options?.signal,
		});
		if (!resolution) throw new ModelsError("auth", `Provider is not configured: ${model.provider}`);

		const { transformHeaders, ...rawProviderOptions } = options ?? {};
		const providerOptions = rawProviderOptions as Omit<TOptions, "transformHeaders"> & ProviderRequestOptions<TModel>;
		const requestModel: TModel = resolution.auth.baseUrl ? { ...model, baseUrl: resolution.auth.baseUrl } : model;
		const sessionId =
			"sessionId" in providerOptions && typeof providerOptions.sessionId === "string"
				? providerOptions.sessionId
				: undefined;
		let headers = mergeHeaders(
			mergeHeaders(getOpenCodeSessionHeaders(requestModel, sessionId), resolution.auth.headers),
			providerOptions.headers,
		);
		if (transformHeaders) headers = await transformHeaders(headers ?? {});
		const env =
			resolution.env || providerOptions.env
				? { ...(resolution.env ?? {}), ...(providerOptions.env ?? {}) }
				: undefined;
		return {
			provider,
			model: requestModel,
			options: {
				...providerOptions,
				apiKey: providerOptions.apiKey ?? resolution.auth.apiKey,
				headers,
				env,
			} as Omit<TOptions, "transformHeaders"> & ProviderRequestOptions<TModel>,
		};
	}

	stream<TApi extends Api>(
		model: Model<TApi>,
		context: Context,
		options?: ModelsApiStreamOptions<TApi>,
	): AssistantMessageEventStream {
		const transcript = normalizeContext(context);
		return lazyStream(
			model,
			async () => {
				assertChatModel(model);
				const prepared = await this.prepareRequest(
					model,
					options as (StreamOptions & ModelsRequestTransforms) | undefined,
				);
				return prepared.provider.stream(prepared.model, transcript, prepared.options as ApiStreamOptions<TApi>);
			},
			undefined,
			options?.signal,
		);
	}

	complete<TApi extends Api>(
		model: Model<TApi>,
		context: Context,
		options?: ModelsApiStreamOptions<TApi>,
	): Promise<AssistantMessage> {
		return this.stream(model, context, options).result();
	}

	streamSimple(model: Model<Api>, context: Context, options?: ModelsSimpleStreamOptions): AssistantMessageEventStream {
		const transcript = normalizeContext(context);
		if (isVirtualModel(model)) {
			// Requests outside the agent loop are routed here. Callers sized them before routing, so
			// cap the output budget to the routed model.
			return lazyStream(
				model,
				async () => {
					const route = await this.resolveModel(model, transcript.messages, {
						reason: "direct",
						thinkingLevel: options?.reasoning ?? "off",
						signal: options?.signal,
					});
					const { maxTokens: limit } = route.model;
					const maxTokens =
						options?.maxTokens && limit > 0 ? Math.min(options.maxTokens, limit) : options?.maxTokens;
					const reasoning = route.thinkingLevel === "off" ? undefined : route.thinkingLevel;
					// Caller credentials were resolved for the virtual model's provider. Another provider
					// resolves its own, so they are not sent to the wrong vendor.
					const { apiKey, headers, env, ...rest } = options ?? {};
					const auth = route.model.provider === model.provider ? { apiKey, headers, env } : {};
					return this.streamSimple(route.model, context, { ...rest, ...auth, maxTokens, reasoning });
				},
				undefined,
				options?.signal,
			);
		}
		return lazyStream(
			model,
			async () => {
				assertChatModel(model);
				const prepared = await this.prepareRequest(model, options);
				return prepared.provider.streamSimple(prepared.model, transcript, prepared.options as SimpleStreamOptions);
			},
			undefined,
			options?.signal,
		);
	}

	completeSimple(model: Model<Api>, context: Context, options?: ModelsSimpleStreamOptions): Promise<AssistantMessage> {
		return this.streamSimple(model, context, options).result();
	}

	streamDeferred(
		model: Model<Api>,
		handle: DeferredHandle,
		options?: ModelsDeferredFetchOptions,
	): AssistantMessageEventStream {
		return lazyStream(
			model,
			async () => {
				assertChatModel(model);
				const prepared = await this.prepareRequest(model, options);
				if (!prepared.provider.fetchDeferred) {
					throw new ModelsError("provider", `Provider ${model.provider} does not support deferred responses`);
				}
				return prepared.provider.fetchDeferred(prepared.model, handle, prepared.options as DeferredFetchOptions);
			},
			undefined,
			options?.signal,
		);
	}

	async fetchDeferred(
		model: Model<Api>,
		handle: DeferredHandle,
		options?: ModelsDeferredFetchOptions,
	): Promise<AssistantMessage> {
		return this.streamDeferred(model, handle, options).result();
	}

	async cancelDeferred(
		model: Model<Api>,
		handle: DeferredHandle,
		options?: ModelsDeferredCancelOptions,
	): Promise<void> {
		assertChatModel(model);
		const prepared = await this.prepareRequest(model, options);
		if (!prepared.provider.cancelDeferred) {
			throw new ModelsError("provider", `Provider ${model.provider} does not support deferred responses`);
		}
		await prepared.provider.cancelDeferred(prepared.model, handle, prepared.options as DeferredCancelOptions);
	}

	async generateImages(
		model: ImageModel<ImageApi>,
		context: ImagesContext,
		options?: ModelsImagesOptions,
	): Promise<AssistantImages> {
		try {
			assertImageModel(model);
			const prepared = await this.prepareRequest(model, options);
			if (!prepared.provider.generateImages) {
				throw new ModelsError("provider", `Provider ${model.provider} does not support image generation`);
			}
			return await prepared.provider.generateImages(prepared.model, context, prepared.options as ImagesOptions);
		} catch (error) {
			return imageErrorResult(model, error, options?.signal?.aborted);
		}
	}

	async classify(
		model: ClassifierModel<ClassifierApi>,
		context: ClassifierContext,
		options?: ModelsClassifierOptions,
	): Promise<ClassifierResult> {
		try {
			assertClassifierModel(model);
			assertClassifierInputSupported(model, context);
			const prepared = await this.prepareRequest(model, options);
			if (!prepared.provider.classify) {
				throw new ModelsError("provider", `Provider ${model.provider} does not support classification`);
			}
			return await prepared.provider.classify(prepared.model, context, prepared.options as ClassifierOptions);
		} catch (error) {
			return classifierErrorResult(model, error, options?.signal?.aborted);
		}
	}

	login(
		providerId: string,
		type: AuthType,
		interaction: AuthInteraction,
		options?: LoginOptions,
	): Promise<Credential> {
		const signal = operationSignal(interaction.signal);
		return this.enqueueCredentialOperation(providerId, signal, async () => {
			const credential = await this.models.login(providerId, type, { ...interaction, signal }, options);
			await this.synchronizeCredentialState(providerId, "login", credential, signal);
			return credential;
		});
	}

	logout(providerId: string, options: AuthOperationOptions = {}): Promise<void> {
		const signal = operationSignal(options.signal);
		return this.enqueueCredentialOperation(providerId, signal, async () => {
			await this.models.logout(providerId, { signal });
			await this.synchronizeCredentialState(providerId, "logout", undefined, signal);
		});
	}

	async refresh(options: ModelsRefreshOptions = {}): Promise<ModelsRefreshResult> {
		// An explicitly requested refresh subsumes any queued registration batch.
		this.extensionRefreshQueued = false;
		this.config = await ModelConfig.load(this.modelsPath);
		this.configureRadiusProviders();
		if (options.providers) {
			for (const providerId of new Set(options.providers)) this.recomposeProvider(providerId);
			this.updateModelSnapshot();
		} else {
			this.rebuildProviders();
		}
		const refreshOptions = {
			...options,
			allowNetwork: options.allowNetwork ?? this.modelNetworkEnabled,
		};
		// Published pi-ai builds before ModelsStore returned void and accepted a provider ID.
		// The fallback keeps source-mode CLI tests working without rebuilding workspace dependencies.
		const result = ((await this.models.refresh(refreshOptions)) as ModelsRefreshResult | undefined) ?? {
			aborted: refreshOptions.signal?.aborted ?? false,
			errors: new Map(),
		};
		const errors = new Map(result.errors);
		this.updateModelSnapshot();
		if (options.providers) {
			await Promise.all(
				[...new Set(options.providers)].map(async (providerId) => {
					try {
						await this.refreshProviderAvailability(providerId, operationSignal(options.signal));
					} catch (error) {
						if (!options.signal?.aborted) {
							errors.set(providerId, error instanceof Error ? error : new Error(String(error)));
						}
					}
				}),
			);
		} else {
			try {
				await this.queueAvailabilityRefresh(options.signal);
			} catch {
				// Availability errors are recorded by the latest pass; refreshed models remain usable.
			}
		}
		return { aborted: result.aborted || (options.signal?.aborted ?? false), errors };
	}

	private scheduleExtensionRefresh(): void {
		if (this.extensionRefreshQueued) return;
		this.extensionRefreshQueued = true;
		queueMicrotask(() => {
			if (!this.extensionRefreshQueued) return;
			this.extensionRefreshQueued = false;
			// Synchronous registrations already refreshed provider and model snapshots.
			void this.refresh({ allowNetwork: false });
		});
	}

	registerNativeProvider(provider: Provider): void {
		if (!provider.id.trim()) throw new Error("Provider id must not be empty.");
		this.extensionProviders.delete(provider.id);
		this.nativeExtensionProviders.set(provider.id, provider);
		this.recomposeProvider(provider.id);
		this.updateModelSnapshot();
		this.markProvisionallyConfigured(
			provider.id,
			configuredRequestAuthStatus(this.config.getProvider(provider.id), undefined),
			provider.auth.oauth && !provider.auth.apiKey ? "oauth" : "api_key",
		);
		this.scheduleExtensionRefresh();
	}

	/**
	 * Mark a newly registered provider as configured when it has a stored credential or a configured
	 * API key. Availability checks run asynchronously, and callers such as initial model selection
	 * read the snapshot before they finish. The next availability pass replaces this entry.
	 */
	private markProvisionallyConfigured(
		providerId: string,
		configuredStatus: AuthStatus | undefined,
		type: AuthType,
	): void {
		if (!this.snapshot.storedProviders.has(providerId) && !configuredStatus?.configured) return;
		const configuredProviders = new Set(this.snapshot.configuredProviders).add(providerId);
		const auth = new Map(this.snapshot.auth);
		// Never clobber a real check result.
		if (!auth.get(providerId)) auth.set(providerId, { type, source: "configured provider" });
		this.snapshot = {
			...this.snapshot,
			auth,
			configuredProviders,
			available: this.snapshot.all.filter((model) => configuredProviders.has(model.provider)),
		};
	}

	registerProvider(providerId: string, config: ProviderConfigInput): void {
		// Validate the incoming registration on its own, like the legacy registry:
		// a broken re-registration must throw without touching the stored config.
		validateExtensionProvider(providerId, this.builtins.get(providerId), this.config.getProvider(providerId), config);
		this.nativeExtensionProviders.delete(providerId);
		// Re-registration merges defined values over the previous registration and
		// preserves undefined ones, matching the legacy ModelRegistry contract.
		const previous = this.extensionProviders.get(providerId);
		const effective: ProviderConfigInput = { ...previous };
		for (const [key, value] of Object.entries(config)) {
			if (value !== undefined) (effective as Record<string, unknown>)[key] = value;
		}
		this.extensionProviders.set(providerId, effective);
		this.recomposeProvider(providerId);
		this.updateModelSnapshot();
		this.markProvisionallyConfigured(
			providerId,
			configuredRequestAuthStatus(this.config.getProvider(providerId), effective),
			effective.oauth && !effective.apiKey ? "oauth" : "api_key",
		);
		this.scheduleExtensionRefresh();
	}

	/**
	 * Apply validated provider registrations with one final model snapshot.
	 * Individual registerProvider calls keep their existing synchronous semantics.
	 */
	registerProviderBatch(registrations: readonly { providerId: string; config: ProviderConfigInput }[]): void {
		if (registrations.length === 0) return;
		const staged = new Map<string, ProviderConfigInput>();
		for (const { providerId, config } of registrations) {
			validateExtensionProvider(providerId, this.builtins.get(providerId), this.config.getProvider(providerId), config);
			const previous = staged.get(providerId) ?? this.extensionProviders.get(providerId);
			const effective: ProviderConfigInput = { ...previous };
			for (const [key, value] of Object.entries(config)) {
				if (value !== undefined) (effective as Record<string, unknown>)[key] = value;
			}
			staged.set(providerId, effective);
		}
		for (const [providerId, config] of staged) {
			this.nativeExtensionProviders.delete(providerId);
			this.extensionProviders.set(providerId, config);
			this.recomposeProvider(providerId);
		}
		this.updateModelSnapshot();
		const configuredProviders = new Set(this.snapshot.configuredProviders);
		const auth = new Map(this.snapshot.auth);
		for (const [providerId, config] of staged) {
			const status = configuredRequestAuthStatus(this.config.getProvider(providerId), config);
			if (!this.snapshot.storedProviders.has(providerId) && !status?.configured) continue;
			configuredProviders.add(providerId);
			if (!auth.get(providerId)) {
				auth.set(providerId, {
					type: config.oauth && !config.apiKey ? "oauth" : "api_key",
					source: "configured provider",
				});
			}
		}
		this.snapshot = {
			...this.snapshot,
			configuredProviders,
			auth,
			available: this.snapshot.all.filter((model) => configuredProviders.has(model.provider)),
		};
		this.scheduleExtensionRefresh();
	}

	unregisterProvider(providerId: string): void {
		this.extensionProviders.delete(providerId);
		this.nativeExtensionProviders.delete(providerId);
		this.recomposeProvider(providerId);
		this.updateModelSnapshot();
		this.scheduleExtensionRefresh();
	}

	/**
	 * Register a virtual model under `definition.provider`, which may also list physical models or
	 * several virtual models. Re-registering the same provider and id replaces the virtual model.
	 * Throws when the id belongs to a physical model of that provider.
	 */
	registerVirtualModel(definition: VirtualModelDefinition): void {
		const { provider: providerId, id } = definition;
		if (!providerId.trim() || !id.trim()) throw new Error("Virtual model provider and id must not be empty.");
		const existing = this.models.getModel(providerId, id);
		if (existing && !isVirtualModel(existing)) {
			throw new Error(`Virtual model ${providerId}/${id} conflicts with a physical model.`);
		}
		const models = this.virtualModels.get(providerId) ?? new Map<string, RegisteredVirtualModel>();
		models.set(id, {
			model: createVirtualModel(definition),
			route: (request) => definition.route(request),
			...(definition.shouldRetry ? { shouldRetry: definition.shouldRetry } : {}),
		});
		this.virtualModels.set(providerId, models);
		if (!this.recomposeProvider(providerId) && !this.snapshot.configuredProviders.has(providerId)) {
			// A provider of only virtual models needs no credentials. Mark it configured now: session
			// restore checks auth before the refresh below lands.
			const auth = new Map(this.snapshot.auth).set(providerId, { type: "api_key", source: "virtual" });
			const configuredProviders = new Set(this.snapshot.configuredProviders).add(providerId);
			this.snapshot = { ...this.snapshot, auth, configuredProviders };
		}
		this.updateModelSnapshot();
		this.scheduleExtensionRefresh();
	}

	unregisterVirtualModel(providerId: string, id: string): void {
		const models = this.virtualModels.get(providerId);
		if (!models?.delete(id)) return;
		if (models.size === 0) this.virtualModels.delete(providerId);
		this.recomposeProvider(providerId);
		this.updateModelSnapshot();
		this.scheduleExtensionRefresh();
	}

	/** Allow opt-in, scoped recovery without changing ordinary provider retry policy. */
	shouldRetryVirtualFailure(model: Model<Api>, message: AssistantMessage): boolean {
		if (!isVirtualModel(model) || message.stopReason !== "error") return false;
		return this.virtualModels.get(model.provider)?.get(model.id)?.shouldRetry?.(message) ?? false;
	}

	/**
	 * Ask a virtual model's router for the model and thinking level of one request. The router must
	 * return a physical catalog model whose provider has credentials; the thinking level is clamped
	 * to that model. Throws when routing fails.
	 *
	 * `previous` reports the latest successful response in `messages`. A retry passes the failed
	 * response as `options.failed`; `messages` no longer contains it. `options.state` is the router
	 * state stored by the caller, which also stores the returned state.
	 */
	async resolveModel(
		model: Model<Api>,
		messages: readonly Message[],
		options: {
			reason: ModelRouteReason;
			thinkingLevel: ModelThinkingLevel;
			signal?: AbortSignal;
			failed?: AssistantMessage;
			state?: unknown;
		},
	): Promise<ModelRoute> {
		const name = `Virtual model ${model.provider}/${model.id}`;
		const virtual = this.virtualModels.get(model.provider)?.get(model.id);
		if (!virtual) throw new Error(`${name} is not registered.`);
		const { failed, ...request } = options;
		const latest = findLatestResponse(messages);
		const previousModel = latest && this.getPhysicalModel(latest.provider, latest.model);
		// A failed routing attempt names the virtual model; there is no physical request to report.
		const failedModel = failed && this.getPhysicalModel(failed.provider, failed.model);
		const route = await virtual.route({
			...request,
			model,
			previous: previousModel && { model: previousModel, thinkingLevel: latest?.thinkingLevel },
			failed: failedModel && failed && { model: failedModel, thinkingLevel: failed.thinkingLevel, message: failed },
			messages,
		});
		const target = this.getPhysicalModel(route.model.provider, route.model.id);
		const routed = `${name} routed to ${route.model.provider}/${route.model.id}`;
		if (!target) throw new Error(`${routed}, which is not a physical model.`);
		if (!this.hasConfiguredAuth(target.provider)) throw new Error(`${routed}, which has no credentials.`);
		return { model: target, thinkingLevel: clampThinkingLevel(target, route.thinkingLevel), state: route.state };
	}

	/** A catalog chat model that is not virtual. */
	getPhysicalModel(providerId: string, modelId: string): Model<Api> | undefined {
		const model = this.models.getModel(providerId, modelId);
		return model && !isVirtualModel(model) ? model : undefined;
	}
}
