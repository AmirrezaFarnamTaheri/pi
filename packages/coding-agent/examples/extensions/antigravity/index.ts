/**
 * Opt-in Antigravity delegation for Pi.
 *
 * The Google-owned agy CLI performs authentication and inference. This adapter
 * adds Pi-native tasks, bounded output, model discovery, cautious failover,
 * session continuation and admission. No OAuth interception or fingerprinting.
 *
 * Load with: pi --extension packages/coding-agent/examples/extensions/antigravity/index.ts
 */

import { realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import type { ExtensionAPI, ExtensionToolContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { AgyBridge, type AgyDelegationRequest } from "./core.ts";

const optionalModel = Type.Optional(
	Type.String({ description: "Exact name or ID from /agy models. An explicit model disables automatic fallback." }),
);
const outputGuidance =
	"Respond directly; give file:line references for code findings, identify uncertainty, and avoid unnecessary context.";
const commonDescription =
	"Uses an independently installed Antigravity CLI (agy), with its own authentication and service terms. " +
	"Do not include API keys or secrets in prompts. May use the CLI's local tools; request a sandboxed, permission-respecting operation.";

function isWithin(root: string, target: string): boolean {
	const rel = relative(root, target);
	return rel !== ".." && !rel.startsWith(".." + sep) && !isAbsolute(rel);
}

async function withinWorkspace(file: string, cwd: string): Promise<string> {
	const root = resolve(cwd);
	const candidate = resolve(root, file);
	if (!isWithin(root, candidate)) throw new Error("Antigravity file path is outside the current workspace");
	let resolvedRoot: string;
	let resolvedFile: string;
	try {
		resolvedRoot = await realpath(root);
		resolvedFile = await realpath(candidate);
	} catch {
		throw new Error("Antigravity selected file does not exist or cannot be read");
	}
	if (!isWithin(resolvedRoot, resolvedFile)) {
		throw new Error("Antigravity file path is outside the current workspace");
	}
	try {
		if (!(await stat(resolvedFile)).isFile()) throw new Error("Antigravity selected file must be a regular file");
	} catch {
		throw new Error("Antigravity selected file does not exist or cannot be read");
	}
	return resolvedFile;
}

async function formatFiles(files: string[], cwd: string): Promise<string> {
	if (files.length === 0 || files.length > 32) throw new Error("Select 1 to 32 files for Antigravity analysis");
	const canonical = await Promise.all(files.map((file) => withinWorkspace(file, cwd)));
	return canonical.map((file) => "- " + file).join("\n");
}

async function delegate(
	bridge: AgyBridge,
	prompt: string,
	ctx: ExtensionToolContext,
	signal?: AbortSignal,
	model?: string,
	conversationId?: string,
) {
	const request: AgyDelegationRequest = { cwd: ctx.cwd, prompt, signal, model, conversationId };
	const result = await bridge.delegate(request);
	const details = {
		model: result.model,
		sessionId: result.sessionId,
		attempts: result.attempts,
		truncated: result.truncated,
	};
	const continuation = result.sessionId
		? "\n\n[agy session: " + result.sessionId + "; use agy_follow_up to continue without resending context]"
		: "\n\n[agy session ID unavailable; continuation may not be possible]";
	return {
		content: [{ type: "text" as const, text: result.text + continuation }],
		details,
	};
}

export function createAntigravityExtension(
	bridge: AgyBridge = new AgyBridge({
		binary: process.env.AGY_BIN || "agy",
		sandbox: true,
		cooldownFile: process.env.AGY_COOLDOWN_FILE?.trim() || join(homedir(), ".pi", "agent", "agy-model-cooldowns.json"),
		outputLimit:
			Number(process.env.AGY_OUTPUT_LIMIT) > 0 ? Math.min(Number(process.env.AGY_OUTPUT_LIMIT), 64_000) : 16_000,
	}),
) {
	return (pi: ExtensionAPI): void => {
		pi.registerTool({
			name: "agy_analyze_files",
			label: "Antigravity: analyze files",
			description:
				"Delegate analysis of large files to the installed agy CLI and receive only a bounded answer. " +
				commonDescription,
			parameters: Type.Object({
				files: Type.Array(Type.String(), { minItems: 1, maxItems: 32 }),
				question: Type.String({ description: "What to determine from these files" }),
				model: optionalModel,
			}),
			async execute(_id, params, signal, _onUpdate, ctx) {
				const names = await formatFiles(params.files, ctx.cwd);
				return delegate(
					bridge,
					"Read and analyze these files:\n" + names + "\n\nQuestion: " + params.question + "\n\n" + outputGuidance,
					ctx,
					signal,
					params.model,
				);
			},
		});

		pi.registerTool({
			name: "agy_deep_search",
			label: "Antigravity: deep search",
			description:
				"Delegate wide repository search, file history, git archaeology, and cross-file tracing to agy. " +
				commonDescription,
			parameters: Type.Object({
				query: Type.String({ description: "Codebase question or search objective" }),
				model: optionalModel,
			}),
			async execute(_id, params, signal, _onUpdate, ctx) {
				return delegate(
					bridge,
					"Search this repository using the tools available to you; use git history and source references when relevant.\n\nQuestion: " +
						params.query +
						"\n\n" +
						outputGuidance,
					ctx,
					signal,
					params.model,
				);
			},
		});

		pi.registerTool({
			name: "agy_web_lookup",
			label: "Antigravity: web lookup",
			description:
				"Delegate a documentation or web lookup to agy; responses should cite source URLs. " + commonDescription,
			parameters: Type.Object({
				query: Type.String({ description: "Documentation or public-web lookup objective" }),
				model: optionalModel,
			}),
			async execute(_id, params, signal, _onUpdate, ctx) {
				return delegate(
					bridge,
					"Look up the following and cite source URLs for material claims:\n\n" +
						params.query +
						"\n\n" +
						outputGuidance,
					ctx,
					signal,
					params.model,
				);
			},
		});

		pi.registerTool({
			name: "agy_review",
			label: "Antigravity: adversarial review",
			description:
				"Ask agy to review a design, code or selected workspace files for flaws and risks. " + commonDescription,
			parameters: Type.Object({
				content: Type.Optional(Type.String({ description: "Inline code or proposal to review" })),
				files: Type.Optional(Type.Array(Type.String(), { maxItems: 32 })),
				focus: Type.Optional(Type.String({ description: "Review emphasis, e.g. security or concurrency" })),
				model: optionalModel,
			}),
			async execute(_id, params, signal, _onUpdate, ctx) {
				if (!params.content?.trim() && !params.files?.length) {
					throw new Error("Antigravity review needs content or workspace files");
				}
				const files = params.files?.length ? "\nFiles:\n" + (await formatFiles(params.files, ctx.cwd)) : "";
				const prompt =
					"Act as a critical code reviewer. Rank concrete problems by severity; avoid speculation and praise.\n" +
					(params.content ? "\nContent:\n" + params.content : "") +
					files +
					(params.focus ? "\nFocus: " + params.focus : "") +
					"\n\n" +
					outputGuidance;
				return delegate(bridge, prompt, ctx, signal, params.model);
			},
		});

		pi.registerTool({
			name: "agy_delegate",
			label: "Antigravity: delegate",
			description: "Delegate a bounded, independent task to an existing agy installation. " + commonDescription,
			parameters: Type.Object({
				prompt: Type.String({ description: "Complete task description; do not include secrets" }),
				model: optionalModel,
			}),
			async execute(_id, params, signal, _onUpdate, ctx) {
				return delegate(bridge, params.prompt, ctx, signal, params.model);
			},
		});

		pi.registerTool({
			name: "agy_follow_up",
			label: "Antigravity: continue session",
			description:
				"Continue an agy session returned by an earlier delegation without resending its prior context. " +
				commonDescription,
			parameters: Type.Object({
				session_id: Type.String({ description: "CLI session identifier returned by a previous agy tool result" }),
				question: Type.String({ description: "Follow-up question or instruction" }),
			}),
			async execute(_id, params, signal, _onUpdate, ctx) {
				return delegate(bridge, params.question, ctx, signal, undefined, params.session_id);
			},
		});

		pi.registerCommand("agy", {
			description: "Inspect the optional Antigravity CLI bridge (/agy models, /agy help)",
			handler: async (args, ctx) => {
				switch (args.trim().toLowerCase()) {
					case "models": {
						const models = await bridge.listModels();
						ctx.ui.notify(
							models === null
								? "agy models unavailable: install and authenticate the agy CLI."
								: "Antigravity CLI models:\n" +
										(models
											.map((model) => (model.id ? model.id + " — " + model.name : model.name))
											.join("\n") || "(none)"),
						);
						break;
					}
					case "":
					case "help":
					case "status":
						ctx.ui.notify(
							"Optional agy CLI bridge is loaded. Use /agy models to inspect available models. " +
								"Authentication is managed only by the agy CLI. No OAuth tokens or device fingerprints are read by Pi. " +
								"Terms-of-service/account suspension risks may apply to third-party CLI use.",
						);
						break;
					default:
						ctx.ui.notify("Usage: /agy models | /agy help", "warning");
				}
			},
		});
	};
}

export default createAntigravityExtension();
