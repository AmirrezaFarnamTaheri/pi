import { describe, expect, it } from "vitest";
import { KeybindingsManager } from "../src/core/keybindings.ts";

describe("manual background tasks and keyboard transcript scrolling", () => {
  it("reserves Ctrl+B for an independent background agent and keeps left-arrow editing", () => {
    const keys = new KeybindingsManager();
    expect(keys.getKeys("app.message.background")).toEqual(["ctrl+b"]);
    expect(keys.getKeys("tui.editor.cursorLeft")).toEqual(["left"]);
    expect(keys.getConflicts().filter((entry) => entry.key === "ctrl+b")).toEqual([]);
  });

  it("scrolls the fullscreen transcript by line with Shift+Up and Shift+Down", () => {
    const keys = new KeybindingsManager();
    expect(keys.getKeys("tui.altScreen.lineUp")).toEqual(["shift+up"]);
    expect(keys.getKeys("tui.altScreen.lineDown")).toEqual(["shift+down"]);
  });
});
