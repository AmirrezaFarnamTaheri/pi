# Accounts and automatic rotation

`/login` is the single account-management screen. `/accounts` and `/logout` without arguments open that same screen for compatibility. It shows connected provider logins and additional accounts, with their names, providers, and connection states.

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

Rotation is represented by a virtual model at `account-profiles/<source-provider-id>`. Use the account manager or `/model` to select an individual account again. Saving a rotation model as your default keeps it selected for future sessions.

- New user turns select connected identities round-robin for the same model.
- Tool continuations stay on the identity that started the turn.
- A retry may switch identities on recognized pre-output authentication or availability failures; output-producing requests do not silently restart elsewhere.
- Unavailable identities are skipped and cooldowns prevent immediate reuse of failing accounts.

Rotation may send the current session context to another account in that group; keep unrelated contexts in separate sessions. Account quotas and entitlements are unchanged. The legacy `account-rotation.json` extension remains available for custom strategies.

## Antigravity Manager

Under **Sign in to existing account**, choose **Antigravity Manager** to connect the gateway, or use **Create separate account** to make an independent gateway identity and then sign into it. The default gateway URL is `http://127.0.0.1:8045/v1`. Additional identities may have different URLs and keys without replacing the original connection.
