import * as vscode from "vscode";
import { runFrameworkJson } from "./framework";

interface HistoryEntry {
  command: string;
}

export class HistoryEntryItem extends vscode.TreeItem {
  /** The literal historical command text -- what "Re-run" sends straight to the terminal, unmodified (this is the user's own prior input, not untrusted). */
  readonly command_: string;

  constructor(entry: HistoryEntry) {
    super(entry.command, vscode.TreeItemCollapsibleState.None);
    this.command_ = entry.command;
    this.iconPath = new vscode.ThemeIcon("terminal");
    this.tooltip = entry.command;
    this.contextValue = "mtDevopsHistoryEntry";
  }
}

class HistoryErrorItem extends vscode.TreeItem {
  constructor(message: string) {
    super(message, vscode.TreeItemCollapsibleState.None);
    this.iconPath = new vscode.ThemeIcon("error");
  }
}

export class HistoryProvider implements vscode.TreeDataProvider<vscode.TreeItem> {
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
      const entries = await runFrameworkJson<HistoryEntry[]>("mt-history --json -n 50");
      return entries.length > 0 ? entries.map((entry) => new HistoryEntryItem(entry)) : [new HistoryErrorItem("No recorded framework command history yet.")];
    } catch (err) {
      return [new HistoryErrorItem(err instanceof Error ? err.message : String(err))];
    }
  }
}
