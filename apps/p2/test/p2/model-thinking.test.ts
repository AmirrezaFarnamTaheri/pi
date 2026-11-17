import assert from "node:assert/strict";
import { test } from "node:test";
import { modelChoice } from "../../src/web/model-choice.ts";

test("model choice resolves a legacy effort to one the selected model actually offers", () => {
	const model = {
		provider: "faux",
		modelId: "limited",
		name: "Limited",
		contextWindow: 4096,
		thinkingLevels: ["minimal", "medium"],
	};
	assert.deepEqual(modelChoice(model, "high"), {
		model: { provider: "faux", modelId: "limited" },
		thinkingLevel: "medium",
	});
	assert.equal(modelChoice(model, "off").thinkingLevel, "minimal");
});
