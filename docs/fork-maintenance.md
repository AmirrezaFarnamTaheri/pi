# Maintaining the Pi fork

This repository is a fork of [earendil-works/pi](https://github.com/earendil-works/pi). Fork releases are independent of the upstream npm namespace, package preview server, staff bots and cloud publishing infrastructure.

## Workflows that remain

- \`ci.yml\`: builds, type checks, linting and tests on main and pull requests.
- \`fork-github-release.yml\`: builds six binary archives, a source tarball and SHA256SUMS. Runs smoke tests on Linux, Windows and macOS, then publishes a GitHub prerelease on this fork only.
- \`sync-upstream.yml\`: weekly/manual proposal for merging upstream main into the fork via a pull request, never an automatic merge.
- `envelope-compat.yml`: runs the Envelope source regression suite against this fork's built Pi CLI and verifies actual RPC extension registration.
- \`npm-audit.yml\`: dependency checks on demand and daily.
- \`env.yml\` and \`env-daemons.yml\`: cross-platform execution-environment tests.
- \`bench-runtime.yml\` (once included): manual/scheduled benchmark results saved as an artifact.

Upstream-only npm publication, model-catalog upload, R2/cloud UI publication, Nix pin automation and staff/issue bots were deliberately removed. Run \`npm run check:fork-workflows\` to prevent them from being reintroduced accidentally.

## Updating from upstream

The weekly sync workflow fetches upstream main, merges into a dedicated \`sync/upstream-main\` branch and opens or updates a PR. Review differences and CI results before merging. If either merge encounters a conflict, the job fails and lists conflicted files in its Actions summary; no remote branch or fork main overwrite occurs. Resolve those conflicts manually on a new integration branch, preserving fork-specific fixes.

When upstream changes conflict, leave the integration proposal as a draft until fork-specific behavior and the complete CI matrix are reviewed. Do not force-push or auto-merge across divergent histories.

GitHub repository Actions permissions must permit pull-request creation for the scheduled workflow. No upstream write access or upstream credentials are required.

## Building and releasing

Merge a tested PR into \`main\`, choose a new version that matches the coding-agent package, and push \`release/fork-v<version>\` at the tested commit. The workflow builds from that commit, checks platform binaries and publishes only to this fork's GitHub Releases. Never reuse an existing tag; use the next version.

Windows standalone users should unpack \`pi-windows-x64.zip\` or \`pi-windows-arm64.zip\` under a directory in their user \`PATH\`. This fork's release updater is not the upstream \`pi.dev\` installer or upstream npm package.

## Benchmarks

Run \`npm run bench:runtime\` after a normal build. Benchmarks exercise production session APIs with deterministic fixture sessions and report median and p95 wall-time plus CPU, RSS and heap measurements. CI benchmark artifacts are diagnostic: compare like runner environments and do not treat one synthetic timing as a fixed production SLA.
