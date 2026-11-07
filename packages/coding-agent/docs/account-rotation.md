# Multi-account login and API-key rotation

The opt-in `account-rotation` virtual model rotates between separate, authorized API-key aliases and authenticated account aliases without modifying Pi's core providers.

## Setup

Create `~/.pi/agent/account-rotation.json` (or the equivalent folder reported by Pi's agent directory configuration):

```json
{
  "pools": [
    {
      "id": "claude",
      "name": "Claude OAuth accounts",
      "cooldownMs": 60000,
      "strategy": "hybrid",
      "members": [
        {
          "provider": "anthropic-login-work",
          "sourceProvider": "anthropic",
          "model": "claude-sonnet-4-5"
        },
        {
          "provider": "anthropic-login-personal",
          "sourceProvider": "anthropic",
          "model": "claude-sonnet-4-5"
        }
      ]
    },
    {
      "id": "codex",
      "name": "Codex OAuth accounts",
      "members": [
        {
          "provider": "codex-login-work",
          "sourceProvider": "openai-codex",
          "model": "gpt-5.3-codex"
        },
        {
          "provider": "codex-login-personal",
          "sourceProvider": "openai-codex",
          "model": "gpt-5.3-codex"
        }
      ]
    }
  ]
}
```

Each `sourceProvider` plus a distinct `provider` alias registers an independent OAuth identity with its own credential-store entry. Pi's existing `/login` interface can sign in to each alias independently. Refresh uses the source provider's native OAuth code and Pi's existing credential-store locking. The original provider account remains unchanged.

Start `pi`, then run `/login` and select each named account. Repeat for all aliases. The CLI `pi auth login` may not load extension-provided aliases, so use interactive `/login` unless your installation loads extensions for CLI auth commands. Restart Pi after changing the configuration.

You can also mix separately authenticated OAuth accounts with API-key aliases. An API-key member looks like `{ "provider": "anthropic-key-2", "sourceProvider": "anthropic", "model": "claude-sonnet-4-5", "apiKeyEnv": "ANTHROPIC_API_KEY_2" }`. Export that environment variable before launching Pi. Configuration contains only environment variable names, never secret values. Use only authorized accounts consistent with provider terms and quotas.

In this repository checkout `.pi/extensions/account-rotation.ts` loads automatically. In a standalone installation, supply an extension loader pointing at the implementation. Select the virtual model with:

```sh
pi --model account-rotation/claude
```

The `strategy` option is optional. Choose `round-robin` (default), `sticky` (retain the healthy identity between turns), `random` (uniform eligible-account selection), or `hybrid` (prefer healthy accounts with more remaining quota; round-robin breaks ties). These policies are shared across Anthropic, Codex, Google OAuth extension aliases, and API-key identities.

The `/account-rotation` command supports:

- `/account-rotation status` — account aliases, current strategy, health, quota percentage, cooldown, disabled/pinned state (never secrets)
- `/account-rotation reset [pool]` — clear health, cooldown, quota observations and manual account overrides
- `/account-rotation disable <pool> <alias>` / `enable <pool> <alias>` — exclude or re-enable an identity for new turns
- `/account-rotation pin <pool> <alias>` / `unpin <pool>` — explicitly choose an identity without changing in-flight tool continuations
- `/account-rotation quota <pool> <alias> <fraction> [reset-epoch-ms]` — submit a trusted observed quota fraction (0–1), with an optional reset time in Unix milliseconds

Commands that manage accounts become available after the pool has been selected once. Observed quota state is intentionally process-local and never includes bearer tokens. Do not feed model-generated text as a trusted quota observation.

## Antigravity and independent account login

The [Antigravity Manager](providers.md#antigravity-manager-gateway) endpoint is a built-in `antigravity-manager` **gateway-key** provider. Its Google account connections and any internal account rotation remain in the separate manager. For direct Google sign-in, the optional MIT-licensed [realagy](https://github.com/st0nie/realagy) integration uses Google's official `agy acp` client and registers `antigravity/*` models after the Antigravity CLI is signed in.

The official ACP provider does not expose per-account OAuth tokens to Pi. The `sourceProvider` field in this rotation extension is for providers that supply native Pi OAuth login methods (e.g. Anthropic and Codex), **not** for cloning `realagy`'s CLI session or bypassing Google's quota enforcement. A separate Antigravity CLI installation or data directory may carry a different Google sign-in, but the generic rotation extension does not currently launch or coordinate multiple ACP sessions.

## Compatibility with three Antigravity integrations

The rotation pool can route among ordinary Pi providers regardless of which extension registered them. Provider adapters are **not interchangeable OAuth token stores**:

- **[realagy](https://github.com/st0nie/realagy)** — Google's official `agy acp` CLI transport, local Google sign-in, live model discovery, Pi tool bridge, native session management, quota checks, and cancellation. It registers `antigravity/*`. Pi does **not** own its Google refresh tokens; treat an `antigravity/<model>` as one CLI-managed slot in a mixed pool. Use `/realagy setup` and `/realagy usage` for its own health and usage.
- **[pi-antigravity-auth](https://github.com/windowsrefundday/pi-antigravity-auth)** — browser OAuth, internal multi-account rotation, quota-style fallback, and tool/thinking streaming. The extension itself owns its account pool and registers `antigravity/*`; Pi's outer pool should treat it as **one logical provider**, not try to read or duplicate its refresh-token files.
- **[CortexKit](https://github.com/cortexkit/antigravity-auth)** — local Pi OAuth, refresh, model variants, external credential-vault modes, and the health-aware selection pattern adopted here. Its Pi plugin uses `google/*`. A `google` extension provider with Pi-native OAuth can be used as `sourceProvider` to create separately stored account aliases; this is tested with a simulated extension-registered OAuth provider. Vault-managed or placeholder credentials must continue to be handled by the external vault, not copied into local account aliases.

Do not install two integrations that both register the same `antigravity` provider ID: choose **realagy** for the official CLI or **pi-antigravity-auth** for its own browser-login flow. The built-in `antigravity-manager` gateway provider has a distinct ID and may coexist. The native Google OAuth alias integration is conditional on the external provider exposing Pi's `auth.oauth` contract; extensions that intentionally bind a login to a single provider slot or vault cannot be cloned safely.

A mixed pool can contain existing physical providers (e.g. a working `antigravity` extension model alongside a `antigravity-manager` model) or independently logged-in OAuth aliases. Every member must select an actual model ID available in the current Pi model registry.

## Routing and failure behavior

- New user turns select an eligible identity using the pool's strategy: round-robin, sticky, random, or health/quota-aware hybrid.
- Tool follow-ups retain the account that produced the prior successful response, preserving continuity and prompt caching.
- On Pi's **automatic retry**, a pre-output retryable 429 or transient 5xx failure quarantines the slot and tries another. Automatic retry must be enabled in Pi settings.
- Pi's built-in retry classifier deliberately excludes authentication failures (401) and exhausted quota/billing errors, so these errors **do not cause automatic failover**. If another caller explicitly retries such an attempt, the rotation policy also understands invalid-key and exhausted-quota failures and quarantines those credentials.
- Credentials are never switched automatically after a response has produced text, reasoning, or tool calls, or for context-limit and policy errors.
- If all accounts are unavailable, requests fail instead of reusing an exhausted identity. Authentication failures get at least one hour of quarantine; subsequent failures get exponential cooldowns (capped at 24 hours). Explicit reset durations in trusted provider errors are honored when safely parseable.
- Direct requests (e.g. compaction) use an available credential without advancing the turn-robin index.
- Cooldown/health observations, quota fractions, account pins, and selection cursors are process-local; concurrent Pi processes do not share them. Model error strings with explicit `Retry-After` or quota-reset hints can guide cooldowns, but response headers are not yet forwarded to the router.

## Tests

```sh
cd packages/coding-agent
node ../../node_modules/vitest/dist/cli.js --run test/account-rotation-policy.test.ts test/account-rotation-extension.test.ts
cd ../..
npm run check
./test.sh
```

The virtual model requires its source physical model ID to exist. All provider aliases must be distinct from built-in provider IDs. Each pool member must represent a unique credential; multiple models under one provider are not separate accounts.
