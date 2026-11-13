import { describe, expect, it } from "vitest";
import { backgroundSupervisorInvocation } from "../src/core/tools/background-shell.ts";

describe("background supervisor in standalone builds", () => {
	it("starts the compiled Pi executable using its hidden worker entrypoint, never with -e", () => {
		const cmd = backgroundSupervisorInvocation(
			"C:\\Apps\\pi\\pi.exe",
			["C:\\Apps\\pi\\pi.exe"],
			[],
			"C:\\Temp\\task-1",
		);
		expect(cmd.executable).toBe("C:\\Apps\\pi\\pi.exe");
		expect(cmd.args).toEqual(["--pi-internal-background-supervisor", "C:\\Temp\\task-1"]);
	});

	it("keeps Node's compatible -e startup for source development", () => {
		const cmd = backgroundSupervisorInvocation(
			"/usr/bin/node",
			["/usr/bin/node", "/repo/dist/cli.js"],
			[],
			"/tmp/task-1",
		);
		expect(cmd.args).toEqual(["-e", expect.any(String), "/tmp/task-1"]);
	});
});
