import * as fs from "node:fs";
import * as yaml from "js-yaml";
import * as vscode from "vscode";

interface SecretMeta {
  created?: string;
  expiry?: string;
  last_used?: string;
}

type SecretHealth = "expired" | "expiring" | "active" | "no-expiry";

const EXPIRING_SOON_DAYS = 30;

const HEALTH_ICONS: Record<SecretHealth, vscode.ThemeIcon> = {
  expired: new vscode.ThemeIcon("error", new vscode.ThemeColor("testing.iconFailed")),
  expiring: new vscode.ThemeIcon("warning", new vscode.ThemeColor("testing.iconQueued")),
  active: new vscode.ThemeIcon("pass", new vscode.ThemeColor("testing.iconPassed")),
  "no-expiry": new vscode.ThemeIcon("key"),
};

function classify(meta: SecretMeta): SecretHealth {
  if (!meta.expiry) return "no-expiry";
  const expiryMs = Date.parse(meta.expiry);
  if (Number.isNaN(expiryMs)) return "no-expiry";
  const daysRemaining = (expiryMs - Date.now()) / (1000 * 60 * 60 * 24);
  if (daysRemaining < 0) return "expired";
  if (daysRemaining <= EXPIRING_SOON_DAYS) return "expiring";
  return "active";
}

/**
 * Reads `$CONFIG_DIR/secrets_metadata.yaml` -- created/expiry/last_used
 * dates only, per secret name. The actual secret VALUES live in a
 * separate chmod-600 file this extension never reads or needs to.
 */
function parseSecretsMetadata(metadataPath: string): Array<[string, SecretMeta]> {
  if (!fs.existsSync(metadataPath)) return [];
  const raw = fs.readFileSync(metadataPath, "utf8");
  const data = (yaml.load(raw) as Record<string, SecretMeta>) || {};
  return Object.entries(data).sort(([a], [b]) => a.localeCompare(b));
}

class SecretTreeItem extends vscode.TreeItem {
  constructor(name: string, meta: SecretMeta) {
    super(name, vscode.TreeItemCollapsibleState.None);
    const health = classify(meta);
    this.iconPath = HEALTH_ICONS[health];
    this.description = meta.expiry ? `expires ${meta.expiry}` : meta.last_used ? `last used ${meta.last_used}` : "";
    this.tooltip = new vscode.MarkdownString(
      `**${name}**\n\n` +
        `- Created: ${meta.created ?? "unknown"}\n` +
        `- Expiry: ${meta.expiry ?? "none"}\n` +
        `- Last used: ${meta.last_used ?? "never recorded"}\n` +
        `- Status: ${health}`,
    );
    this.contextValue = "mtDevopsSecret";
  }
}

export class SecretsProvider implements vscode.TreeDataProvider<SecretTreeItem> {
  private readonly _onDidChangeTreeData = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  constructor(private readonly metadataPath: string) {}

  refresh(): void {
    this._onDidChangeTreeData.fire();
  }

  getTreeItem(element: SecretTreeItem): vscode.TreeItem {
    return element;
  }

  getChildren(): SecretTreeItem[] {
    return parseSecretsMetadata(this.metadataPath).map(([name, meta]) => new SecretTreeItem(name, meta));
  }
}
