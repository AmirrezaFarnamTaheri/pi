import { describe, expect, it } from "vitest";
import {
	formatLoginProviderCompletionDescription,
	getLoginProviderCompletionOptions,
	getLoginProviderSearchText,
} from "../src/modes/interactive/login-completion.ts";

describe("login provider completion helpers", () => {
	it("uses searchable nicknames without replacing provider names in completion", () => {
		const choices = getLoginProviderCompletionOptions([
			{ id: "account-anthropic-1", name: "Anthropic", accountLabel: "Client projects", authType: "oauth" },
		]);
		expect(choices[0]?.name).toBe("Anthropic");
		expect(getLoginProviderSearchText(choices[0]!)).toContain("Client projects");
		expect(formatLoginProviderCompletionDescription(choices[0]!)).toContain(
			"Anthropic · Client projects",
		);
	});

	it("deduplicates auth methods and preserves alphabetical provider ordering", () => {
		const choices = getLoginProviderCompletionOptions([
			{ id: "zeta", name: "Zeta", authType: "api_key" },
			{ id: "alpha", name: "Alpha", authType: "api_key" },
			{ id: "alpha", name: "Alpha", authType: "oauth", subscription: false },
			{ id: "alpha", name: "Alpha", authType: "oauth" },
		]);
		expect(choices.map((item) => item.id)).toEqual(["alpha", "zeta"]);
		expect(choices[0]!.authTypes).toEqual(["oauth", "api_key"]);
		expect(getLoginProviderSearchText(choices[0]!)).toContain("api_key API key");
		expect(formatLoginProviderCompletionDescription(choices[0]!)).toContain("API key");
	});
});
