# Change Log

All notable changes to the "mt-devops-companion" extension will be documented in this file.

Check [Keep a Changelog](http://keepachangelog.com/) for recommendations on how to structure this file.

## [Unreleased]

- Initial release: `MT DevOps: Run Command...` command-palette fuzzy-search over the full framework catalog, and `MT DevOps: Show Status Dashboard` shortcut.
- Added a new "MT DevOps" activity bar view with Jobs, Repo Hub, and Secrets tree views (live-updated via file watchers).
- Added Status, Doctor, Docker, and Kubernetes tree views, backed by the framework's `--json` output modes; refreshed on demand.
- Added a `@mtdevops` chat participant (`ai`/`ai-explain`/`tf-ai-iam`) and an Explorer right-click "MT DevOps: Copy for LLM" action (`mt-copy`). Requires VS Code 1.93+ for the Chat Participant API.
- The chat participant now reads back and inlines code that `ai` saved to a file, with an "Open Generated File" button, instead of only showing the one-line "Saved to: ..." summary.
