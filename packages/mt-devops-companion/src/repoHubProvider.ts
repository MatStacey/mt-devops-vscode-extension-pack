import * as fs from "node:fs";
import * as path from "node:path";
import * as vscode from "vscode";

interface RepoMeta {
  category?: string;
  description?: string;
  stack?: string;
  build?: string;
  cicd?: string;
  testing?: string;
}

/**
 * Reads `$CACHE_DIR/.vcs_hub.json`, the cache mt-hub already builds
 * (.bash.d/20-vcs/53-vcs-insight.sh) -- an object keyed by absolute
 * repo path, valued with AI/heuristic metadata about that repo.
 */
function parseRepoHub(hubFilePath: string): Array<[string, RepoMeta]> {
  if (!fs.existsSync(hubFilePath)) return [];
  const raw = fs.readFileSync(hubFilePath, "utf8");
  const data = JSON.parse(raw) as Record<string, RepoMeta>;
  return Object.entries(data).sort(([a], [b]) => path.basename(a).localeCompare(path.basename(b)));
}

class RepoTreeItem extends vscode.TreeItem {
  constructor(repoPath: string, meta: RepoMeta) {
    super(path.basename(repoPath), vscode.TreeItemCollapsibleState.None);
    this.description = meta.stack || meta.category || "";
    this.iconPath = new vscode.ThemeIcon("repo");
    this.tooltip = new vscode.MarkdownString(
      `**${repoPath}**\n\n` +
        `${meta.description || "No description available."}\n\n` +
        `- Category: ${meta.category ?? "Unknown"}\n` +
        `- Stack: ${meta.stack ?? "Unknown"}\n` +
        `- Build: ${meta.build ?? "None"}\n` +
        `- CI/CD: ${meta.cicd ?? "None"}\n` +
        `- Testing: ${meta.testing ?? "None"}`,
    );
    this.contextValue = "mtDevopsRepo";
    if (fs.existsSync(repoPath)) {
      this.command = {
        command: "vscode.openFolder",
        title: "Open Repository",
        arguments: [vscode.Uri.file(repoPath), { forceNewWindow: true }],
      };
    }
  }
}

export class RepoHubProvider implements vscode.TreeDataProvider<RepoTreeItem> {
  private readonly _onDidChangeTreeData = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  constructor(private readonly hubFilePath: string) {}

  refresh(): void {
    this._onDidChangeTreeData.fire();
  }

  getTreeItem(element: RepoTreeItem): vscode.TreeItem {
    return element;
  }

  getChildren(): RepoTreeItem[] {
    return parseRepoHub(this.hubFilePath).map(([repoPath, meta]) => new RepoTreeItem(repoPath, meta));
  }
}
