/**
 * Benchmark the compiled AssistantMessageComponent during a streaming answer.
 * Requires npm ci, npm run hydrate:model-data, npm run build:offline.
 * Compare the same script, Node version and hardware at v1.5.0 and this PR head.
 */
import { performance } from "node:perf_hooks";
import { AssistantMessageComponent } from "../packages/coding-agent/dist/modes/interactive/components/assistant-message.js";
import { initTheme } from "../packages/coding-agent/dist/modes/interactive/theme/theme.js";

const flag = process.argv.indexOf("--updates");
const updates = flag === -1 ? 50 : Number(process.argv[flag + 1]);
if (!Number.isSafeInteger(updates) || updates < 1 || updates > 1000) {
	throw new RangeError("Expected --updates INTEGER between 1 and 1000");
}
initTheme("dark");
const source = "## Stable context\n\n" + "Long unchanged section with **Markdown** styling.\n\n".repeat(80);
const data = (index) => ({
	role: "assistant",
	content: [{ type: "text", text: source }, { type: "text", text: "Streaming output " + "x".repeat(index * 24) }],
	api: "openai-responses",
	provider: "openai",
	model: "benchmark",
	stopReason: "stop",
	usage: {
		input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	},
	timestamp: 0,
});
const samples = [];
let renderedLines = 0;
for (let run = 0; run < 15; run++) {
	const component = new AssistantMessageComponent();
	const before = performance.now();
	for (let i = 0; i < updates; i++) {
		component.updateContent(data(i), true);
		renderedLines += component.render(100).length;
	}
	component.updateContent(data(updates), false);
	renderedLines += component.render(100).length;
	const elapsedMs = performance.now() - before;
	if (run >= 3) samples.push(elapsedMs);
}
samples.sort((a, b) => a - b);
const nearestRank = (fraction) => samples[Math.max(0, Math.ceil(samples.length * fraction) - 1)];
console.log(JSON.stringify({
	schemaVersion: 1,
	benchmark: "streamed-markdown-with-stable-block",
	updates,
	samples: samples.length,
	medianMs: nearestRank(0.5),
	p95Ms: nearestRank(0.95),
	renderedLines,
	node: process.version,
	platform: process.platform,
	arch: process.arch,
}));
