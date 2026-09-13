import * as vscode from "vscode";
import { runFrameworkJson } from "./framework";

interface HelmStatus {
  context: string;
  version: string;
  releases: number;
  repos: number;
}

// Subset of `helm list -o json`'s own release shape -- only the fields
// this view actually renders.
interface HelmRelease {
  name: string;
  namespace: string;
  revision: string;
  status: string;
  chart: string;
  app_version: string;
}

const STATUS_ICONS: Record<string, vscode.ThemeIcon> = {
  deployed: new vscode.ThemeIcon("pass", new vscode.ThemeColor("testing.iconPassed")),
  failed: new vscode.ThemeIcon("error", new vscode.ThemeColor("testing.iconFailed")),
  pending: new vscode.ThemeIcon("clock", new vscode.ThemeColor("testing.iconQueued")),
  "pending-install": new vscode.ThemeIcon("clock", new vscode.ThemeColor("testing.iconQueued")),
  "pending-upgrade": new vscode.ThemeIcon("clock", new vscode.ThemeColor("testing.iconQueued")),
  "pending-rollback": new vscode.ThemeIcon("clock", new vscode.ThemeColor("testing.iconQueued")),
  uninstalling: new vscode.ThemeIcon("trash"),
};

class HelmContextItem extends vscode.TreeItem {
  constructor(status: HelmStatus) {
    super(status.context, vscode.TreeItemCollapsibleState.None);
    this.description = `${status.releases} release(s) · ${status.repos} repo(s)`;
    this.iconPath = new vscode.ThemeIcon("package");
    this.tooltip = new vscode.MarkdownString(
      `**${status.context}**\n\n` +
        `- Helm version: ${status.version}\n` +
        `- Releases (all namespaces): ${status.releases}\n` +
        `- Configured repos: ${status.repos}`,
    );
  }
}

export class HelmReleaseItem extends vscode.TreeItem {
  /** The release's name and namespace -- what `helm-uninstall <name> -n <namespace>` targets. */
  readonly releaseName: string;
  readonly namespace: string;

  constructor(release: HelmRelease) {
    super(release.name, vscode.TreeItemCollapsibleState.None);
    this.releaseName = release.name;
    this.namespace = release.namespace;
    this.description = `${release.status} · ${release.chart}`;
    this.iconPath = STATUS_ICONS[release.status] ?? new vscode.ThemeIcon("question");
    this.tooltip = new vscode.MarkdownString(
      `**${release.name}**\n\n` +
        `- Namespace: ${release.namespace}\n` +
        `- Status: ${release.status}\n` +
        `- Chart: ${release.chart}\n` +
        `- App version: ${release.app_version || "unknown"}\n` +
        `- Revision: ${release.revision}`,
    );
    this.contextValue = "mtDevopsHelmRelease";
  }
}

class HelmErrorItem extends vscode.TreeItem {
  constructor(message: string) {
    super(message, vscode.TreeItemCollapsibleState.None);
    this.iconPath = new vscode.ThemeIcon("error");
  }
}

export class HelmProvider implements vscode.TreeDataProvider<vscode.TreeItem> {
  private readonly _onDidChangeTreeData = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  refresh(): void {
    this._onDidChangeTreeData.fire();
  }

  getTreeItem(element: vscode.TreeItem): vscode.TreeItem {
    return element;
  }

  async getChildren(): Promise<vscode.TreeItem[]> {
    let status: HelmStatus;
    try {
      status = await runFrameworkJson<HelmStatus>("helm-status --json");
    } catch (err) {
      return [new HelmErrorItem(err instanceof Error ? err.message : String(err))];
    }

    const items: vscode.TreeItem[] = [new HelmContextItem(status)];
    try {
      const releases = await runFrameworkJson<HelmRelease[]>("helm-list --json");
      items.push(...releases.map((release) => new HelmReleaseItem(release)));
    } catch (err) {
      items.push(new HelmErrorItem(`Releases: ${err instanceof Error ? err.message : String(err)}`));
    }
    return items;
  }
}
