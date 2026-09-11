import * as vscode from "vscode";
import { runFrameworkJson } from "./framework";

interface DoctorCheck {
  section: string;
  status: "OK" | "WARN" | "FAIL" | "SKIP";
  message: string;
}

interface DoctorData {
  issues: number;
  checks: DoctorCheck[];
}

const STATUS_ICON: Record<DoctorCheck["status"], vscode.ThemeIcon> = {
  OK: new vscode.ThemeIcon("pass", new vscode.ThemeColor("testing.iconPassed")),
  WARN: new vscode.ThemeIcon("warning", new vscode.ThemeColor("testing.iconQueued")),
  FAIL: new vscode.ThemeIcon("error", new vscode.ThemeColor("testing.iconFailed")),
  SKIP: new vscode.ThemeIcon("circle-slash"),
};

const SECTION_LABELS: Record<string, string> = {
  version: "Version",
  sync_config: "Sync Configuration",
  sync_repo_state: "Sync Repo Git State",
  config_schema: "Config Schema",
};

function worstStatus(checks: DoctorCheck[]): DoctorCheck["status"] {
  if (checks.some((c) => c.status === "FAIL")) return "FAIL";
  if (checks.some((c) => c.status === "WARN")) return "WARN";
  if (checks.every((c) => c.status === "SKIP")) return "SKIP";
  return "OK";
}

class DoctorCheckItem extends vscode.TreeItem {
  constructor(check: DoctorCheck) {
    super(check.message, vscode.TreeItemCollapsibleState.None);
    this.iconPath = STATUS_ICON[check.status];
    this.tooltip = `${check.status}: ${check.message}`;
  }
}

class DoctorSectionItem extends vscode.TreeItem {
  constructor(
    section: string,
    public readonly checks: DoctorCheck[],
  ) {
    super(SECTION_LABELS[section] ?? section, vscode.TreeItemCollapsibleState.Expanded);
    this.iconPath = STATUS_ICON[worstStatus(checks)];
  }
}

class DoctorErrorItem extends vscode.TreeItem {
  constructor(message: string) {
    super(message, vscode.TreeItemCollapsibleState.None);
    this.iconPath = new vscode.ThemeIcon("error");
  }
}

function groupBySection(checks: DoctorCheck[]): DoctorSectionItem[] {
  const order: string[] = [];
  const bySection = new Map<string, DoctorCheck[]>();
  for (const check of checks) {
    if (!bySection.has(check.section)) {
      bySection.set(check.section, []);
      order.push(check.section);
    }
    bySection.get(check.section)!.push(check);
  }
  return order.map((section) => new DoctorSectionItem(section, bySection.get(section)!));
}

export class DoctorProvider implements vscode.TreeDataProvider<vscode.TreeItem> {
  private readonly _onDidChangeTreeData = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  refresh(): void {
    this._onDidChangeTreeData.fire();
  }

  getTreeItem(element: vscode.TreeItem): vscode.TreeItem {
    return element;
  }

  async getChildren(element?: DoctorSectionItem): Promise<vscode.TreeItem[]> {
    if (element) return element.checks.map((check) => new DoctorCheckItem(check));
    try {
      const data = await runFrameworkJson<DoctorData>("mt-doctor --json");
      return groupBySection(data.checks);
    } catch (err) {
      return [new DoctorErrorItem(err instanceof Error ? err.message : String(err))];
    }
  }
}
