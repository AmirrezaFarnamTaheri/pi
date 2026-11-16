import assert from "node:assert/strict";
import { test } from "node:test";
import { measureWorkload, parseBenchmarkArgs, percentile } from "./bench-runtime-metrics.mjs";

test("nearest-rank percentiles do not mutate samples", () => {
  const measurements = [10, 2, 4, 8, 6];
  assert.equal(percentile(measurements, 0.5), 6);
  assert.equal(percentile(measurements, 0.95), 10);
  assert.deepEqual(measurements, [10, 2, 4, 8, 6]);
});

test("rejects invalid benchmark sizes and unknown flags", () => {
  assert.throws(() => parseBenchmarkArgs(["--entries", "0"]), /Invalid benchmark/);
  assert.throws(() => parseBenchmarkArgs(["--samples", "NaN"]), /Invalid benchmark/);
  assert.throws(() => parseBenchmarkArgs(["--unknown", "1"]), /Usage/);
  assert.deepEqual(parseBenchmarkArgs(["--entries", "100", "--samples", "4", "--warmups", "0"]), {
    entries: 100, samples: 4, warmups: 0, output: null,
  });
});

test("captures real samples, CPU and memory without fake clocks", async () => {
  let invocations = 0;
  const result = await measureWorkload("test", () => { invocations++; }, { samples: 4, warmups: 2 });
  assert.equal(invocations, 6);
  assert.equal(result.samples, 4);
  assert.equal(result.samplesMs.length, 4);
  assert.ok(result.medianMs >= 0 && result.p95Ms >= result.medianMs);
  assert.ok(result.cpuMs >= 0);
  assert.ok(result.maxObservedRssBytes > 0);
});
