/** Presentation for ordinary local background job inspection. */
import { Text } from "@earendil-works/pi-tui";
import type { ToolRenderers } from "../../extensions/types.ts";
import { getTextOutput } from "../render-utils.ts";

export const backgroundJobRenderers: ToolRenderers = {
	renderCall(args, theme, context) {
		const input = args as { action?: string; job_id?: string };
		const title = theme.fg("toolTitle", theme.bold("background_job"));
		const job = input.job_id ? ` ${theme.fg("muted", input.job_id)}` : "";
		const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
		text.setText(`${title} ${input.action ?? "status"}${job}`);
		return text;
	},
	renderResult(result, options, theme, context) {
		const output = getTextOutput(result, context.showImages).trim();
		const lines = output.split("\n");
		const shown = options.expanded ? lines : lines.slice(0, 24);
		const suffix = shown.length < lines.length ? `\n... (${lines.length - shown.length} more lines)` : "";
		const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
		text.setText(`${shown.map((line) => theme.fg("toolOutput", line)).join("\n")}${theme.fg("muted", suffix)}`);
		return text;
	},
};
