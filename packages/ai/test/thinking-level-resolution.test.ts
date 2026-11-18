import { describe, expect, it } from "vitest";
import { resolveThinkingLevel } from "../src/models.ts";

describe("model-specific thinking level resolution", () => {
	it("uses the closest supported level instead of a universal high effort", () => {
		expect(resolveThinkingLevel(["off", "low", "medium"], "xhigh")).toBe("medium");
		expect(resolveThinkingLevel(["off", "low", "high"], "minimal")).toBe("low");
		expect(resolveThinkingLevel(["off", "low"], "high")).toBe("low");
	});
	it("returns off for a non-reasoning model without overwriting the preferred level", () => {
		expect(resolveThinkingLevel(["off"], "max")).toBe("off");
	});
});
