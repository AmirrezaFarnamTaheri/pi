# Batched extension provider registration

SDK callers may register many extension provider configs in a single synchronous
operation using `ModelRuntime.registerProviderBatch()` or
`ModelRegistry.registerProviderBatch()`.

```ts
registry.registerProviderBatch([
  { providerId: "provider-a", config: { /* extension config */ } },
  { providerId: "provider-b", config: { /* extension config */ } },
]);
```

The API validates all provided configurations **before applying any of them**,
merges repeated registrations in input order, recomposes the affected providers,
then publishes one complete model snapshot and schedules one background refresh.
If validation fails, the batch leaves registered providers unchanged. Existing
single-provider registration and its immediate snapshot semantics are unchanged.

The batch is intentionally explicit: it publishes a single final snapshot, so
code that needs to inspect intermediate registration states should continue
using `registerProvider()`. This does not automatically accelerate existing
extension startup paths until they opt into batching.

## Measured comparison

Compile the fork, then run the same fixture on both modes separately:

```bash
npm ci --ignore-scripts
npm run hydrate:model-data
npm run build:offline
node scripts/bench-model-registration.mjs --providers 100 --mode sequential
node scripts/bench-model-registration.mjs --providers 100 --mode batch
```

Record median/p95 synchronous registration time across 12 measured runs after
three warmups and compare on identical hardware and Node versions. Also check
cold-start time and refresh counts in real extension loadouts. The synthetic
fixture does not emulate external OAuth or network-backed provider startup.

**No production speedup is claimed until the compiled benchmark and full
coding-agent test suite pass.** The model-runtime tests compare final models,
availability, validation rollback and one queued refresh.
