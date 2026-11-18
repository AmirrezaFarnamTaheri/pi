/**
 * Best-effort, credential-free Antigravity model cooldown persistence.
 *
 * Only model names and bounded expiry timestamps are stored. This is not an
 * account identity manager or cross-process quota coordinator. Writes are
 * atomic within a process but concurrent processes still need stronger leases
 * if they must agree on a shared admission budget.
 */

import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

export const MAX_AGY_COOLDOWN_MS = 30 * 24 * 60 * 60_000;
const MAX_COOLDOWN_FILE_BYTES = 128 * 1024;
const MAX_MODELS = 256;

function validModelName(name: string): boolean {
	return name.length > 0 && name.length <= 200 && !name.startsWith("-") && !name.includes("\0");
}

function validExpiry(value: unknown, now: number): value is number {
	return (
		typeof value === "number" &&
		Number.isSafeInteger(value) &&
		value > now &&
		value - now <= MAX_AGY_COOLDOWN_MS
	);
}

export class AgyCooldownStore {
	private readonly file: string;
	private readonly now: () => number;

	constructor(file: string, now: () => number = Date.now) {
		this.file = file;
		this.now = now;
	}

	async load(): Promise<Map<string, number>> {
		const entries = new Map<string, number>();
		try {
			if ((await stat(this.file)).size > MAX_COOLDOWN_FILE_BYTES) return entries;
			const decoded: unknown = JSON.parse(await readFile(this.file, "utf8"));
			if (decoded === null || typeof decoded !== "object" || Array.isArray(decoded)) return entries;
			const record = decoded as { version?: unknown; entries?: unknown };
			if (
				record.version !== 1 ||
				record.entries === null ||
				typeof record.entries !== "object" ||
				Array.isArray(record.entries)
			) {
				return entries;
			}
			const now = this.now();
			for (const [name, expiry] of Object.entries(record.entries as Record<string, unknown>).slice(0, MAX_MODELS)) {
				if (validModelName(name) && validExpiry(expiry, now)) entries.set(name, expiry);
			}
		} catch {
			// A corrupt, missing, or inaccessible file must not prevent healthy work.
		}
		return entries;
	}

	async save(values: ReadonlyMap<string, number>): Promise<void> {
		const merged = await this.load();
		const now = this.now();
		for (const [name, expiry] of values) {
			if (!validModelName(name) || !validExpiry(expiry, now)) continue;
			merged.set(name, Math.max(merged.get(name) ?? 0, expiry));
		}
		const entries: Record<string, number> = Object.create(null);
		for (const [name, expiry] of [...merged].slice(0, MAX_MODELS)) entries[name] = expiry;
		const folder = dirname(this.file);
		await mkdir(folder, { recursive: true, mode: 0o700 });
		const temporary = join(folder, ".agy-cooldowns-" + randomUUID() + ".tmp");
		try {
			await writeFile(temporary, JSON.stringify({ version: 1, entries }), { flag: "wx", mode: 0o600 });
			await rename(temporary, this.file);
		} finally {
			await rm(temporary, { force: true }).catch(() => undefined);
		}
	}
}
