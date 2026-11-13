/**
 * Bash command execution with streaming support and cancellation.
 *
 * This module provides a unified bash execution implementation used by:
 * - AgentSession.executeBash() for interactive and RPC modes
 * - Direct calls from modes that need bash execution
 */

import type { WriteStream } from "node:fs";
import { finished } from "node:stream/promises";
import { splitIncompleteAnsiSuffix, stripAnsi } from "../utils/ansi.ts";
import { createOutputFileStream } from "../utils/output-files.ts";
import { sanitizeBinaryOutput } from "../utils/shell.ts";
import type { BashOperations } from "./tools/bash.ts";
import type { BackgroundedProcess } from "./tools/manual-background.ts";
import { DEFAULT_MAX_BYTES, truncateTail } from "./tools/truncate.ts";

// ============================================================================
// Types
// ============================================================================

export interface BashExecutorOptions {
	/** Callback for streaming output chunks (already sanitized) */
	onChunk?: (chunk: string) => void;
	/** AbortSignal for cancellation */
	signal?: AbortSignal;
}

export interface BashResult {
	/** Combined stdout + stderr output (sanitized, possibly truncated) */
	output: string;
	/** Process exit code (undefined if killed/cancelled) */
	exitCode: number | undefined;
	/** Whether the command was cancelled via signal */
	cancelled: boolean;
	/** Whether the output was truncated */
	truncated: boolean;
	/** Path to temp file containing full output (if output exceeded truncation threshold) */
	fullOutputPath?: string;
	/** PID and log for a running process that Ctrl+B detached without restarting it. */
	background?: BackgroundedProcess;
}

// ============================================================================
// Implementation
// ============================================================================

/**
 * Execute a bash command using custom BashOperations.
 * Used for remote execution (SSH, containers, etc.).
 */
export async function executeBashWithOperations(
	command: string,
	cwd: string,
	operations: BashOperations,
	options?: BashExecutorOptions,
): Promise<BashResult> {
	const outputChunks: string[] = [];
	let outputBytes = 0;
	let discardedOutput = false;
	const maxOutputBytes = DEFAULT_MAX_BYTES * 2;

	let tempFilePath: string | undefined;
	let tempFileStream: WriteStream | undefined;
	let tempFileFailed = false;
	let totalBytes = 0;

	const disableTempFile = () => {
		const stream = tempFileStream;
		tempFileFailed = true;
		tempFilePath = undefined;
		tempFileStream = undefined;
		// Synchronous write failures may not auto-destroy the stream. Release
		// its file descriptor before returning a truncated in-memory result.
		if (stream && !stream.destroyed) stream.destroy();
	};

	const writeTempFile = (chunk: string) => {
		const stream = tempFileStream;
		if (!stream || tempFileFailed) return;
		try {
			stream.write(chunk);
		} catch {
			// A failed spool must not take down a successful command.
			disableTempFile();
		}
	};

	const ensureTempFile = () => {
		if (tempFilePath || tempFileFailed) return;
		try {
			const { path, stream } = createOutputFileStream("pi-bash", ".log");
			tempFilePath = path;
			tempFileStream = stream;
			// Node write streams report open and write failures asynchronously.
			// Register before writing, even for a failed initial open.
			stream.on("error", disableTempFile);
			for (const chunk of outputChunks) writeTempFile(chunk);
		} catch {
			disableTempFile();
		}
	};

	const finishTempFile = async () => {
		const stream = tempFileStream;
		if (!stream) return;
		try {
			if (!stream.destroyed) stream.end();
			// Do not expose a path until every write has actually finished.
			await finished(stream);
		} catch {
			disableTempFile();
		}
	};

	const decoder = new TextDecoder();
	// Unfinished escape sequence at the end of the previous chunk, completed by the next chunk.
	let pendingAnsi = "";

	const appendText = (rawText: string) => {
		// Sanitize: strip ANSI, replace binary garbage, normalize newlines
		const text = sanitizeBinaryOutput(stripAnsi(rawText)).replace(/\r/g, "");
		if (!text) {
			return;
		}

		// Start writing to temp file if exceeds threshold
		if (totalBytes > DEFAULT_MAX_BYTES) {
			ensureTempFile();
		}

		writeTempFile(text);

		// Keep rolling buffer
		outputChunks.push(text);
		outputBytes += text.length;
		while (outputBytes > maxOutputBytes && outputChunks.length > 1) {
			const removed = outputChunks.shift()!;
			outputBytes -= removed.length;
			discardedOutput = true;
		}

		// Stream to callback
		if (options?.onChunk) {
			options.onChunk(text);
		}
	};

	const onData = (data: Buffer) => {
		totalBytes += data.length;
		const { complete, pending } = splitIncompleteAnsiSuffix(pendingAnsi + decoder.decode(data, { stream: true }));
		pendingAnsi = pending;
		appendText(complete);
	};

	const flushOutput = () => {
		const rest = pendingAnsi + decoder.decode();
		pendingAnsi = "";
		appendText(rest);
	};

	let exitCode: number | null = null;
	let background: BackgroundedProcess | undefined;
	try {
		({ exitCode, background } = await operations.exec(command, cwd, { onData, signal: options?.signal }));
	} catch (err) {
		// An aborted command still returns the output it produced so far
		if (!options?.signal?.aborted) {
			await finishTempFile();
			throw err;
		}
	}

	flushOutput();
	const fullOutput = outputChunks.join("");
	const truncationResult = truncateTail(fullOutput);
	if (truncationResult.truncated) {
		ensureTempFile();
	}
	await finishTempFile();
	const cancelled = options?.signal?.aborted ?? false;
	if (background) {
		return {
			output: `Command detached with Ctrl+B; still running as PID ${background.pid}. Output log: ${background.outputPath}`,
			exitCode: undefined,
			cancelled: false,
			truncated: false,
			// The background log may be capped while the command is still running.
			// It is not a complete foreground-output archive.
			background,
		};
	}

	return {
		output: truncationResult.truncated ? truncationResult.content : fullOutput,
		exitCode: cancelled ? undefined : (exitCode ?? undefined),
		cancelled,
		truncated: discardedOutput || truncationResult.truncated,
		fullOutputPath: tempFilePath,
	};
}
