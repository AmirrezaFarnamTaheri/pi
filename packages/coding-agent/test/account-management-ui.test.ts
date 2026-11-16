import { setKeybindings } from "@earendil-works/pi-tui";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AccountRotationPreferences } from "../src/core/account-profiles.ts";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import type { ExtensionSelectorComponent } from "../src/modes/interactive/components/extension-selector.ts";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";

describe("provider-first account manager", () => {
	beforeEach(() => {
		initTheme("dark");
		setKeybindings(new KeybindingsManager());
	});

	function harness() {
		const actions: string[] = [];
		let preferences: AccountRotationPreferences = {
			enabled: false,
			strategy: "round-robin",
			memberIds: ["anthropic", "account-anthropic-1"],
		};
		const names = new Map([
			["anthropic", "Atomic Chat"],
			["account-anthropic-1", "Work"],
		]);
		const alias = { id: "account-anthropic-1", label: "Work", sourceProviderId: "anthropic" };
		const renameAccount = vi.fn((id: string, label: string) => {
			names.set(id, label.trim());
			return label.trim();
		});
		const addAccountAlias = vi.fn((sourceProviderId: string, label?: string) => {
			const profile = { id: "account-anthropic-2", sourceProviderId, label: label?.trim() ?? "Backup" };
			actions.push(`add ${profile.id}`);
			return profile;
		});
		const removeAccountAlias = vi.fn(async (id: string) => {
			actions.push(`delete ${id}`);
		});
		const logout = vi.fn(async (id: string) => {
			actions.push(`logout ${id}`);
		});
		const setModel = vi.fn(async (model: { provider: string }, _opts?: { persist?: boolean }) => {
			actions.push(`switch ${model.provider}`);
		});
		const setAccountRotationPreferences = vi.fn((_id: string, value: AccountRotationPreferences) => {
			preferences = { ...value, memberIds: [...value.memberIds] };
		});
		const runtime = {
			getProviders: () => [
				{ id: "anthropic", name: "Anthropic", auth: { oauth: { login: async () => undefined } } },
				{ id: alias.id, name: "Anthropic", auth: { oauth: { login: async () => undefined } } },
			],
			getAccountProfiles: () => [alias],
			getProviderAuthStatus: () => ({ configured: true }),
			hasConfiguredAuth: () => true,
			isUsingOAuth: () => true,
			getAccountLabel: (id: string) => names.get(id) ?? "Primary",
			getProvider: () => ({ name: "Anthropic", auth: { oauth: { login: async () => undefined } } }),
			getAccountRotationPreferences: () => ({ ...preferences, memberIds: [...preferences.memberIds] }),
			setAccountRotationPreferences,
			getRotationMemberIds: () => ["anthropic", alias.id],
			getModel: () => ({ provider: "account-profiles", id: "anthropic" }),
			getModels: () => [{ provider: "anthropic", id: "claude-sonnet", name: "Sonnet" }],
			getAvailableSnapshot: () => [{ provider: "anthropic", id: "claude-sonnet" }],
			renameAccount,
			addAccountAlias,
			removeAccountAlias,
			logout,
		};
		let selected: ExtensionSelectorComponent | undefined;
		const mode = Object.create(InteractiveMode.prototype) as {
			runtimeHost: unknown;
			showSelector: (factory: (done: () => void) => { component: ExtensionSelectorComponent }) => void;
			showExtensionInput: (...args: unknown[]) => Promise<string | undefined>;
			showStatus: (message: string) => void;
			showError: (message: string) => void;
			showAccountManager: () => void;
			showProviderAccounts: (id: string) => void;
			getLoginProviderOptions: () => { name: string; accountLabel?: string }[];
			updateAvailableProviderCount: () => Promise<void>;
			updateEditorBorderColor: () => void;
			footer: { invalidate: () => void };
			ui: { requestRender: () => void };
			settingsManager: {
				getDefaultProvider: () => string | undefined;
				getDefaultModel: () => string;
				setDefaultModelAndProvider: () => void;
			};
		};
		mode.runtimeHost = {
			session: {
				settingsManager: {
					getDefaultProvider: () => undefined,
					getDefaultModel: () => "claude-sonnet",
					setDefaultModelAndProvider: () => {},
				},
				model: { provider: "anthropic", id: "claude-sonnet" },
				modelRuntime: runtime,
				setModel,
			},
		};
		mode.showSelector = (factory) => {
			selected = factory(() => {}).component;
		};
		mode.showExtensionInput = async () => "  Client projects  ";
		mode.showStatus = (message) => {
			actions.push(`status ${message}`);
		};
		mode.showError = (message) => {
			throw new Error(message);
		};
		mode.updateAvailableProviderCount = async () => {};
		mode.updateEditorBorderColor = () => {};
		mode.footer = { invalidate() {} };
		mode.ui = { requestRender() {} };
		const selector = () => {
			if (!selected) throw new Error("No account selector");
			return selected;
		};
		const choose = (index: number) => {
			for (let i = 0; i < index; i++) selector().handleInput("j");
			selector().handleInput("\n");
		};
		return {
			mode,
			actions,
			selector,
			choose,
			renameAccount,
			addAccountAlias,
			removeAccountAlias,
			logout,
			setModel,
			setAccountRotationPreferences,
			getPreferences: () => preferences,
			openProvider() {
				mode.showAccountManager();
				choose(0);
			},
		};
	}

	it("shows immutable provider names, not editable labels, at /login root", () => {
		const ui = harness();
		ui.mode.showAccountManager();
		const view = ui.selector().render(100).join("\n");
		expect(view).toContain("Anthropic");
		expect(view).not.toContain("Atomic Chat");
		expect(view).not.toContain("Work");
		expect(view).toContain("Add custom provider");
	});

	it("shows account nicknames, types and checkboxes within the provider", () => {
		const ui = harness();
		ui.openProvider();
		const view = ui.selector().render(100).join("\n");
		expect(view).toContain("Atomic Chat");
		expect(view).toContain("Work");
		expect(view).toContain("subscription");
		expect(view).toContain("Select all");
		expect(view).toContain("Rotation algorithm");
	});

	it("login provider choices do not append mutable nicknames", () => {
		const ui = harness();
		expect(ui.mode.getLoginProviderOptions().map((option) => option.name)).toEqual(["Anthropic", "Anthropic"]);
		expect(ui.mode.getLoginProviderOptions().every((option) => option.accountLabel === undefined)).toBe(true);
	});

	it("Space changes persisted rotation membership by stable account ID", () => {
		const ui = harness();
		ui.openProvider();
		ui.selector().handleInput("j"); // Primary account
		ui.selector().handleInput(" ");
		expect(ui.getPreferences().memberIds).toEqual(["account-anthropic-1"]);
		expect(ui.setAccountRotationPreferences).toHaveBeenCalledWith(
			"anthropic",
			expect.objectContaining({
				memberIds: ["account-anthropic-1"],
			}),
		);
	});

	it("M selects a persisted rotation algorithm", () => {
		const ui = harness();
		ui.openProvider();
		ui.selector().handleInput("m");
		ui.choose(3);
		expect(ui.getPreferences().strategy).toBe("hybrid");
	});

	it("T enables rotation using the selected accounts", async () => {
		const ui = harness();
		ui.openProvider();
		ui.selector().handleInput("t");
		await new Promise<void>((resolve) => setImmediate(resolve));
		expect(ui.getPreferences().enabled).toBe(true);
		expect(ui.setModel).toHaveBeenCalledWith({ provider: "account-profiles", id: "anthropic" }, { persist: true });
	});

	it("R renames only the highlighted account", async () => {
		const ui = harness();
		ui.openProvider();
		ui.selector().handleInput("j");
		ui.selector().handleInput("r");
		await new Promise<void>((resolve) => setImmediate(resolve));
		expect(ui.renameAccount).toHaveBeenCalledWith("anthropic", "  Client projects  ");
	});

	it("+ creates an additional unsigned account instead of overwriting existing credentials", async () => {
		const ui = harness();
		ui.openProvider();
		ui.selector().handleInput("+");
		await new Promise<void>((resolve) => setImmediate(resolve));
		expect(ui.addAccountAlias).toHaveBeenCalledWith("anthropic", "  Client projects  ");
	});

	it("X removes a selected additional account with confirmation", async () => {
		const ui = harness();
		ui.openProvider();
		ui.selector().handleInput("j");
		ui.selector().handleInput("j");
		ui.selector().handleInput("x");
		ui.choose(1);
		await new Promise<void>((resolve) => setImmediate(resolve));
		expect(ui.removeAccountAlias).toHaveBeenCalledWith("account-anthropic-1");
		expect(ui.logout).not.toHaveBeenCalled();
	});
});
