#!/usr/bin/env node
/**
 * Publishing under upstream-owned @earendil-works/* is intentionally disabled
 * in this fork. No npm registry or upstream credentials should be used here.
 */
console.error("This fork does not publish upstream npm packages. Build and distribute fork-only binaries via the reviewed fork GitHub release workflow; see docs/fork-maintenance.md.");
process.exitCode = 1;
