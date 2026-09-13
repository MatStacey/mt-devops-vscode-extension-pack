import { execFile } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import * as vscode from "vscode";

export interface RepoEnvironment {
  name: string;
  type: string;
}

/** From __mt_hub_detect_gcp (.bash.d/20-vcs/53-vcs-insight.sh) -- "source" is "terraform" when a "google"/"google-beta" provider block or any google_* resource type was found (also the only source that ever populates "services", since resource-type prefixes are what map to a human-readable product name), "config-files" for the weaker app.yaml/cloudbuild.yaml/registry-reference fallback, "none" otherwise. */
export interface RepoGcp {
  detected: boolean;
  source: "terraform" | "config-files" | "none";
  services: string[];
}

export interface RepoMeta {
  category?: string;
  description?: string;
  stack?: string;
  build?: string;
  cicd?: string;
  testing?: string;
  environments?: RepoEnvironment[];
  gcp?: RepoGcp;
  last_indexed?: number;
}

/**
 * Reads `$CACHE_DIR/.vcs_hub.json`, the cache mt-hub already builds
 * (.bash.d/20-vcs/53-vcs-insight.sh) -- an object keyed by absolute
 * repo path, valued with AI/heuristic metadata about that repo.
 */
function parseRepoHub(hubFilePath: string): Array<[string, RepoMeta]> {
  if (!fs.existsSync(hubFilePath)) return [];
  const raw = fs.readFileSync(hubFilePath, "utf8");
  const data = JSON.parse(raw) as Record<string, RepoMeta>;
  return Object.entries(data).sort(([a], [b]) => path.basename(a).localeCompare(path.basename(b)));
}

/**
 * Derives a repo's grouping folder the same way __mt_hub_should_index /
 * mt-hub's own dashboard scan do (.bash.d/20-vcs/53-vcs-insight.sh): the
 * first path segment under VCS_ROOT, or "Root" for a repo sitting
 * directly in VCS_ROOT with no subfolder.
 */
function repoCategory(repoPath: string, vcsRoot: string): string {
  const rel = path.relative(vcsRoot, repoPath);
  if (rel.startsWith("..")) return "Root";
  const [first] = rel.split(path.sep);
  return first || "Root";
}

export class RepoTreeItem extends vscode.TreeItem {
  constructor(
    public readonly repoPath: string,
    public readonly meta: RepoMeta,
    dirty = false,
    favorited = false,
  ) {
    super(`${favorited ? "⭐ " : ""}${path.basename(repoPath)}`, vscode.TreeItemCollapsibleState.None);
    this.description = [meta.stack || meta.category || "", dirty ? "●" : ""].filter(Boolean).join("  ");
    this.iconPath = dirty
      ? new vscode.ThemeIcon("repo", new vscode.ThemeColor("gitDecoration.modifiedResourceForeground"))
      : new vscode.ThemeIcon("repo");
    this.tooltip = new vscode.MarkdownString(
      `**${repoPath}**\n\n` +
        `${meta.description || "No description available."}\n\n` +
        `- Category: ${meta.category ?? "Unknown"}\n` +
        `- Stack: ${meta.stack ?? "Unknown"}\n` +
        `- Build: ${meta.build ?? "None"}\n` +
        `- CI/CD: ${meta.cicd ?? "None"}\n` +
        `- Testing: ${meta.testing ?? "None"}` +
        (dirty ? `\n\n⚠️ Has uncommitted changes` : ""),
    );
    this.contextValue = "mtDevopsRepo";
    // Clicking opens the report/summary view (repoReportPanel) rather than
    // the folder itself -- opening a new VS Code window per click was the
    // only option before, with no lighter-weight way to just see what a
    // repo is before committing to opening it. "Open in VS Code" is now a
    // right-click action (and a button inside the report) instead.
    this.command = {
      command: "mtDevops.showRepoReport",
      title: "Show Repository Report",
      arguments: [this],
    };
  }
}

export class RepoCategoryItem extends vscode.TreeItem {
  constructor(
    public readonly category: string,
    public readonly repos: Array<[string, RepoMeta]>,
  ) {
    super(category, vscode.TreeItemCollapsibleState.Collapsed);
    this.description = `${repos.length} repo${repos.length === 1 ? "" : "s"}`;
    this.iconPath = new vscode.ThemeIcon("folder-library");
    this.contextValue = "mtDevopsRepoCategory";
  }
}

/**
 * The "Open in VS Code" section -- repos from the current workspace's
 * folders, not a real mt-hub -t/--type folder under VCS_ROOT, so it
 * gets its own contextValue rather than "mtDevopsRepoCategory": the
 * bulk "Index All in Category"/"Update All in Category" actions target
 * mt-hub's -t filter by name, which has no meaning for a synthetic
 * grouping like this one, and would silently no-op (or worse, collide
 * with a real folder that happens to share this label).
 */
export class WorkspaceCategoryItem extends vscode.TreeItem {
  constructor(public readonly repos: Array<[string, RepoMeta]>) {
    super("Open in VS Code", vscode.TreeItemCollapsibleState.Expanded);
    this.description = `${repos.length} repo${repos.length === 1 ? "" : "s"}`;
    this.iconPath = new vscode.ThemeIcon("window");
    this.contextValue = "mtDevopsWorkspaceCategory";
  }
}

/**
 * A curated pinned-repos section at the top of the tree -- persisted in
 * extension globalState (see RepoHubProvider.toggleFavorite), not a real
 * mt-hub grouping, so like WorkspaceCategoryItem it gets its own
 * contextValue rather than "mtDevopsRepoCategory" (the bulk index/update
 * actions' -t filter has no meaning for it).
 */
export class FavoritesCategoryItem extends vscode.TreeItem {
  constructor(public readonly repos: Array<[string, RepoMeta]>) {
    super("Favorites", vscode.TreeItemCollapsibleState.Expanded);
    this.description = `${repos.length} repo${repos.length === 1 ? "" : "s"}`;
    this.iconPath = new vscode.ThemeIcon("star-full");
    this.contextValue = "mtDevopsFavoritesCategory";
  }
}

/**
 * A real tree checkbox controlling whether every mt-hub --index call this
 * provider's commands build runs with -b/--background -- ticked, indexing
 * detaches into a background job (tracked in the Jobs panel) instead of
 * streaming in the shared terminal, useful for a bulk "Index All Repos"
 * run the user doesn't want to sit and watch. Checkbox state changes are
 * delivered via the Repo Hub TreeView's own onDidChangeCheckboxState
 * event (registered in extension.ts, since that event lives on the
 * TreeView object, not this provider) -- the same wiring pattern the
 * Export Wizard's file-exclude checkboxes use.
 */
export class BackgroundIndexingControlItem extends vscode.TreeItem {
  constructor(enabled: boolean) {
    super("Background Indexing", vscode.TreeItemCollapsibleState.None);
    this.checkboxState = enabled ? vscode.TreeItemCheckboxState.Checked : vscode.TreeItemCheckboxState.Unchecked;
    this.description = enabled ? "On -- runs as a background job" : "Off -- runs visibly in the terminal";
    this.iconPath = new vscode.ThemeIcon("run-all");
    this.contextValue = "mtDevopsHubBackgroundToggle";
  }
}

/**
 * Click-to-quick-pick row overriding mt-hub --index's AI provider for
 * this session, the GUI equivalent of the CLI's own -p/--provider flag
 * (e.g. to save Claude usage by indexing with Gemini instead, without
 * touching the real ai.default_provider in config.yaml). Empty means no
 * override -- every index/update call falls back to whatever the config
 * default already is.
 */
export class ProviderOverrideControlItem extends vscode.TreeItem {
  constructor(provider: string) {
    super("AI Provider Override", vscode.TreeItemCollapsibleState.None);
    this.description = provider || "Default (config.yaml)";
    this.iconPath = new vscode.ThemeIcon("sparkle");
    this.contextValue = "mtDevopsHubProviderOverride";
    this.command = { command: "mtDevops.hubChangeProviderOverride", title: "Change AI Provider Override" };
  }
}

class RepoErrorItem extends vscode.TreeItem {
  constructor(message: string) {
    super(message, vscode.TreeItemCollapsibleState.None);
    this.iconPath = new vscode.ThemeIcon("error");
  }
}

/**
 * A plain, non-interactive dashboard line at the top of the tree -- the
 * closest thing to a "header" a VS Code TreeView has, since the API
 * itself has no dedicated header slot. Deliberately cheap-only: no live
 * "N behind" count here, since that needs a real network fetch per repo
 * (see mt-bulk-update) and this renders on every tree refresh.
 */
class SummaryItem extends vscode.TreeItem {
  constructor(total: number, needsIndex: number, dirty: number) {
    const parts = [`${total} indexed repo${total === 1 ? "" : "s"}`];
    if (needsIndex > 0) parts.push(`${needsIndex} need${needsIndex === 1 ? "s" : ""} indexing`);
    if (dirty > 0) parts.push(`${dirty} dirty`);
    super(parts.join(" · "), vscode.TreeItemCollapsibleState.None);
    this.iconPath = new vscode.ThemeIcon("dashboard");
  }
}

/**
 * Same gap definition as the framework's own __mt_hub_load_existing_keys
 * (.bash.d/20-vcs/53-vcs-insight.sh) -- category/description never came
 * back from the AI, or the stack heuristic found nothing. Mirrored here
 * (not read from the framework) since it's a pure function of already-
 * cached data with no shell-out involved.
 */
function hasIndexGap(meta: RepoMeta): boolean {
  return (
    !meta.category ||
    meta.category === "Unknown" ||
    !meta.description ||
    meta.description === "No description available." ||
    !meta.stack ||
    meta.stack === "Unknown"
  );
}

/** Whether a repo has uncommitted changes -- resolves false (not an error) if git itself fails, e.g. a repo mid-rebase or otherwise transiently unreadable. */
function isDirty(repoPath: string): Promise<boolean> {
  return new Promise((resolve) => {
    execFile("git", ["-C", repoPath, "status", "--porcelain"], { maxBuffer: 1024 * 1024 }, (error, stdout) => {
      resolve(!error && stdout.trim().length > 0);
    });
  });
}

/**
 * Groups repos into their VCS_ROOT subfolder (Personal, Work, ...),
 * sorted with "Root" last since it's the leftover/ungrouped bucket
 * rather than a deliberate category.
 */
function groupByCategory(entries: Array<[string, RepoMeta]>, vcsRoot: string): RepoCategoryItem[] {
  const byCategory = new Map<string, Array<[string, RepoMeta]>>();
  for (const entry of entries) {
    const category = repoCategory(entry[0], vcsRoot);
    if (!byCategory.has(category)) byCategory.set(category, []);
    byCategory.get(category)!.push(entry);
  }

  const categories = [...byCategory.keys()].sort((a, b) => {
    if (a === "Root") return 1;
    if (b === "Root") return -1;
    return a.localeCompare(b);
  });
  return categories.map((category) => new RepoCategoryItem(category, byCategory.get(category)!));
}

/**
 * The current workspace's folders that are actually git repos --
 * `fs.existsSync(.../.git)` (not `-d`) so a worktree checkout (".git"
 * is a plain file there) still counts, same test as the framework's
 * own __mt_hub_find_repos. A plain non-repo directory added to the
 * workspace (a scratch folder, a mounted data dir, ...) is
 * deliberately excluded -- this section is "repos I have open", not
 * "folders I have open".
 */
function findOpenWorkspaceRepos(cacheEntries: Array<[string, RepoMeta]>): Array<[string, RepoMeta]> {
  const folders = vscode.workspace.workspaceFolders ?? [];
  const metaByPath = new Map(cacheEntries);
  const repos: Array<[string, RepoMeta]> = [];
  for (const folder of folders) {
    const repoPath = folder.uri.fsPath;
    if (fs.existsSync(path.join(repoPath, ".git"))) {
      repos.push([repoPath, metaByPath.get(repoPath) ?? {}]);
    }
  }
  return repos;
}

const FAVORITES_STATE_KEY = "mtDevops.favoriteRepoPaths";
const BACKGROUND_INDEXING_STATE_KEY = "mtDevops.backgroundIndexing";
const PROVIDER_OVERRIDE_STATE_KEY = "mtDevops.providerOverride";

/**
 * Builds the extra mt-hub --index flags implied by the sidebar's
 * Background Indexing checkbox / AI Provider Override row -- appended
 * verbatim to every index/update command built anywhere in extension.ts
 * (context menus, title-bar buttons, and the Explorer counterparts, some
 * of which are registered before RepoHubProvider itself exists). Reads
 * the same globalState keys RepoHubProvider's own instance methods use,
 * so it's a free function rather than a provider method -- a shared
 * store, not state owned by one object. Provider values only ever come
 * from the fixed quick-pick list in extension.ts (gemini/claude/
 * claude-code/local), never free-typed input, so no shell-quoting is
 * needed here.
 */
export function getIndexModifierFlags(state: vscode.Memento): string {
  const parts: string[] = [];
  if (state.get(BACKGROUND_INDEXING_STATE_KEY, false)) parts.push("-b");
  const provider = state.get(PROVIDER_OVERRIDE_STATE_KEY, "");
  if (provider) parts.push("-p", provider);
  return parts.length > 0 ? ` ${parts.join(" ")}` : "";
}

export class RepoHubProvider implements vscode.TreeDataProvider<vscode.TreeItem> {
  private readonly _onDidChangeTreeData = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  constructor(
    private readonly hubFilePath: string,
    private readonly vcsRoot: string,
    private readonly state: vscode.Memento,
  ) {}

  private getFavoritePaths(): string[] {
    return this.state.get(FAVORITES_STATE_KEY, []);
  }

  isFavorite(repoPath: string): boolean {
    return this.getFavoritePaths().includes(repoPath);
  }

  async toggleFavorite(repoPath: string): Promise<void> {
    const favorites = this.getFavoritePaths();
    const next = favorites.includes(repoPath) ? favorites.filter((p) => p !== repoPath) : [...favorites, repoPath];
    await this.state.update(FAVORITES_STATE_KEY, next);
    this.refresh();
  }

  getBackgroundIndexing(): boolean {
    return this.state.get(BACKGROUND_INDEXING_STATE_KEY, false);
  }

  async setBackgroundIndexing(value: boolean): Promise<void> {
    await this.state.update(BACKGROUND_INDEXING_STATE_KEY, value);
    this.refresh();
  }

  getProviderOverride(): string {
    return this.state.get(PROVIDER_OVERRIDE_STATE_KEY, "");
  }

  async setProviderOverride(value: string): Promise<void> {
    await this.state.update(PROVIDER_OVERRIDE_STATE_KEY, value);
    this.refresh();
  }

  refresh(): void {
    this._onDidChangeTreeData.fire();
  }

  getTreeItem(element: vscode.TreeItem): vscode.TreeItem {
    return element;
  }

  async getChildren(element?: RepoCategoryItem | WorkspaceCategoryItem | FavoritesCategoryItem): Promise<vscode.TreeItem[]> {
    if (element instanceof WorkspaceCategoryItem) {
      // Only ever a handful of repos (whatever's actually open), so a
      // live `git status` per repo here is cheap -- doing the same for
      // every repo in the full category tree below would not be.
      const dirtyFlags = await Promise.all(element.repos.map(([repoPath]) => isDirty(repoPath)));
      return element.repos.map(([repoPath, meta], i) => new RepoTreeItem(repoPath, meta, dirtyFlags[i], this.isFavorite(repoPath)));
    }
    if (element instanceof FavoritesCategoryItem) {
      return element.repos.map(([repoPath, meta]) => new RepoTreeItem(repoPath, meta, false, true));
    }
    if (element) {
      return element.repos.map(([repoPath, meta]) => new RepoTreeItem(repoPath, meta, false, this.isFavorite(repoPath)));
    }
    try {
      const cacheEntries = parseRepoHub(this.hubFilePath);
      const openRepos = findOpenWorkspaceRepos(cacheEntries);
      const workspaceSection = openRepos.length > 0 ? [new WorkspaceCategoryItem(openRepos)] : [];

      const metaByPath = new Map([...cacheEntries, ...openRepos]);
      const favoriteEntries: Array<[string, RepoMeta]> = this.getFavoritePaths()
        .filter((repoPath) => metaByPath.has(repoPath))
        .map((repoPath) => [repoPath, metaByPath.get(repoPath)!]);
      const favoritesSection = favoriteEntries.length > 0 ? [new FavoritesCategoryItem(favoriteEntries)] : [];

      const needsIndex = cacheEntries.filter(([, meta]) => hasIndexGap(meta)).length;
      const openDirtyFlags = await Promise.all(openRepos.map(([repoPath]) => isDirty(repoPath)));
      const dirtyCount = openDirtyFlags.filter(Boolean).length;
      const summary = new SummaryItem(cacheEntries.length, needsIndex, dirtyCount);
      const backgroundItem = new BackgroundIndexingControlItem(this.getBackgroundIndexing());
      const providerItem = new ProviderOverrideControlItem(this.getProviderOverride());

      return [
        backgroundItem,
        providerItem,
        summary,
        ...favoritesSection,
        ...workspaceSection,
        ...groupByCategory(cacheEntries, this.vcsRoot),
      ];
    } catch (err) {
      return [new RepoErrorItem(err instanceof Error ? err.message : String(err))];
    }
  }
}
