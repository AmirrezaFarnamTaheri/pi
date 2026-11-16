import { describe, expect, it } from "vitest";
import { groupProviderAccounts } from "../src/core/account-provider-groups.ts";

describe("provider-first account groups", () => {
	it("shows immutable provider names rather than editable account nicknames", () => {
		const groups = groupProviderAccounts(
			[
				{ id: "openai-codex", name: "OpenAI Codex", connected: true, authType: "oauth" },
				{ id: "anthropic", name: "Anthropic", connected: true, authType: "oauth" },
				{ id: "account-anthropic-1", name: "Anthropic", connected: true, authType: "oauth" },
			],
			[{ id: "account-anthropic-1", sourceProviderId: "anthropic", label: "Work" }],
			(id) => (id === "anthropic" ? "Atomic Chat" : "Primary"),
		);
		expect(groups.map((group) => group.name)).toEqual(["Codex", "Anthropic"]);
		expect(groups[1]?.accounts.map((account) => account.label)).toEqual(["Atomic Chat", "Work"]);
		expect(groups.map((group) => group.name).join(" ")).not.toContain("Atomic Chat");
	});

	it("groups separate NVIDIA credentials without merging their identities", () => {
		const groups = groupProviderAccounts(
			[
				{ id: "nvidia-i", name: "NVIDIA I", connected: true, authType: "api_key" },
				{ id: "nvidia-ii", name: "NVIDIA II", connected: true, authType: "api_key" },
			],
			[],
			() => "Primary",
		);
		expect(groups).toHaveLength(1);
		expect(groups[0]).toMatchObject({ id: "nvidia", name: "NVIDIA" });
		expect(groups[0]?.accounts.map((account) => [account.id, account.label])).toEqual([
			["nvidia-i", "NVIDIA I"],
			["nvidia-ii", "NVIDIA II"],
		]);
	});

	it("keeps unsigned-in additional accounts visible for connection but not rotation", () => {
		const groups = groupProviderAccounts(
			[{ id: "anthropic", name: "Anthropic", connected: true, authType: "oauth" }],
			[{ id: "account-anthropic-1", label: "Backup", sourceProviderId: "anthropic" }],
			() => "Primary",
		);
		expect(groups[0]?.accounts[1]).toMatchObject({
			id: "account-anthropic-1",
			connected: false,
			label: "Backup",
		});
	});
});
