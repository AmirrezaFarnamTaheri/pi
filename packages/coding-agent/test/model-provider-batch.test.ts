import { InMemoryModelsStore } from "@earendil-works/pi-ai";
import { describe, expect, it, vi } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { ModelRegistry } from "../src/core/model-registry.ts";
import { ModelRuntime } from "../src/core/model-runtime.ts";
import type { ProviderConfigInput } from "../src/core/provider-composer.ts";

const model = (id: string) => ({
	id,
	name: id,
	reasoning: false,
	input: ["text"] as ("text" | "image")[],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 10000,
	maxTokens: 1000,
});

async function runtime() {
	return ModelRuntime.create({
		credentials: AuthStorage.inMemory(),
		modelsStore: new InMemoryModelsStore(),
		modelsPath: null,
		allowModelNetwork: false,
		refreshOnCreate: false,
	});
}

const entries = (n: number) =>
	Array.from({ length: n }, (_, i) => ({
		providerId: `batch-provider-${i}`,
		config: {
			name: `Batch Provider ${i}`,
			api: "openai-completions" as const,
			baseUrl: "https://example.test/v1",
			apiKey: "test-key",
			models: [model(`model-${i}`)],
		} satisfies ProviderConfigInput,
	}));

describe("ModelRuntime batch provider registration", () => {
	it("publishes the same model and provisional availability snapshots as sequential registration", async () => {
		const sequential = await runtime();
		const batched = await runtime();
		const items = entries(32);

		for (const { providerId, config } of items) sequential.registerProvider(providerId, config);
		batched.registerProviderBatch(items);
		for (const { providerId } of items) {
			expect(batched.getModels(providerId).map((entry) => entry.id)).toEqual(
				sequential.getModels(providerId).map((entry) => entry.id),
			);
			expect(batched.getAvailableSnapshot().filter((entry) => entry.provider === providerId).map((entry) => entry.id)).toEqual(
				sequential.getAvailableSnapshot().filter((entry) => entry.provider === providerId).map((entry) => entry.id),
			);
			expect(batched.getProviderAuthStatus(providerId)).toEqual(sequential.getProviderAuthStatus(providerId));
		}
		expect(batched.getRegisteredProviderIds()).toEqual(sequential.getRegisteredProviderIds());
	});

	it("fails validation without registering any partial provider", async () => {
		const subject = await runtime();
		const good = entries(1)[0]!;
		const invalid = {
			providerId: "batch-bad",
			config: {
				api: "openai-completions" as const,
				apiKey: "test-key",
				models: [model("missing-base-url")],
			},
		};
		expect(() => subject.registerProviderBatch([good, invalid])).toThrow(/baseUrl/);
		expect(subject.getRegisteredProviderIds()).not.toContain(good.providerId);
		expect(subject.getRegisteredProviderIds()).not.toContain(invalid.providerId);
		expect(subject.getModel(good.providerId, "model-0")).toBeUndefined();
	});

	it("merges repeated registration inputs and preserves undefined-field semantics", async () => {
		const subject = await runtime();
		const { providerId, config } = entries(1)[0]!;
		subject.registerProviderBatch([
			{ providerId, config },
			{ providerId, config: { name: "Final Name", headers: { "x-batch": "ok" }, apiKey: undefined } },
		]);
		expect(subject.getModel(providerId, "model-0")).toBeDefined();
		expect(subject.getRegisteredProviderConfig(providerId)).toMatchObject({
			name: "Final Name",
			apiKey: "test-key",
			headers: { "x-batch": "ok" },
		});
		expect(subject.getProvider(providerId)?.name).toBe("Final Name");
	});

	it("coalesces scheduled background refreshes and remains usable through the registry", async () => {
		const subject = await runtime();
		const refresh = vi.spyOn(subject, "refresh").mockResolvedValue({ aborted: false, errors: new Map() });
		const registry = new ModelRegistry(subject);
		try {
			registry.registerProviderBatch(entries(20));
			expect(registry.find("batch-provider-19", "model-19")).toBeDefined();
			expect(refresh).not.toHaveBeenCalled();
			await new Promise<void>((resolve) => queueMicrotask(resolve));
			expect(refresh).toHaveBeenCalledTimes(1);
		} finally {
			refresh.mockRestore();
		}
	});

	it("does not schedule a refresh for an empty batch", async () => {
		const subject = await runtime();
		const refresh = vi.spyOn(subject, "refresh").mockResolvedValue({ aborted: false, errors: new Map() });
		subject.registerProviderBatch([]);
		await new Promise<void>((resolve) => queueMicrotask(resolve));
		expect(refresh).not.toHaveBeenCalled();
		refresh.mockRestore();
	});
});
