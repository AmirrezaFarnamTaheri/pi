import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionToolContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import {
	AgyBridge,
	type AgyBridgeOptions,
	type AgyProcessRequest,
	type AgyProcessResult,
} from "../examples/extensions/antigravity/core.ts";
import { createAntigravityExtension } from "../examples/extensions/antigravity/index.ts";

const ok = (stdout: string): AgyProcessResult => ({ stdout, stderr: "", exitCode: 0 });
const available = "Gemini 3 Flash\nGemini 3 Pro\n";

describe("Antigravity cooldown persistence (no credentials)", () => {
	it("retains only model quota windows between separate bridge instances", async () => {
		const directory = await mkdtemp(join(tmpdir(), "pi-agy-cooldown-test-"));
		try {
			const cooldownFile = join(directory, "cooldowns.json");
			const options = {
				preferredModels: ["Gemini 3 Flash", "Gemini 3 Pro"],
				now: () => 1_000_000,
				cooldownFile,
			} as AgyBridgeOptions & { cooldownFile: string };
			const first = new AgyBridge(options, {
				exec: async (req) => {
					if (req.args[0] === "models") return ok(available);
					if (req.args.includes("Gemini 3 Flash")) {
						return { stdout: "", stderr: "RESOURCE_EXHAUSTED (code 429) Resets in 5m secret-credential", exitCode: 1 };
					}
					return ok("successful analysis");
				},
			});
			const response = await first.delegate({ prompt: "PRIVATE PROMPT", cwd: process.cwd() });
			expect(response.model).toBe("Gemini 3 Pro");
			const saved = await readFile(cooldownFile, "utf8");
			expect(saved).toContain("Gemini 3 Flash");
			expect(saved).not.toMatch(/PRIVATE PROMPT|secret-credential|RESOURCE_EXHAUSTED/);
			const secondAttempts: string[] = [];
			const second = new AgyBridge(options, {
				exec: async (req: AgyProcessRequest) => {
					if (req.args[0] === "models") return ok(available);
					secondAttempts.push(req.args[req.args.indexOf("--model") + 1] ?? "(default)");
					return ok("new session");
				},
			});
			expect((await second.delegate({ prompt: "another", cwd: process.cwd() })).model).toBe("Gemini 3 Pro");
			expect(secondAttempts).toEqual(["Gemini 3 Pro"]);
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});

	it("ignores invalid, expired and far-future cooldown records", async () => {
		const directory = await mkdtemp(join(tmpdir(), "pi-agy-cooldown-test-"));
		try {
			const cooldownFile = join(directory, "cooldowns.json");
			await writeFile(
				cooldownFile,
				JSON.stringify({
					version: 1,
					entries: {
						"Gemini 3 Flash": Number.MAX_SAFE_INTEGER,
						"Gemini 3 Pro": -1,
						other: "invalid",
					},
				}),
			);
			const attempts: string[] = [];
			const bridge = new AgyBridge(
				{
					preferredModels: ["Gemini 3 Flash", "Gemini 3 Pro"],
					now: () => 1_000_000,
					cooldownFile,
				} as AgyBridgeOptions & { cooldownFile: string },
				{
					exec: async (req) => {
						if (req.args[0] === "models") return ok(available);
						attempts.push(req.args[req.args.indexOf("--model") + 1] ?? "(default)");
						return ok("healthy");
					},
				},
			);
			expect((await bridge.delegate({ prompt: "task", cwd: process.cwd() })).model).toBe("Gemini 3 Flash");
			expect(attempts).toEqual(["Gemini 3 Flash"]);
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});
});

describe("Antigravity file analysis workspace boundary", () => {
	it("rejects symlinked files resolving outside the trusted workspace", async () => {
		const directory = await mkdtemp(join(tmpdir(), "pi-agy-file-safety-"));
		try {
			const workspace = join(directory, "project");
			await mkdir(workspace);
			const secret = join(directory, "outside-secret.txt");
			await writeFile(secret, "private data");
			await symlink(secret, join(workspace, "apparently-local.txt"));
			const seen: AgyProcessRequest[] = [];
			const tools = new Map<string, ToolDefinition>();
			const bridge = new AgyBridge({ preferredModels: ["Gemini 3 Flash"] }, {
				exec: async (req) => {
					seen.push(req);
					if (req.args[0] === "models") return ok(available);
					return ok("should never run");
				},
			});
			createAntigravityExtension(bridge)({
				registerTool: (tool: ToolDefinition) => tools.set(tool.name, tool),
				registerCommand: () => undefined,
			} as unknown as ExtensionAPI);
			const ctx = { cwd: workspace } as ExtensionToolContext;
			await expect(
				tools
					.get("agy_analyze_files")!
					.execute(
						"call",
						{ files: ["apparently-local.txt"], question: "inspect it" },
						undefined,
						undefined,
						ctx,
					),
			).rejects.toThrow(/outside the current workspace/i);
			expect(seen).toHaveLength(0);
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});

	it("accepts a real file but refuses a nonexistent path before launching agy", async () => {
		const directory = await mkdtemp(join(tmpdir(), "pi-agy-file-safety-"));
		try {
			await writeFile(join(directory, "real-file.ts"), "export const ok = true;\n");
			const seen: AgyProcessRequest[] = [];
			const tools = new Map<string, ToolDefinition>();
			const bridge = new AgyBridge({ preferredModels: ["Gemini 3 Flash"] }, {
				exec: async (req) => {
					seen.push(req);
					if (req.args[0] === "models") return ok(available);
					return ok("analysis complete");
				},
			});
			createAntigravityExtension(bridge)({
				registerTool: (tool: ToolDefinition) => tools.set(tool.name, tool),
				registerCommand: () => undefined,
			} as unknown as ExtensionAPI);
			const ctx = { cwd: directory } as ExtensionToolContext;
			await expect(
				tools
					.get("agy_analyze_files")!
					.execute("missing", { files: ["absent.txt"], question: "inspect" }, undefined, undefined, ctx),
			).rejects.toThrow(/does not exist|cannot be read/i);
			expect(seen).toHaveLength(0);
			const valid = await tools
				.get("agy_analyze_files")!
				.execute("valid", { files: ["real-file.ts"], question: "inspect" }, undefined, undefined, ctx);
			expect(valid.content[0]).toMatchObject({ type: "text", text: expect.stringContaining("analysis complete") });
			expect(seen.some((req) => req.args.includes("real-file.ts"))).toBe(true);
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});
});
