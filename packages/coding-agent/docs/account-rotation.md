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

Each `sourceProvider` plus a distinct `provider` alias registers an independent OAuth identity with its own credential-store entry. Pi\u0027s existing `/login` interface can sign in to each alias independently. Refresh uses the source provider\u0027s native OAuth code and Pi\u0027s existing credential-store locking. The original provider account remains unchanged.

Start `pi`, then run `/login` and select each named account. Repeat for all aliases. The CLI `pi auth login` may not load extension-provided aliases, so use interactive `/login` unless your installation loads extensions for CLI auth commands. Restart Pi after changing the configuration.

You can also mix separately authenticated OAuth accounts with API-key aliases. An API-key member looks like `{ "provider": "anthropic-key-2", "sourceProvider": "anthropic", "model": "claude-sonnet-4-5", "apiKeyEnv": "ANTHROPIC_API_KEY_2" }`. Export that environment variable before launching Pi. Configuration contains only environment variable names, never secret values. Use only authorized accounts consistent with provider terms and quotas.

In this repository checkout `.pi/extensions/account-rotation.ts` loads automatically. In a standalone installation, supply an extension loader pointing at the implementation. Select the virtual model with:

```sh
pi --model account-rotation/claude
```

The slash commands `/account-rotation status` and `/account-rotation reset` show alias status and clear in-memory cooldowns without revealing keys.

## Antigravity and independent account login

The [Antigravity Manager](providers.md#antigravity-manager-gateway) endpoint is a built-in `antigravity-manager` **gateway-key** provider. Its Google account connections and any internal account rotation remain in the separate manager. For direct Google sign-in, the optional MIT-licensed [realagy](https://github.com/st0nie/realagy) integration uses Google's official `agy acp` client and registers `antigravity/*` models after the Antigravity CLI is signed in.

The official ACP provider does not expose per-account OAuth tokens to Pi. The `sourceProvider` field in this rotation extension is for providers that supply native Pi OAuth login methods (e.g. Anthropic and Codex), **not** for cloning `realagy`'s CLI session or bypassing Google's quota enforcement. Use separate realagy/CLI profiles for separate sign-ins under the extension's own configuration; this rotation extension does not currently manage them.

## Routing and failure behavior

- A new user turn selects the next available credential slot in round-robin order.
- Tool follow-ups retain the account that produced the prior successful response, preserving continuity and prompt caching.
- On Pi's **automatic retry**, a pre-output retryable 429 or transient 5xx failure quarantines the slot and tries another. Automatic retry must be enabled in Pi settings.
- Pi's built-in retry classifier deliberately excludes authentication failures (401) and exhausted quota/billing errors, so these errors **do not cause automatic failover**. If another caller explicitly retries such an attempt, the rotation policy also understands invalid-key and exhausted-quota failures and quarantines those credentials.
- Credentials are never switched automatically after a response has produced text, reasoning, or tool calls, or for context-limit and policy errors.
- If all accounts are cooling down, the request fails instead of silently reusing a blocked key. A 401 authentication failure gets at least one hour of quarantine; other failures use `cooldownMs`.
- Direct requests (e.g. compaction) use an available credential without advancing the turn-robin index.
- All cooldowns and round-robin cursors are process-local; multiple Pi processes do not share health state. Provider-specific `Retry-After` headers are not currently consumed.

## Tests

```sh
cd packages/coding-agent
node ../../node_modules/vitest/dist/cli.js --run test/account-rotation-policy.test.ts test/account-rotation-extension.test.ts
cd ../..
npm run check
./test.sh
```

The virtual model requires its source physical model ID to exist. All provider aliases must be distinct from built-in provider IDs. Each pool member must represent a unique credential; multiple models under one provider are not separate accounts.
