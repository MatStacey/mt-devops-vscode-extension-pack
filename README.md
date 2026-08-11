# VSCode Extension Pack

This Extension Pack contains a curated list of Visual Studio Code extensions to standardize development environments. Installing this pack will automatically install all the extensions listed below, ensuring everyone has the same tooling, formatting, and language support.

## Prerequisites

Before installing this extension pack, ensure you have the following installed:

* **Visual Studio Code:** Download the latest version from the [official website](https://code.visualstudio.com/).

### Windows 
* **Docker Desktop:** Download the latest version from the [official website](https://docs.docker.com/desktop/setup/install/windows-install/).
  * Requires Virtualization (hyper-v) enabled BIOS
  
### WSL  

* **WSL (Windows Subsystem for Linux):** Configured with a Debian distribution.
* **WSL Extension:** The official `ms-vscode-remote.remote-wsl` extension installed in VS Code to enable connecting to your Debian environment.

## How to Install

1. Open Visual Studio Code.
2. [WSL] Connect to your WSL: Debian environment using the Remote Explorer.
3. Navigate to the **Extensions** view (`Ctrl+Shift+X` or `Cmd+Shift+X`).
4. Click the `...` (Views and More Actions) menu in the top right of the Extensions panel.
5. Select **Install from VSIX...**
6. Locate and select the downloaded `.vsix` file.
7. Reload VS Code when prompted. All extensions in the pack will be installed automatically into your WSL environment.

---