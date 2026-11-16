/** Provider-first presentation of immutable brands and independently named credential identities. */
import type { AccountProfile } from "./account-profiles.ts";

export interface ProviderAccountEntry {
	id: string;
	name: string;
	connected: boolean;
	authType: "oauth" | "api_key" | null;
}
export interface GroupedAccount {
	id: string;
	label: string;
	connected: boolean;
	authType: "oauth" | "api_key" | null;
	original: boolean;
	sourceProviderId: string;
}
export interface ProviderAccountGroup {
	id: string;
	name: string;
	accounts: GroupedAccount[];
}

/** Only known provider families are grouped across *distinct* physical IDs. */
export function getProviderGroupId(id: string, name: string): string {
	if (id === "openai-codex") return "openai-codex";
	if (/^nvidia(?:[ -]?(?:i|ii|iii|iv|[0-9]+))?$/i.test(name)) return "nvidia";
	return id;
}
export function getProviderGroupName(id: string, name: string): string {
	if (id === "openai-codex") return "Codex";
	if (id === "nvidia") return "NVIDIA";
	if (id === "antigravity-manager") return "Antigravity";
	return name;
}

/** A provider label comes from the registered provider, never a user-editable account nickname. */
export function groupProviderAccounts(
	providers: readonly ProviderAccountEntry[],
	profiles: readonly AccountProfile[],
	getAccountLabel: (id: string) => string,
): ProviderAccountGroup[] {
	const aliases = new Map(profiles.map((profile) => [profile.id, profile]));
	const sources = new Map(
		providers.filter((provider) => !aliases.has(provider.id)).map((provider) => [provider.id, provider]),
	);
	const groups = new Map<string, ProviderAccountGroup>();
	for (const provider of providers) {
		if (aliases.has(provider.id) || provider.id === "account-profiles") continue;
		const id = getProviderGroupId(provider.id, provider.name);
		let group = groups.get(id);
		if (!group) {
			group = { id, name: getProviderGroupName(id, provider.name), accounts: [] };
			groups.set(id, group);
		}
		const label = getAccountLabel(provider.id);
		group.accounts.push({
			id: provider.id,
			label: label === "Primary" && id !== provider.id ? provider.name : label,
			connected: provider.connected,
			authType: provider.authType,
			original: true,
			sourceProviderId: provider.id,
		});
	}
	for (const profile of profiles) {
		const source = sources.get(profile.sourceProviderId);
		const groupId = source ? getProviderGroupId(source.id, source.name) : profile.sourceProviderId;
		let group = groups.get(groupId);
		if (!group) {
			group = {
				id: groupId,
				name: source ? getProviderGroupName(groupId, source.name) : profile.sourceProviderId,
				accounts: [],
			};
			groups.set(groupId, group);
		}
		const actual = providers.find((provider) => provider.id === profile.id);
		group.accounts.push({
			id: profile.id,
			label: profile.label,
			connected: actual?.connected ?? false,
			authType: actual?.authType ?? null,
			original: false,
			sourceProviderId: profile.sourceProviderId,
		});
	}
	return [...groups.values()].sort((a, b) => {
		const preferred = ["openai-codex", "antigravity", "antigravity-manager", "anthropic", "nvidia"];
		const ai = preferred.indexOf(a.id);
		const bi = preferred.indexOf(b.id);
		if (ai !== bi) return (ai === -1 ? Infinity : ai) - (bi === -1 ? Infinity : bi);
		return a.name.localeCompare(b.name);
	});
}
