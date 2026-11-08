import { strict as assert } from "node:assert";
import { test } from "vitest";
import { Input } from "../src/components/input.ts";

test("secret input never renders the credential or exposes it via cursor movement", () => {
	const input = new Input({ mask: true });
	input.setValue("s3cr3t-token");
	const line = input.render(60).join("\n");
	assert.ok(!line.includes("s3cr3t"));
	assert.ok(line.includes("•"));
	assert.equal(input.getValue(), "s3cr3t-token");
});

test("secret-to-plain transition clears the value rather than revealing it", () => {
	const input = new Input();
	input.setValue("public endpoint");
	assert.ok(input.render(60).join("\n").includes("public endpoint"));
	input.setMask(true);
	input.setValue("sensitive-secret");
	assert.ok(!input.render(60).join("\n").includes("sensitive-secret"));
	input.setMask(false);
	assert.equal(input.getValue(), "");
	assert.ok(!input.render(60).join("\n").includes("sensitive-secret"));
});

test("secret text cannot return from undo or from the kill ring after a mode change", () => {
	const input = new Input({ mask: true });
	input.handleInput("credential-1234");
	input.handleInput("\\x17"); // Ctrl+W, remove the secret
	input.setMask(false);
	input.handleInput("\\x19"); // Ctrl+Y must not yank the removed secret
	input.handleInput("\\x1f"); // Ctrl+_, undo must not restore it
	assert.equal(input.getValue(), "");
	assert.ok(!input.render(80).join("\n").includes("credential-1234"));
});

test("clearing secret input discards hidden history before normal prompts", () => {
	const input = new Input({ mask: true });
	input.handleInput("an-older-secret");
	input.setValue("");
	input.handleInput("another-secret");
	input.clearSensitiveValue();
	input.setMask(false);
	input.handleInput("\\x1f");
	input.handleInput("\\x19");
	assert.equal(input.getValue(), "");
});
