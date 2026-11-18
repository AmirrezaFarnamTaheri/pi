import { describe, expect, it } from "vitest";
import { getSharedThinkingLevels, resolveThinkingLevel } from "../src/models.ts";
import type { Model } from "../src/types.ts";

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

describe("account rotation effort capabilities", () => {
	const baseline: Model<"openai-completions"> = {
		api: "openai-completions",
		provider: "test",
		id: "model",
		name: "Model",
		baseUrl: "https://example.invalid",
		input: ["text"],
		reasoning: true,
		contextWindow: 4096,
		maxTokens: 1024,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	};
	it("never advertises thinking unsupported by one of the routed physical models", () => {
		const noReasoning = { ...baseline, reasoning: false };
		expect(getSharedThinkingLevels([baseline, noReasoning])).toEqual(["off"]);
		expect(getSharedThinkingLevels([])).toEqual(["off"]);
	});
});
