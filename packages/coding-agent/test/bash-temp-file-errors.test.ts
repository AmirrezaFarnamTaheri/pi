import type { WriteStream } from "node:fs";
import { Writable } from "node:stream";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { executeBashWithOperations } from "../src/core/bash-executor.ts";
import { bashExecutionToText } from "../src/core/messages.ts";
import { createOutputFileStream } from "../src/utils/output-files.ts";

vi.mock("../src/utils/output-files.ts", () => ({
	createOutputFileStream: vi.fn(),
}));

const createSpool = vi.mocked(createOutputFileStream);
const commandOutput = `${"x".repeat(128 * 1024)}\nlast useful output\n`;

function execution() {
	return executeBashWithOperations("produce long output", process.cwd(), {
		exec: async (_command, _cwd, { onData }) => {
			onData(Buffer.from(commandOutput));
			return { exitCode: 0 };
		},
	});
}

describe("recovering from temporary Bash output failures", () => {
	beforeEach(() => {
		createSpool.mockReset();
	});

	it("keeps truncated command output when opening the temporary file throws EACCES", async () => {
		createSpool.mockImplementation(() => {
			throw Object.assign(new Error("Access denied"), { code: "EACCES" });
		});
		const result = await execution();
		expect(result.exitCode).toBe(0);
		expect(result.truncated).toBe(true);
		expect(result.output).toContain("last useful output");
		expect(result.fullOutputPath).toBeUndefined();
		expect(bashExecutionToText({ role: "bashExecution", command: "echo", timestamp: 0, ...result })).toContain("Full output unavailable");
		expect(createSpool).toHaveBeenCalledTimes(1);
	});

	it("does not crash or report an invalid path when a stream emits ENOSPC", async () => {
		const stream = new Writable({
			write(_chunk, _encoding, callback) {
				callback(Object.assign(new Error("Disk full"), { code: "ENOSPC" }));
			},
		});
		createSpool.mockReturnValue({
			path: "C:\\temp\\pi-bash-output.log",
			stream: stream as WriteStream,
		});
		const result = await execution();
		expect(result.exitCode).toBe(0);
		expect(result.truncated).toBe(true);
		expect(result.output).toContain("last useful output");
		expect(result.fullOutputPath).toBeUndefined();
		expect(bashExecutionToText({ role: "bashExecution", command: "echo", timestamp: 0, ...result })).toContain("Full output unavailable");
		expect(createSpool).toHaveBeenCalledTimes(1);
	});
});
