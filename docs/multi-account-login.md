# Accounts and automatic rotation

`/accounts` and `/login` open the same account manager. It shows the main provider logins and any additional accounts, with their names, providers, and connection states.

## Everyday account actions

Choose an account and then:

- **Choose model:** use a model from that particular account.
- **Sign in:** connect or replace that account's credentials.
- **Rename account:** give the account a memorable nickname, such as "Personal", "Client projects" or "Backup". Names persist across restarts and do not change credentials or stable provider IDs.
- **Delete account:** remove an additional account and its saved credentials, without touching other accounts. Main provider logins offer **Disconnect account** instead; the provider remains available for a future sign-in.
- **Rotate accounts:** use a group of connected accounts from the same provider. Choosing a rotation group enables it immediately without a second confirmation prompt.

From the manager, select **Sign in** to connect a provider, or **Add another account** to create another independently authenticated identity using browser login or an API key. Use `/login add <provider>` to start adding an account directly. `/logout` removes a saved provider credential.

A separate account keeps a stable provider ID, such as `account-antigravity-manager-1`, even after you rename it. Friendly names live in `account-profiles.json` without secrets. Saved credentials remain stored separately under their corresponding IDs. Pi can restore accounts from extension-provided providers after those extensions register.

## Automatic rotation

Rotation is represented by a virtual model at `account-profiles/<source-provider-id>`. Use the account manager or `/model` to select an individual account again. Saving a rotation model as your default keeps it selected for future sessions.

- New user turns select connected identities round-robin for the same model.
- Tool continuations stay on the identity that started the turn.
- A retry may switch identities on recognized pre-output authentication or availability failures; output-producing requests do not silently restart elsewhere.
- Unavailable identities are skipped and cooldowns prevent immediate reuse of failing accounts.

Rotation may send the current session context to another account in that group; keep unrelated contexts in separate sessions. Account quotas and entitlements are unchanged. The legacy `account-rotation.json` extension remains available for custom strategies.

## Antigravity Manager

Under **Sign in**, choose **Antigravity Manager** to connect the gateway, or use **Add another account** for a separate gateway connection. The default gateway URL is `http://127.0.0.1:8045/v1`. Additional identities may have different URLs and keys without replacing the original connection.
