import { describe, expect, it } from "vitest";
import { parseSkillBlock } from "../src/core/agent-session.ts";
import { getNextCycleIndex, withoutDeletedHeaders } from "../src/core/agent-session-utils.ts";

describe("agent-session utility boundaries", () => {
	it("preserves the public skill-block parser and its trailing message", () => {
		const text = '<skill name="review" location="a/b">\nGuidance\n</skill>\n\nUser request';
		expect(parseSkillBlock(text)).toEqual({
			name: "review",
			location: "a/b",
			content: "Guidance",
			userMessage: "User request",
		});
		expect(parseSkillBlock("ordinary user input")).toBeNull();
	});

	it("retains model-cycle edge behavior and filters deleted provider headers", () => {
		expect(getNextCycleIndex(-1, 3, "backward")).toBe(2);
		expect(getNextCycleIndex(0, 1, "forward")).toBeUndefined();
		expect(withoutDeletedHeaders({ foo: "bar", deleted: null })).toEqual({ foo: "bar" });
	});
});
