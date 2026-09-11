import * as vscode from "vscode";
import { runFrameworkJson } from "./framework";

interface StatusData {
  framework: { version: string; theme: string; ai_enabled: boolean; ai_provider: string };
  sync_repo: { initialized: boolean; path: string; branch: string; uncommitted_files: number };
  docker: { daemon_running: boolean; containers_running: number; containers_total: number };
  updates: { os_packages_pending: number; framework_update_available: string | null };
}

const OK_ICON = new vscode.ThemeIcon("pass", new vscode.ThemeColor("testing.iconPassed"));
const WARN_ICON = new vscode.ThemeIcon("warning", new vscode.ThemeColor("testing.iconQueued"));

class StatusLeafItem extends vscode.TreeItem {
  constructor(label: string, value: string, icon?: vscode.ThemeIcon) {
    super(label, vscode.TreeItemCollapsibleState.None);
    this.description = value;
    if (icon) this.iconPath = icon;
  }
}

class StatusCategoryItem extends vscode.TreeItem {
  constructor(
    label: string,
    icon: vscode.ThemeIcon,
    public readonly children: StatusLeafItem[],
  ) {
    super(label, vscode.TreeItemCollapsibleState.Expanded);
    this.iconPath = icon;
  }
}

class StatusErrorItem extends vscode.TreeItem {
  constructor(message: string) {
    super(message, vscode.TreeItemCollapsibleState.None);
    this.iconPath = new vscode.ThemeIcon("error");
  }
}

function buildCategories(data: StatusData): StatusCategoryItem[] {
  return [
    new StatusCategoryItem("Framework", new vscode.ThemeIcon("gear"), [
      new StatusLeafItem("Version", data.framework.version),
      new StatusLeafItem("Theme", data.framework.theme),
      new StatusLeafItem(
        "AI",
        `${data.framework.ai_enabled ? "enabled" : "disabled"} (${data.framework.ai_provider})`,
      ),
    ]),
    new StatusCategoryItem(
      "Sync Repo",
      new vscode.ThemeIcon("repo"),
      data.sync_repo.initialized
        ? [
            new StatusLeafItem("Path", data.sync_repo.path),
            new StatusLeafItem("Branch", data.sync_repo.branch),
            new StatusLeafItem(
              "Uncommitted",
              String(data.sync_repo.uncommitted_files),
              data.sync_repo.uncommitted_files > 0 ? WARN_ICON : OK_ICON,
            ),
          ]
        : [new StatusLeafItem("Status", "Not initialized", WARN_ICON)],
    ),
    new StatusCategoryItem(
      "Docker",
      new vscode.ThemeIcon("server-environment"),
      data.docker.daemon_running
        ? [
            new StatusLeafItem("Daemon", "Running", OK_ICON),
            new StatusLeafItem(
              "Containers",
              `${data.docker.containers_running} running / ${data.docker.containers_total} total`,
            ),
          ]
        : [new StatusLeafItem("Daemon", "Stopped or not installed", WARN_ICON)],
    ),
    new StatusCategoryItem("Updates", new vscode.ThemeIcon("cloud-download"), [
      new StatusLeafItem(
        "OS Packages",
        data.updates.os_packages_pending > 0 ? `${data.updates.os_packages_pending} available` : "Up to date",
        data.updates.os_packages_pending > 0 ? WARN_ICON : OK_ICON,
      ),
      new StatusLeafItem(
        "Framework",
        data.updates.framework_update_available ? `${data.updates.framework_update_available} available` : "Up to date",
        data.updates.framework_update_available ? WARN_ICON : OK_ICON,
      ),
    ]),
  ];
}

export class StatusProvider implements vscode.TreeDataProvider<vscode.TreeItem> {
  private readonly _onDidChangeTreeData = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  refresh(): void {
    this._onDidChangeTreeData.fire();
  }

  getTreeItem(element: vscode.TreeItem): vscode.TreeItem {
    return element;
  }

  async getChildren(element?: StatusCategoryItem): Promise<vscode.TreeItem[]> {
    if (element) return element.children;
    try {
      const data = await runFrameworkJson<StatusData>("mt-status --json");
      return buildCategories(data);
    } catch (err) {
      return [new StatusErrorItem(err instanceof Error ? err.message : String(err))];
    }
  }
}
