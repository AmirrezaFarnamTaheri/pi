import { getModel } from "@earendil-works/pi-ai/compat";
import { getSupportedThinkingLevels } from "@earendil-works/pi-ai/models";
import { describe, expect, it } from "vitest";
import { sharedRotationThinkingLevels } from "../src/extensions/account-rotation-policy.ts";

describe("rotation thinking capabilities", () => {
	const original = getModel("anthropic", "claude-sonnet-4-5")!;

	it("advertises only the levels common to physical targets", () => {
		const basic = {
			...original,
			reasoning: true,
			thinkingLevelMap: { ...original.thinkingLevelMap, xhigh: null, max: null },
		};
		const extended = {
			...original,
			reasoning: true,
			thinkingLevelMap: { ...original.thinkingLevelMap, xhigh: "xhigh" as const, max: null },
		};
		expect(sharedRotationThinkingLevels([basic, extended])).toEqual(getSupportedThinkingLevels(basic));
	});

	it("does not offer reasoning when any eligible physical target cannot reason", () => {
		expect(sharedRotationThinkingLevels([{ ...original, reasoning: false }, original])).toEqual(["off"]);
	});

	it("does not claim unavailable capabilities with no routable targets", () => {
		expect(sharedRotationThinkingLevels([])).toEqual([]);
	});
});
