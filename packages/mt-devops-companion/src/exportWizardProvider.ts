import * as fs from "node:fs";
import * as path from "node:path";
import * as vscode from "vscode";
import { readConfigValue } from "./settingsProvider";

/**
 * mt-export's own baseline ignore list (llm_exports.dir_ignore_glob /
 * EXPORT_IGNORE_DIRS), used here only as a fallback for an older install
 * whose config.yaml predates that key -- matches the framework's own
 * config.yaml.tpl default exactly, so a repo indexed against either one
 * hides the same directories from the tree.
 */
const DEFAULT_IGNORE_GLOB = ".git|.dev|.vscode|.idea|node_modules|__pycache__|.terraform|venv|.venv|.mt_cache*|target";

/**
 * A name-set (exact match) plus a prefix-list (for the one glob-star
 * entry, ".mt_cache*") pulled from the same config.yaml key mt-export
 * itself now applies unconditionally (see .bash.d/03-mytools/06-llm-exports.sh)
 * -- entries matching either are hidden from the wizard's tree entirely,
 * since ticking one to "exclude" it would be a no-op: it's already
 * excluded by every real mt-export run regardless of this UI.
 */
function loadIgnoreConfig(configPath: string): { names: Set<string>; prefixes: string[] } {
  const raw = readConfigValue(configPath, "llm_exports.dir_ignore_glob");
  const glob = typeof raw === "string" && raw ? raw : DEFAULT_IGNORE_GLOB;
  const segments = glob.split("|").filter(Boolean);
  return {
    names: new Set(segments.filter((s) => !s.endsWith("*"))),
    prefixes: segments.filter((s) => s.endsWith("*")).map((s) => s.slice(0, -1)),
  };
}

/** The three always-present control rows at the top of the wizard tree, each opening a quick pick/input box/toggle via its own command. */
export class WizardControlItem extends vscode.TreeItem {
  constructor(label: string, description: string, commandId: string, icon: string) {
    super(label, vscode.TreeItemCollapsibleState.None);
    this.description = description;
    this.iconPath = new vscode.ThemeIcon(icon);
    this.command = { command: commandId, title: label };
    this.contextValue = "mtDevopsWizardControl";
  }
}

/** The "Show Export Plan" row pinned at the end of the root list. */
export class WizardActionItem extends vscode.TreeItem {
  constructor(label: string, commandId: string, icon: string) {
    super(label, vscode.TreeItemCollapsibleState.None);
    this.iconPath = new vscode.ThemeIcon(icon);
    this.command = { command: commandId, title: label };
    this.contextValue = "mtDevopsWizardAction";
  }
}

/**
 * One file or folder in the wizard's Explorer-like tree. Its checkbox
 * means "exclude this from the export" (ticked = excluded), the opposite
 * sense of a normal file picker, since the common case is excluding a
 * handful of noisy paths out of an otherwise-included tree -- matching
 * mt-export's own --exclude semantics, not a fresh inclusion list.
 *
 * Ticking a folder is never propagated to its already-rendered children's
 * own checkbox state (VS Code's checkbox API has no indeterminate state
 * to represent "excluded via an ancestor") -- but it doesn't need to be
 * for correctness: mt-export's --exclude matches a folder's relative path
 * anywhere in a file's path, so ticking "src/legacy" excludes every file
 * under it regardless of whether those files show a tick of their own.
 */
export class WizardFileItem extends vscode.TreeItem {
  constructor(
    public readonly relPath: string,
    public readonly absPath: string,
    public readonly isDirectory: boolean,
    excluded: boolean,
  ) {
    super(path.basename(absPath), isDirectory ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None);
    this.resourceUri = vscode.Uri.file(absPath);
    this.iconPath = isDirectory ? vscode.ThemeIcon.Folder : vscode.ThemeIcon.File;
    this.checkboxState = excluded ? vscode.TreeItemCheckboxState.Checked : vscode.TreeItemCheckboxState.Unchecked;
    this.tooltip = excluded
      ? `${relPath} -- excluded from the export${isDirectory ? " (and everything under it)" : ""}`
      : relPath;
    this.contextValue = "mtDevopsWizardFile";
    // Stable across re-renders (schema/extension-exclude changes redraw
    // the whole tree) so VS Code can preserve expand/scroll state by id
    // rather than only by object identity.
    this.id = `mtDevopsWizardFile:${relPath}`;
  }
}

export type WizardTreeItem = WizardControlItem | WizardActionItem | WizardFileItem;

/**
 * Backs the "MT Export Wizard" sidebar view: a GUI front end for
 * mt-export's own -s/-e/-x/-z flags, replacing free-typed CLI arguments
 * with a schema quick pick, an Explorer-like tree of checkboxes for
 * folder/file excludes, and an extension-exclusion input box. Holds all
 * wizard state itself (the tree view is stateless UI) so "Show Export
 * Plan" can read it back out in one place.
 */
export class ExportWizardProvider implements vscode.TreeDataProvider<WizardTreeItem> {
  private readonly _onDidChangeTreeData = new vscode.EventEmitter<WizardTreeItem | undefined>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  private repoPath: string | undefined;
  private schema = "default";
  private excludeExt = "";
  private zip = false;
  private readonly excluded = new Set<string>();

  constructor(private readonly configPath: string) {}

  /** Opens the wizard on a new repo, resetting every control back to its default -- a stale exclude list from a previously-wizarded repo would silently apply to the wrong directory otherwise. */
  setRepo(repoPath: string): void {
    this.repoPath = repoPath;
    this.schema = "default";
    this.excludeExt = "";
    this.zip = false;
    this.excluded.clear();
    this._onDidChangeTreeData.fire(undefined);
  }

  getRepoPath(): string | undefined {
    return this.repoPath;
  }

  getSchema(): string {
    return this.schema;
  }

  setSchema(schema: string): void {
    this.schema = schema;
    this._onDidChangeTreeData.fire(undefined);
  }

  getExcludeExt(): string {
    return this.excludeExt;
  }

  setExcludeExt(value: string): void {
    this.excludeExt = value;
    this._onDidChangeTreeData.fire(undefined);
  }

  getZip(): boolean {
    return this.zip;
  }

  toggleZip(): void {
    this.zip = !this.zip;
    this._onDidChangeTreeData.fire(undefined);
  }

  getExcludedPaths(): string[] {
    return [...this.excluded];
  }

  /** Called from the TreeView's own onDidChangeCheckboxState event (registered in extension.ts, since that event lives on the TreeView object, not the provider). Doesn't refresh the tree -- VS Code has already updated the checkbox's own visual state; only the exclude list needs updating here. */
  setExcluded(relPath: string, excluded: boolean): void {
    if (excluded) {
      this.excluded.add(relPath);
    } else {
      this.excluded.delete(relPath);
    }
  }

  getTreeItem(element: WizardTreeItem): vscode.TreeItem {
    return element;
  }

  getChildren(element?: WizardTreeItem): WizardTreeItem[] {
    if (!this.repoPath) return [];

    if (!element) {
      const schemaItem = new WizardControlItem("Schema", this.schema, "mtDevops.wizardChangeSchema", "list-selection");
      const extItem = new WizardControlItem("Extension Exclusions", this.excludeExt || "None", "mtDevops.wizardEditExtExclude", "filter");
      const formatItem = new WizardControlItem("Output Format", this.zip ? "ZIP" : "TXT", "mtDevops.wizardToggleFormat", "package");
      const planItem = new WizardActionItem("▶  Show Export Plan", "mtDevops.showExportPlan", "play");
      return [schemaItem, extItem, formatItem, ...this.listDir(this.repoPath, ""), planItem];
    }

    if (element instanceof WizardFileItem && element.isDirectory) {
      return this.listDir(element.absPath, element.relPath);
    }

    return [];
  }

  private listDir(dirPath: string, relBase: string): WizardFileItem[] {
    const { names, prefixes } = loadIgnoreConfig(this.configPath);
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dirPath, { withFileTypes: true });
    } catch {
      return [];
    }
    return entries
      .filter((e) => !names.has(e.name) && !prefixes.some((p) => e.name.startsWith(p)))
      .sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name))
      .map((e) => {
        const relPath = relBase ? `${relBase}/${e.name}` : e.name;
        return new WizardFileItem(relPath, path.join(dirPath, e.name), e.isDirectory(), this.excluded.has(relPath));
      });
  }
}
