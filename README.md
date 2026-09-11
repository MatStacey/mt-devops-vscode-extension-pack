# VSCode Extension Packs

This repository hosts three Visual Studio Code extensions/packs, built
and released independently:

* **[MT DevOps Framework VSCode Extension Pack](packages/mt-devops-vscode-extension-pack/README.md)**
  — the full pack, including Atlassian/Bitbucket (Atlascode) and Google
  Cloud (GCP IAM Completions) tooling, designed to integrate with the
  **MT DevOps Framework**.
* **[Generic Dev Extension Pack](packages/generic-dev-extension-pack/README.md)**
  — the same general-purpose development tooling with the Atlassian,
  Bitbucket, and Google Cloud specific extensions stripped out.
* **[MT DevOps Framework Companion](packages/mt-devops-companion/README.md)**
  — a real (coded, not just a manifest) extension: command-palette access
  to the full `mt-` catalog, an activity bar view with Jobs/Repo Hub/
  Secrets/Status/Doctor/Docker/Kubernetes panels, a `@mtdevops` chat
  participant, and an Explorer "Copy for LLM" action -- all as a thin
  client over the framework's own commands.

See each package's own README for its included extensions/features,
prerequisites, and install instructions.
