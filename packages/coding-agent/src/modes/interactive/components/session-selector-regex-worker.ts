import { Worker } from "node:worker_threads";
import type { SessionInfo } from "../../../core/session-manager.ts";
import type { SortMode } from "./session-selector-search.ts";

// Evaluated in a disposable Node worker: a pathological pattern can hang this
// worker, but never the terminal input/rendering thread. No external file path
// is required, including when the coding-agent is bundled into one executable.
const REGEX_WORKER_CODE = String.raw`
"use strict";
const { parentPort } = require("node:worker_threads");
const { createReadStream } = require("node:fs");

// JavaScript regex has unbounded lookaround, anchors, and backtracking.
// Arbitrary patterns cannot be matched correctly with rolling windows.
// Assemble one transcript up to a hard cap in a disposable worker; report
// oversized or unreadable histories instead of returning false positives.
const MAX_LINE_CHARS = 512 * 1024;
const MAX_TEXT_CHARS = 16 * 1024 * 1024;

async function matchHistoryFile(path, regex, maxTextChars) {
  const chunks = [];
  let length = 0;
  let line = "";
  const addText = (text) => {
    const extra = text.length + (chunks.length ? 1 : 0);
    if (length + extra > maxTextChars) throw new Error("session text exceeds regex memory cap");
    if (chunks.length) length += 1;
    chunks.push(text);
    length += text.length;
  };
  const processLine = (raw) => {
    let entry;
    try { entry = JSON.parse(raw); } catch { return; }
    if (entry?.type !== "message") return;
    const message = entry.message;
    if (!message || (message.role !== "user" && message.role !== "assistant")) return;
    const content = message.content;
    const text = typeof content === "string" ? content
      : Array.isArray(content)
        ? content.filter((part) => part?.type === "text").map((part) => part.text).join(" ")
        : "";
    if (text) addText(text);
  };
  for await (const chunk of createReadStream(path, { encoding: "utf8", highWaterMark: 64 * 1024 })) {
    let from = 0;
    for (;;) {
      const at = chunk.indexOf("\n", from);
      const fragment = at < 0 ? chunk.slice(from) : chunk.slice(from, at);
      if (line.length + fragment.length > MAX_LINE_CHARS)
        throw new Error("session history line too large for regex search");
      line += fragment;
      if (at < 0) break;
      processLine(line);
      line = "";
      from = at + 1;
    }
  }
  if (line) processLine(line);
  return regex.test(chunks.join(" "));
}

parentPort.on("message", async ({ pattern, sessions, maxTextChars }) => {
  try {
    const regex = new RegExp(pattern, "i");
    const scores = [];
    const incomplete = [];
    for (const { name, id, text, path, cwd } of sessions) {
      if (name && regex.test(name)) { scores.push(0); continue; }
      if (regex.test(id) || regex.test(cwd)) { scores.push(1); continue; }
      if (text !== undefined && text.length > Math.min(MAX_TEXT_CHARS, maxTextChars ?? MAX_TEXT_CHARS)) {
        incomplete.push(id);
        scores.push(-1);
        continue;
      }
      try {
        scores.push(text === undefined
          ? (await matchHistoryFile(path, regex, Math.min(MAX_TEXT_CHARS, maxTextChars ?? MAX_TEXT_CHARS)) ? 1 : -1)
          : (regex.test(text) ? 1 : -1));
      } catch {
        incomplete.push(id);
        scores.push(-1);
      }
    }
    parentPort.postMessage({ scores, incomplete });
  } catch (error) {
    parentPort.postMessage({ error: error instanceof Error ? error.message : String(error) });
  }
});
`;

const SEARCH_BUDGET_MS = 500;
const BATCH_SIZE = 16;
const MAX_PATTERN_LENGTH = 2048;
const INLINE_TEXT_LIMIT = 64 * 1024;
const MAX_REGEX_TEXT_CHARS = 16 * 1024 * 1024;
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
	options?: { maxSessionTextChars?: number },
): Promise<SessionInfo[]> {
	if (!pattern || pattern.length > MAX_PATTERN_LENGTH) throw new Error("Invalid regex search length");
	if (signal?.aborted) throw new Error("Regex search cancelled");
	if (
		options?.maxSessionTextChars !== undefined &&
		(!Number.isSafeInteger(options.maxSessionTextChars) ||
			options.maxSessionTextChars <= 0 ||
			options.maxSessionTextChars > MAX_REGEX_TEXT_CHARS)
	) {
		throw new Error("Invalid regex session text cap");
	}

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
						maxTextChars: options?.maxSessionTextChars ?? MAX_REGEX_TEXT_CHARS,
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
			matched.sort(
				(left, right) =>
					left.score - right.score || right.session.modified.getTime() - left.session.modified.getTime(),
			);
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
