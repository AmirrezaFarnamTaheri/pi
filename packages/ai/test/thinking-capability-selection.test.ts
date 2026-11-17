import { describe, expect, it } from "vitest";
import { clampThinkingLevelFromLevels } from "../src/models.ts";

describe("clampThinkingLevelFromLevels", () => {
	it("keeps the explicit level when the selected model supports it", () => {
		expect(clampThinkingLevelFromLevels(["off", "low", "high"], "low")).toBe("low");
	});
	it("uses the closest supported level rather than a universal hard-coded choice", () => {
		expect(clampThinkingLevelFromLevels(["off", "low", "high"], "medium")).toBe("high");
		expect(clampThinkingLevelFromLevels(["off", "low", "high"], "xhigh")).toBe("high");
		expect(clampThinkingLevelFromLevels(["minimal", "medium"], "off")).toBe("minimal");
	});
	it("preserves an off-only model and fails closed when no level is available", () => {
		expect(clampThinkingLevelFromLevels(["off"], "max")).toBe("off");
		expect(() => clampThinkingLevelFromLevels([], "high")).toThrow(/no supported thinking levels/i);
	});
});
