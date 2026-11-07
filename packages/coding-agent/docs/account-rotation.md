# Account/API-key rotation

The opt-in `account-rotation` virtual model rotates between separate, authorized API-key aliases and authenticated account aliases without modifying Pi's core providers.

## Setup

Create `~/.pi/agent/account-rotation.json` (or the equivalent folder reported by Pi's agent directory configuration):

```json
{
  "pools": [
    {
      "id": "claude",
      "name": "Claude accounts",
      "cooldownMs": 60000,
      "members": [
        { "provider": "anthropic", "model": "claude-sonnet-4-5" },
        {
          "provider": "anthropic-key-2",
          "sourceProvider": "anthropic",
          "model": "claude-sonnet-4-5",
          "apiKeyEnv": "ANTHROPIC_API_KEY_2"
        },
        { "provider": "anthropic-account-3", "model": "claude-sonnet-4-5" }
      ]
    }
  ]
}
```

Export `ANTHROPIC_API_KEY_2` in the environment used to launch Pi. The config stores **environment-variable names**, never raw secrets. The alias `anthropic-key-2` inherits physical model metadata from `anthropic`; no key value is persisted by the extension. Use only your own authorized credentials, subject to provider terms and quotas.

The third slot is optional. For a separately authenticated OAuth account, first install a multi-account extension (for example [pi-multi-account](https://github.com/Sarrius/pi-multi-account)) and use the provider/account alias it registers. This extension does **not** perform OAuth login or refresh.

In this repository checkout `.pi/extensions/account-rotation.ts` loads automatically. In a standalone installation, supply an extension loader pointing at the implementation. Select the virtual model with:

```sh
pi --model account-rotation/claude
```

The slash commands `/account-rotation status` and `/account-rotation reset` show alias status and clear in-memory cooldowns without revealing keys.

## Routing and failure behavior

- A new user turn selects the next available credential slot in round-robin order.
- Tool follow-ups retain the account that produced the prior successful response, preserving continuity and prompt caching.
- On Pi's **automatic retry**, a pre-output 429, quota-exhaustion, 401/invalid-key, or transient 5xx failure quarantines that slot and tries another. No retry happens automatically unless Pi's retry feature is enabled.
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

The virtual-model integration also depends on the physical model ID existing for every configured slot. Keep alias provider IDs distinct from real provider IDs.
