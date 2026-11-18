// The model picker preserves an available effort and resolves unsupported preferences to model capabilities.
import assert from "node:assert/strict";
import { test } from "node:test";
import { modelChoice } from "../../src/web/model-choice.ts";

test("a model switch chooses the closest supported thinking effort", () => {
	const limited = {
		provider: "faux",
		modelId: "limited",
		name: "Limited",
		thinkingLevels: ["off", "low", "medium"],
		contextWindow: 4096,
	};
	assert.equal(modelChoice(limited, "xhigh").thinkingLevel, "medium");
	assert.equal(modelChoice(limited, "low").thinkingLevel, "low");
});
