# Antigravity interoperability for Pi (opt-in)

Pi can delegate an isolated, bounded task to an **already installed** Google Antigravity CLI (\`agy\`). This does not add an Antigravity OAuth provider to Pi's model picker or replace Pi's ordinary Google AI Studio/Vertex authentication. It exposes six extension tools backed by the local CLI.

> **Account safety:** The maintainers of [antigravity-acp](https://github.com/shubzkothekar/antigravity-acp) and [opencode-agy-auth](https://github.com/anthonyhaussman/opencode-agy-auth) warn that using Antigravity accounts from third-party tools can breach Google's terms and lead to account suspension. **Even driving the official CLI from this extension may carry that risk.** Use an approved Gemini API key or Google Cloud Vertex AI integration when you need a supported third-party model API. No source here claims Google's approval.

## Enable the optional extension

Install and authenticate the official \`agy\` CLI using Google's own instructions first. Verify \`agy models\` works in your terminal. The extension never performs login, reads an OAuth token, spoofs a device fingerprint, downloads a binary, or accesses private backend APIs.

From a checkout of this Pi repository:

\`\`\`sh
pi --extension packages/coding-agent/examples/extensions/antigravity/index.ts
\`\`\`

From a \`packages/coding-agent\` working directory:

\`\`\`sh
pi --extension examples/extensions/antigravity/index.ts
\`\`\`

Inside Pi, run \`/agy models\` to inspect the CLI's available model IDs and display names. \`/agy help\` explains which side owns authentication. To make the extension persistent, explicitly copy its \`antigravity/\` directory to your user extension directory or configure the extension path in Pi. The extension is **not enabled by default**.

Optional environment variables: \`AGY_BIN\` specifies a preinstalled CLI binary (default \`agy\` on \`PATH\`); \`AGY_OUTPUT_LIMIT\` caps the model-visible response (default 16,000 characters; maximum 64,000).

## Tools Pi gains

| Tool | Intended work |
| --- | --- |
| \`agy_analyze_files\` | Analyze selected files in the current workspace (external paths are rejected) |
| \`agy_deep_search\` | Broad repository search and git archaeology without bringing all source into Pi's context |
| \`agy_web_lookup\` | Documentation/public web lookup with requested source URLs |
| \`agy_review\` | A second opinion on code, selected files, or a design |
| \`agy_delegate\` | An independent, bounded task |
| \`agy_follow_up\` | Continue a CLI-owned conversation by the session ID returned by a preceding tool |

Responses are capped before reaching Pi's context and include a continuation ID when the CLI cache supplies one. Pi reads only the CLI's **nonsecret conversation-to-directory map** to identify a session; Pi does not maintain a separate Google account database or need access to CLI credentials.

Models come from \`agy models\`, with support for current two-column ID/name listings, legacy name-only listings, version-pattern preferences, and exact user-pinned models. A known quota failure can cool down **the failed model**, then optionally try another already available model when no output has been emitted. Explicit pins and existing conversations do not switch models. **No 429 account swapping or identity rotation.**

## Execution safeguards and limits

- No shell interpolation or \`--dangerously-skip-permissions\`. The CLI is started by executable + argv, with sandbox requested. The CLI itself owns any tool permissions; review its sandbox behavior.
- Stdin is closed on launch (the CLI's print mode can otherwise hang). Timeouts, abort/cancellation, output-capture bounds, and process-group termination prevent runaway calls.
- Delegation has a FIFO, per-Pi-process admission queue to avoid overlapping CLI invocations; this is **not** the cross-process, durable admission controller used by Paseo.
- Errors shown to Pi are generic, not raw credential-bearing stderr. No prompt is automatically replayed following partial stdout, a timeout, an unclassified failure, or a cancellation.
- The CLI currently receives its \`-p\` prompt as an argv value, so operating-system process listings may expose prompt text. Never place tokens, passwords, or secrets in delegated prompts.
- Per-model cooldowns and conversation bindings have local/per-process semantics; no promise of accurate, account-wide 5-hour or weekly quota across independently running Pi processes.

## Alternative: use Pi's existing MCP client

Pi already has a built-in MCP host. To use the original [agy-bridge](https://github.com/sshahzaiib/agy-bridge) tool server instead of Pi's extension, configure it as an **optional local MCP server**, after reviewing its package and permissions:

\`\`\`sh
pi mcp add agy-bridge -- npx -y agy-bridge
pi mcp list
\`\`\`

Prefer a pinned, audited package version for reproducible installations. Review the server's default model access, sandbox settings, CLI identity, and tool exposure under Pi's \`/mcp\` menu. You do **not** need both the Pi extension and the MCP bridge for the same delegation tasks.

ACP is a separate host/client protocol. [antigravity-acp](https://github.com/shubzkothekar/antigravity-acp) provides an ACP server with streaming and history replay; [paseo-agy-acp](https://github.com/tiezbro/paseo-agy-acp) adapts the official ACP kernel to Paseo, with admission scheduling, mode mapping, and skill discovery. They are **reference implementations**, not Pi plugins: simply installing their packages does not make Pi an ACP client. This patch adopts their admission and session-boundary lessons without vendoring an ACP stack.

## Source audit and adoption boundaries

| Source | Reusable mechanisms | Adopted here / deferred |
| --- | --- | --- |
| [chaos-03x/dsh-agy](https://github.com/chaos-03x/dsh-agy) (MIT) | 429/reset handling, model-family quota, credential redaction, account health, CLI/web management | Bounded quota reset classification and no-secret diagnostics. Not copied: private API auth, device fingerprints, account pool, DSH web UI |
| [sshahzaiib/agy-bridge](https://github.com/sshahzaiib/agy-bridge) (MIT) | Purpose-built tasks, CLI spawn discipline, model lookup, fallback, session continuation, truncation | Six Pi tools, binary runner, model resolution, session ID, bounded results. External MCP server also works directly with Pi |
| [tiezbro/paseo-agy-acp](https://github.com/tiezbro/paseo-agy-acp) (Apache-2.0) | Admission, permission mode mapping, ACP kernel adapter, skill discovery | Per-process FIFO admission adopted; ACP and cross-process owner/lease machinery deferred pending a Pi ACP-host design |
| [shubzkothekar/antigravity-acp](https://github.com/shubzkothekar/antigravity-acp) (MIT) | Nonsecret CLI subprocess integration, session mapping, history replay, bounded streaming | CLI owns auth and existing sessions; full SQLite replay and ACP streaming not copied into Pi's different session model |
| [anthonyhaussman/opencode-agy-auth](https://github.com/anthonyhaussman/opencode-agy-auth) (Apache-2.0) | Dynamic catalog, quota/tier reports, cached cooldowns, turn state, API compatibility | Model discovery and cooldown classification. Not copied: undocumented Antigravity API/OAuth interception, OpenCode-specific request shims |

No proprietary Google binary, client secret, device identity, user token, or internal endpoint is redistributed. These are independent Pi-oriented implementations informed by the linked repositories. The remainder of Pi's multi-account authentication/rotation design is handled separately in [PR #38](https://github.com/AmirrezaFarnamTaheri/pi/pull/38), which must be reviewed on its own merits.

## Verification

The focused tests are \`packages/coding-agent/test/antigravity-extension.test.ts\` and \`packages/coding-agent/test/antigravity-integration.test.ts\`. Pi's CI runs its project-wide \`npm run check\` and its Vitest suites. A real end-to-end request requires a local, authenticated CLI and should not be mistaken for a provider-approved integration.
