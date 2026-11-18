import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { modelChoice } from "../../src/web/model-choice.ts";

describe("modelChoice", () => {
	it("clamps the remembered level to the chosen model's actual levels", () => {
		const model = {
			provider: "faux",
			modelId: "limited",
			name: "Limited",
			thinkingLevels: ["off", "low", "medium"],
			contextWindow: 128_000,
		};
		assert.deepEqual(modelChoice(model, "xhigh"), {
			model: { provider: "faux", modelId: "limited" },
			thinkingLevel: "medium",
		});
	});

	it("uses off for a model with no reasoning and retains supported preferences", () => {
		const model = {
			provider: "faux",
			modelId: "ordinary",
			name: "Ordinary",
			thinkingLevels: ["off"],
			contextWindow: 32_000,
		};
		assert.equal(modelChoice(model, "high").thinkingLevel, "off");
		assert.equal(modelChoice({ ...model, thinkingLevels: ["off", "low", "high"] }, "low").thinkingLevel, "low");
	});
});
