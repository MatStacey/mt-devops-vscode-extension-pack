import * as fs from "node:fs";
import * as path from "node:path";
import * as vscode from "vscode";
import { registerAiChatParticipant } from "./aiChatParticipant";
import { DoctorProvider } from "./doctorProvider";
import { DockerContainerItem, DockerProvider } from "./dockerProvider";
import { resolveFrameworkPaths, runInteractiveShell, runInTerminal, shellQuote, stripAnsi } from "./framework";
import { JobsProvider, JobTreeItem } from "./jobsProvider";
import { KubernetesProvider } from "./kubernetesProvider";
import { RepoCategoryItem, RepoHubProvider, RepoTreeItem } from "./repoHubProvider";
import { showRepoReport } from "./repoReportPanel";
import { SecretsProvider, SecretTreeItem } from "./secretsProvider";
import { SettingsValueItem, SettingsProvider } from "./settingsProvider";
import { StatusProvider } from "./statusProvider";
import { checkForUpdates } from "./updateChecker";

interface CatalogEntry {
  id: string;
  command: string;
  description: string;
  category: string;
}

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
 * Runs a quick, non-interactive mt-jobs/mt-hub mutation (job
 * restart/stop/remove) via a captured shell call rather than a visible
 * terminal -- these finish in well under a second and their own
 * tree view already auto-refreshes from a file watcher once the
 * underlying cache/registry file changes, so a toast with the result is
 * enough feedback without a terminal tab appearing for a one-line action.
 */
async function runAndNotify(command: string, failurePrefix: string): Promise<void> {
  try {
    const output = await runInteractiveShell(command);
    const plain = stripAnsi(output).trim();
    if (plain) vscode.window.showInformationMessage(plain);
  } catch (err) {
    vscode.window.showErrorMessage(`${failurePrefix}: ${err instanceof Error ? err.message : String(err)}`);
  }
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
    vscode.commands.registerCommand("mtDevops.checkForUpdates", () => checkForUpdates(context, true)),
    vscode.commands.registerCommand("mtDevops.copyForLLM", (uri: vscode.Uri | undefined) => {
      const target = uri ?? vscode.window.activeTextEditor?.document.uri;
      if (!target) {
        vscode.window.showWarningMessage("MT DevOps: select a file or folder first.");
        return;
      }
      runInTerminal(`mt-copy ${shellQuote(target.fsPath)}`);
    }),
    // Explorer counterpart to the Repo Hub tree's own right-click "Update
    // This Repo" -- lets a repo be gap-filled from wherever it's already
    // open in the editor, without needing to also find it in the Repo Hub
    // sidebar. Filters by basename (mt-hub's own -r/--repo match), so this
    // is only meaningful when right-clicking a repo's root folder, not an
    // arbitrary file/subfolder inside one.
    vscode.commands.registerCommand("mtDevops.updateRepoIndexFromExplorer", (uri: vscode.Uri | undefined) => {
      const target = uri ?? vscode.window.activeTextEditor?.document.uri;
      if (!target) {
        vscode.window.showWarningMessage("MT DevOps: select a repository folder first.");
        return;
      }
      runInTerminal(`mt-hub --index -u -r ${shellQuote(path.basename(target.fsPath))}`);
    }),

    // Docker: single-container actions from the sidebar's context menu.
    // Start/stop/restart shell out to the framework's own
    // __docker_container_* helpers (30-docker.sh) -- the exact same ones
    // docker-containers' interactive console calls per-container -- so
    // messaging and behavior stay identical to running them by hand.
    // Logs/shell need a real attached TTY (docker logs -f / exec -it),
    // so those run in the terminal directly rather than a captured shell.
    vscode.commands.registerCommand("mtDevops.dockerStart", (item: DockerContainerItem) =>
      runInTerminal(`__docker_container_start ${shellQuote(item.containerName)}`),
    ),
    vscode.commands.registerCommand("mtDevops.dockerStop", (item: DockerContainerItem) =>
      runInTerminal(`__docker_container_stop ${shellQuote(item.containerName)}`),
    ),
    vscode.commands.registerCommand("mtDevops.dockerRestart", (item: DockerContainerItem) =>
      runInTerminal(`__docker_container_restart ${shellQuote(item.containerName)}`),
    ),
    vscode.commands.registerCommand("mtDevops.dockerLogs", (item: DockerContainerItem) =>
      runInTerminal(`__docker_container_logs ${shellQuote(item.containerName)}`),
    ),
    vscode.commands.registerCommand("mtDevops.dockerShell", (item: DockerContainerItem) =>
      runInTerminal(`__docker_container_shell ${shellQuote(item.containerName)}`),
    ),

    // Jobs: per-job actions plus a bulk "clear finished" -- restart/stop/
    // remove are fast, one-shot mt-jobs mutations (see the framework's
    // --restart/--stop/--remove flags), so they run captured rather than
    // in a terminal, with the result shown as a toast. The Jobs tree
    // already watches .mt_jobs.tsv for changes and refreshes itself once
    // any of these commands rewrites it -- no manual refresh needed here.
    vscode.commands.registerCommand("mtDevops.jobRestart", (item: JobTreeItem) =>
      runAndNotify(`mt-jobs --restart ${shellQuote(item.jobId)}`, "MT DevOps: restart failed"),
    ),
    vscode.commands.registerCommand("mtDevops.jobStop", (item: JobTreeItem) =>
      runAndNotify(`mt-jobs --stop ${shellQuote(item.jobId)}`, "MT DevOps: stop failed"),
    ),
    vscode.commands.registerCommand("mtDevops.jobRemove", (item: JobTreeItem) =>
      runAndNotify(`mt-jobs --remove ${shellQuote(item.jobId)}`, "MT DevOps: remove failed"),
    ),
    vscode.commands.registerCommand("mtDevops.jobsClearFinished", () =>
      runAndNotify("mt-jobs --clean", "MT DevOps: clear failed"),
    ),

    // Secrets: "Add / Update" always runs in a visible terminal, whether
    // the secret is already configured or not -- the real mt-add-*-key
    // command it dispatches to (via mt-secrets --add) prompts for the
    // value on /dev/tty, so a captured/toast-only call (like the Jobs
    // actions above) would just hang with no visible prompt. "Delete" is
    // fast and non-interactive, so it's captured with a toast, same as
    // Jobs, but confirmed first since it's destructive and has no undo.
    vscode.commands.registerCommand("mtDevops.secretAdd", (item: SecretTreeItem) =>
      runInTerminal(`mt-secrets --add ${shellQuote(item.name)}`),
    ),
    vscode.commands.registerCommand("mtDevops.secretDelete", async (item: SecretTreeItem) => {
      const choice = await vscode.window.showWarningMessage(
        `Delete the ${item.name} secret? This removes it from secrets.sh immediately -- there's no undo.`,
        { modal: true },
        "Delete",
      );
      if (choice !== "Delete") return;
      await runAndNotify(`mt-secrets --delete ${shellQuote(item.name)}`, "MT DevOps: delete failed");
    }),

    // Settings: edits go straight through config_manager.py's own
    // "update <section> <key> <value>" (the same write path every
    // mt-set-*/mt-toggle-* command uses) rather than hand-editing
    // config.yaml here -- keeps validation, the .env.cache invalidation,
    // and permissions (chmod 600) all in one place. A boolean setting
    // gets a true/false picker so it can't be typo'd into a truthy-looking
    // string; everything else is a plain input box pre-filled with its
    // current value.
    vscode.commands.registerCommand("mtDevops.editConfigValue", async (item: SettingsValueItem) => {
      const segments = item.dotPath.split(".");
      const key = segments.pop();
      const sectionPath = segments.join(".");
      if (!key || !sectionPath) {
        vscode.window.showErrorMessage(`MT DevOps: "${item.dotPath}" isn't an editable setting.`);
        return;
      }

      let newValue: string | undefined;
      if (typeof item.value === "boolean") {
        newValue = await vscode.window.showQuickPick(["true", "false"], {
          placeHolder: `Current value: ${item.value}`,
        });
      } else {
        newValue = await vscode.window.showInputBox({
          prompt: `${item.dotPath}`,
          value: String(item.value),
        });
      }
      if (newValue === undefined) return;

      // newValue is free-typed user input -- shellQuote() everywhere it
      // reaches the shell string, including here, rather than only on
      // the update call itself (an unquoted second use would reopen the
      // same shell-injection hole via the confirmation echo).
      await runAndNotify(
        `python3 "$CONFIG_MANAGER" update ${shellQuote(sectionPath)} ${shellQuote(key)} ${shellQuote(newValue)} && echo ${shellQuote(`✅ ${item.dotPath} set to ${newValue}.`)}`,
        "MT DevOps: setting update failed",
      );
    }),

    // Repo Hub: click opens the report webview (registered below via
    // repoHubProvider.ts's own tree-item command); right-click offers
    // "Open in VS Code" plus per-repo/per-category index & update.
    // Index/update shell out to mt-hub --index, which can take a while
    // (an AI call per un-cached or gapped repo) -- run visibly in the
    // terminal so progress is watchable, same reasoning as bulk repo
    // scans elsewhere in this extension. The Repo Hub tree already
    // watches .vcs_hub.json, so it refreshes itself once mt-hub writes
    // the updated cache -- no manual refresh needed here either.
    vscode.commands.registerCommand("mtDevops.showRepoReport", (item: RepoTreeItem) =>
      showRepoReport(item.repoPath, item.meta),
    ),
    vscode.commands.registerCommand("mtDevops.openRepoInVSCode", (item: RepoTreeItem) =>
      vscode.commands.executeCommand("vscode.openFolder", vscode.Uri.file(item.repoPath), { forceNewWindow: true }),
    ),
    vscode.commands.registerCommand("mtDevops.indexRepo", (item: RepoTreeItem) =>
      runInTerminal(`mt-hub --index -f -r ${shellQuote(path.basename(item.repoPath))}`),
    ),
    vscode.commands.registerCommand("mtDevops.updateRepo", (item: RepoTreeItem) =>
      runInTerminal(`mt-hub --index -u -r ${shellQuote(path.basename(item.repoPath))}`),
    ),
    vscode.commands.registerCommand("mtDevops.indexCategory", (item: RepoCategoryItem) =>
      runInTerminal(`mt-hub --index -f -t ${shellQuote(item.category)}`),
    ),
    vscode.commands.registerCommand("mtDevops.updateCategory", (item: RepoCategoryItem) =>
      runInTerminal(`mt-hub --index -u -t ${shellQuote(item.category)}`),
    ),
    vscode.commands.registerCommand("mtDevops.indexAllRepos", async () => {
      const choice = await vscode.window.showWarningMessage(
        "Force-reindex every repo under VCS_ROOT? This re-runs AI summarization for all of them, not just gapped ones.",
        { modal: true },
        "Index All",
      );
      if (choice === "Index All") runInTerminal("mt-hub --index -f");
    }),
    vscode.commands.registerCommand("mtDevops.updateAllRepos", () => runInTerminal("mt-hub --index -u")),
  );

  registerAiChatParticipant(context);

  // Fire-and-forget: never blocks activation on a network call, and
  // checkForUpdates itself swallows/reports its own errors -- a failed
  // update check should never surface as an extension activation error.
  if (vscode.workspace.getConfiguration("mtDevops").get<boolean>("checkForUpdatesOnStartup", true)) {
    void checkForUpdates(context, false);
  }

  registerAsyncView(context, "mtDevopsStatus", new StatusProvider(), "mtDevops.refreshStatus");
  registerAsyncView(context, "mtDevopsDoctor", new DoctorProvider(), "mtDevops.refreshDoctor");
  registerAsyncView(context, "mtDevopsDocker", new DockerProvider(), "mtDevops.refreshDocker");
  registerAsyncView(context, "mtDevopsKubernetes", new KubernetesProvider(), "mtDevops.refreshKubernetes");

  try {
    const { cacheDir, configDir, vcsRoot } = await resolveFrameworkPaths();

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
      new RepoHubProvider(path.join(cacheDir, ".vcs_hub.json"), vcsRoot),
      "mtDevops.refreshRepoHub",
    );
    registerWatchedView(
      context,
      "mtDevopsSecrets",
      path.join(configDir, "secrets_metadata.yaml"),
      new SecretsProvider(),
      "mtDevops.refreshSecrets",
    );
    registerWatchedView(
      context,
      "mtDevopsSettings",
      path.join(configDir, "config.yaml"),
      new SettingsProvider(path.join(configDir, "config.yaml")),
      "mtDevops.refreshSettings",
    );
  } catch (err) {
    vscode.window.showWarningMessage(
      `MT DevOps: couldn't resolve framework paths, tree views are unavailable (${err instanceof Error ? err.message : err}).`,
    );
  }
}

export function deactivate(): void {}
