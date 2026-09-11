import * as fs from "node:fs";
import * as path from "node:path";
import * as vscode from "vscode";
import { DoctorProvider } from "./doctorProvider";
import { DockerProvider } from "./dockerProvider";
import { resolveFrameworkPaths } from "./framework";
import { JobsProvider } from "./jobsProvider";
import { KubernetesProvider } from "./kubernetesProvider";
import { RepoHubProvider } from "./repoHubProvider";
import { SecretsProvider } from "./secretsProvider";
import { StatusProvider } from "./statusProvider";

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

/**
 * Registers a tree view backed by a file that may not exist yet (e.g. no
 * background job has ever run), watching it for live updates without any
 * polling or shell-outs -- the provider itself just re-reads the file
 * whenever the watcher fires.
 */
function registerWatchedView<T>(
  context: vscode.ExtensionContext,
  viewId: string,
  filePath: string,
  provider: vscode.TreeDataProvider<T> & { refresh: () => void },
  refreshCommandId: string,
): void {
  context.subscriptions.push(vscode.window.registerTreeDataProvider(viewId, provider));
  context.subscriptions.push(vscode.commands.registerCommand(refreshCommandId, () => provider.refresh()));

  const watcher = vscode.workspace.createFileSystemWatcher(filePath);
  watcher.onDidChange(() => provider.refresh());
  watcher.onDidCreate(() => provider.refresh());
  watcher.onDidDelete(() => provider.refresh());
  context.subscriptions.push(watcher);
}

/**
 * Registers a tree view backed by a `--json` shell-out (Phase 0) rather
 * than a watched file -- there's no filesystem event to watch, so
 * refresh is manual only (a view/title button), which is the right cost
 * model given each refresh is a real shell invocation, not a cheap file
 * read.
 */
function registerAsyncView<T>(
  context: vscode.ExtensionContext,
  viewId: string,
  provider: vscode.TreeDataProvider<T> & { refresh: () => void },
  refreshCommandId: string,
): void {
  context.subscriptions.push(vscode.window.registerTreeDataProvider(viewId, provider));
  context.subscriptions.push(vscode.commands.registerCommand(refreshCommandId, () => provider.refresh()));
}

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const catalog = loadCatalog(context.extensionUri);

  context.subscriptions.push(
    vscode.commands.registerCommand("mtDevops.runCommand", () => pickAndRunCommand(catalog)),
    vscode.commands.registerCommand("mtDevops.showStatus", () => runInTerminal("mt-status")),
  );

  registerAsyncView(context, "mtDevopsStatus", new StatusProvider(), "mtDevops.refreshStatus");
  registerAsyncView(context, "mtDevopsDoctor", new DoctorProvider(), "mtDevops.refreshDoctor");
  registerAsyncView(context, "mtDevopsDocker", new DockerProvider(), "mtDevops.refreshDocker");
  registerAsyncView(context, "mtDevopsKubernetes", new KubernetesProvider(), "mtDevops.refreshKubernetes");

  try {
    const { cacheDir, configDir } = await resolveFrameworkPaths();

    registerWatchedView(
      context,
      "mtDevopsJobs",
      path.join(cacheDir, ".mt_jobs.tsv"),
      new JobsProvider(path.join(cacheDir, ".mt_jobs.tsv")),
      "mtDevops.refreshJobs",
    );
    registerWatchedView(
      context,
      "mtDevopsRepoHub",
      path.join(cacheDir, ".vcs_hub.json"),
      new RepoHubProvider(path.join(cacheDir, ".vcs_hub.json")),
      "mtDevops.refreshRepoHub",
    );
    registerWatchedView(
      context,
      "mtDevopsSecrets",
      path.join(configDir, "secrets_metadata.yaml"),
      new SecretsProvider(path.join(configDir, "secrets_metadata.yaml")),
      "mtDevops.refreshSecrets",
    );
  } catch (err) {
    vscode.window.showWarningMessage(
      `MT DevOps: couldn't resolve framework paths, tree views are unavailable (${err instanceof Error ? err.message : err}).`,
    );
  }
}

export function deactivate(): void {}
