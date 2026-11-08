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

// Hard memory ceiling per JSONL entry; a huge single JSON string cannot be
// parsed safely without a streaming JSON tokenizer, so reject it explicitly.
const MAX_LINE_CHARS = 512 * 1024;
const MATCH_CHUNK_CHARS = 16 * 1024;
const MATCH_OVERLAP_CHARS = 16 * 1024;

/** Incrementally scan JSONL user/assistant text without joining all messages. */
async function matchHistoryFile(path, regex) {
  let line = "";
  let overlap = "";
  let contentStarted = false;
  // End-anchored patterns must run only at EOF, not at a temporary chunk end.
  const endAnchored = regex.source.endsWith("$") && regex.source.at(-2) !== "\\";
  const append = (text) => {
    if (!text) return false;
    for (let start = 0; start < text.length; start += MATCH_CHUNK_CHARS) {
      const candidate = overlap + text.slice(start, start + MATCH_CHUNK_CHARS);
      if (!endAnchored && regex.test(candidate)) return true;
      overlap = candidate.slice(-MATCH_OVERLAP_CHARS);
    }
    return false;
  };
  const processLine = (json) => {
    let entry;
    try { entry = JSON.parse(json); } catch { return false; }
    if (entry?.type !== "message") return false;
    const message = entry.message;
    if (!message || (message.role !== "user" && message.role !== "assistant")) return false;
    const content = message.content;
    const text = typeof content === "string"
      ? [content]
      : Array.isArray(content)
        ? content.filter((part) => part?.type === "text" && typeof part.text === "string").map((part) => part.text)
        : [];
    for (const part of text) {
      if (!part) continue;
      if (contentStarted && append(" ")) return true;
      contentStarted = true;
      if (append(part)) return true;
    }
    return false;
  };

  for await (const chunk of createReadStream(path, { encoding: "utf8", highWaterMark: 64 * 1024 })) {
    let start = 0;
    while (start < chunk.length) {
      const newline = chunk.indexOf("\n", start);
      const fragment = newline === -1 ? chunk.slice(start) : chunk.slice(start, newline);
      if (line.length + fragment.length > MAX_LINE_CHARS)
        throw new Error("Session history line too large for bounded regex search");
      line += fragment;
      if (newline === -1) break;
      if (processLine(line)) return true;
      line = "";
      start = newline + 1;
    }
  }
  if (line && processLine(line)) return true;
  return endAnchored ? regex.test(overlap) : false;
}

parentPort.on("message", async ({ pattern, sessions }) => {
  try {
    const regex = new RegExp(pattern, "i");
    const scores = [];
    for (const { name, id, text, path, cwd } of sessions) {
      if (name && regex.test(name)) { scores.push(0); continue; }
      if (regex.test(id) || regex.test(cwd)) { scores.push(1); continue; }
      scores.push(text === undefined
        ? (await matchHistoryFile(path, regex) ? 1 : -1)
        : (regex.test(text) ? 1 : -1));
    }
    parentPort.postMessage({ scores });
  } catch (error) {
    parentPort.postMessage({ error: error instanceof Error ? error.message : String(error) });
  }
});
`;

const SEARCH_BUDGET_MS = 500;
const BATCH_SIZE = 16;
const MAX_PATTERN_LENGTH = 2048;
const INLINE_TEXT_LIMIT = 64 * 1024;
type SearchResponse = { scores?: number[]; error?: string };

/**
 * Search full session texts off the UI thread. Serial batches bound the size
 * of each structured-clone transfer. Large JSONL files are scanned incrementally with bounded line buffers inside the
 * worker, and an idle batch deadline terminates non-progressing regex work.
 */
export async function filterSessionsByRegexInWorker(
	sessions: readonly SessionInfo[],
	pattern: string,
	sortMode: SortMode,
	signal?: AbortSignal,
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
	try {
		for (let start = 0; start < sessions.length; start += BATCH_SIZE) {
			if (signal?.aborted) throw new Error("Regex search cancelled");
			const batch = sessions.slice(start, start + BATCH_SIZE);
			const scores = await new Promise<number[]>((resolve, rejectRequest) => {
				const onMessage = ({ scores, error }: SearchResponse) => {
					resetIdleTimeout();
					worker.off("message", onMessage);
					rejectActive = undefined;
					if (error) rejectRequest(new Error(error));
					else if (!scores) rejectRequest(new Error("Regex worker returned no results"));
					else resolve(scores);
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
		return matched.map(({ session }) => session);
	} finally {
		if (timeout !== undefined) clearTimeout(timeout);
		signal?.removeEventListener("abort", onAbort);
		worker.off("error", onError);
		worker.off("exit", onExit);
		await worker.terminate();
	}
}
