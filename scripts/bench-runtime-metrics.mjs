import { performance } from "node:perf_hooks";

export function percentile(samples, fraction) {
  if (!Array.isArray(samples) || samples.length === 0 || samples.some((value) => !Number.isFinite(value))) {
    throw new RangeError("Expected a nonempty list of finite measurements");
  }
  if (!Number.isFinite(fraction) || fraction < 0 || fraction > 1) throw new RangeError("Invalid percentile");
  const sorted = [...samples].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil(fraction * sorted.length) - 1)];
}

export function parseBenchmarkArgs(args) {
  const options = { entries: 12000, samples: 12, warmups: 3, output: null };
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index];
    const value = args[index + 1];
    if (!["--entries", "--samples", "--warmups", "--output"].includes(flag) || value === undefined) {
      throw new Error("Usage: bench-runtime [--entries <positive-int>] [--samples <positive-int>] [--warmups <nonnegative-int>] [--output <path>]");
    }
    const key = flag.slice(2);
    if (key === "output") {
      if (!value.trim()) throw new RangeError("Output path cannot be empty");
      options.output = value;
      continue;
    }
    const number = Number(value);
    if (!Number.isSafeInteger(number) || number < (key === "warmups" ? 0 : 1) || number > 250000) {
      throw new RangeError("Invalid benchmark " + key + ": " + value);
    }
    options[key] = number;
  }
  return options;
}

/** Samples genuine functions. No mocked clocks or production algorithms. */
export async function measureWorkload(name, fn, options = {}) {
  const samples = options.samples ?? 12;
  const warmups = options.warmups ?? 3;
  for (let i = 0; i < warmups; i++) await fn();

  const durations = [];
  const heapDeltas = [];
  const cpuBefore = process.cpuUsage();
  let maxObservedRssBytes = process.memoryUsage().rss;
  for (let i = 0; i < samples; i++) {
    const beforeHeap = process.memoryUsage().heapUsed;
    const begin = performance.now();
    await fn();
    durations.push(performance.now() - begin);
    const memory = process.memoryUsage();
    heapDeltas.push(memory.heapUsed - beforeHeap);
    maxObservedRssBytes = Math.max(maxObservedRssBytes, memory.rss);
  }
  const cpu = process.cpuUsage(cpuBefore);
  return {
    name, samples, warmups,
    medianMs: percentile(durations, 0.5),
    p95Ms: percentile(durations, 0.95),
    minMs: Math.min(...durations),
    maxMs: Math.max(...durations),
    cpuMs: (cpu.user + cpu.system) / 1000,
    medianHeapDeltaBytes: percentile(heapDeltas, 0.5),
    maxObservedRssBytes,
    samplesMs: durations,
  };
}
