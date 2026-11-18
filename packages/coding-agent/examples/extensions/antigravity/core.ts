/**
 * Opt-in Antigravity CLI delegation primitives for Pi.
 *
 * Architectural ideas: agy-bridge (model discovery, session continuation, bounded
 * subprocesses), paseo-agy-acp (admission), dsh-agy (quota windows), and
 * antigravity-acp (separation from CLI-owned authentication).
 *
 * No OAuth tokens, device identities, fingerprints or undocumented Google API
 * requests are created or read here. Authentication stays in the installed agy CLI.
 */

import { spawn } from "node:child_process";
import { mkdtemp, open, readFile, rm, stat } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { AgyCooldownStore, MAX_AGY_COOLDOWN_MS } from "./state.ts";

export interface AgyModel {
	id?: string;
	name: string;
}

export interface AgyProcessRequest {
	binary: string;
	args: string[];
	cwd: string;
	timeoutMs: number;
	signal?: AbortSignal;
	maxCaptureBytes?: number;
}

export interface AgyProcessResult {
	stdout: string;
	stderr: string;
	exitCode: number | null;
	spawnError?: string;
	timedOut?: boolean;
	aborted?: boolean;
	outputOverflow?: boolean;
}

export interface AgyBridgeOptions {
	binary?: string;
	sandbox?: boolean;
	preferredModels?: string[];
	timeoutMs?: number;
	outputLimit?: number;
	now?: () => number;
	maxConcurrent?: number;
	maxQueued?: number;
	/** Optional local file containing only model names and bounded quota-reset times. */
	cooldownFile?: string;
}

export interface AgyBridgeDeps {
	exec?: (request: AgyProcessRequest) => Promise<AgyProcessResult>;
	readSessionId?: (cwd: string) => Promise<string | undefined>;
}

export interface AgyDelegationRequest {
	prompt: string;
	cwd: string;
	model?: string;
	conversationId?: string;
	signal?: AbortSignal;
}

export interface AgyDelegationResult {
	text: string;
	model?: string;
	sessionId?: string;
	truncated: boolean;
	attempts: string[];
}

const DEFAULT_TIMEOUT_MS = 180_000;
const DEFAULT_OUTPUT_LIMIT = 16_000;
const DEFAULT_COOLDOWN_MS = 15 * 60_000;
const MAX_QUOTA_WINDOW_MS = MAX_AGY_COOLDOWN_MS;
const DEFAULT_PREFERRED_MODELS = ["Gemini * Flash (High)", "Gemini * Pro (Low)"];

export function parseAgyModels(output: string): AgyModel[] {
	const lines = output
		.split(/\r?\n/)
		.map((line) => line.trim().replace(/\s+\(current\)$/, ""))
		.filter((line) => line.length > 0 && !/^fetching available models/i.test(line));
	const tabbed = lines.some((line) => line.includes("\t"));
	const entries: AgyModel[] = [];
	for (const line of lines) {
		if (tabbed && !line.includes("\t")) continue;
		const tab = line.indexOf("\t");
		if (tab < 0) {
			entries.push({ name: line });
		} else {
			const id = line.slice(0, tab).trim();
			const name = line.slice(tab + 1).trim();
			if (id && name) entries.push({ id, name });
		}
	}
	return entries;
}

function compareVersions(a: number[], b: number[]): number {
	for (let index = 0; index < Math.max(a.length, b.length); index++) {
		const difference = (a[index] ?? 0) - (b[index] ?? 0);
		if (difference !== 0) return difference;
	}
	return 0;
}

function chooseModel(pattern: string, names: string[]): string | undefined {
	if (!pattern.includes("*")) return names.find((name) => name === pattern);
	if (pattern.indexOf("*") !== pattern.lastIndexOf("*")) return undefined;
	const [before, after = ""] = pattern.split("*");
	const escapePattern = (part: string) => part.replace(/[.*+?^$()|[\]\\]/g, "\\$&");
	const matcher = new RegExp("^" + escapePattern(before) + "(\\d+(?:\\.\\d+)*)" + escapePattern(after) + "$");
	let best: { name: string; version: number[] } | undefined;
	for (const name of names) {
		const found = matcher.exec(name);
		if (!found) continue;
		const version = found[1].split(".").map(Number);
		if (!best || compareVersions(version, best.version) > 0) best = { name, version };
	}
	return best?.name;
}

/** Normalize CLI model IDs to display names; exact explicit selections never silently fall back. */
export function resolveAgyModelChain(entries: AgyModel[], preferences: string[], explicit?: string): string[] {
	const available = entries.map((entry) => entry.name);
	const normalize = (name: string) => entries.find((entry) => entry.id === name)?.name ?? name;
	const selected = explicit ? [explicit] : preferences;
	const found = selected
		.map((pattern) => chooseModel(normalize(pattern), available))
		.filter((name): name is string => !!name);
	return [...new Set(found)];
}

export type AgyFailureKind = "quota" | "auth" | "overloaded" | "other";

export function classifyAgyFailure(message: string): AgyFailureKind {
	if (/\bRESOURCE_EXHAUSTED\b|\b(?:HTTP\s*)?429\b|\binsufficient_quota\b/i.test(message)) return "quota";
	if (/\b(?:HTTP\s*)?401\b|\bUNAUTHENTICATED\b|(?:invalid|revoked|expired)\s+(?:access\s+)?token/i.test(message)) {
		return "auth";
	}
	if (/\b(?:HTTP\s*)?(?:502|503|504)\b|\bOVERLOADED\b|\bUNAVAILABLE\b/i.test(message)) {
		return "overloaded";
	}
	return "other";
}

/** Accept only bounded positive durations; malformed or enormous reset hints are ignored. */
export function parseQuotaResetMs(message: string): number | undefined {
	const match = /resets?\s+in\s+((?:\d+d)?(?:\d+h)?(?:\d+m)?(?:\d+s)?)/i.exec(message);
	const value = match?.[1];
	if (!value) return undefined;
	const parts = /^(?:(\d+)d)?(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/.exec(value);
	if (!parts || !parts.slice(1).some(Boolean)) return undefined;
	const ms =
		((Number(parts[1] ?? 0) * 24 + Number(parts[2] ?? 0)) * 3600 +
			Number(parts[3] ?? 0) * 60 +
			Number(parts[4] ?? 0)) *
		1000;
	return Number.isSafeInteger(ms) && ms > 0 && ms <= MAX_QUOTA_WINDOW_MS ? ms : undefined;
}

export function truncateAgyOutput(output: string, maxChars: number): { text: string; truncated: boolean } {
	const cap = Math.max(1, Math.floor(maxChars));
	const chars = Array.from(output);
	if (chars.length <= cap) return { text: output, truncated: false };
	return {
		text:
			chars.slice(0, cap).join("") +
			"\n\n[Antigravity output truncated; request a narrower result or raise AGY_OUTPUT_LIMIT.]",
		truncated: true,
	};
}

/** One FIFO admission gate per bridge. A queued cancellation never starts a CLI process. */
export class AgyAdmissionQueue {
	private active = 0;
	private readonly pending: Array<{
		resolve: () => void;
		reject: (error: Error) => void;
		signal?: AbortSignal;
		onAbort: () => void;
	}> = [];

	private readonly maxConcurrent: number;
	private readonly maxQueued: number;

	constructor(maxConcurrent = 1, maxQueued = 8) {
		if (
			!Number.isSafeInteger(maxConcurrent) ||
			maxConcurrent < 1 ||
			!Number.isSafeInteger(maxQueued) ||
			maxQueued < 0
		) {
			throw new Error("Invalid Antigravity admission limits");
		}
		this.maxConcurrent = maxConcurrent;
		this.maxQueued = maxQueued;
	}

	private acquire(signal?: AbortSignal): Promise<void> {
		if (signal?.aborted) return Promise.reject(new Error("Antigravity delegation cancelled"));
		if (this.active < this.maxConcurrent && this.pending.length === 0) {
			this.active++;
			return Promise.resolve();
		}
		if (this.pending.length >= this.maxQueued)
			return Promise.reject(new Error("Antigravity admission queue is full"));
		return new Promise((resolve, reject) => {
			const waiter: (typeof this.pending)[number] = {
				resolve,
				reject,
				signal,
				onAbort: () => {
					const index = this.pending.indexOf(waiter);
					if (index !== -1) this.pending.splice(index, 1);
					signal?.removeEventListener("abort", waiter.onAbort);
					reject(new Error("Antigravity delegation cancelled while queued"));
				},
			};
			this.pending.push(waiter);
			signal?.addEventListener("abort", waiter.onAbort, { once: true });
		});
	}

	private release(): void {
		this.active--;
		while (this.pending.length > 0) {
			const next = this.pending.shift();
			if (!next) break;
			next.signal?.removeEventListener("abort", next.onAbort);
			if (next.signal?.aborted) {
				next.reject(new Error("Antigravity delegation cancelled while queued"));
				continue;
			}
			this.active++;
			next.resolve();
			break;
		}
	}

	async run<T>(work: () => Promise<T>, signal?: AbortSignal): Promise<T> {
		await this.acquire(signal);
		try {
			if (signal?.aborted) throw new Error("Antigravity delegation cancelled");
			return await work();
		} finally {
			this.release();
		}
	}
}

export function runAgyProcess(request: AgyProcessRequest): Promise<AgyProcessResult> {
	return new Promise((resolvePromise) => {
		if (request.signal?.aborted) {
			resolvePromise({ stdout: "", stderr: "", exitCode: null, aborted: true });
			return;
		}
		const captureLimit = Math.max(256, request.maxCaptureBytes ?? 1024 * 1024);
		const stdout: Buffer[] = [];
		const stderr: Buffer[] = [];
		let outBytes = 0;
		let errBytes = 0;
		let settled = false;
		let exited = false;
		let timedOut = false;
		let aborted = false;
		let outputOverflow = false;
		let spawnError: string | undefined;
		let timeout: ReturnType<typeof setTimeout> | undefined;
		let fallback: ReturnType<typeof setTimeout> | undefined;
		let killEscalation: ReturnType<typeof setTimeout> | undefined;
		let child: ReturnType<typeof spawn>;
		try {
			child = spawn(request.binary, request.args, {
				cwd: request.cwd,
				shell: false,
				windowsHide: true,
				detached: process.platform !== "win32",
				stdio: ["pipe", "pipe", "pipe"],
			});
		} catch (error) {
			resolvePromise({
				stdout: "",
				stderr: "",
				exitCode: null,
				spawnError: error instanceof Error ? error.name : "spawn",
			});
			return;
		}
		const result = (exitCode: number | null): AgyProcessResult => ({
			stdout: Buffer.concat(stdout).toString("utf8"),
			stderr: Buffer.concat(stderr).toString("utf8"),
			exitCode,
			...(spawnError ? { spawnError } : {}),
			...(timedOut ? { timedOut } : {}),
			...(aborted ? { aborted } : {}),
			...(outputOverflow ? { outputOverflow } : {}),
		});
		const finish = (exitCode: number | null) => {
			if (settled) return;
			settled = true;
			if (timeout) clearTimeout(timeout);
			if (fallback) clearTimeout(fallback);
			request.signal?.removeEventListener("abort", onAbort);
			resolvePromise(result(exitCode));
		};
		const kill = (signal: NodeJS.Signals) => {
			if (exited || !child.pid) return;
			if (process.platform !== "win32") {
				try {
					process.kill(-child.pid, signal);
					return;
				} catch {
					// The process group may already be gone; attempt the child next.
				}
			}
			try {
				child.kill(signal);
			} catch {
				// Process is already gone.
			}
		};
		const stop = () => {
			kill("SIGTERM");
			if (!killEscalation) {
				killEscalation = setTimeout(() => kill("SIGKILL"), 1500);
				killEscalation.unref?.();
			}
			if (!fallback) {
				fallback = setTimeout(() => finish(null), 3500);
				fallback.unref?.();
			}
		};
		const onAbort = () => {
			aborted = true;
			stop();
		};
		if (request.signal) request.signal.addEventListener("abort", onAbort, { once: true });
		const capture = (data: Buffer | string, destination: Buffer[], current: "out" | "err") => {
			const bytes = Buffer.isBuffer(data) ? data : Buffer.from(data);
			const used = current === "out" ? outBytes : errBytes;
			const cap = current === "out" ? captureLimit : Math.min(captureLimit, 32 * 1024);
			const n = Math.min(Math.max(0, cap - used), bytes.length);
			if (n > 0) destination.push(bytes.subarray(0, n));
			if (current === "out") outBytes += n;
			else errBytes += n;
			if (n < bytes.length) {
				outputOverflow = true;
				stop();
			}
		};
		child.stdout?.on("data", (chunk: Buffer) => capture(chunk, stdout, "out"));
		child.stderr?.on("data", (chunk: Buffer) => capture(chunk, stderr, "err"));
		child.on("error", (error: NodeJS.ErrnoException) => {
			spawnError = error.code ?? "spawn";
			finish(null);
		});
		child.on("exit", () => {
			exited = true;
			// Descendants may inherit stdout and never close the pipes.
			if (!fallback) {
				fallback = setTimeout(() => finish(null), 2000);
				fallback.unref?.();
			}
		});
		child.on("close", (code) => {
			exited = true;
			finish(code);
		});
		try {
			// agy print mode expects EOF; leaving this pipe open can hang forever.
			child.stdin?.end();
		} catch {
			// Any launch failure will be reported by the child error/close event.
		}
		const ms = Math.max(1, request.timeoutMs);
		timeout = setTimeout(() => {
			timedOut = true;
			stop();
		}, ms);
		timeout.unref?.();
	});
}

export async function readAgySessionId(cwd: string): Promise<string | undefined> {
	const filename = join(homedir(), ".gemini", "antigravity-cli", "cache", "last_conversations.json");
	try {
		if ((await stat(filename)).size > 1024 * 1024) return undefined;
		const parsed: unknown = JSON.parse(await readFile(filename, "utf8"));
		if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
		const value = (parsed as Record<string, unknown>)[resolve(cwd)];
		return typeof value === "string" && value.length > 0 && value.length <= 256 ? value : undefined;
	} catch {
		return undefined;
	}
}

interface AgyLogQuota {
	detected: boolean;
	resetMs?: number;
}

/** Read only the tail of an isolated CLI log, without exposing log text or credentials to Pi. */
async function readAgyLogQuota(filename: string): Promise<AgyLogQuota> {
	try {
		const handle = await open(filename, "r");
		try {
			const metadata = await handle.stat();
			const length = Math.min(metadata.size, 256 * 1024);
			if (length === 0) return { detected: false };
			const buffer = Buffer.alloc(length);
			const { bytesRead } = await handle.read(buffer, 0, length, metadata.size - length);
			const tail = buffer.toString("utf8", 0, bytesRead);
			if (!/RESOURCE_EXHAUSTED\s*\(code\s*429\)/i.test(tail)) return { detected: false };
			return { detected: true, resetMs: parseQuotaResetMs(tail) };
		} finally {
			await handle.close();
		}
	} catch {
		return { detected: false };
	}
}

export class AgyBridge {
	private readonly exec: (request: AgyProcessRequest) => Promise<AgyProcessResult>;
	private readonly readSessionId: (cwd: string) => Promise<string | undefined>;
	private readonly queue: AgyAdmissionQueue;
	private readonly cooldowns = new Map<string, number>();
	private readonly cooldownStore?: AgyCooldownStore;
	private cooldownLoad?: Promise<void>;
	private modelCache?: Promise<AgyModel[] | null>;
	private readonly now: () => number;

	private readonly options: AgyBridgeOptions;

	constructor(options: AgyBridgeOptions = {}, dependencies: AgyBridgeDeps = {}) {
		this.options = options;
		this.exec = dependencies.exec ?? runAgyProcess;
		this.readSessionId = dependencies.readSessionId ?? readAgySessionId;
		this.queue = new AgyAdmissionQueue(options.maxConcurrent ?? 1, options.maxQueued ?? 8);
		this.now = options.now ?? Date.now;
		if (options.cooldownFile) this.cooldownStore = new AgyCooldownStore(options.cooldownFile, this.now);
	}

	private async loadCooldowns(): Promise<void> {
		if (!this.cooldownStore) return;
		this.cooldownLoad ??= (async () => {
			const stored = await this.cooldownStore!.load();
			for (const [model, until] of stored) {
				this.cooldowns.set(model, Math.max(this.cooldowns.get(model) ?? 0, until));
			}
		})();
		await this.cooldownLoad;
	}

	private async recordCooldown(model: string | undefined, delayMs: number): Promise<void> {
		const key = model ?? "(default)";
		const until = this.now() + delayMs;
		this.cooldowns.set(key, Math.max(this.cooldowns.get(key) ?? 0, until));
		if (this.cooldownStore) await this.cooldownStore.save(this.cooldowns).catch(() => undefined);
	}

	private get binary(): string {
		return this.options.binary ?? process.env.AGY_BIN ?? "agy";
	}

	async listModels(): Promise<AgyModel[] | null> {
		this.modelCache ??= this.exec({
			binary: this.binary,
			args: ["models"],
			cwd: process.cwd(),
			timeoutMs: 10_000,
		})
			.then((result) => {
				if (result.exitCode !== 0 || result.timedOut || result.outputOverflow) return null;
				return parseAgyModels(result.stdout);
			})
			.catch(() => null);
		const models = await this.modelCache;
		if (models === null) this.modelCache = undefined;
		return models;
	}

	async delegate(request: AgyDelegationRequest): Promise<AgyDelegationResult> {
		if (!request.prompt.trim() || request.prompt.length > 65_536)
			throw new Error("Antigravity prompt must be 1 to 65536 characters");
		if (!request.cwd.trim()) throw new Error("Antigravity cwd must be specified");
		if (request.model && (request.model.length > 200 || request.model.startsWith("-"))) {
			throw new Error("Invalid Antigravity model selection");
		}
		if (request.conversationId && (request.conversationId.length > 256 || request.conversationId.startsWith("-"))) {
			throw new Error("Invalid Antigravity conversation ID");
		}
		return this.queue.run(() => this.delegateAdmitted(request), request.signal);
	}

	private async executeWithQuotaLog(
		request: AgyDelegationRequest,
		args: string[],
		timeoutMs: number,
	): Promise<{ result: AgyProcessResult; quota: AgyLogQuota }> {
		const directory = await mkdtemp(join(tmpdir(), "pi-agy-log-"));
		const logPath = join(directory, "invocation.log");
		const controller = new AbortController();
		const onAbort = () => controller.abort();
		if (request.signal?.aborted) controller.abort();
		else request.signal?.addEventListener("abort", onAbort, { once: true });
		let quota: AgyLogQuota = { detected: false };
		let scanning: Promise<void> | undefined;
		const scan = (): Promise<void> => {
			if (scanning) return scanning;
			scanning = (async () => {
				const observed = await readAgyLogQuota(logPath);
				if (observed.detected) {
					quota = observed;
					controller.abort();
				}
			})().finally(() => {
				scanning = undefined;
			});
			return scanning;
		};
		const poll = setInterval(() => {
			if (!quota.detected) void scan();
		}, 250);
		poll.unref?.();
		try {
			const result = await this.exec({
				binary: this.binary,
				args: ["--log-file", logPath, ...args],
				cwd: resolve(request.cwd),
				timeoutMs,
				signal: controller.signal,
			});
			// The CLI sometimes exits 0 with no stdout after quota exhaustion.
			// Check once more even if a short-lived invocation escaped the poller.
			if (scanning) await scanning;
			if (!quota.detected) await scan();
			return { result, quota };
		} finally {
			clearInterval(poll);
			request.signal?.removeEventListener("abort", onAbort);
			if (scanning) await scanning;
			await rm(directory, { recursive: true, force: true });
		}
	}

	private async delegateAdmitted(request: AgyDelegationRequest): Promise<AgyDelegationResult> {
		await this.loadCooldowns();
		const catalog = await this.listModels();
		const explicit = request.model;
		let models: (string | undefined)[];
		if (explicit) {
			models = catalog ? resolveAgyModelChain(catalog, [], explicit) : [explicit];
			if (models.length === 0) throw new Error("Antigravity model is not available. Inspect /agy models.");
		} else if (request.conversationId) {
			// Existing agy sessions retain their own model; never silently switch it.
			models = [undefined];
		} else {
			models = catalog
				? resolveAgyModelChain(catalog, this.options.preferredModels ?? DEFAULT_PREFERRED_MODELS)
				: [];
			if (models.length === 0) models = [undefined];
		}
		const ready = models.filter((model) => (this.cooldowns.get(model ?? "(default)") ?? 0) <= this.now());
		if (ready.length === 0) throw new Error("Requested Antigravity models are cooling down after a quota limit");
		const attempts: string[] = [];
		for (const model of ready) {
			if (request.signal?.aborted) throw new Error("Antigravity delegation cancelled");
			attempts.push(model ?? "(default)");
			const timeoutMs = this.options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
			const args = ["--add-dir", resolve(request.cwd)];
			if (this.options.sandbox !== false) args.push("--sandbox");
			if (request.conversationId) args.push("--conversation", request.conversationId);
			if (model) args.push("--model", model);
			args.push("--print-timeout", String(Math.max(1, Math.ceil(timeoutMs / 1000))) + "s", "-p", request.prompt);
			const { result, quota } = await this.executeWithQuotaLog(request, args, timeoutMs);
			if (request.signal?.aborted) throw new Error("Antigravity delegation cancelled");
			if (result.outputOverflow) throw new Error("Antigravity CLI exceeded its output capture limit; no replay");
			if (result.spawnError)
				throw new Error("Antigravity CLI could not start (" + result.spawnError + "); install agy or set AGY_BIN");
			const output = result.stdout.trim();
			if (quota.detected) {
				if (output) throw new Error("Antigravity emitted partial output before quota exhaustion; no replay");
				await this.recordCooldown(model, quota.resetMs ?? DEFAULT_COOLDOWN_MS);
				if (!explicit && !request.conversationId) continue;
				throw new Error("Antigravity model quota exhausted; respect the provider reset window");
			}
			if (result.aborted) throw new Error("Antigravity delegation cancelled");
			if (result.timedOut) throw new Error("Antigravity CLI timed out; no automatic replay");
			if (result.exitCode === 0 && output) {
				const limited = truncateAgyOutput(output, this.options.outputLimit ?? DEFAULT_OUTPUT_LIMIT);
				const sessionId = request.conversationId ?? (await this.readSessionId(resolve(request.cwd)));
				return { ...limited, sessionId, model, attempts };
			}
			// Never replay a prompt after a partially visible response: side effects
			// or tokens may already have been emitted by the previous execution.
			if (output) throw new Error("Antigravity emitted partial output before failing; no automatic replay");
			const failure = classifyAgyFailure(result.stderr);
			if (failure === "quota") {
				const cooldown = parseQuotaResetMs(result.stderr) ?? DEFAULT_COOLDOWN_MS;
				await this.recordCooldown(model, cooldown);
				if (!explicit && !request.conversationId) continue;
				throw new Error("Antigravity model quota exhausted; respect the provider reset window");
			}
			if (failure === "overloaded" && !explicit) continue;
			if (failure === "auth") throw new Error("Antigravity CLI authentication failed; sign in through agy itself");
			throw new Error("Antigravity CLI failed or returned empty output; no automatic replay");
		}
		throw new Error("No eligible Antigravity models completed the request; models may be rate-limited");
	}
}
