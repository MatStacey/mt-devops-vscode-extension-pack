import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as vscode from "vscode";
import { registerAiChatParticipant } from "./aiChatParticipant";
import { DoctorProvider } from "./doctorProvider";
import { DockerContainerItem, DockerProvider } from "./dockerProvider";
import { ExportWizardProvider, WizardFileItem } from "./exportWizardProvider";
import { showExportPlan } from "./exportPlanPanel";
import { resolveFrameworkPaths, runFrameworkJson, runInteractiveShell, runInTerminal, shellQuote, stripAnsi } from "./framework";
import { JobsProvider, JobTreeItem } from "./jobsProvider";
import { HelmProvider, HelmReleaseItem } from "./helmProvider";
import { HistoryEntryItem, HistoryProvider } from "./historyProvider";
import { KubernetesProvider } from "./kubernetesProvider";
import { LogProvider } from "./logProvider";
import { MinikubeProvider } from "./minikubeProvider";
import { RepoCategoryItem, RepoHubProvider, RepoMeta, RepoTreeItem, WorkspaceCategoryItem } from "./repoHubProvider";
import { runAiUpdateFlow, showRepoReport } from "./repoReportPanel";
import { SecretsProvider, SecretTreeItem } from "./secretsProvider";
import { readConfigValue, SettingsValueItem, SettingsProvider } from "./settingsProvider";
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
 * Resolves the Explorer right-click target for a repo-scoped command
 * (index/update/show report), verifying it's a directory and the root
 * of an actual git repository -- `test -e` semantics (not `-d`), same
 * as the framework's own __mt_hub_find_repos, so a worktree checkout
 * (".git" is a file there) still counts. Returns undefined (after
 * showing the user why) for anything else: no selection, a file, or a
 * folder that just happens to sit inside/near a repo without being its
 * root. These commands only make sense against a repo root since
 * mt-hub's own -r/--repo filter matches by exact basename.
 */
function resolveRepoRootTarget(uri: vscode.Uri | undefined): string | undefined {
  const target = uri ?? vscode.window.activeTextEditor?.document.uri;
  if (!target) {
    vscode.window.showWarningMessage("MT DevOps: select a repository folder first.");
    return undefined;
  }
  const folderPath = target.fsPath;
  if (!fs.existsSync(folderPath) || !fs.statSync(folderPath).isDirectory()) {
    vscode.window.showWarningMessage("MT DevOps: select a folder, not a file.");
    return undefined;
  }
  if (!fs.existsSync(path.join(folderPath, ".git"))) {
    vscode.window.showWarningMessage(`MT DevOps: "${path.basename(folderPath)}" isn't the root of a git repository.`);
    return undefined;
  }
  return folderPath;
}

/** Open workspace folders that are actually git repos (checks for ".git", same test as resolveRepoRootTarget/mt-hub's own repo detection). */
function openWorkspaceRepoPaths(): string[] {
  const folders = vscode.workspace.workspaceFolders ?? [];
  return folders.map((f) => f.uri.fsPath).filter((p) => fs.existsSync(path.join(p, ".git")));
}

/**
 * Resolves a repo path for a command that can be invoked either from an
 * Explorer/editor context (a real `uri`/active file to resolve against, via
 * resolveRepoRootTarget) or bare from the command palette with no such
 * context -- in which case it falls back to whichever repos are open in the
 * workspace: the one open repo if there's exactly one, otherwise a quick
 * pick, otherwise a warning that nothing's open to target.
 */
async function pickRepoPath(uri: vscode.Uri | undefined): Promise<string | undefined> {
  const target = uri ?? vscode.window.activeTextEditor?.document.uri;
  if (target) {
    const folderPath = fs.existsSync(target.fsPath) && fs.statSync(target.fsPath).isDirectory() ? target.fsPath : path.dirname(target.fsPath);
    if (fs.existsSync(path.join(folderPath, ".git"))) return folderPath;
  }

  const openRepos = openWorkspaceRepoPaths();
  if (openRepos.length === 1) return openRepos[0];
  if (openRepos.length === 0) {
    vscode.window.showWarningMessage("MT DevOps: no open repository to target -- open one in the workspace first.");
    return undefined;
  }

  const pick = await vscode.window.showQuickPick(
    openRepos.map((p) => ({ label: path.basename(p), description: p, repoPath: p })),
    { placeHolder: "Select a repository" },
  );
  return pick?.repoPath;
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
    // Explorer counterparts to the Repo Hub tree's own right-click "Index
    // This Repo"/"Update This Repo" -- let a repo be (re)indexed from
    // wherever it's already open in the editor, without needing to also
    // find it in the Repo Hub sidebar. resolveRepoRootTarget guards all
    // three of these against a non-folder selection or a folder that
    // isn't actually a repo root, since mt-hub's own -r/--repo match is
    // an exact basename match.
    vscode.commands.registerCommand("mtDevops.indexRepoFromExplorer", (uri: vscode.Uri | undefined) => {
      const repoPath = resolveRepoRootTarget(uri);
      if (!repoPath) return;
      runInTerminal(`mt-hub --index -f -r ${shellQuote(path.basename(repoPath))}`);
    }),
    vscode.commands.registerCommand("mtDevops.updateRepoIndexFromExplorer", (uri: vscode.Uri | undefined) => {
      const repoPath = resolveRepoRootTarget(uri);
      if (!repoPath) return;
      runInTerminal(`mt-hub --index -u -r ${shellQuote(path.basename(repoPath))}`);
    }),

    // Command-palette/Explorer counterparts to the Repo Report panel's own
    // "Generate/Update README"/".gitignore" buttons -- pickRepoPath covers
    // invocation with no obvious repo context (bare command palette).
    vscode.commands.registerCommand("mtDevops.generateReadme", async (uri: vscode.Uri | undefined) => {
      const repoPath = await pickRepoPath(uri);
      if (repoPath) await runAiUpdateFlow(repoPath, "readme");
    }),
    vscode.commands.registerCommand("mtDevops.generateGitignore", async (uri: vscode.Uri | undefined) => {
      const repoPath = await pickRepoPath(uri);
      if (repoPath) await runAiUpdateFlow(repoPath, "gitignore");
    }),

    // AI Explain: a highlighted selection, an untitled/unsaved buffer, a
    // saved whole file, or an Explorer-right-clicked file -- all funnel
    // into ai-explain's own -f <file> mode. A selection (or unsaved buffer)
    // is written to a temp file first since ai-explain reads real files,
    // not stdin/inline text (avoids the bash -ic variable-expansion pitfall
    // of inlining arbitrary code content into a shell command string).
    vscode.commands.registerCommand("mtDevops.aiExplainCode", (uri: vscode.Uri | undefined) => {
      const editor = vscode.window.activeTextEditor;

      if (uri && (!editor || editor.document.uri.fsPath !== uri.fsPath) && fs.existsSync(uri.fsPath) && fs.statSync(uri.fsPath).isFile()) {
        runInTerminal(`ai-explain -f ${shellQuote(uri.fsPath)}`);
        return;
      }

      if (!editor) {
        vscode.window.showWarningMessage("MT DevOps: open a file (or right-click one in the Explorer) first.");
        return;
      }

      if (!editor.selection.isEmpty || editor.document.isUntitled) {
        const text = editor.selection.isEmpty ? editor.document.getText() : editor.document.getText(editor.selection);
        const ext = path.extname(editor.document.fileName) || ".txt";
        // mkdtemp (not a Date.now()-named file directly under the shared,
        // world-writable os.tmpdir()) gives a private, non-guessable,
        // 0700 directory -- a predictable path there would let another
        // local user read the code snippet or race to plant a symlink at
        // that path before this write lands.
        const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mt-ai-explain-"));
        const tempFile = path.join(tempDir, `snippet${ext}`);
        fs.writeFileSync(tempFile, text, "utf8");
        runInTerminal(`ai-explain -f ${shellQuote(tempFile)}`);
        return;
      }

      runInTerminal(`ai-explain -f ${shellQuote(editor.document.uri.fsPath)}`);
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

    // Helm: uninstall runs in a visible terminal, not captured -- unlike
    // Jobs/Secrets' fast one-shot actions, helm-uninstall's own
    // __k8s_confirm_destructive guard needs a real /dev/tty (and adds a
    // genuinely useful extra check this dialog can't: refusing a
    // prod-looking context/namespace without typing "yes"), so this
    // confirmation is a first pass, not a replacement for that one.
    vscode.commands.registerCommand("mtDevops.helmUninstall", async (item: HelmReleaseItem) => {
      const choice = await vscode.window.showWarningMessage(
        `Uninstall the Helm release "${item.releaseName}" (namespace: ${item.namespace})? This can't be undone.`,
        { modal: true },
        "Uninstall",
      );
      if (choice !== "Uninstall") return;
      runInTerminal(`helm-uninstall ${shellQuote(item.releaseName)} -n ${shellQuote(item.namespace)}`);
    }),

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
    // The "Open in VS Code" section is a curated set of repo names, not
    // a real mt-hub -t/--type folder, so there's no single filter that
    // covers it the way indexCategory/updateCategory's -t does -- chain
    // one -r invocation per repo instead, same flag each already uses
    // per-repo. No confirmation dialog, matching indexCategory's own
    // precedent (only the whole-VCS_ROOT indexAllRepos warns first,
    // since this is bounded to whatever's actually open right now).
    vscode.commands.registerCommand("mtDevops.indexWorkspaceRepos", (item: WorkspaceCategoryItem) => {
      const command = item.repos
        .map(([repoPath]) => `mt-hub --index -f -r ${shellQuote(path.basename(repoPath))}`)
        .join(" && ");
      runInTerminal(command);
    }),
    vscode.commands.registerCommand("mtDevops.updateWorkspaceRepos", (item: WorkspaceCategoryItem) => {
      const command = item.repos
        .map(([repoPath]) => `mt-hub --index -u -r ${shellQuote(path.basename(repoPath))}`)
        .join(" && ");
      runInTerminal(command);
    }),

    // Pull-if-behind: mt-bulk-update's own fast-forward-only logic already
    // reports UNCHANGED for a repo with nothing to pull, so there's no
    // separate "only if behind" flag to pass -- this is just the
    // fast-forward-only pull itself, run visibly since it's a real network
    // fetch per repo. --repo bypasses the scope/provider/workspace/project
    // filter tree entirely for a single known path; the category/workspace
    // variants chain one invocation per repo the same way
    // indexWorkspaceRepos does, since mt-bulk-update's own -s scope filter
    // happens to line up with the Repo Hub category name (the VCS_ROOT
    // subfolder) but has nothing equivalent for the synthetic "Open in VS
    // Code" grouping.
    vscode.commands.registerCommand("mtDevops.pullRepoIfBehind", (item: RepoTreeItem) =>
      runInTerminal(`mt-bulk-update --repo ${shellQuote(item.repoPath)}`),
    ),
    vscode.commands.registerCommand("mtDevops.pullCategoryIfBehind", (item: RepoCategoryItem) =>
      runInTerminal(`mt-bulk-update -s ${shellQuote(item.category.toLowerCase())}`),
    ),
    vscode.commands.registerCommand("mtDevops.pullWorkspaceReposIfBehind", (item: WorkspaceCategoryItem) => {
      const command = item.repos.map(([repoPath]) => `mt-bulk-update --repo ${shellQuote(repoPath)}`).join(" && ");
      runInTerminal(command);
    }),
    vscode.commands.registerCommand("mtDevops.pullAllReposIfBehind", async () => {
      const choice = await vscode.window.showWarningMessage(
        "Pull every repo under VCS_ROOT that's behind its remote? This fetches every repo -- never pushes, never force-merges.",
        { modal: true },
        "Pull All",
      );
      if (choice === "Pull All") runInTerminal("mt-bulk-update");
    }),

    // Push All Changes: git-ai-push-all formats, AI-groups/commits, and
    // pushes unconditionally with no confirmation of its own -- unlike the
    // pull actions above, this genuinely publishes to the remote, so it
    // gets the same confirm-first treatment as indexAllRepos/
    // pullAllReposIfBehind rather than running immediately on click.
    vscode.commands.registerCommand("mtDevops.pushAllChanges", async (item: RepoTreeItem) => {
      const choice = await vscode.window.showWarningMessage(
        `Format, AI-commit, and push all changes in "${path.basename(item.repoPath)}"?`,
        { modal: true },
        "Push",
      );
      if (choice === "Push") runInTerminal(`cd ${shellQuote(item.repoPath)} && git-ai-push-all`);
    }),

    // mt-export's own -i flow already prompts for every option (dir,
    // schema, exclusions, zip) interactively, so this just points it at
    // the right starting directory and lets that flow run in a visible
    // terminal -- same reasoning as indexRepo/updateRepo's own
    // shell-outs.
    vscode.commands.registerCommand("mtDevops.exportForLLM", (item: RepoTreeItem) =>
      runInTerminal(`cd ${shellQuote(item.repoPath)} && mt-export -i`),
    ),
    // Cleanup isn't repo-scoped (it clears mt-export's own output
    // directory, wherever AI_WORKSPACE_DIR/config.yaml points it), so
    // this is command-palette-only rather than a per-repo action.
    vscode.commands.registerCommand("mtDevops.exportCleanup", () => runInTerminal("mt-export-cleanup -i")),

    // History: re-running is just re-sending the exact prior command text
    // to the terminal -- no framework flag needed, since the extension
    // already holds the literal command string from mt-history --json.
    vscode.commands.registerCommand("mtDevops.historyRerun", (item: HistoryEntryItem) => runInTerminal(item.command_)),

    // Search Repos: mt-hub --search only ever looks at the already-cached
    // .vcs_hub.json (name/description/category/stack), same fields
    // RepoMeta already carries -- so a picked result can go straight into
    // showRepoReport without a second cache read.
    vscode.commands.registerCommand("mtDevops.searchRepos", async () => {
      const term = await vscode.window.showInputBox({ prompt: "Search indexed repos by name, description, category, or stack" });
      if (!term) return;

      interface SearchResult {
        path: string;
        category?: string;
        description?: string;
        stack?: string;
      }
      let results: SearchResult[];
      try {
        results = await runFrameworkJson<SearchResult[]>(`mt-hub --search ${shellQuote(term)} --json`);
      } catch (err) {
        vscode.window.showErrorMessage(`MT DevOps: search failed -- ${err instanceof Error ? err.message : String(err)}`);
        return;
      }
      if (results.length === 0) {
        vscode.window.showInformationMessage(`MT DevOps: no indexed repos match "${term}".`);
        return;
      }

      const pick = await vscode.window.showQuickPick(
        results.map((r) => ({
          label: path.basename(r.path),
          description: r.category,
          detail: r.description,
          repoPath: r.path,
          meta: { category: r.category, description: r.description, stack: r.stack } as RepoMeta,
        })),
        { placeHolder: `${results.length} match${results.length === 1 ? "" : "es"} for "${term}"` },
      );
      if (pick) await showRepoReport(pick.repoPath, pick.meta);
    }),
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
  const dockerProvider = new DockerProvider(context.globalState);
  registerAsyncView(context, "mtDevopsDocker", dockerProvider, "mtDevops.refreshDocker");
  context.subscriptions.push(
    vscode.commands.registerCommand("mtDevops.toggleDockerGroupByRepo", () => dockerProvider.toggleGroupByRepo()),
  );
  registerAsyncView(context, "mtDevopsKubernetes", new KubernetesProvider(), "mtDevops.refreshKubernetes");
  registerAsyncView(context, "mtDevopsHelm", new HelmProvider(), "mtDevops.refreshHelm");
  registerAsyncView(context, "mtDevopsMinikube", new MinikubeProvider(), "mtDevops.refreshMinikube");
  registerAsyncView(context, "mtDevopsHistory", new HistoryProvider(), "mtDevops.refreshHistory");

  try {
    const { cacheDir, configDir, logDir, vcsRoot } = await resolveFrameworkPaths();

    // Explorer counterpart to the Repo Hub tree's own click-to-open
    // report -- reads the same .vcs_hub.json cache by exact absolute
    // path (no basename fallback needed here, unlike mt-hub --preview's
    // CLI convenience, since Explorer already gives us the exact path).
    // A repo that's never been indexed just gets an empty meta object;
    // showRepoReport already renders every field as "Unknown"/"None" in
    // that case, same as a freshly-discovered repo in the sidebar.
    context.subscriptions.push(
      vscode.commands.registerCommand("mtDevops.showRepoReportFromExplorer", (uri: vscode.Uri | undefined) => {
        const repoPath = resolveRepoRootTarget(uri);
        if (!repoPath) return;
        let meta: RepoMeta = {};
        try {
          const cache = JSON.parse(fs.readFileSync(path.join(cacheDir, ".vcs_hub.json"), "utf8")) as Record<
            string,
            RepoMeta
          >;
          meta = cache[repoPath] ?? {};
        } catch {
          // No cache file yet, or this repo isn't in it -- fine, show the
          // report with an empty meta object rather than failing.
        }
        showRepoReport(repoPath, meta);
      }),
    );

    registerWatchedView(
      context,
      "mtDevopsJobs",
      path.join(cacheDir, ".mt_jobs.tsv"),
      new JobsProvider(path.join(cacheDir, ".mt_jobs.tsv")),
      "mtDevops.refreshJobs",
    );
    const repoHubProvider = new RepoHubProvider(path.join(cacheDir, ".vcs_hub.json"), vcsRoot, context.globalState);
    registerWatchedView(
      context,
      "mtDevopsRepoHub",
      path.join(cacheDir, ".vcs_hub.json"),
      repoHubProvider,
      "mtDevops.refreshRepoHub",
    );
    // The tree's "Open in VS Code" section reads vscode.workspace.workspaceFolders
    // directly (no file to watch), so it needs its own refresh trigger for
    // whenever a folder is added to or removed from the workspace.
    context.subscriptions.push(
      vscode.workspace.onDidChangeWorkspaceFolders(() => repoHubProvider.refresh()),
    );
    // One toggle command rather than two contextValue-gated
    // Add/Remove-Favorite commands -- avoids having to also update every
    // other action already scoped to an exact `viewItem == mtDevopsRepo`
    // match, since favorited state here is just a visual (star prefix +
    // Favorites section membership), not a distinct item kind.
    context.subscriptions.push(
      vscode.commands.registerCommand("mtDevops.toggleFavoriteRepo", (item: RepoTreeItem) => repoHubProvider.toggleFavorite(item.repoPath)),
    );

    const configPath = path.join(configDir, "config.yaml");

    // Repo Hub title-bar counterpart to the per-repo "Export for LLM"
    // action: not repo-scoped by construction (there's no item to
    // right-click at the view's title bar), so this reuses pickRepoPath's
    // own "resolve from context, else fall back to whichever repos are
    // open in the workspace" logic with no uri/active-editor context to
    // resolve against -- it always falls straight to the open-workspace
    // fallback (or its warning if nothing's open).
    context.subscriptions.push(
      vscode.commands.registerCommand("mtDevops.createLlmExport", async () => {
        const repoPath = await pickRepoPath(undefined);
        if (repoPath) runInTerminal(`cd ${shellQuote(repoPath)} && mt-export -i`);
      }),
    );
    // Opens the real EXPORT_DIR (paths.export_dir in config.yaml, same
    // value mt-export itself resolves it from) in the OS file
    // explorer/Finder -- not repo-scoped, since every repo's exports land
    // in per-project subfolders of the one shared EXPORT_DIR.
    context.subscriptions.push(
      vscode.commands.registerCommand("mtDevops.viewExports", async () => {
        const exportDir = readConfigValue(configPath, "paths.export_dir");
        const dir = typeof exportDir === "string" && exportDir ? exportDir : "/tmp/exports";
        const resolved = dir.startsWith("~") ? path.join(os.homedir(), dir.slice(1)) : dir;
        if (!fs.existsSync(resolved)) {
          vscode.window.showInformationMessage(`MT DevOps: no exports yet -- ${resolved} doesn't exist.`);
          return;
        }
        await vscode.commands.executeCommand("revealFileInOS", vscode.Uri.file(resolved));
      }),
    );

    // Export Wizard: a GUI front end for mt-export's own -s/-e/-x/-z
    // flags. Uses vscode.window.createTreeView directly (not
    // registerWatchedView/registerAsyncView) because checkbox toggles
    // are delivered via TreeView.onDidChangeCheckboxState, an event that
    // lives on the view object itself, not the data provider.
    const exportWizardProvider = new ExportWizardProvider(configPath);
    const exportWizardView = vscode.window.createTreeView("mtDevopsExportWizard", {
      treeDataProvider: exportWizardProvider,
      showCollapseAll: true,
    });
    context.subscriptions.push(exportWizardView);
    context.subscriptions.push(
      exportWizardView.onDidChangeCheckboxState((e) => {
        for (const [item, state] of e.items) {
          if (item instanceof WizardFileItem) {
            exportWizardProvider.setExcluded(item.relPath, state === vscode.TreeItemCheckboxState.Checked);
          }
        }
      }),
    );

    async function openExportWizardFor(repoPath: string): Promise<void> {
      exportWizardProvider.setRepo(repoPath);
      await vscode.commands.executeCommand("mtDevopsExportWizard.focus");
    }

    context.subscriptions.push(
      // Repo Hub context-menu entry point: the item already carries its
      // own repoPath, no resolution needed.
      vscode.commands.registerCommand("mtDevops.openExportWizard", (item: RepoTreeItem) => openExportWizardFor(item.repoPath)),
      // Command-palette/Explorer entry point: same repo-resolution
      // fallback (context uri, else the one open repo, else a quick
      // pick) as every other command that can be invoked bare.
      vscode.commands.registerCommand("mtDevops.openExportWizardFromExplorer", async (uri: vscode.Uri | undefined) => {
        const repoPath = await pickRepoPath(uri);
        if (repoPath) await openExportWizardFor(repoPath);
      }),
      vscode.commands.registerCommand("mtDevops.wizardChangeSchema", async () => {
        const schemasDir = path.join(os.homedir(), ".bash.d", "config", "export", "schemas");
        let schemas = ["default", "terraform", "shell", "python", "springboot", "cloudrun"];
        try {
          schemas = fs
            .readdirSync(schemasDir)
            .filter((f) => f.endsWith(".yaml"))
            .map((f) => f.replace(/\.yaml$/, ""))
            .sort();
        } catch {
          // Fall back to the hardcoded list above -- an unreadable
          // schemas dir shouldn't block picking a schema by name.
        }
        const picked = await vscode.window.showQuickPick(schemas, { placeHolder: "Select an export schema" });
        if (picked) exportWizardProvider.setSchema(picked);
      }),
      vscode.commands.registerCommand("mtDevops.wizardEditExtExclude", async () => {
        const value = await vscode.window.showInputBox({
          prompt: "File extensions to exclude, comma-separated (e.g. log,tmp,map)",
          value: exportWizardProvider.getExcludeExt(),
        });
        if (value !== undefined) exportWizardProvider.setExcludeExt(value);
      }),
      vscode.commands.registerCommand("mtDevops.wizardToggleFormat", () => exportWizardProvider.toggleZip()),
      vscode.commands.registerCommand("mtDevops.showExportPlan", async () => {
        const repoPath = exportWizardProvider.getRepoPath();
        if (!repoPath) {
          vscode.window.showWarningMessage("MT DevOps: open the Export Wizard on a repo first.");
          return;
        }
        await showExportPlan(
          repoPath,
          exportWizardProvider.getSchema(),
          exportWizardProvider.getExcludeExt(),
          exportWizardProvider.getZip(),
          exportWizardProvider.getExcludedPaths(),
        );
      }),
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
      configPath,
      new SettingsProvider(configPath),
      "mtDevops.refreshSettings",
    );

    // Logs: reads framework.log directly (see logProvider.ts) rather
    // than shelling out to `mt-logs -j`, since this view auto-refreshes
    // on every file change and mt-log appends on nearly every framework
    // command -- a bash -ic round trip per line would be both slow and
    // wasteful. Clear/Open/Tail still delegate to the real mt-logs
    // command (or, for Open, VS Code's own editor API) rather than
    // reimplementing any of that.
    const logFilePath = path.join(logDir, "framework.log");
    registerWatchedView(context, "mtDevopsLogs", logFilePath, new LogProvider(logFilePath), "mtDevops.refreshLogs");
    context.subscriptions.push(
      vscode.commands.registerCommand("mtDevops.clearLogs", () => runAndNotify("mt-logs --clear", "MT DevOps: clear failed")),
      vscode.commands.registerCommand("mtDevops.openLogFile", async () => {
        const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(logFilePath));
        await vscode.window.showTextDocument(doc);
      }),
      vscode.commands.registerCommand("mtDevops.tailLogsInTerminal", () => runInTerminal("mt-logs --follow")),
    );
  } catch (err) {
    vscode.window.showWarningMessage(
      `MT DevOps: couldn't resolve framework paths, tree views are unavailable (${err instanceof Error ? err.message : err}).`,
    );
  }
}

export function deactivate(): void {}
