import * as fs from "node:fs";
import * as path from "node:path";
import * as vscode from "vscode";

interface CatalogEntry {
  id: string;
  command: string;
  description: string;
  category: string;
}

const TERMINAL_NAME = "MT DevOps";

/**
 * Loads the generated command catalog shipped with the extension (see
 * scripts/generate-commands.mjs). Read from disk at activation rather
 * than bundled into the compiled JS, so the JSON stays a plain,
 * inspectable/diffable asset.
 */
function loadCatalog(extensionUri: vscode.Uri): CatalogEntry[] {
  const catalogPath = path.join(extensionUri.fsPath, "data", "commands.json");
  const raw = fs.readFileSync(catalogPath, "utf8");
  return JSON.parse(raw) as CatalogEntry[];
}

/**
 * Runs a framework command in a persistent, reused "MT DevOps" terminal.
 * Framework functions are interactive/colorized and expect a real shell
 * (they source ~/.bashrc for everything from color variables to
 * XDG-resolved paths), so a visible terminal -- not a captured
 * child_process -- is the right execution model for this first pass.
 */
function runInTerminal(command: string): void {
  const existing = vscode.window.terminals.find((t) => t.name === TERMINAL_NAME);
  const terminal = existing ?? vscode.window.createTerminal(TERMINAL_NAME);
  terminal.show();
  terminal.sendText(command);
}

async function pickAndRunCommand(catalog: CatalogEntry[]): Promise<void> {
  const picked = await vscode.window.showQuickPick(
    catalog.map((entry) => ({
      label: entry.command,
      description: entry.category,
      detail: entry.description,
      entry,
    })),
    {
      placeHolder: "Search the MT DevOps Framework command catalog...",
      matchOnDescription: true,
      matchOnDetail: true,
    },
  );

  if (picked) {
    runInTerminal(picked.entry.command);
  }
}

export function activate(context: vscode.ExtensionContext): void {
  const catalog = loadCatalog(context.extensionUri);

  context.subscriptions.push(
    vscode.commands.registerCommand("mtDevops.runCommand", () => pickAndRunCommand(catalog)),
    vscode.commands.registerCommand("mtDevops.showStatus", () => runInTerminal("mt-status")),
  );
}

export function deactivate(): void {}
