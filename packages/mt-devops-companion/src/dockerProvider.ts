import * as vscode from "vscode";
import { runFrameworkJson } from "./framework";

// Fields as emitted by `docker ps --format '{{json .}}'` -- docker's own
// per-container shape, not something this extension defines.
interface DockerContainer {
  ID: string;
  Names: string;
  Image: string;
  State: string;
  Status: string;
  Ports: string;
  RunningFor: string;
}

const RUNNING_ICON = new vscode.ThemeIcon("play-circle", new vscode.ThemeColor("testing.iconPassed"));
const STOPPED_ICON = new vscode.ThemeIcon("stop-circle", new vscode.ThemeColor("disabledForeground"));

class DockerContainerItem extends vscode.TreeItem {
  constructor(container: DockerContainer) {
    super(container.Names, vscode.TreeItemCollapsibleState.None);
    this.description = container.Status;
    this.iconPath = container.State === "running" ? RUNNING_ICON : STOPPED_ICON;
    this.tooltip = new vscode.MarkdownString(
      `**${container.Names}**\n\n` +
        `- Image: ${container.Image}\n` +
        `- Status: ${container.Status}\n` +
        `- Ports: ${container.Ports || "none"}\n` +
        `- Running for: ${container.RunningFor}`,
    );
    this.contextValue = "mtDevopsContainer";
  }
}

class DockerErrorItem extends vscode.TreeItem {
  constructor(message: string) {
    super(message, vscode.TreeItemCollapsibleState.None);
    this.iconPath = new vscode.ThemeIcon("error");
  }
}

export class DockerProvider implements vscode.TreeDataProvider<vscode.TreeItem> {
  private readonly _onDidChangeTreeData = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  refresh(): void {
    this._onDidChangeTreeData.fire();
  }

  getTreeItem(element: vscode.TreeItem): vscode.TreeItem {
    return element;
  }

  async getChildren(): Promise<vscode.TreeItem[]> {
    try {
      const containers = await runFrameworkJson<DockerContainer[]>("docker-ls --json");
      return containers
        .sort((a, b) => a.Names.localeCompare(b.Names))
        .map((container) => new DockerContainerItem(container));
    } catch (err) {
      return [new DockerErrorItem(err instanceof Error ? err.message : String(err))];
    }
  }
}
