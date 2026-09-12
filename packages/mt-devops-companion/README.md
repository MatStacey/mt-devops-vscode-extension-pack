# MT DevOps Framework Companion

A thin VS Code companion for the [MT DevOps Framework](https://github.com/MatStacey/mt-devops-framework) -- gives command-palette access to its full `mt-` command catalog without needing to remember command names or drop into `mt-search -i`/`mt-fzf` in a terminal.

This is a thin client: it never reimplements framework logic. Every command it runs is sent straight to a real, framework-loaded shell, so behavior always matches what you'd get typing the command yourself.

## Features

* **`MT DevOps: Run Command...`** -- fuzzy-searches the framework's entire command catalog (aliases and functions, generated from the framework's own `COMMANDS.md`) and runs your selection in a reused "MT DevOps" integrated terminal.
* **`MT DevOps: Show Status Dashboard`** -- shortcut for `mt-status`, the framework's health-check dashboard.
* **`MT DevOps: Check for Extension Updates`** -- checks this pack's latest GitHub release against every installed extension from it (mt-devops-companion, and either extension pack manifest, if installed) and offers to download + install (via VS Code's own `workbench.extensions.installExtension`, no `code` CLI dependency) whichever are outdated. Also runs automatically once every 24 hours on startup (toggle: `mtDevops.checkForUpdatesOnStartup`) -- since this pack isn't on the Marketplace, VS Code's own auto-update never covers it.
* **MT DevOps activity bar view**, with eight panels:
  * **Jobs** -- the background job registry (`mt-jobs`), live-updated; click a finished job to open its log. Right-click a job to **Re-run**, **Stop** (while running), or **Remove from History**; the view's title bar has a **Clear Completed/Failed** button (`mt-jobs --clean`) for bulk cleanup. These shell out to `mt-jobs --restart/--stop/--remove <job_id>`, the same non-interactive per-job actions its own interactive picker uses.
  * **Repo Hub** -- `mt-hub`'s own AI/heuristic dashboard of every repo under `VCS_ROOT`, grouped by its top-level subfolder (e.g. Personal/Work). Click a repo to open a **report**: description, category, stack, build/CI/CD/testing detection, last-indexed time, recent commits (hashes link to the commit on GitHub/Bitbucket when the repo has a recognized remote), the full list of remote branches with a **Fetch** button for any not yet local, an **Open in Browser** button to the repo's GitHub/Bitbucket page, an **Update (Pull ...)** button that appears only when the local branch is behind its upstream, an **Update Index (fill gaps only)** button, and the repo's README rendered inline at the bottom. Right-click a repo for **Open in VS Code**, **Index This Repo** (force a fresh reindex), and **Update This Repo** (only if its entry has a gap -- see `mt-hub`'s own `-u`/`--update`). The same Index/Update pair is available per-category, and as **Index All Repos** (confirms first -- reindexes everything) / **Update All Repos** in the view's title bar. `mt-hub --index` itself now warns (and asks for confirmation, in a real terminal) before actually calling AI on more than a configurable number of repos in one run -- see the Settings panel's `ai.enable_bulk_index_warning`/`ai.bulk_index_warning_threshold`.
  * **Secrets** -- the framework's full supported-secrets registry (Gemini, Claude, Bitbucket, Docker Hub), configured or not, with status (created/expiry/last-used dates, colour-coded expired/expiring/active) -- never reads the actual secret values. Right-click any secret for **Add / Update Secret** (opens a terminal running the real `mt-add-*-key`/`mt-add-*-secret` command, since it needs to prompt for the value); a configured secret also gets **Delete Secret** (confirms first, then `mt-secrets --delete`, no undo).
  * **Settings** -- the full `config.yaml` schema (core/paths/ai/git/llm_exports/docker/server/cicd/minikube/display), grouped into collapsible sections, read directly from the file. Click (or right-click "Edit Setting") any value to change it -- a boolean gets a true/false picker, everything else a pre-filled input box -- written back via `config_manager.py update <section> <key> <value>`, the same path every `mt-set-*`/`mt-toggle-*` command uses, so validation, `.env.cache` invalidation, and file permissions all stay in one place. Never shows secrets.sh contents; those live in the Secrets panel above.
  * **Status** -- `mt-status`, structured into Framework / Sync Repo / Docker / Updates.
  * **Doctor** -- `mt-doctor`'s checks, grouped by section with pass/warn/fail icons.
  * **Docker** -- running/stopped containers (`docker-ls`). Right-click a container for **Start**/**Stop**/**Restart**, **Tail Logs**, or **Open Shell (SSH)** (`docker exec`) -- these call the framework's own `__docker_container_*` helpers (the same ones `docker-containers`' interactive console uses per-container), so messaging matches running them by hand. Logs and shell open in the integrated terminal since both need a real attached TTY.
  * **Kubernetes** -- active context plus every pod in the current namespace (`k8s-status`/`k8s-pods`).

  Jobs, Repo Hub, Secrets, and Settings update live as their underlying files change -- including after a sidebar action like re-running a job, indexing a repo, or editing a setting, since those rewrite the same underlying files. Status, Doctor, Docker, and Kubernetes are refreshed on demand (the refresh button in each view's title bar), since each refresh is a real shell invocation rather than a file read.
* **`@mtdevops` chat participant** -- ask it anything (`ai`), or use its slash commands: `/explain <command>` (`ai-explain`) and `/iam` (`tf-ai-iam`, analyzes the first open workspace folder). When a reply is code that `ai` saved to a file (rather than a plain chat answer), the participant reads that file back and shows it inline in the chat too, with an "Open Generated File" button -- the file is still the source of truth (this is read-back, not a reimplementation of `ai`'s own save/categorize logic).
* **Explorer right-click "MT DevOps: Copy for LLM"** -- runs `mt-copy` on the selected file or folder, copying it (with headers) to your clipboard.
* **Explorer right-click "MT DevOps: Show Repo Report" / "Index Repo (force reindex)" / "Update Repo Index (fill gaps only)"** -- the Repo Hub tree's own report/index/update actions, reachable from wherever a repo is already open in the editor. Only shown for folders (`explorerResourceIsFolder`), and further guarded at runtime against right-clicking a folder that isn't actually the root of a git repository (checks for `.git`, matching mt-hub's own repo discovery -- a worktree's `.git` file counts too) -- these match by exact basename against `mt-hub`'s own `-r`/`--repo` filter, so a non-root folder would otherwise silently target the wrong repo, or none.

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
