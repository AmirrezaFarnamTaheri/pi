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

test("normal input stays visible and prompts can safely change between modes", () => {
	const input = new Input();
	input.setValue("public endpoint");
	assert.ok(input.render(60).join("\n").includes("public endpoint"));
	input.setMask(true);
	assert.ok(!input.render(60).join("\n").includes("public endpoint"));
	input.setMask(false);
	assert.ok(input.render(60).join("\n").includes("public endpoint"));
});
