import { describe, expect, it } from "vitest";
import { clampThinkingLevelToSupported } from "../src/models.ts";

describe("clampThinkingLevelToSupported", () => {
	it("uses a chosen model's available levels rather than the global highest level", () => {
		expect(clampThinkingLevelToSupported(["off", "low", "medium"], "xhigh")).toBe("medium");
		expect(clampThinkingLevelToSupported(["off", "low", "medium"], "minimal")).toBe("low");
		expect(clampThinkingLevelToSupported(["off", "medium"], "high")).toBe("medium");
	});

	it("keeps supported choices and handles reasoning-disabled models", () => {
		expect(clampThinkingLevelToSupported(["off", "minimal", "high"], "minimal")).toBe("minimal");
		expect(clampThinkingLevelToSupported(["off"], "max")).toBe("off");
		expect(clampThinkingLevelToSupported([], "high")).toBe("off");
	});
});
