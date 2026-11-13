import { describe, expect, it } from "vitest";
import { bashToolSystemPromptContribution } from "../src/core/tools/bash.ts";
import { powershellToolSystemPromptContribution } from "../src/core/tools/powershell.ts";

describe("background shell decisions use task dependencies, not a time threshold", () => {
	for (const [name, contribution] of [
		["bash", bashToolSystemPromptContribution],
		["powershell", powershellToolSystemPromptContribution],
	] as const) {
		it(`${name}: keeps a command foreground if its exit code or output is needed to continue`, () => {
			const policy = contribution.guidelines.join("\n");
			expect(policy).toMatch(/next step|next decision/i);
			expect(policy).toMatch(/exit code|test results/i);
			expect(policy).toMatch(/foreground/i);
		});

		it(`${name}: allows independent work in background and requires confirmed completion`, () => {
			const policy = contribution.guidelines.join("\n");
			expect(policy).toMatch(/independent/i);
			expect(policy).toMatch(/background: true/);
			expect(policy).toMatch(/status|exit code/i);
			expect(policy).not.toMatch(/longer than \d+|after \d+ seconds/i);
		});
	}
});
