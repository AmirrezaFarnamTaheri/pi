import { setKeybindings } from "@earendil-works/pi-tui";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import type { ExtensionSelectorComponent } from "../src/modes/interactive/components/extension-selector.ts";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";

describe("account management menu", () => {
	beforeEach(() => {
		initTheme("dark");
		setKeybindings(new KeybindingsManager());
	});

	function harness(activeProvider = "anthropic") {
		const actions: string[] = [];
		const renameAccount = vi.fn((_id: string, name: string) => name.trim());
		const removeAccountAlias = vi.fn(async (id: string) => {
			actions.push(`delete ${id}`);
		});
		const logout = vi.fn(async (id: string) => {
			actions.push(`logout ${id}`);
		});
		const setModel = vi.fn(async (model: { provider: string }) => {
			actions.push(`switch ${model.provider}`);
		});
		const alias = { id: "account-anthropic-1", label: "Work", sourceProviderId: "anthropic" };
		const runtime = {
			getProviders: () => [{ id: "anthropic", name: "Anthropic" }],
			getAccountProfiles: () => [alias],
			getProviderAuthStatus: () => ({ configured: true }),
			getProvider: () => ({ name: "Anthropic" }),
			getAccountLabel: (id: string) => (id === "anthropic" ? "Main" : "Work"),
			getAvailableSnapshot: () => [{ provider: "anthropic", id: "claude-sonnet" }],
			renameAccount,
			removeAccountAlias,
			logout,
		};
		let selected: ExtensionSelectorComponent | undefined;
		const mode = Object.create(InteractiveMode.prototype) as {
			runtimeHost: unknown;
			showSelector: (factory: (done: () => void) => { component: ExtensionSelectorComponent }) => void;
			showExtensionInput: (label: string, initial?: string) => Promise<string | undefined>;
			showStatus: (message: string) => void;
			showError: (message: string) => void;
			showAccountManager: () => void;
			updateAvailableProviderCount: () => Promise<void>;
			updateEditorBorderColor: () => void;
			footer: { invalidate: () => void };
		};
		mode.runtimeHost = {
			session: {
				model: { provider: activeProvider, id: "claude-sonnet" },
				modelRuntime: runtime,
				setModel,
			},
		};
		mode.showSelector = (factory) => {
			selected = factory(() => {}).component;
		};
		mode.showExtensionInput = async () => "  Client projects  ";
		mode.showStatus = () => {};
		mode.showError = (message) => {
			throw new Error(message);
		};
		mode.updateAvailableProviderCount = async () => {};
		mode.updateEditorBorderColor = () => {};
		mode.footer = { invalidate() {} };
		const getSelector = () => {
			if (!selected) throw new Error("No account selector");
			return selected;
		};
		const choose = (index: number) => {
			const selector = getSelector();
			for (let i = 0; i < index; i++) selector.handleInput("j");
			selector.handleInput("\n");
		};
		return { mode, actions, renameAccount, removeAccountAlias, logout, setModel, getSelector, choose };
	}

	it("shows original and additional accounts in the same menu and renames the original", async () => {
		const ui = harness();
		ui.mode.showAccountManager();
		ui.choose(0); // Main
		ui.choose(2); // Rename account
		await new Promise<void>((resolve) => setImmediate(resolve));
		expect(ui.renameAccount).toHaveBeenCalledWith("anthropic", "  Client projects  ");
	});

	it("renames an additional account without changing its stable ID", async () => {
		const ui = harness();
		ui.mode.showAccountManager();
		ui.choose(1); // Work
		ui.choose(2); // Rename account
		await new Promise<void>((resolve) => setImmediate(resolve));
		expect(ui.renameAccount).toHaveBeenCalledWith("account-anthropic-1", "  Client projects  ");
	});

	it("deletes the selected additional account, switching away first when it is active", async () => {
		const ui = harness("account-anthropic-1");
		ui.mode.showAccountManager();
		ui.choose(1); // Work
		ui.choose(4); // Delete account (rotation option is present)
		ui.choose(1); // Confirm once
		await new Promise<void>((resolve) => setImmediate(resolve));
		expect(ui.actions).toEqual(["switch anthropic", "delete account-anthropic-1"]);
		expect(ui.logout).not.toHaveBeenCalled();
	});

	it("disconnects the original login without deleting unrelated accounts", async () => {
		const ui = harness();
		ui.mode.showAccountManager();
		ui.choose(0); // Main
		ui.choose(4); // Disconnect account
		ui.choose(1); // Confirm once
		await new Promise<void>((resolve) => setImmediate(resolve));
		expect(ui.logout).toHaveBeenCalledWith("anthropic");
		expect(ui.removeAccountAlias).not.toHaveBeenCalled();
	});
});
