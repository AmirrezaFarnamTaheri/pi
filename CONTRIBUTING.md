# Contributing to the independent Pi fork

This repository is a downstream fork of [earendil-works/pi](https://github.com/earendil-works/pi). It distributes fork-specific code and GitHub release artifacts, and does not operate upstream's bots, npm publishing infrastructure, or `pi.dev`.

## Scope and expectations

Keep changes focused, testable, and compatible with upstream's extensible core. Prefer extensions over new core features unless a core change is necessary for correctness or security. Read `AGENTS.md` before making changes. Do not submit generated code without inspecting and understanding its behavior.

## Propose a change

1. Check existing pull requests and discuss substantial or breaking design changes with the maintainer before implementation.
2. Create a topic branch; do not commit directly to `main`.
3. Write a reproduction test for bugs or a failing specification for new behavior.
4. Run `npm ci --ignore-scripts`, `npm run build`, `npm run check`, and `./test.sh`. `npm run check` is read-only; run `npm run format` separately if formatting is required.
5. Include a clear summary, affected packages, compatibility/migration implications, security considerations, and exactly which checks you ran.
6. Open a pull request for human review and wait for required CI results before merging. If CI is unavailable, say so explicitly; do not represent unverified changes as tested.

GitHub Issues may be disabled in this fork. In that case, use pull requests for concrete proposed patches and contact the maintainer through their publicly verified GitHub contact method for other topics.

## Security

Do not publish exploitable vulnerabilities or secrets in ordinary pull requests. Follow [SECURITY.md](SECURITY.md). This fork cannot accept reports on behalf of upstream-operated services.

## Upstream compatibility

Explain whether a change is fork-only or suitable for upstream submission. Keep the upstream comparison reviewable; do not force-push `main`, rewrite upstream history, or merge automated upstream sync proposals without human review and passing checks.

## Releases

Fork release artifacts are distributed through this repository's [GitHub Releases](https://github.com/AmirrezaFarnamTaheri/pi/releases). Contributors must not invoke upstream npm, staff, cloud or web release automation. See [fork maintenance](docs/fork-maintenance.md).
