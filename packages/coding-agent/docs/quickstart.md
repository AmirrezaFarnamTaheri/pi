# Quickstart

Pi runs in your terminal and works with files on your machine. To use it, you need access to a model through a supported provider. This can be a subscription, an API key, or a local model.

For native Windows setup, read [Windows Setup](windows.md). For Android, read [Termux Setup](termux.md).

## 1. Install Pi

Install Pi with the installer on macOS, Linux, or Windows:

```bash tab="macOS / Linux"
curl -fsSL https://pi.dev/install.sh | sh
```

```powershell tab="Windows"
powershell -c "irm https://pi.dev/install.ps1 | iex"
```

Both installers pin all dependencies and update Pi with `pi update`. Alternatively, install Pi from npm, which does not pin transitive dependencies. This requires Node.js 22.19 or newer:

```bash
npm install -g --ignore-scripts @earendil-works/pi-coding-agent
```

Pi does not require dependency lifecycle scripts for a normal npm installation.

With Nix on macOS or Linux, install the latest release from Pi's flake. Nix builds Pi from source:

```bash
nix profile add github:earendil-works/pi/stable
```

Older Nix versions use `nix profile install` instead. Update with `nix profile upgrade pi`; `pi update` cannot update a Nix installation. To pin a release, use a tag such as `github:earendil-works/pi/v1.0.0`.

Verify the installation:

```bash
pi --version
```

## 2. Start Pi

Change to the folder you want Pi to work with, then start it:

```bash
cd /path/to/folder
pi
```

The working folder helps Pi discover relevant files, instructions, and configuration. Pi also uses it to group saved sessions.

<p align="center"><img src="images/interactive-mode.png" alt="Pi running in a terminal with a conversation, input editor, and status footer" width="750"></p>

The interface shows your conversation, an editor for prompts and commands, and a footer with the current folder, model, and session status. See [Use Pi in the terminal](usage.md) to learn how to add files, run commands, direct ongoing work, and manage results.

## 3. Choose a model

A **model** generates Pi's responses. A **provider** is the service or account Pi uses to access that model.

In Pi, run:

```text
/login
```

The first screen shows **providers** (Codex, Antigravity, Anthropic, NVIDIA and any configured custom providers), rather than account nicknames. Choose a provider and press **Enter** to manage its individual logins or API keys. If you have no connected account yet, choose **Connect another provider** and follow its subscription sign-in or API-key prompt. You can also choose **Add custom provider** for an API-compatible endpoint.

Inside a provider, **Enter** on an account opens its actions: sign in, choose a model, rename, or disconnect. Press **+** to add another account without replacing the existing one; press **R** to edit its nickname. Names change only their display label, not their credentials or provider ID. Run `/model` afterward to select a model for your account.

For multiple connected accounts, use **Space** to check the identities you want included in rotation, **A** to select all, **M** to select Round Robin, Sticky, Random or Hybrid, and **T** to turn rotation on or off. Rotation is optional and only supports models shared by eligible accounts. **Important:** included accounts may receive your session context; keep confidential client or organization sessions on one authorized identity.

See [Account management and rotation](../../docs/multi-account-login.md) for full keyboard shortcuts, deletion and isolation behavior. See [Choose a model and provider](models.md) for supported providers, environment-variable authentication, local models, and custom endpoints.

## 4. Give Pi a task

Pi shows each file read, search, command, and edit it performs. It does not ask before every tool call.

Enter a task that matches your work, for example:

```text
Summarize @meeting-notes.md and save the action items to action-items.md.
```

```text
Explain how this repository is structured and how to run its checks.
```

```text
Compare @previous.csv with @current.csv and summarize the important changes.
```

Type `@` in the editor to search for a file instead of entering its full path. When Pi finishes, review its response and any changed files. Use version control or backups for important work. For untrusted or unattended work, use a container or another sandbox. See [Security](security.md).

## Continue later

Pi saves sessions automatically. Exit Pi, then resume the most recent session for the same working folder with:

```bash
pi --continue
```

Use `/resume` to choose another saved session. See [Continue or branch a session](sessions.md) for session naming, branching, compaction, export, and sharing.

## Next steps

- [Use Pi interactively](usage.md) to learn input, commands, shortcuts, and queued messages.
- [Add instructions](configuration.md#context-files) that Pi should follow whenever it works in a folder.
- [Choose a model and provider](models.md).

### Choose how to customize Pi

Start with the least powerful mechanism that meets your need:

| Need | Start with |
|---|---|
| Give Pi persistent instructions for a folder | [`AGENTS.md`](configuration.md#context-files) |
| Reuse a prompt from the `/` menu | [Prompt template](prompt-templates.md) |
| Add task-specific instructions and supporting files | [Skill](skills.md) |
| Add executable tools, commands, or event handlers | [Extension](extensions.md) |
| Build a custom terminal component | [Terminal UI](tui.md) |
| Connect an unsupported model service | [Custom provider](custom-provider.md) |
| Install or distribute several resources | [Pi package](packages.md) |

## Uninstall Pi

If you installed Pi with npm, run:

```bash
npm uninstall -g @earendil-works/pi-coding-agent
```

If you used the installer, run it again and choose **Uninstall Pi**:

```bash
curl -fsSL https://pi.dev/install.sh | sh
```

If you installed Pi with Nix, run:

```bash
nix profile remove pi
```

None of these methods removes configuration, credentials, sessions, or installed Pi packages from `~/.pi/agent/`.
