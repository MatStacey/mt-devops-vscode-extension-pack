# MT DevOps VSCode Extension Pack

This Extension Pack contains a strictly curated list of Visual Studio Code extensions designed to seamlessly integrate with the **MT DevOps Framework**. Installing this pack ensures a standardized environment with consistent tooling, linting, and infrastructure-as-code integrations.

## 📦 Included Extensions

* **AI Assistants:** Google Gemini Code Assist, Anthropic Claude Code
* **Infrastructure & Cloud:** HashiCorp Terraform, Bridgecrew Checkov, Docker, GCP IAM Completions
* **Linting & Formatting:** ShellCheck, shell-format, Ruff (Python), YAML, Even Better TOML
* **Languages:** Python, Pylance
* **Version Control:** GitBlame, .gitignore
* **Environment:** WSL, Dev Containers
* **Utilities:** Markdown All in One, Atlassian Atlascode

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
