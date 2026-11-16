import { getKeybindings, setKeybindings } from "@earendil-works/pi-tui";
import { beforeEach, describe, expect, it } from "vitest";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import { ExtensionSelectorComponent } from "../src/modes/interactive/components/extension-selector.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";

describe("extension selector shortcuts", () => {
	beforeEach(() => {
		initTheme("dark");
		setKeybindings(new KeybindingsManager());
	});

	it("passes the highlighted row to the opt-in keyboard handler", () => {
		const handled: string[] = [];
		const selector = new ExtensionSelectorComponent(
			"Choose",
			["Main", "Backup"],
			() => {},
			() => {},
			{
				onShortcut: (key, label) => {
					if (key !== "r" || !label) return false;
					handled.push(label);
					return true;
				},
			},
		);
		selector.handleInput("j");
		selector.handleInput("r");
		expect(handled).toEqual(["Backup"]);
		expect(getKeybindings()).toBeDefined();
	});
});
