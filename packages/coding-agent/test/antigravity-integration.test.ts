import type { ExtensionAPI, ExtensionCommandContext, ExtensionToolContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { AgyBridge, type AgyProcessRequest } from "../examples/extensions/antigravity/core.ts";
import { createAntigravityExtension } from "../examples/extensions/antigravity/index.ts";

function setup() {
	const requests: AgyProcessRequest[] = [];
	const bridge = new AgyBridge({ preferredModels: ["Gemini 3 Flash"], sandbox: true }, {
		exec: async (req) => {
			requests.push(req);
			if (req.args[0] === "models") return { stdout: "Gemini 3 Flash\n", stderr: "", exitCode: 0 };
			return { stdout: "Delegated analysis complete", stderr: "", exitCode: 0 };
		},
		readSessionId: async () => "session-abc",
	});
	const tools = new Map<string, ToolDefinition>();
	const commands = new Map<string, { handler: (args: string, ctx: ExtensionCommandContext) => Promise<void> }>();
	createAntigravityExtension(bridge)({
		registerTool: (tool: ToolDefinition) => tools.set(tool.name, tool),
		registerCommand: (name: string, command: { handler: (args: string, ctx: ExtensionCommandContext) => Promise<void> }) => commands.set(name, command),
	} as unknown as ExtensionAPI);
	const notices: string[] = [];
	const context = {
		cwd: process.cwd(),
		hasUI: true,
		ui: { notify: (text: string) => notices.push(text) },
	} as unknown as ExtensionToolContext;
	return { requests, tools, commands, notices, context };
}

describe("opt-in Antigravity Pi extension", () => {
	it("registers purpose-built tools without registering a fake API model or OAuth provider", () => {
		const { tools, commands } = setup();
		expect([...tools.keys()].sort()).toEqual([
			"agy_analyze_files",
			"agy_deep_search",
			"agy_delegate",
			"agy_follow_up",
			"agy_review",
			"agy_web_lookup",
		]);
		expect(commands.has("agy")).toBe(true);
	});

	it("delegates searches and returns the CLI-owned continuation ID", async () => {
		const { requests, tools, context } = setup();
		const result = await tools.get("agy_deep_search")!.execute("test", { query: "find errors" }, undefined, undefined, context);
		expect(result.content[0]).toMatchObject({ type: "text", text: expect.stringContaining("session-abc") });
		expect(result.details).toMatchObject({ sessionId: "session-abc", model: "Gemini 3 Flash" });
		expect(requests[1]?.args.join(" ")).toContain("find errors");
	});

	it("follows up without repasting previous context or changing the original model", async () => {
		const { requests, tools, context } = setup();
		await tools.get("agy_follow_up")!.execute("test", { session_id: "session-abc", question: "next?" }, undefined, undefined, context);
		const args = requests[1]?.args ?? [];
		expect(args).toContain("--conversation");
		expect(args).toContain("session-abc");
		expect(args).not.toContain("--model");
	});

	it("rejects file paths escaping the current project", async () => {
		const { tools, context, requests } = setup();
		await expect(
			tools.get("agy_analyze_files")!.execute("test", { files: ["../../outside.txt"], question: "read" }, undefined, undefined, context),
		).rejects.toThrow(/outside the current workspace/i);
		expect(requests).toHaveLength(0);
	});

	it("supports CLI model discovery without logging in or reading stored credentials", async () => {
		const { commands, context, notices } = setup();
		await commands.get("agy")!.handler("models", context as unknown as ExtensionCommandContext);
		expect(notices.join("\n")).toContain("Gemini 3 Flash");
	});
});
