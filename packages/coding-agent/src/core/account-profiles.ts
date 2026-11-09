/** Credential-free, persistent account identities for independently authenticated provider aliases. */
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import lockfile from "proper-lockfile";

export interface AccountProfile {
	id: string;
	sourceProviderId: string;
	label: string;
}

const INITIAL = '{"version":1,"accounts":[]}';
const PROVIDER_ID = /^[a-z][a-z0-9._-]{0,127}$/;
const ACCOUNT_ID = /^account-[a-z0-9-]+-[1-9][0-9]*$/;

function validateProfiles(json: unknown): AccountProfile[] {
	if (!json || typeof json !== "object" || Array.isArray(json)) throw new Error("Invalid account profiles format");
	const value = json as Record<string, unknown>;
	if (value.version !== 1 || !Array.isArray(value.accounts) || value.accounts.length > 128) {
		throw new Error("Unsupported account profiles format");
	}
	const ids = new Set<string>();
	return value.accounts.map((item: unknown) => {
		if (!item || typeof item !== "object" || Array.isArray(item)) throw new Error("Invalid account profile");
		const profile = item as Record<string, unknown>;
		if (typeof profile.id !== "string" || !ACCOUNT_ID.test(profile.id) ||
			typeof profile.sourceProviderId !== "string" || !PROVIDER_ID.test(profile.sourceProviderId) ||
			typeof profile.label !== "string" || profile.label.length < 1 || profile.label.length > 64 ||
			/[\x00-\x1f\x7f]/.test(profile.label) || ids.has(profile.id)) {
			throw new Error("Invalid or duplicate account profile");
		}
		ids.add(profile.id);
		return { id: profile.id, sourceProviderId: profile.sourceProviderId, label: profile.label };
	});
}

export function loadAccountProfiles(path: string): AccountProfile[] {
	if (!existsSync(path)) return [];
	return validateProfiles(JSON.parse(readFileSync(path, "utf8")));
}

function withAccountFileLock<T>(path: string, edit: (current: AccountProfile[]) => { next?: AccountProfile[]; result: T }): T {
	mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
	// Lock the destination name BEFORE its initial creation. Another process must
	// never observe an empty file between open("wx") and the initial JSON write.
	// proper-lockfile deliberately rejects the `retries` option on its
	// synchronous API. Retry only contention explicitly, without ever
	// bypassing the lock or changing the atomic rename protocol below.
	let unlock: () => void;
	for (let attempt = 0; ; attempt++) {
		try {
			unlock = lockfile.lockSync(path, { realpath: false });
			break;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ELOCKED" || attempt >= 5) throw error;
			Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25 * (attempt + 1));
		}
	}
	try {
		if (!existsSync(path)) {
			writeFileSync(path, INITIAL, { encoding: "utf8", mode: 0o600, flag: "wx" });
		}
		const { next, result } = edit(loadAccountProfiles(path));
		if (next) {
			const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
			try {
				writeFileSync(temporary, JSON.stringify({ version: 1, accounts: next }, null, 2) + "\n",
					{ encoding: "utf8", mode: 0o600, flag: "wx" });
				renameSync(temporary, path);
			} finally {
				rmSync(temporary, { force: true });
			}
		}
		return result;
	} finally {
		unlock();
	}
}

export function addAccountProfile(
	path: string, sourceProviderId: string, occupiedProviderIds: readonly string[], label?: string,
): AccountProfile {
	if (!PROVIDER_ID.test(sourceProviderId)) throw new Error("Invalid source provider ID");
	if (label !== undefined && (!label.trim() || label.length > 64 || /[\x00-\x1f\x7f]/.test(label))) {
		throw new Error("Invalid account label");
	}
	return withAccountFileLock(path, (current) => {
		if (current.length >= 128) throw new Error("Too many account profiles");
		const occupied = new Set([...occupiedProviderIds, ...current.map((profile) => profile.id)]);
		const slug = sourceProviderId.replace(/[^a-z0-9-]/g, "-").slice(0, 40);
		let index = 1;
		while (occupied.has(`account-${slug}-${index}`)) index++;
		const profile = {
			id: `account-${slug}-${index}`,
			sourceProviderId,
			label: label?.trim() || `${sourceProviderId} account ${index}`,
		};
		return { next: [...current, profile], result: profile };
	});
}

export function removeAccountProfile(path: string, id: string): boolean {
	if (!existsSync(path)) return false;
	return withAccountFileLock(path, (current) => {
		const next = current.filter((profile) => profile.id !== id);
		return { next: next.length !== current.length ? next : undefined, result: next.length !== current.length };
	});
}
