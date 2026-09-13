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

/** Walks a dot-path (e.g. "paths.export_dir") down a parsed config.yaml tree, or returns undefined if any segment is missing or the path resolves to a section rather than a leaf value. */
function resolveDotPath(config: Record<string, ConfigNode>, dotPath: string): ConfigValue | undefined {
  let node: ConfigNode = config;
  for (const segment of dotPath.split(".")) {
    if (typeof node !== "object" || node === null || !(segment in node)) return undefined;
    node = (node as Record<string, ConfigNode>)[segment];
  }
  return isConfigValue(node) ? node : undefined;
}

/**
 * Reads a single config.yaml value by dot-path without building the whole
 * tree view -- used by extension.ts's "View Exports" command, which needs
 * the real EXPORT_DIR (paths.export_dir) and shouldn't have to shell out
 * just to resolve one path.
 */
export function readConfigValue(configPath: string, dotPath: string): ConfigValue | undefined {
  return resolveDotPath(readConfig(configPath), dotPath);
}

/**
 * The three fixed top-level roots of the Settings tree: "Framework" is the
 * full config.yaml tree exactly as before (every section, alphabetized),
 * while "MT Hub" and "MT Export" are curated shortcuts pointing at the
 * subset of that same config.yaml that backs `mt-hub`/`mt-export`'s own
 * CLI defaults -- editing a curated entry writes to the identical dotPath
 * as its Framework-tree counterpart (same mtDevops.editConfigValue command,
 * same config_manager.py write path), so there's exactly one source of
 * truth, just two ways to find a setting.
 */
export class SettingsGroupItem extends vscode.TreeItem {
  constructor(
    label: string,
    public readonly groupKind: "framework" | "hub" | "export",
    icon: string,
  ) {
    super(label, vscode.TreeItemCollapsibleState.Collapsed);
    this.iconPath = new vscode.ThemeIcon(icon);
    this.contextValue = "mtDevopsSettingsGroup";
  }
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

export type SettingsTreeItem = SettingsGroupItem | SettingsSectionItem | SettingsValueItem;

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

/** mt-hub CLI options that persist as a config.yaml default rather than a per-run flag (-t/-r/-f/-u/-b are always explicit per-invocation and stay as tree/context-menu actions, not settings). */
const MT_HUB_SETTINGS = ["ai.default_provider", "ai.enable_bulk_index_warning", "ai.bulk_index_warning_threshold"];

/** mt-export/mt-export-cleanup CLI options that persist as a config.yaml default (schema/exclude/zip/quiet are per-run choices already covered by mt-export -i's own interactive prompts, so they're deliberately not duplicated here). */
const MT_EXPORT_SETTINGS = [
  "paths.export_dir",
  "llm_exports.enable_auto_cleanup",
  "llm_exports.auto_cleanup_days",
  "llm_exports.warn_file_threshold",
  "llm_exports.max_file_threshold",
  "llm_exports.file_blocklist_regex",
  "llm_exports.dir_ignore_glob",
];

/** Builds a flat list of SettingsValueItems for a curated set of dotPaths, skipping any that don't resolve to a leaf value in the current config.yaml (e.g. an older install pre-dating a given key -- shown once config_manager.py's own migration adds it, not a tree error before then). */
function buildCuratedChildren(config: Record<string, ConfigNode>, dotPaths: string[]): SettingsValueItem[] {
  const items: SettingsValueItem[] = [];
  for (const dotPath of dotPaths) {
    const value = resolveDotPath(config, dotPath);
    if (value === undefined) continue;
    items.push(new SettingsValueItem(dotPath.split(".").pop() as string, dotPath, value));
  }
  return items;
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

  getChildren(element?: SettingsTreeItem): SettingsTreeItem[] {
    if (!element) {
      return [
        new SettingsGroupItem("Framework", "framework", "folder-library"),
        new SettingsGroupItem("MT Hub", "hub", "repo"),
        new SettingsGroupItem("MT Export", "export", "export"),
      ];
    }
    if (element instanceof SettingsGroupItem) {
      const config = readConfig(this.configPath);
      if (element.groupKind === "framework") return buildChildren(config, "");
      return buildCuratedChildren(config, element.groupKind === "hub" ? MT_HUB_SETTINGS : MT_EXPORT_SETTINGS);
    }
    return buildChildren((element as SettingsSectionItem).node, (element as SettingsSectionItem).dotPath);
  }
}
