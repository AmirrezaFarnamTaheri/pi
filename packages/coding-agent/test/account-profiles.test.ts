import { strict as assert } from "node:assert";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "vitest";
import {
	addAccountProfile,
	loadAccountProfiles,
	loadPrimaryAccountNames,
	removeAccountProfile,
	renameAccountProfile,
	renamePrimaryAccount,
} from "../src/core/account-profiles.ts";

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

test("renames a single account without changing its identity or sibling accounts", () => {
	const dir = mkdtempSync(join(tmpdir(), "pi-rename-account-"));
	directories.push(dir);
	const path = join(dir, "accounts.json");
	const work = addAccountProfile(path, "anthropic", ["anthropic"], "Work");
	const personal = addAccountProfile(path, "anthropic", ["anthropic", work.id], "Personal");
	const renamed = renameAccountProfile(path, work.id, "  Client projects  ");
	assert.deepEqual(renamed, { ...work, label: "Client projects" });
	assert.deepEqual(loadAccountProfiles(path), [{ ...work, label: "Client projects" }, personal]);
	assert.equal(renameAccountProfile(path, "missing", "Unused"), undefined);
	assert.throws(() => renameAccountProfile(path, work.id, "   "), /name/i);
	assert.throws(() => renameAccountProfile(path, work.id, "bad\\nname"), /name/i);
	assert.throws(() => renameAccountProfile(path, work.id, "a".repeat(65)), /name/i);
	assert.deepEqual(loadAccountProfiles(path)[1], personal);
});

test("primary names survive adding, renaming and deleting additional accounts", () => {
	const dir = mkdtempSync(join(tmpdir(), "pi-primary-name-"));
	directories.push(dir);
	const path = join(dir, "accounts.json");
	assert.equal(renamePrimaryAccount(path, "anthropic", "  Main work  "), "Main work");
	const alternate = addAccountProfile(path, "anthropic", ["anthropic"]);
	renameAccountProfile(path, alternate.id, "Side projects");
	assert.deepEqual(loadPrimaryAccountNames(path), { anthropic: "Main work" });
	assert.deepEqual(loadAccountProfiles(path), [{ ...alternate, label: "Side projects" }]);
	assert.equal(removeAccountProfile(path, alternate.id), true);
	assert.deepEqual(loadPrimaryAccountNames(path), { anthropic: "Main work" });
	assert.deepEqual(loadAccountProfiles(path), []);
});
