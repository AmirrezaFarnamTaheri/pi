# Accounts and automatic rotation

`/login` is the provider-first account manager, with `/accounts` and bare `/logout` opening the same screen. The top-level menu displays **immutable provider names** (for example, Codex, Antigravity, Anthropic and NVIDIA), not editable account nicknames. Providers with a configured credential, additional account, or preferred built-in identity appear as a category. Choose **Connect another provider** to sign into a different built-in provider, or **Add custom provider** to configure an API-compatible endpoint in `models.json`.

Select a provider to see its **original and additional accounts/API keys** together, with connection status and one rotation-membership checkbox per identity. Press **Space** to include or exclude the highlighted connected identity, **A** to select/deselect all eligible identities, **R** to rename the highlighted account, **X** to delete/disconnect it, **T** to toggle rotation, **M** to choose its algorithm, and **+** to create an additional account. **Enter** opens the highlighted account, setting, or action; **Left Arrow** or **Escape** navigates back. The same page also offers **Delete all accounts**, protected by a confirmation prompt.

The provider header remains fixed. An account's nickname changes only its human-readable label, not its provider brand, credential, model catalog, or stable ID. Distinct NVIDIA identities can share one presentation category while keeping independent authentication slots. Externally managed integrations do not expose their private credential pools to Pi.

## Everyday account actions

Highlight a logged-in account to manage it. Press **R** to rename it directly (the existing name is prefilled), **X** to delete/disconnect it, or **Right Arrow** / **Enter** to open the action list; **Left Arrow** goes back. Removing an account asks once for confirmation. You can also choose an account and then:

- **Choose model:** use a model from that particular account.
- **Sign in:** connect or replace that account's credentials.
- **Rename account:** give the account a memorable nickname, such as "Personal", "Client projects" or "Backup". Names persist across restarts and change **only the account label**—never the provider brand, credentials, model catalog or stable provider ID.
- **Delete account:** remove an additional account and its saved credentials, without touching other accounts. Main provider logins offer **Disconnect account** instead; the provider remains available for a future sign-in.
- **Rotate accounts:** use a group of connected accounts from the same provider. Choosing a rotation group enables it immediately without a second confirmation prompt.

The menu separates **Existing accounts** from **Account actions** with visible borders. Choose **Sign in to existing account** to connect or replace credentials for a selected identity; it does not create another account. Choose **Create separate account** to select the source provider, enter a nickname and create a new identity **without signing in**. The newly created account appears as unsigned-in. Open it and choose **Sign in** whenever ready; cancelling that sign-in does not delete or overwrite the new identity. Use `/login add <provider>` to create the named identity directly, or `/logout` or `/accounts` to return to the manager.

Deleting an account also deletes only its own stored credential. If it is the active or saved-default model and no other usable model exists, deletion is refused until you select or connect a replacement, rather than leaving a broken model selection. Disconnecting an original account clears its stored login but cannot delete the built-in provider or disable environment-backed keys.

A separate account keeps a stable provider ID, such as `account-antigravity-manager-1`, even after you rename it. Friendly names live in `account-profiles.json` without secrets. Saved credentials remain linked to their corresponding IDs. Repeated literal API keys and completely identical OAuth credentials are stored only once in `auth.json`, with separate references per account; each account still has independent settings and sign-in identity. A normal sign-in changes only the selected account, while a shared OAuth refresh updates all copies of the same previous token to avoid reusing a rotated refresh token. Removing an account clears its reference, not another account's login. Older flat `auth.json` files continue to load, and duplication is compacted on the next credential write. Custom tools that parse `auth.json` directly should use the exported credential archive parser when shared references are present. Pi can restore accounts from extension-provided providers after those extensions register.

## Automatic rotation

Each provider stores rotation preferences (on/off, selected stable account IDs, and algorithm) in the credential-free `account-profiles.json`. The underlying credentials remain in their original secure store. Newly created accounts are **excluded** from an existing selection until explicitly included; older accounts without explicit preferences retain their legacy pool selection until the user customizes it.

Enable rotation only after selecting at least **two connected accounts that support a model in common**. Activating rotation selects the provider's virtual routing model at `account-profiles/<group-id>` and persists it as the default model. Turning rotation off switches to an available physical account/model while preserving the member selection and algorithm for a later activation. This opt-in process does not change account quotas or entitlements.

Four algorithms are available:

- **Round Robin** (default) — alternate eligible identities on new user turns.
- **Sticky** — prefer the same healthy identity until it becomes unavailable.
- **Random** — uniformly pick an eligible identity.
- **Hybrid** — prefer healthy identities with available quota observations, using round-robin for ties.

A provider may have several identities but not every model available to all of them. The runtime skips identities lacking the model selected for that request, and failing accounts are cooled down. Tool continuations stay on their originating identity; a recognized failure before output begins may trigger an eligible failover. Output-producing requests are not silently replayed.

### Key health, quota recovery and model-scoped rotation

The credential-health policy adopts the useful separation found in Penguin Harness:

- **Temporary HTTP 429 / rate limit:** an account+model combination receives exponential cooldown, honoring a provider's explicit reset/retry interval when available. Other models on the same account are not automatically cooled down.
- **Exhausted quota:** the affected account+model stays unavailable until the reported reset time. When the provider reports no reset time, the slot remains quota-blocked until reauthentication or manual health reset; retrying it on a timer would waste requests.
- **Invalid or revoked credential:** a recognized 401 or invalid credential code quarantines the entire account identity across its models. Signing in again restores all its model slots. A successful authenticated response also clears the account-wide rejection state.
- **Provider outages (503, overload):** may trigger a pre-output attempt through another eligible account, but do not damage any credential's health, rate-limit counters, or quota. An ordinary 403, invalid request or content-policy rejection does not trigger credential failover.
- **Privacy and identity:** an account pin remains absolute, and continuations and responses with output are never replayed on a different account.

The `/account-rotation status` command reports a per-pool readiness summary and nonsecret success/failure counters. `/account-rotation reset [pool]` clears in-memory health; `/account-rotation quota <pool> <account> <fraction> [reset-epoch-ms]` lets the user explicitly provide a quota observation. None of these commands reads or prints API keys.

**Privacy warning:** Rotation may send the active conversation and tool results to any included account. Do not mix identities that are not allowed to share that context, such as unrelated personal, client, or organizational accounts. Use separate sessions or a single account when isolation is required.

## Antigravity Manager

Under **Sign in to existing account**, choose **Antigravity Manager** to connect the gateway, or use **Create separate account** to make an independent gateway identity and then sign into it. The default gateway URL is `http://127.0.0.1:8045/v1`. Additional identities may have different URLs and keys without replacing the original connection.
