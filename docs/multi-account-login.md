# Account management and automatic rotation

This fork supports multiple separately authenticated identities for the same provider. Adding a profile **does not overwrite** the existing provider credential. It creates a new provider ID with its own credential-store entry.

## Login and manage accounts

- `/login`: open the sign-in menu. Choose **Add another account** or **Add another API key** to create a separate identity. The ordinary provider sign-in remains available if you want to update the original account.
- `/login add <provider>`: directly initiate an additional sign-in; the provider must support its own OAuth or API-key login.
- `/accounts`: list additional identities and their configuration status. Select one to sign in again, choose a model using that identity, enable its rotation group, or disconnect and remove only that identity.
- `/logout`: remove an individual stored credential. Disconnecting an additional identity via `/accounts` also removes its saved profile after logging out.

The original provider's ID is preserved. Additional identities receive stable IDs such as `account-antigravity-manager-1` and `account-antigravity-manager-2`. The credential-free `account-profiles.json` keeps the account IDs and display labels; the normal auth store keeps credentials separately under those IDs. No API keys or OAuth tokens belong in the profile file.

If an extension supplies a provider, Pi retains its additional account profiles at startup and connects them once the extension registers the provider.

## Enable automatic rotation

Select **Automatic account rotation** from `/login` or `/accounts`. Selecting the group enables it immediately without an additional confirmation step and selects a virtual model under `account-profiles/<source-provider-id>`. To return to one account, use `/model` or choose **Choose a model from this account**.

- New user turns select available, independently authenticated identities round-robin, for the same physical model ID.
- Tool continuations keep the identity used earlier in that turn.
- On recognized authentication/rate-limit/overload failures, a retry may move to another identity **only before any model output has been emitted**.
- Unavailable identities are skipped. Cooldowns avoid immediate reuse of a failing identity.
- The legacy opt-in `account-rotation.json` extension continues to support explicit pools and advanced strategies. When referencing a profile created by `/accounts`, use its ID without `sourceProvider` in that manual pool.

Rotation never bypasses provider quotas, permissions, or account entitlements. It uses separate credentials you authorized; do not configure the same key more than once.

## Antigravity Manager

The main `/login` menu includes **Connect Antigravity Manager gateway**. This is the locally or remotely hosted, OpenAI-compatible Antigravity Manager gateway integration—not Google Antigravity OAuth and not an import of another application's Google tokens. You provide a gateway URL and gateway access key.

The default gateway URL is `http://127.0.0.1:8045/v1`. Non-loopback gateways require HTTPS. Additional Antigravity Manager identities can use distinct gateway URLs and keys without replacing the original configuration.

## Secret input and troubleshooting

Secret prompts mask values on-screen, clear their input buffer on completion/cancellation, and erase undo/kill-ring history when returning to ordinary input. Never paste credentials into chat messages or `account-profiles.json`.

Account rotation selection persists when saved as the default or restored from a session. Routing may send the existing transcript and tool results to any signed-in account in the selected group; use separate sessions for unrelated identities.
