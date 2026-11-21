#!/usr/bin/env node
import { setupCli } from "./cli/setup.ts";
import { BACKGROUND_SUPERVISOR_FLAG } from "./core/tools/background-shell.ts";
import { runBackgroundShellSupervisor } from "./core/tools/background-supervisor.ts";
import { main } from "./main.ts";

if (process.argv[2] === BACKGROUND_SUPERVISOR_FLAG) {
	// Used only by the standalone binary's detached shell worker.
	// Keep normal Pi agent startup out of this long-lived process.
	try {
		runBackgroundShellSupervisor(process.argv[3]!);
	} catch (error: unknown) {
		console.error(error);
		process.exitCode = 1;
	}
} else {
	setupCli();
	main(process.argv.slice(2));
}
