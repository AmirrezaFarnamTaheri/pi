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

	function harness(
		activeProvider = "anthropic",
		defaultProvider?: string,
		available = [{ provider: "anthropic", id: "claude-sonnet" }],
	) {
		const actions: string[] = [];
		const names = new Map([
			["anthropic", "Main"],
			["account-anthropic-1", "Work"],
		]);
		const renameAccount = vi.fn((id: string, name: string) => {
			names.set(id, name.trim());
			return name.trim();
		});
		const addAccountAlias = vi.fn((sourceProviderId: string, name?: string) => {
			const account = { id: "account-anthropic-2", sourceProviderId, label: name?.trim() ?? "Unnamed" };
			actions.push(`add ${account.id}`);
			return account;
		});
		const removeAccountAlias = vi.fn(async (id: string) => {
			actions.push(`delete ${id}`);
		});
		const logout = vi.fn(async (id: string) => {
			actions.push(`logout ${id}`);
		});
		const setModel = vi.fn(async (model: { provider: string }, _options?: { persist?: boolean }) => {
			actions.push(`switch ${model.provider}`);
		});
		const alias = { id: "account-anthropic-1", label: "Work", sourceProviderId: "anthropic" };
		const runtime = {
			getProviders: () => [
				{ id: "anthropic", name: "Anthropic", auth: { oauth: { login: async () => undefined } } },
				{ id: "account-anthropic-1", name: "Anthropic", auth: { oauth: { login: async () => undefined } } },
			],
			getAccountProfiles: () => [alias],
			getProviderAuthStatus: () => ({ configured: true }),
			hasConfiguredAuth: () => true,
			isUsingOAuth: () => true,
			addAccountAlias,
			getProvider: () => ({ name: "Anthropic" }),
			getAccountLabel: (id: string) => names.get(id) ?? "Unnamed",
			getAvailableSnapshot: () => available,
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
				settingsManager: {
					getDefaultProvider: () => defaultProvider,
					getDefaultModel: () => "claude-sonnet",
					setDefaultModelAndProvider: (provider: string, modelId: string) =>
						actions.push(`default ${provider}/${modelId}`),
				},
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
		const logins: string[] = [];
		(mode as unknown as { showLoginDialog: (id: string) => Promise<void> }).showLoginDialog = async (id) => {
			logins.push(id);
		};
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
		return { mode, actions, renameAccount, addAccountAlias, logins, removeAccountAlias, logout, setModel, getSelector, choose };
	}

	it("/login home shows management actions without a separate accounts screen", () => {
		const ui = harness();
		ui.mode.showAccountManager();
		const view = ui.getSelector().render(100).join("\n");
		expect(view).toContain("Login");
		expect(view).toContain("Main");
		expect(view).toContain("Work");
		expect(view).toContain("Existing accounts");
		expect(view).toContain("Account actions");
	});

	it("keeps the provider brand distinct from an account label in sign-in choices", () => {
		const ui = harness();
		const mode = ui.mode as unknown as {
			getLoginProviderOptions: () => { id: string; name: string; accountLabel?: string }[];
		};
		ui.renameAccount("anthropic", "Client projects");
		const options = mode.getLoginProviderOptions();
		expect(options.find((option) => option.id === "anthropic")).toMatchObject({
			name: "Anthropic",
			accountLabel: "Client projects",
		});
		expect(options.find((option) => option.id === "account-anthropic-1")).toMatchObject({
			name: "Anthropic",
			accountLabel: "Work",
		});
	});

	it("Add account creates a named identity without signing in to a provider", async () => {
		const ui = harness();
		const mode = ui.mode as unknown as {
			startAdditionalAccountLogin: (option: { id: string; name: string; authType: "oauth" }) => Promise<void>;
			showAccountActions: (profile: { id: string; label: string }) => void;
		};
		const actions = vi.spyOn(mode, "showAccountActions");
		await mode.startAdditionalAccountLogin({ id: "anthropic", name: "Anthropic", authType: "oauth" });
		expect(ui.addAccountAlias).toHaveBeenCalledWith("anthropic", "  Client projects  ");
		expect(ui.logins).toEqual([]);
		expect(actions).toHaveBeenCalledWith(expect.objectContaining({ label: "Client projects" }));
	});

	it("does not delete an active account when there is no replacement model", async () => {
		const ui = harness("account-anthropic-1", undefined, []);
		ui.mode.showError = (message) => ui.actions.push(`error ${message}`);
		ui.mode.showAccountManager();
		ui.choose(1);
		ui.choose(4);
		ui.choose(1);
		await new Promise<void>((resolve) => setImmediate(resolve));
		expect(ui.removeAccountAlias).not.toHaveBeenCalled();
		expect(ui.actions.some((action) => action.includes("error"))).toBe(true);
	});

	it("starts rename with the current nickname, ready to edit", async () => {
		const ui = harness();
		const edit = vi.spyOn(ui.mode, "showExtensionInput");
		ui.mode.showAccountManager();
		ui.getSelector().handleInput("r");
		await new Promise<void>((resolve) => setImmediate(resolve));
		expect(edit).toHaveBeenCalledWith("Rename Main", undefined, { initialValue: "Main" });
	});

	it("renames the highlighted login directly with r", async () => {
		const ui = harness();
		ui.mode.showAccountManager();
		ui.getSelector().handleInput("r");
		await new Promise<void>((resolve) => setImmediate(resolve));
		expect(ui.renameAccount).toHaveBeenCalledWith("anthropic", "  Client projects  ");
	});

	it("deletes the highlighted additional account directly with x", async () => {
		const ui = harness("account-anthropic-1");
		ui.mode.showAccountManager();
		ui.getSelector().handleInput("j"); // Additional login
		ui.getSelector().handleInput("x");
		ui.choose(1); // Single removal confirmation
		await new Promise<void>((resolve) => setImmediate(resolve));
		expect(ui.removeAccountAlias).toHaveBeenCalledWith("account-anthropic-1");
		expect(ui.logout).not.toHaveBeenCalled();
	});

	it("right opens account actions and left returns to login list", async () => {
		const ui = harness();
		ui.mode.showAccountManager();
		ui.getSelector().handleInput("\x1b[C");
		expect(ui.getSelector().render(100).join("\n")).toContain("Rename account");
		ui.getSelector().handleInput("\x1b[D");
		expect(ui.getSelector().render(100).join("\n")).toContain("＋ Create separate account");
	});

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

	it("updates a saved default when deleting the account it uses", async () => {
		const ui = harness("account-anthropic-1", "account-anthropic-1");
		ui.mode.showAccountManager();
		ui.choose(1);
		ui.choose(4);
		ui.choose(1);
		await new Promise<void>((resolve) => setImmediate(resolve));
		expect(ui.setModel).toHaveBeenCalledWith({ provider: "anthropic", id: "claude-sonnet" }, { persist: true });
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
