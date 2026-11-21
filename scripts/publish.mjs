#!/usr/bin/env node
// The upstream npm namespace does not belong to this independent fork.
// This direct entry point must also fail closed (not just npm run publish).
console.error("Upstream npm publishing is disabled for this fork. Use the reviewed GitHub release workflow.");
process.exitCode = 1;
