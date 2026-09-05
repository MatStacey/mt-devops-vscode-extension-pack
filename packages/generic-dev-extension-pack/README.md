# Generic Dev Extension Pack

This Extension Pack is the vendor-agnostic sibling of the
[MT DevOps Framework VSCode Extension Pack](../mt-devops-vscode-extension-pack/README.md).
It contains the same general-purpose development tooling, minus anything
tied to Atlassian/Bitbucket or Google Cloud, for anyone who wants
standardized linting, IaC, and container tooling without those
vendor-specific extensions.

## 📦 Included Extensions

* **AI Assistants:** Google Gemini Code Assist, Anthropic Claude Code
* **Infrastructure & Containers:** HashiCorp Terraform, Bridgecrew Checkov, Container Tools (Docker/Podman)
* **CI/CD & Security:** GitHub Actions, Checkmarx AST Results, SonarLint
* **Linting & Formatting:** ShellCheck, shell-format, Ruff (Python), YAML, Even Better TOML
* **Languages:** Python, Pylance
* **Version Control:** GitBlame, .gitignore, GitHub Pull Requests
* **Environment:** WSL, Dev Containers
* **Utilities:** Markdown All in One

## 📋 Prerequisites

Before installing this extension pack, ensure you have the following installed:

* **Visual Studio Code:** Download the latest version from the [official website](https://code.visualstudio.com/).

### Windows
* **Docker Desktop:** Download the latest version from the [official website](https://docs.docker.com/desktop/setup/install/windows-install/).
  * Requires Virtualization (Hyper-V) enabled in BIOS.

### WSL
* **WSL (Windows Subsystem for Linux):** Configured with a Debian/Ubuntu distribution.
* **WSL Extension:** The official `ms-vscode-remote.remote-wsl` extension installed in VS Code to enable connecting to your environment.

## 🚀 How to Install

1. Download the latest `.vsix` release artifact from this repository's **Releases** page.
2. Open Visual Studio Code.
3. **[WSL Only]** Connect to your WSL environment using the Remote Explorer.
4. Navigate to the **Extensions** view (`Ctrl+Shift+X` or `Cmd+Shift+X`).
5. Click the `...` (Views and More Actions) menu in the top right of the Extensions panel.
6. Select **Install from VSIX...**
7. Locate and select the downloaded `.vsix` file.
8. Reload VS Code when prompted. All extensions in the pack will automatically initialize.
