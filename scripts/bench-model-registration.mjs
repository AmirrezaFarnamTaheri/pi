/**
 * Benchmark batched versus single-provider registration against compiled ModelRuntime.
 * First run npm ci --ignore-scripts && npm run hydrate:model-data && npm run build:offline.
 * Run separate processes for --mode batch and --mode sequential.
 */
import { performance } from "node:perf_hooks";
import { ModelRuntime } from "../packages/coding-agent/dist/core/model-runtime.js";
import { AuthStorage } from "../packages/coding-agent/dist/core/auth-storage.js";

let mode = "sequential";
let count = 100;
for (let i = 0; i < process.argv.length; i++) {
	if (process.argv[i] === "--mode") mode = process.argv[++i];
	if (process.argv[i] === "--providers") count = Number(process.argv[++i]);
}
if (!["sequential", "batch"].includes(mode)) throw new RangeError("Invalid --mode");
if (!Number.isSafeInteger(count) || count < 1 || count > 1000) throw new RangeError("--providers must be 1–1000");

const config = (i) => ({
	providerId: `benchmark-${i}`,
	config: {
		name: `Benchmark ${i}`,
		api: "openai-completions",
		baseUrl: "https://example.invalid/v1",
		apiKey: "fake-benchmark-key",
		models: [{
			id: `model-${i}`, name: `Model ${i}`, input: ["text"],
			reasoning: false, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 10_000, maxTokens: 1000,
		}],
	},
});
const entries = Array.from({ length: count }, (_, i) => config(i));
const times = [];
for (let sample = 0; sample < 15; sample++) {
	const runtime = await ModelRuntime.create({
		credentials: AuthStorage.inMemory(), modelsPath: null,
		allowModelNetwork: false, refreshOnCreate: false,
	});
	const before = performance.now();
	if (mode === "batch") runtime.registerProviderBatch(entries);
	else for (const { providerId, config } of entries) runtime.registerProvider(providerId, config);
	const elapsedMs = performance.now() - before;
	if (!runtime.getModel(`benchmark-${count - 1}`, `model-${count - 1}`)) throw new Error("Missing last provider");
	if (sample >= 3) times.push(elapsedMs);
}
times.sort((a, b) => a - b);
const percentile = (fraction) => times[Math.max(0, Math.ceil(times.length * fraction) - 1)];
console.log(JSON.stringify({
	schemaVersion: 1, benchmark: "model-provider-registration", mode,
	providers: count, samples: times.length, medianMs: percentile(0.5), p95Ms: percentile(0.95),
	node: process.version, platform: process.platform, arch: process.arch,
}));
