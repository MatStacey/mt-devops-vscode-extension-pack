# MT DevOps Framework Companion

A thin VS Code companion for the [MT DevOps Framework](https://github.com/MatStacey/mt-devops-framework) -- gives command-palette access to its full `mt-` command catalog without needing to remember command names or drop into `mt-search -i`/`mt-fzf` in a terminal.

This is a thin client: it never reimplements framework logic. Every command it runs is sent straight to a real, framework-loaded shell, so behavior always matches what you'd get typing the command yourself.

## Features

* **`MT DevOps: Run Command...`** -- fuzzy-searches the framework's entire command catalog (aliases and functions, generated from the framework's own `COMMANDS.md`) and runs your selection in a reused "MT DevOps" integrated terminal.
* **`MT DevOps: Show Status Dashboard`** -- shortcut for `mt-status`, the framework's health-check dashboard.
* **MT DevOps activity bar view**, with seven panels:
  * **Jobs** -- the background job registry (`mt-jobs`), live-updated; click a finished job to open its log.
  * **Repo Hub** -- `mt-hub`'s own AI/heuristic dashboard of every repo under `VCS_ROOT`; click a repo to open it.
  * **Secrets** -- status only (created/expiry/last-used dates, colour-coded expired/expiring/active) -- never reads the actual secret values.
  * **Status** -- `mt-status`, structured into Framework / Sync Repo / Docker / Updates.
  * **Doctor** -- `mt-doctor`'s checks, grouped by section with pass/warn/fail icons.
  * **Docker** -- running/stopped containers (`docker-ls`).
  * **Kubernetes** -- active context plus every pod in the current namespace (`k8s-status`/`k8s-pods`).

  Jobs, Repo Hub, and Secrets update live as their underlying files change. Status, Doctor, Docker, and Kubernetes are refreshed on demand (the refresh button in each view's title bar), since each refresh is a real shell invocation rather than a file read.

## Requirements

The [MT DevOps Framework](https://github.com/MatStacey/mt-devops-framework) must be installed and loaded into your interactive shell (`~/.bash.d`). Commands are run via VS Code's integrated terminal, which sources your shell profile the same way a regular terminal tab would. The tree views shell out to a genuinely interactive `bash -ic` for the same reason (a plain `bash -c`/`bash -lc` never loads the framework at all, since `~/.bashrc` itself is guarded to only run interactively).

## Keeping the command catalog current

The catalog in `data/commands.json` is generated from the framework repo's own `COMMANDS.md`, not hand-maintained. If you have both repos checked out as sibling directories (the default `~/vcs/personal/` layout), regenerate it with:

```bash
npm run sync-commands
```

Override the source path with the `MT_COMMANDS_MD` environment variable if your checkout layout differs.

## 🚀 How to Install

1. Download the latest `.vsix` release artifact from this repository's **Releases** page.
2. Open Visual Studio Code.
3. Navigate to the **Extensions** view (`Ctrl+Shift+X` or `Cmd+Shift+X`).
4. Click the `...` (Views and More Actions) menu in the top right of the Extensions panel.
5. Select **Install from VSIX...**
6. Locate and select the downloaded `.vsix` file.
7. Reload VS Code when prompted.
