#!/bin/bash

# 1. Extract existing version and bump it, or default to 1.0.0
if [ -f package.json ]; then
  OLD_VERSION=$(jq -r '.version' package.json)
  MAJOR_MINOR="${OLD_VERSION%.*}"       # Extracts everything before the last dot (e.g., 1.0)
  PATCH="${OLD_VERSION##*.}"            # Extracts everything after the last dot (e.g., 0)
  NEW_VERSION="${MAJOR_MINOR}.$((PATCH + 1))"
  echo "Bumping extension pack version: $OLD_VERSION -> $NEW_VERSION"
else
  NEW_VERSION="1.0.0"
  echo "Creating new extension pack: version $NEW_VERSION"
fi

# 2. Generate the base package.json with the repository field and dynamic version
cat <<EOF > package.json
{
  "name": "vscode-ext-pack",
  "displayName": "VSCode Extensions",
  "description": "A standardized VSCode environment",
  "version": "${NEW_VERSION}",
  "publisher": "mathewstacey",
  "repository": {
    "type": "git",
    "url": "https://github.com/MatStacey/vscode-ext-pack"
  },
  "license": "MIT",
  "engines": {
    "vscode": "^1.80.0"
  },
  "categories": [
    "Extension Packs"
  ],
  "files": [
    "README.md",
    "LICENSE"
  ]
}
EOF

# 3. Use 'jq' to cleanly grab your extensions and inject them into the package.json
echo "Extracting extensions..."
code --list-extensions | grep . | jq -R . | jq -s . > ext_list.json
jq --slurpfile exts ext_list.json '.extensionPack = $exts[0]' package.json > package.tmp.json
mv package.tmp.json package.json
rm ext_list.json

# 4. Create a README (VSCode packaging will fail without one)
echo "# Team VSCode Standard Environment" > README.md
echo "# VSCode Extension Pack

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

---" >> README.md

# 5. Create a LICENSE file
cat <<EOF > LICENSE
MIT License

Copyright (c) 2026 Mathew Stacey

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
EOF

# 6. Package the extension using npx
echo "Packaging into .vsix format..."
npx @vscode/vsce package