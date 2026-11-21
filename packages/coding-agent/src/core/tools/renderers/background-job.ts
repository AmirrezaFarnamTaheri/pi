/** Display background job actions and their bounded results without loading execution modules. */
import { Text } from "@earendil-works/pi-tui";
import type { ToolRenderers } from "../../extensions/types.ts";

export const backgroundJobRenderers: ToolRenderers = {
	renderCall(args, theme) {
		const action = (args as { action?: string; jobId?: string })?.action ?? "status";
		const jobId = (args as { jobId?: string })?.jobId;
		return new Text(
			theme.fg("toolTitle", theme.bold("background_job")) +
				theme.fg("toolOutput", ` ${action}${jobId ? ` ${jobId}` : ""}`),
			0,
			0,
		);
	},
	renderResult(result, options, theme) {
		const value = result.content.find((entry) => entry.type === "text");
		const message = value?.type === "text" ? value.text : "";
		const limit = options.expanded ? 32_768 : 2_048;
		const shown = message.length > limit ? `${message.slice(0, limit)}\n[More output available]` : message;
		return new Text(theme.fg("toolOutput", shown), 0, 0);
	},
};
