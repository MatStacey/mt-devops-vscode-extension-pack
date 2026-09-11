import * as vscode from "vscode";
import { runInteractiveShell } from "./framework";

interface SecretEntry {
  name: string;
  system: string;
  description: string;
  configured: boolean;
  created: string;
  expiry: string;
  status: string;
  lastUsed: string;
}

type SecretHealth = "expired" | "expiring" | "active" | "no-expiry";

const HEALTH_ICONS: Record<SecretHealth, vscode.ThemeIcon> = {
  expired: new vscode.ThemeIcon("error", new vscode.ThemeColor("testing.iconFailed")),
  expiring: new vscode.ThemeIcon("warning", new vscode.ThemeColor("testing.iconQueued")),
  active: new vscode.ThemeIcon("pass", new vscode.ThemeColor("testing.iconPassed")),
  "no-expiry": new vscode.ThemeIcon("key"),
};

/**
 * Runs `python3 "$SECRETS_MANAGER" list` (the same registry backing the
 * bash `mt-secrets` menu) via a genuinely interactive shell, rather than
 * reading secrets_metadata.yaml directly -- the YAML only has entries
 * for secrets that have been configured at least once, but the tree
 * needs the FULL supported-secrets registry (configured or not) so an
 * unconfigured secret can still be right-clicked to add. Never reads
 * or exposes secret values, only this pipe-delimited status line per
 * secret name (per secrets_manager.py's own cmd_list docstring):
 * name|system|description|configured|created|expiry|status|days|last_used
 */
async function readSecretsRegistry(): Promise<SecretEntry[]> {
  const output = await runInteractiveShell('python3 "$SECRETS_MANAGER" list');
  return output
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => {
      const [name, system, description, configured, created, expiry, status, , lastUsed] = line.split("|");
      return {
        name,
        system,
        description,
        configured: configured === "true",
        created,
        expiry,
        status,
        lastUsed,
      };
    });
}

function classify(entry: SecretEntry): SecretHealth {
  if (!entry.configured) return "no-expiry";
  if (entry.status === "expired") return "expired";
  if (entry.status === "expiring") return "expiring";
  return entry.expiry ? "active" : "no-expiry";
}

export class SecretTreeItem extends vscode.TreeItem {
  /** The secret's registry name (e.g. "GEMINI_API_KEY") -- what `mt-secrets --add/--delete` targets. */
  readonly name: string;

  constructor(entry: SecretEntry) {
    super(entry.name, vscode.TreeItemCollapsibleState.None);
    this.name = entry.name;
    const health = classify(entry);
    this.iconPath = entry.configured
      ? HEALTH_ICONS[health]
      : new vscode.ThemeIcon("circle-slash", new vscode.ThemeColor("disabledForeground"));
    this.description = entry.configured
      ? entry.expiry
        ? `expires ${entry.expiry}`
        : entry.lastUsed
          ? `last used ${entry.lastUsed}`
          : "configured"
      : "not configured";
    this.tooltip = new vscode.MarkdownString(
      `**${entry.name}**\n\n` +
        `${entry.description}\n\n` +
        `- System: ${entry.system}\n` +
        `- Created: ${entry.created || "unknown"}\n` +
        `- Expiry: ${entry.expiry || "none"}\n` +
        `- Last used: ${entry.lastUsed || "never recorded"}\n` +
        `- Status: ${entry.configured ? health : "not configured"}`,
    );
    // Suffixed with configured/unconfigured so package.json's
    // view/item/context menu only offers "Delete" on a secret that's
    // actually set -- mirroring the Docker/Jobs adaptive action sets.
    this.contextValue = entry.configured ? "mtDevopsSecret-configured" : "mtDevopsSecret-unconfigured";
  }
}

export class SecretsProvider implements vscode.TreeDataProvider<SecretTreeItem> {
  private readonly _onDidChangeTreeData = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  refresh(): void {
    this._onDidChangeTreeData.fire();
  }

  getTreeItem(element: SecretTreeItem): vscode.TreeItem {
    return element;
  }

  async getChildren(): Promise<SecretTreeItem[]> {
    const entries = await readSecretsRegistry();
    return entries.map((entry) => new SecretTreeItem(entry));
  }
}
