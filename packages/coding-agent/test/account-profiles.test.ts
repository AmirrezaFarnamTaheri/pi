import { strict as assert } from "node:assert";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "vitest";
import { addAccountProfile, loadAccountProfiles, removeAccountProfile } from "../src/core/account-profiles.ts";

const directories: string[] = [];
afterEach(() => {
	for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true });
});

test("creates independent, persistent alias IDs without overwriting existing accounts", () => {
	const dir = mkdtempSync(join(tmpdir(), "pi-accounts-"));
	directories.push(dir);
	const path = join(dir, "account-profiles.json");
	const first = addAccountProfile(path, "anthropic", ["anthropic"], "Work");
	const second = addAccountProfile(path, "anthropic", ["anthropic", first.id], "Personal");
	assert.notEqual(first.id, second.id);
	assert.deepEqual(loadAccountProfiles(path), [first, second]);
	assert.equal(readFileSync(path, "utf8").includes("secret"), false);
});

test("never silently overwrites provider IDs, disallows malformed profiles, and removes just one alias", () => {
	const dir = mkdtempSync(join(tmpdir(), "pi-accounts-"));
	directories.push(dir);
	const path = join(dir, "account-profiles.json");
	const account = addAccountProfile(path, "antigravity-manager", ["antigravity-manager"]);
	assert.match(account.id, /^account-antigravity-manager-/);
	assert.throws(() => addAccountProfile(path, "../bad", []), /provider/i);
	assert.throws(() => addAccountProfile(path, "antigravity-manager", [], "x".repeat(300)), /label/i);
	assert.equal(removeAccountProfile(path, "unrelated"), false);
	assert.equal(removeAccountProfile(path, account.id), true);
	assert.deepEqual(loadAccountProfiles(path), []);
});

test("keeps profiles independent of credentials, even when the provider source contains punctuation", () => {
	const dir = mkdtempSync(join(tmpdir(), "pi-accounts-"));
	directories.push(dir);
	const path = join(dir, "profiles.json");
	const profile = addAccountProfile(path, "llama.cpp", ["llama.cpp"]);
	assert.match(profile.id, /^account-llama-cpp-/);
	assert.equal(profile.sourceProviderId, "llama.cpp");
});
