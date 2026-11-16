import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getModel } from "@earendil-works/pi-ai/compat";
import { setKeybindings } from "@earendil-works/pi-tui";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import { ModelRuntime } from "../src/core/model-runtime.ts";
import { createAgentSession } from "../src/core/sdk.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import type { ExtensionSelectorComponent } from "../src/modes/interactive/components/extension-selector.ts";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";

describe("automatic account rotation selection", () => {
	it("does not require repeated session consent after the user selects the rotation model", async () => {
		const original = getModel("anthropic", "claude-sonnet-4-5")!;
		const virtual = { ...original, id: "anthropic", provider: "account-profiles" };
		const auth = AuthStorage.inMemory();
		const runtime = await ModelRuntime.create({ credentials: auth, modelsPath: null });
		const { session } = await createAgentSession({
			model: virtual,
			modelRuntime: runtime,
			sessionManager: SessionManager.inMemory(),
			noTools: "all",
		});
		try {
			expect(session.model?.provider).toBe("account-profiles");
		} finally {
			session.dispose();
		}
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
		vi.spyOn(runtime, "checkAuth").mockResolvedValue({ type: "api_key", source: "test" });
		const { session } = await createAgentSession({
			cwd: dir,
			agentDir: dir,
			model: original,
			modelRuntime: runtime,
			sessionManager: SessionManager.inMemory(),
			noTools: "all",
			...(scoped ? { scopedModels: [{ model: original }, { model: virtual }, { model: ordinary }] } : {}),
		});
		return { session, original, virtual, ordinary };
	}

	for (const scoped of [false, true]) {
		it(`can select and cycle through account rotation (${scoped ? "scoped" : "unscoped"})`, async () => {
			const { session, original, virtual } = await createSession(scoped);
			try {
				await session.setModel(virtual);
				expect(session.model?.provider).toBe("account-profiles");
				await session.setModel(original);
				const next = await session.cycleModel("forward");
				expect(next?.model.provider).toBe("account-profiles");
			} finally {
				session.dispose();
			}
		});
	}
});

describe("interactive account rotation activation", () => {
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
			const result = factory(() => {
				cancelled++;
			});
			selector = result.component;
		};
		mode.showError = (error) => errors.push(error);
		mode.showStatus = () => {};
		mode.updateEditorBorderColor = () => {};
		mode.footer = { invalidate() {} };
		return { mode, chosen, errors, getSelector: () => selector!, getCancelled: () => cancelled };
	}

	for (const persist of [false, true]) {
		it(`enables rotation immediately with persist=${persist}`, async () => {
			const { mode, chosen, errors, getCancelled } = createSelectorHarness();
			await mode.enableAccountRotation("anthropic", persist);
			expect(errors).toEqual([]);
			expect(getCancelled()).toBe(0);
			expect(chosen).toEqual([
				{
					model: { provider: "account-profiles", id: "anthropic", name: "Anthropic accounts" },
					options: { persist },
				},
			]);
		});
	}
});
