import * as vscode from "vscode";
import { runFrameworkJson } from "./framework";

interface MinikubeStatus {
  profile: string;
  driver: string;
  host: string;
  kubelet: string;
  apiserver: string;
}

const RUNNING_STATES = new Set(["Running"]);

class MinikubeProfileItem extends vscode.TreeItem {
  constructor(status: MinikubeStatus) {
    super(status.profile, vscode.TreeItemCollapsibleState.None);
    this.description = `${status.driver} · ${status.host}`;
    this.iconPath = RUNNING_STATES.has(status.host)
      ? new vscode.ThemeIcon("play-circle", new vscode.ThemeColor("testing.iconPassed"))
      : new vscode.ThemeIcon("stop-circle", new vscode.ThemeColor("disabledForeground"));
    this.tooltip = new vscode.MarkdownString(
      `**${status.profile}**\n\n` +
        `- Driver: ${status.driver}\n` +
        `- Host: ${status.host}\n` +
        `- Kubelet: ${status.kubelet}\n` +
        `- APIServer: ${status.apiserver}`,
    );
    this.contextValue = "mtDevopsMinikubeProfile";
  }
}

class MinikubeErrorItem extends vscode.TreeItem {
  constructor(message: string) {
    super(message, vscode.TreeItemCollapsibleState.None);
    this.iconPath = new vscode.ThemeIcon("error");
  }
}

export class MinikubeProvider implements vscode.TreeDataProvider<vscode.TreeItem> {
  private readonly _onDidChangeTreeData = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  refresh(): void {
    this._onDidChangeTreeData.fire();
  }

  getTreeItem(element: vscode.TreeItem): vscode.TreeItem {
    return element;
  }

  async getChildren(): Promise<vscode.TreeItem[]> {
    // mk-status only supports one profile per call and defaults to
    // "minikube" -- there's no mk-profiles equivalent yet to enumerate
    // others, so (as with real single-cluster usage today) this shows
    // just the default profile. A "no cluster" failure here is a
    // legitimate, expected state (nothing started yet), not an error
    // worth alarming over the way a real command failure would be --
    // shown as an informational row instead of the error icon.
    try {
      const status = await runFrameworkJson<MinikubeStatus>("mk-status --json");
      return [new MinikubeProfileItem(status)];
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const item = new MinikubeErrorItem(message);
      if (/no minikube cluster found/i.test(message)) {
        item.iconPath = new vscode.ThemeIcon("circle-slash", new vscode.ThemeColor("disabledForeground"));
      }
      return [item];
    }
  }
}
