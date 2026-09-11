import * as fs from "node:fs";
import * as yaml from "js-yaml";
import * as vscode from "vscode";

type ConfigValue = string | number | boolean;
type ConfigNode = ConfigValue | { [key: string]: ConfigNode };

/**
 * Reads config.yaml directly (rather than shelling out to
 * `config_manager.py load-env`) because load-env only prints the fully
 * *flattened* env vars it exports (e.g. GEMINI_VERSION) -- it discards
 * the section/key YAML path (ai.providers.gemini.model) that
 * `config_manager.py update <section> <key> <value>` needs to write a
 * change back. Never touches secrets.sh or secrets_metadata.yaml --
 * only this framework-owned, non-secret settings file.
 */
function readConfig(configPath: string): Record<string, ConfigNode> {
  if (!fs.existsSync(configPath)) return {};
  const raw = fs.readFileSync(configPath, "utf8");
  // js-yaml's load() (unlike PyYAML's) uses the safe DEFAULT_SCHEMA since
  // v4 -- no arbitrary object instantiation from tags -- so this is
  // already the equivalent of the old, explicit safeLoad().
  const data = yaml.load(raw);
  return typeof data === "object" && data !== null ? (data as Record<string, ConfigNode>) : {};
}

function isConfigValue(node: ConfigNode): node is ConfigValue {
  return typeof node !== "object" || node === null;
}

export class SettingsSectionItem extends vscode.TreeItem {
  constructor(
    public readonly label: string,
    /** Dot-separated path to this section from config.yaml's root, e.g. "ai.providers". */
    public readonly dotPath: string,
    public readonly node: Record<string, ConfigNode>,
  ) {
    super(label, vscode.TreeItemCollapsibleState.Collapsed);
    this.iconPath = new vscode.ThemeIcon("folder-library");
    this.contextValue = "mtDevopsSettingsSection";
  }
}

export class SettingsValueItem extends vscode.TreeItem {
  constructor(
    public readonly key: string,
    /** Full dot-separated path from config.yaml's root, e.g. "ai.providers.gemini.model" -- what mtDevops.editConfigValue edits. */
    public readonly dotPath: string,
    public readonly value: ConfigValue,
  ) {
    super(key, vscode.TreeItemCollapsibleState.None);
    this.description = String(value);
    this.iconPath = new vscode.ThemeIcon(typeof value === "boolean" ? "symbol-boolean" : "symbol-field");
    this.tooltip = `${dotPath} = ${value}`;
    this.contextValue = "mtDevopsSettingsValue";
    this.command = {
      command: "mtDevops.editConfigValue",
      title: "Edit Setting",
      arguments: [this],
    };
  }
}

export type SettingsTreeItem = SettingsSectionItem | SettingsValueItem;

function buildChildren(node: Record<string, ConfigNode>, parentPath: string): SettingsTreeItem[] {
  return Object.entries(node)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => {
      const dotPath = parentPath ? `${parentPath}.${key}` : key;
      return isConfigValue(value)
        ? new SettingsValueItem(key, dotPath, value)
        : new SettingsSectionItem(key, dotPath, value as Record<string, ConfigNode>);
    });
}

export class SettingsProvider implements vscode.TreeDataProvider<SettingsTreeItem> {
  private readonly _onDidChangeTreeData = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  constructor(private readonly configPath: string) {}

  refresh(): void {
    this._onDidChangeTreeData.fire();
  }

  getTreeItem(element: SettingsTreeItem): vscode.TreeItem {
    return element;
  }

  getChildren(element?: SettingsSectionItem): SettingsTreeItem[] {
    if (element) return buildChildren(element.node, element.dotPath);
    return buildChildren(readConfig(this.configPath), "");
  }
}
