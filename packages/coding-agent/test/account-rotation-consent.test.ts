import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getModel } from "@earendil-works/pi-ai/compat";
import { setKeybindings } from "@earendil-works/pi-tui";
import { afterEach, describe, expect, it, vi } from "vitest";
import { assertAccountRotationConsent, allowedCycleModels } from "../src/core/account-rotation-consent.ts";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import { ModelRuntime } from "../src/core/model-runtime.ts";
import { createAgentSession } from "../src/core/sdk.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { ExtensionSelectorComponent } from "../src/modes/interactive/components/extension-selector.ts";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";

describe("cross-account model selection requires opt-in", () => {
	it("allows ordinary provider models and explicitly approved account rotation", () => {
		expect(() => assertAccountRotationConsent("anthropic", false)).not.toThrow();
		expect(() => assertAccountRotationConsent("account-profiles", true)).not.toThrow();
	});

	it("refuses implicit selection through model cycling, /model or extensions", () => {
		expect(() => assertAccountRotationConsent("account-profiles", false)).toThrow(/share.*transcript|consent/i);
	});
});

describe("rotation consent is scoped to each session transcript", () => {
	it("permits an approved rotation only while the same session remains active", () => {
		expect(() => assertAccountRotationConsent("account-profiles", true, "session-1", "session-1")).not.toThrow();
		expect(() => assertAccountRotationConsent("account-profiles", true, "session-1", "session-2")).toThrow(/consent/i);
	});

	it("cycles past an unconsented account group without trapping model navigation", () => {
		const models = [
			{ provider: "ordinary", id: "a" },
			{ provider: "account-profiles", id: "x" },
			{ provider: "ordinary", id: "b" },
		];
		expect(allowedCycleModels(models, false).map((model) => model.id)).toEqual(["a", "b"]);
		expect(allowedCycleModels(models, true)).toEqual(models);
	});
});

describe("AgentSession model mutation regression (not merely a consent helper)", () => {
	const dirs: string[] = [];
	afterEach(() => {
		vi.restoreAllMocks();
		for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
	});

	async function createSession(scoped = false) {
		const dir = mkdtempSync(join(tmpdir(), "pi-rotation-consent-"));
		dirs.push(dir);
		const original = getModel("anthropic", "claude-sonnet-4-5")!;
		const virtual = { ...original, id: "anthropic", provider: "account-profiles" };
		const ordinary = { ...original, id: "another-ordinary-model" };
		const auth = AuthStorage.inMemory();
		await auth.modify("anthropic", async () => ({ type: "api_key", key: "test-key" }));
		const runtime = await ModelRuntime.create({ credentials: auth, modelsPath: join(dir, "models.json") });
		vi.spyOn(runtime, "getAvailableSnapshot").mockReturnValue([original, virtual, ordinary]);
		const { session } = await createAgentSession({
			cwd: dir,
			agentDir: dir,
			model: original,
			modelRuntime: runtime,
			sessionManager: SessionManager.inMemory(),
			noTools: "all",
			...(scoped
				? { scopedModels: [{ model: original }, { model: virtual }, { model: ordinary }] }
				: {}),
		});
		return { session, original, virtual, ordinary };
	}

	for (const scoped of [false, true]) {
		it(`refuses unconsented virtual selection but cycles to ordinary models (${scoped ? "scoped" : "unscoped"})`, async () => {
			const { session, original, virtual, ordinary } = await createSession(scoped);
			try {
				await expect(session.setModel(virtual)).rejects.toThrow(/consent|share/i);
				expect(session.model?.provider).toBe(original.provider);
				expect(session.model?.id).toBe(original.id);
				const next = await session.cycleModel("forward");
				expect(next?.model.id).toBe(ordinary.id);
				expect(session.model?.provider).toBe("anthropic");
				expect(session.model?.id).toBe(ordinary.id);
			} finally {
				session.dispose();
			}
		});
	}
});

describe("interactive account rotation consent and cancellation", () => {
	function createSelectorHarness() {
		initTheme("dark");
		setKeybindings(new KeybindingsManager());
		const chosen: Array<{ model: { provider: string; id: string }; options: unknown }> = [];
		const errors: string[] = [];
		let selector: ExtensionSelectorComponent | undefined;
		let cancelled = 0;
		const virtual = { provider: "account-profiles", id: "anthropic", name: "Anthropic accounts" };
		const mode = Object.create(InteractiveMode.prototype) as {
			runtimeHost: unknown;
			showSelector: (factory: (done: () => void) => { component: ExtensionSelectorComponent }) => void;
			showError: (text: string) => void;
			showStatus: (text: string) => void;
			updateEditorBorderColor: () => void;
			footer: { invalidate: () => void };
			enableAccountRotation: (sourceProviderId: string, persist: boolean) => Promise<void>;
		};
		mode.runtimeHost = {
			session: {
				modelRuntime: {
					getAccountProfiles: () => [{ id: "account-anthropic-2", sourceProviderId: "anthropic" }],
					hasConfiguredAuth: () => true,
					getModel: () => virtual,
				},
				setModel: async (model: typeof virtual, options: unknown) => {
					chosen.push({ model, options });
				},
			},
		};
		mode.showSelector = (factory) => {
			const result = factory(() => { cancelled++; });
			selector = result.component;
		};
		mode.showError = (error) => errors.push(error);
		mode.showStatus = () => {};
		mode.updateEditorBorderColor = () => {};
		mode.footer = { invalidate() {} };
		return { mode, chosen, errors, getSelector: () => selector!, getCancelled: () => cancelled };
	}

	it("Cancel leaves model unchanged and does not grant cross-account consent", async () => {
		const { mode, chosen, getSelector, getCancelled } = createSelectorHarness();
		await mode.enableAccountRotation("anthropic", true);
		getSelector().handleInput("\n");
		await Promise.resolve();
		expect(getCancelled()).toBe(1);
		expect(chosen).toEqual([]);
	});

	for (const persist of [false, true]) {
		it(`confirmation passes scoped consent with the requested persist=${persist} policy`, async () => {
			const { mode, chosen, getSelector, errors } = createSelectorHarness();
			await mode.enableAccountRotation("anthropic", persist);
			getSelector().handleInput("j");
			getSelector().handleInput("\n");
			await new Promise<void>((resolve) => setImmediate(resolve));
			expect(errors).toEqual([]);
			expect(chosen).toEqual([{
				model: { provider: "account-profiles", id: "anthropic", name: "Anthropic accounts" },
				options: { persist, accountRotationConsent: true },
			}]);
		});
	}
});
