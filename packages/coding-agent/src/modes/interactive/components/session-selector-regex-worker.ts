import { Worker } from "node:worker_threads";
import type { SessionInfo } from "../../../core/session-manager.ts";
import type { SortMode } from "./session-selector-search.ts";

// Evaluated in a disposable Node worker: a pathological pattern can hang this
// worker, but never the terminal input/rendering thread. No external file path
// is required, including when the coding-agent is bundled into one executable.
const REGEX_WORKER_CODE = "\"use strict\";\nconst { parentPort } = require(\"node:worker_threads\");\nconst { createReadStream } = require(\"node:fs\");\n\n// JavaScript regex has unbounded lookaround, anchors, and backtracking.\n// Arbitrary patterns cannot be matched correctly with rolling windows.\n// Assemble one transcript up to a hard cap in a disposable worker; report\n// oversized or unreadable histories instead of returning false positives.\nconst MAX_LINE_CHARS = 512 * 1024;\nconst MAX_TEXT_CHARS = 16 * 1024 * 1024;\n\nasync function matchHistoryFile(path, regex) {\n  const chunks = [];\n  let length = 0;\n  let line = \"\";\n  const addText = (text) => {\n    const extra = text.length + (chunks.length ? 1 : 0);\n    if (length + extra > MAX_TEXT_CHARS) throw new Error(\"session text exceeds regex memory cap\");\n    if (chunks.length) length += 1;\n    chunks.push(text);\n    length += text.length;\n  };\n  const processLine = (raw) => {\n    let entry;\n    try { entry = JSON.parse(raw); } catch { return; }\n    if (entry?.type !== \"message\") return;\n    const message = entry.message;\n    if (!message || (message.role !== \"user\" && message.role !== \"assistant\")) return;\n    const content = message.content;\n    const text = typeof content === \"string\" ? content\n      : Array.isArray(content)\n        ? content.filter((part) => part?.type === \"text\").map((part) => part.text).join(\" \")\n        : \"\";\n    if (text) addText(text);\n  };\n  for await (const chunk of createReadStream(path, { encoding: \"utf8\", highWaterMark: 64 * 1024 })) {\n    let from = 0;\n    for (;;) {\n      const at = chunk.indexOf(\"\\n\", from);\n      const fragment = at < 0 ? chunk.slice(from) : chunk.slice(from, at);\n      if (line.length + fragment.length > MAX_LINE_CHARS)\n        throw new Error(\"session history line too large for regex search\");\n      line += fragment;\n      if (at < 0) break;\n      processLine(line);\n      line = \"\";\n      from = at + 1;\n    }\n  }\n  if (line) processLine(line);\n  return regex.test(chunks.join(\" \"));\n}\n\nparentPort.on(\"message\", async ({ pattern, sessions }) => {\n  try {\n    const regex = new RegExp(pattern, \"i\");\n    const scores = [];\n    const incomplete = [];\n    for (const { name, id, text, path, cwd } of sessions) {\n      if (name && regex.test(name)) { scores.push(0); continue; }\n      if (regex.test(id) || regex.test(cwd)) { scores.push(1); continue; }\n      try {\n        scores.push(text === undefined\n          ? (await matchHistoryFile(path, regex) ? 1 : -1)\n          : (regex.test(text) ? 1 : -1));\n      } catch {\n        incomplete.push(id);\n        scores.push(-1);\n      }\n    }\n    parentPort.postMessage({ scores, incomplete });\n  } catch (error) {\n    parentPort.postMessage({ error: error instanceof Error ? error.message : String(error) });\n  }\n});\n";

const SEARCH_BUDGET_MS = 500;
const BATCH_SIZE = 16;
const MAX_PATTERN_LENGTH = 2048;
const INLINE_TEXT_LIMIT = 64 * 1024;
type SearchResponse = { scores?: number[]; incomplete?: string[]; error?: string };

/**
 * Search full session texts off the UI thread. Serial batches bound the size
 * of each structured-clone transfer. Arbitrary regex needs a complete string to
 * preserve JavaScript semantics, so the disposable worker reads one session at a time
 * with explicit file/line and total-text memory caps; oversize entries are reported
 * without hiding matches in other sessions.
 */
export async function filterSessionsByRegexInWorker(
	sessions: readonly SessionInfo[],
	pattern: string,
	sortMode: SortMode,
	signal?: AbortSignal,
	onIncomplete?: (sessionIds: string[]) => void,
): Promise<SessionInfo[]> {
	if (!pattern || pattern.length > MAX_PATTERN_LENGTH) throw new Error("Invalid regex search length");
	if (signal?.aborted) throw new Error("Regex search cancelled");
	if (sessions.length === 0) return [];

	const worker = new Worker(REGEX_WORKER_CODE, { eval: true });
	let rejectActive: ((error: Error) => void) | undefined;
	const reject = (error: Error) => {
		rejectActive?.(error);
		rejectActive = undefined;
	};
	const onAbort = () => reject(new Error("Regex search cancelled"));
	const onError = (error: Error) => reject(error);
	const onExit = (code: number) => {
		if (code !== 0) reject(new Error(`Regex worker exited (${code})`));
	};
	worker.on("error", onError);
	worker.on("exit", onExit);
	signal?.addEventListener("abort", onAbort, { once: true });
	let timeout: ReturnType<typeof setTimeout> | undefined;
	const resetIdleTimeout = () => {
		if (timeout !== undefined) clearTimeout(timeout);
		timeout = setTimeout(() => reject(new Error("Regex search timed out")), SEARCH_BUDGET_MS);
	};
	resetIdleTimeout();

	const matched: { session: SessionInfo; score: number }[] = [];
	const incomplete: string[] = [];
	try {
		for (let start = 0; start < sessions.length; start += BATCH_SIZE) {
			if (signal?.aborted) throw new Error("Regex search cancelled");
			const batch = sessions.slice(start, start + BATCH_SIZE);
			const scores = await new Promise<number[]>((resolve, rejectRequest) => {
				const onMessage = ({ scores, error, incomplete: missing }: SearchResponse) => {
					resetIdleTimeout();
					worker.off("message", onMessage);
					rejectActive = undefined;
					if (error) rejectRequest(new Error(error));
					else if (!scores) rejectRequest(new Error("Regex worker returned no results"));
					else {
						if (missing?.length) incomplete.push(...missing);
						resolve(scores);
					}
				};
				rejectActive = (error: Error) => {
					worker.off("message", onMessage);
					rejectRequest(error);
				};
				worker.on("message", onMessage);
				try {
					worker.postMessage({
						pattern,
						sessions: batch.map((session) => ({
							name: session.name,
							id: session.id,
							path: session.path,
							// Small histories are cheap to clone; large ones are read off
							// the terminal thread and never cross postMessage().
							text: session.allMessagesText.length <= INLINE_TEXT_LIMIT ? session.allMessagesText : undefined,
							cwd: session.cwd,
						})),
					});
				} catch (error) {
					worker.off("message", onMessage);
					rejectActive = undefined;
					rejectRequest(error);
				}
			});
			for (let index = 0; index < scores.length; index++) {
				const score = scores[index]!;
				if (score >= 0) matched.push({ session: batch[index]!, score });
			}
		}
		if (sortMode !== "recent") {
			matched.sort((left, right) => left.score - right.score || right.session.modified.getTime() - left.session.modified.getTime());
		}
		if (incomplete.length) onIncomplete?.(incomplete);
		return matched.map(({ session }) => session);
	} finally {
		if (timeout !== undefined) clearTimeout(timeout);
		signal?.removeEventListener("abort", onAbort);
		worker.off("error", onError);
		worker.off("exit", onExit);
		await worker.terminate();
	}
}
