import { execFile } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import * as vscode from "vscode";

export interface RepoEnvironment {
  name: string;
  type: string;
}

/** From __mt_radar_detect_gcp (.bash.d/20-vcs/53-vcs-insight.sh) -- "source" is "terraform" when a "google"/"google-beta" provider block or any google_* resource type was found (also the only source that ever populates "services", since resource-type prefixes are what map to a human-readable product name), "config-files" for the weaker app.yaml/cloudbuild.yaml/registry-reference fallback, "none" otherwise. */
export interface RepoGcp {
  detected: boolean;
  source: "terraform" | "config-files" | "none";
  services: string[];
}

/** From __mt_radar_detect_top_contributors (.bash.d/20-vcs/53-vcs-insight.sh) -- top 5 authors on the repo's default branch within the configured lookback window (git.contributor_lookback_months, default 12 months), ordered highest-commits-first. last_commit is a Unix epoch (seconds). */
export interface RepoContributor {
  name: string;
  commits: number;
  last_commit: number;
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
  top_contributors?: RepoContributor[];
  last_indexed?: number;
}

/**
 * Reads `$CACHE_DIR/.vcs_radar.json`, the cache mt-radar already builds
 * (.bash.d/20-vcs/53-vcs-insight.sh) -- an object keyed by absolute
 * repo path, valued with AI/heuristic metadata about that repo.
 */
function parseRepoRadar(radarFilePath: string): Array<[string, RepoMeta]> {
  if (!fs.existsSync(radarFilePath)) return [];
  const raw = fs.readFileSync(radarFilePath, "utf8");
  const data = JSON.parse(raw) as Record<string, RepoMeta>;
  return Object.entries(data).sort(([a], [b]) => path.basename(a).localeCompare(path.basename(b)));
}

/**
 * Derives a repo's grouping folder the same way __mt_radar_should_index /
 * mt-radar's own dashboard scan do (.bash.d/20-vcs/53-vcs-insight.sh): the
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
    const needsIndex = hasIndexGap(meta);
    // Dirty (uncommitted local work) takes icon-color priority over needs-
    // indexing (a stale/missing AI metadata gap) -- both are surfaced
    // either way via the description glyphs and tooltip below, this only
    // decides which one gets the single ThemeIcon color VS Code allows.
    this.description = [meta.stack || meta.category || "", needsIndex ? "⚠" : "", dirty ? "●" : ""].filter(Boolean).join("  ");
    this.iconPath = dirty
      ? new vscode.ThemeIcon("repo", new vscode.ThemeColor("gitDecoration.modifiedResourceForeground"))
      : needsIndex
        ? new vscode.ThemeIcon("repo", new vscode.ThemeColor("problemsWarningIcon.foreground"))
        : new vscode.ThemeIcon("repo");
    this.tooltip = new vscode.MarkdownString(
      `**${repoPath}**\n\n` +
        `${meta.description || "No description available."}\n\n` +
        `- Category: ${meta.category ?? "Unknown"}\n` +
        `- Stack: ${meta.stack ?? "Unknown"}\n` +
        `- Build: ${meta.build ?? "None"}\n` +
        `- CI/CD: ${meta.cicd ?? "None"}\n` +
        `- Testing: ${meta.testing ?? "None"}` +
        (needsIndex ? `\n\n⚠️ Needs (re)indexing -- category/description/stack metadata is incomplete` : "") +
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
 * folders, not a real mt-radar -t/--type folder under VCS_ROOT, so it
 * gets its own contextValue rather than "mtDevopsRepoCategory": the
 * bulk "Index All in Category"/"Update All in Category" actions target
 * mt-radar's -t filter by name, which has no meaning for a synthetic
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
 * extension globalState (see RepoRadarProvider.toggleFavorite), not a real
 * mt-radar grouping, so like WorkspaceCategoryItem it gets its own
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
 * A real tree checkbox controlling whether every mt-radar --index call this
 * provider's commands build runs with -b/--background -- ticked, indexing
 * detaches into a background job (tracked in the Jobs panel) instead of
 * streaming in the shared terminal, useful for a bulk "Index All Repos"
 * run the user doesn't want to sit and watch. Checkbox state changes are
 * delivered via the Repo Radar TreeView's own onDidChangeCheckboxState
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
    this.contextValue = "mtDevopsRadarBackgroundToggle";
  }
}

/**
 * Click-to-quick-pick row overriding mt-radar --index's AI provider for
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
    this.contextValue = "mtDevopsRadarProviderOverride";
    this.command = { command: "mtDevops.radarChangeProviderOverride", title: "Change AI Provider Override" };
  }
}

/**
 * A real tree checkbox controlling whether every mt-radar --index call this
 * provider's commands build also runs --infra (see .bash.d/20-vcs/57-infra.sh)
 * right after each repo's normal indexing step -- generating a Terraform
 * infrastructure overview (resources by category, providers, modules) for
 * any repo that has Terraform, skipped silently for one that doesn't. Off
 * by default since it's an extra (cheap, no-AI) heuristic pass most index
 * runs don't need; the standalone "Generate Infrastructure Overview"
 * context-menu action covers the "repo's already indexed, I just want
 * this one thing" case without needing this ticked at all.
 */
export class InfraOverviewControlItem extends vscode.TreeItem {
  constructor(enabled: boolean) {
    super("Generate Infra Overview", vscode.TreeItemCollapsibleState.None);
    this.checkboxState = enabled ? vscode.TreeItemCheckboxState.Checked : vscode.TreeItemCheckboxState.Unchecked;
    this.description = enabled ? "On -- runs --infra after indexing" : "Off";
    this.iconPath = new vscode.ThemeIcon("server-environment");
    this.contextValue = "mtDevopsRadarInfraToggle";
  }
}

/**
 * A real tree checkbox controlling whether each of the "personal"/"work"/
 * "Open in VS Code" sections is split into Dirty/Needs Indexing/Indexed
 * subgroups (see RepoStatusGroupItem) instead of listing repos flat. Off
 * by default -- most repo lists are short enough that the extra nesting
 * level isn't worth it until a user actually asks for it.
 */
export class GroupByStatusControlItem extends vscode.TreeItem {
  constructor(enabled: boolean) {
    super("Group by Status", vscode.TreeItemCollapsibleState.None);
    this.checkboxState = enabled ? vscode.TreeItemCheckboxState.Checked : vscode.TreeItemCheckboxState.Unchecked;
    this.description = enabled ? "On -- splits each group into Dirty/Needs Indexing/Indexed" : "Off";
    this.iconPath = new vscode.ThemeIcon("list-tree");
    this.contextValue = "mtDevopsRadarGroupByStatusToggle";
  }
}

/**
 * Collapsed-by-default container for the sidebar's non-repo settings
 * (Background Indexing, AI Provider Override, Generate Infra Overview,
 * Group by Status) -- tucks them out of the way now that they're their
 * own section rather than four always-visible rows above every repo.
 */
export class OptionsSectionItem extends vscode.TreeItem {
  constructor() {
    super("Options", vscode.TreeItemCollapsibleState.Collapsed);
    this.iconPath = new vscode.ThemeIcon("settings-gear");
    this.contextValue = "mtDevopsRadarOptionsSection";
  }
}

/**
 * Collapsed-by-default container for the sidebar's Search/Filters rows,
 * separate from OptionsSectionItem since these narrow what's shown rather
 * than change how indexing behaves.
 */
export class SearchSectionItem extends vscode.TreeItem {
  constructor() {
    super("Search", vscode.TreeItemCollapsibleState.Collapsed);
    this.iconPath = new vscode.ThemeIcon("search");
    this.contextValue = "mtDevopsRadarSearchSection";
  }
}

/** The three buckets a repo can fall into for GroupByStatusControlItem's subgrouping -- see repoStatusBucket for the (mutually exclusive) assignment rule. */
type RepoStatusBucket = "dirty" | "needs-index" | "indexed";

const STATUS_BUCKET_LABEL: Record<RepoStatusBucket, string> = { dirty: "Dirty", "needs-index": "Needs Indexing", indexed: "Indexed" };
const STATUS_BUCKET_ICON: Record<RepoStatusBucket, string> = { dirty: "diff-modified", "needs-index": "warning", indexed: "check" };

/**
 * A "Dirty"/"Needs Indexing"/"Indexed" subgroup under a category or the
 * "Open in VS Code" section, shown only when GroupByStatusControlItem is
 * checked. Carries the already-computed dirty flags (from
 * RepoRadarProvider's per-refresh dirtyCache) alongside its repos so
 * expanding it doesn't need another round of git status calls.
 */
export class RepoStatusGroupItem extends vscode.TreeItem {
  constructor(
    public readonly bucket: RepoStatusBucket,
    public readonly repos: Array<[string, RepoMeta]>,
    public readonly dirtyByPath: Map<string, boolean>,
  ) {
    super(STATUS_BUCKET_LABEL[bucket], vscode.TreeItemCollapsibleState.Collapsed);
    this.description = `${repos.length} repo${repos.length === 1 ? "" : "s"}`;
    this.iconPath = new vscode.ThemeIcon(STATUS_BUCKET_ICON[bucket]);
    this.contextValue = "mtDevopsRepoStatusGroup";
  }
}

/**
 * Click-to-input-box row filtering the tree to repos whose name,
 * description, category or stack contains the given text
 * (case-insensitive substring match). Applied ahead of every other
 * section (Favorites, Open in VS Code, categories) so a search narrows
 * the whole tree consistently. Empty term means no filtering.
 */
export class SearchControlItem extends vscode.TreeItem {
  constructor(term: string) {
    super("Search Repos", vscode.TreeItemCollapsibleState.None);
    this.description = term || "(none)";
    this.iconPath = new vscode.ThemeIcon("search");
    this.contextValue = "mtDevopsRadarSearch";
    this.command = { command: "mtDevops.radarSearch", title: "Search Repos" };
  }
}

/**
 * Click-to-quick-pick row narrowing the tree by category/stack (OR'd
 * within each facet, AND'd across facets) plus the "Needs Indexing" and
 * "GCP Detected" toggles -- same AND-across/OR-within convention as most
 * faceted filters. No "Favorites Only" facet here since the Favorites
 * section already exists for that.
 */
export class FilterControlItem extends vscode.TreeItem {
  constructor(summary: string) {
    super("Filters", vscode.TreeItemCollapsibleState.None);
    this.description = summary || "(none)";
    this.iconPath = new vscode.ThemeIcon("filter");
    this.contextValue = "mtDevopsRadarFilter";
    this.command = { command: "mtDevops.radarFilter", title: "Filter Repos" };
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
 * Same gap definition as the framework's own __mt_radar_load_existing_keys
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

/**
 * Assigns a repo to exactly one of GroupByStatusControlItem's three
 * subgroups. Dirty (uncommitted local work) wins over a metadata gap --
 * it's the more urgent, more transient fact -- so a repo that's both
 * dirty and never fully indexed lands under "Dirty", not "Needs
 * Indexing". This is a partition (every repo lands in exactly one
 * bucket), unlike RepoTreeItem's own display, which shows both facts
 * independently regardless of this ordering.
 */
function repoStatusBucket(meta: RepoMeta, dirty: boolean): RepoStatusBucket {
  if (dirty) return "dirty";
  if (hasIndexGap(meta)) return "needs-index";
  return "indexed";
}

export interface RadarFilters {
  categories: string[];
  stacks: string[];
  needsIndex: boolean;
  gcpOnly: boolean;
}

const EMPTY_FILTERS: RadarFilters = { categories: [], stacks: [], needsIndex: false, gcpOnly: false };

/** Case-insensitive substring match against name, description, category and stack -- an empty term always matches. */
function matchesSearch(repoPath: string, meta: RepoMeta, term: string): boolean {
  if (!term) return true;
  const needle = term.toLowerCase();
  const haystacks = [path.basename(repoPath), meta.description, meta.category, meta.stack];
  return haystacks.some((field) => field?.toLowerCase().includes(needle));
}

/** Categories/stacks OR within their own facet, every non-empty facet AND'd together. */
function matchesFilters(repoPath: string, meta: RepoMeta, filters: RadarFilters, vcsRoot: string): boolean {
  if (filters.categories.length > 0 && !filters.categories.includes(repoCategory(repoPath, vcsRoot))) return false;
  if (filters.stacks.length > 0 && (!meta.stack || !filters.stacks.includes(meta.stack))) return false;
  if (filters.needsIndex && !hasIndexGap(meta)) return false;
  if (filters.gcpOnly && !meta.gcp?.detected) return false;
  return true;
}

/** Short "Category: Personal · Needs Indexing" style label for FilterControlItem's description -- empty when no filter is active. */
function summarizeFilters(filters: RadarFilters): string {
  const parts: string[] = [];
  if (filters.categories.length > 0) parts.push(`Category: ${filters.categories.join(", ")}`);
  if (filters.stacks.length > 0) parts.push(`Stack: ${filters.stacks.join(", ")}`);
  if (filters.needsIndex) parts.push("Needs Indexing");
  if (filters.gcpOnly) parts.push("GCP Detected");
  return parts.join(" · ");
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
 * own __mt_radar_find_repos. A plain non-repo directory added to the
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
const INFRA_OVERVIEW_STATE_KEY = "mtDevops.generateInfraOverview";
const GROUP_BY_STATUS_STATE_KEY = "mtDevops.groupByStatus";

/**
 * Builds the extra mt-radar --index flags implied by the sidebar's
 * Background Indexing / Generate Infra Overview checkboxes and the AI
 * Provider Override row -- appended verbatim to every index/update
 * command built anywhere in extension.ts (context menus, title-bar
 * buttons, and the Explorer counterparts, some of which are registered
 * before RepoRadarProvider itself exists). Reads the same globalState keys
 * RepoRadarProvider's own instance methods use, so it's a free function
 * rather than a provider method -- a shared store, not state owned by
 * one object. Provider values only ever come from the fixed quick-pick
 * list in extension.ts (gemini/claude/claude-code/local), never
 * free-typed input, so no shell-quoting is needed here.
 */
export function getIndexModifierFlags(state: vscode.Memento): string {
  const parts: string[] = [];
  if (state.get(BACKGROUND_INDEXING_STATE_KEY, false)) parts.push("-b");
  const provider = state.get(PROVIDER_OVERRIDE_STATE_KEY, "");
  if (provider) parts.push("-p", provider);
  if (state.get(INFRA_OVERVIEW_STATE_KEY, false)) parts.push("--infra");
  return parts.length > 0 ? ` ${parts.join(" ")}` : "";
}

export class RepoRadarProvider implements vscode.TreeDataProvider<vscode.TreeItem> {
  private readonly _onDidChangeTreeData = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  // Search/filter are per-session view state, not read by anything outside
  // this provider (unlike the globalState-backed toggles above, which
  // getIndexModifierFlags also needs), so plain instance fields are enough
  // -- they reset when the window reloads, same as a typical filter box.
  private searchTerm = "";
  private filters: RadarFilters = EMPTY_FILTERS;

  // Populated once per root getChildren() call (a `git status --porcelain`
  // per cached repo, run in parallel) and read synchronously by every
  // subsequent getChildren(element) call for the same tree refresh --
  // VS Code always resolves a TreeDataProvider's root before any of its
  // children, so this is never read before it's populated. Kept on the
  // instance (not returned from getChildren itself) since RepoStatusGroupItem
  // and the plain category/workspace branches all need the same map,
  // without paying for another round of git calls per expansion.
  private dirtyCache = new Map<string, boolean>();

  constructor(
    private readonly radarFilePath: string,
    private readonly vcsRoot: string,
    private readonly state: vscode.Memento,
  ) {}

  getSearchTerm(): string {
    return this.searchTerm;
  }

  setSearchTerm(term: string): void {
    this.searchTerm = term.trim();
    this.refresh();
  }

  getFilters(): RadarFilters {
    return this.filters;
  }

  setFilters(filters: RadarFilters): void {
    this.filters = filters;
    this.refresh();
  }

  /** Distinct, sorted category values from the current radar cache, for the filter quick-pick. */
  getAvailableCategories(): string[] {
    const entries = parseRepoRadar(this.radarFilePath);
    return [...new Set(entries.map(([repoPath]) => repoCategory(repoPath, this.vcsRoot)))].sort();
  }

  /** Distinct, sorted stack values from the current radar cache, for the filter quick-pick. */
  getAvailableStacks(): string[] {
    const entries = parseRepoRadar(this.radarFilePath);
    return [...new Set(entries.map(([, meta]) => meta.stack).filter((stack): stack is string => Boolean(stack)))].sort();
  }

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

  getGroupByStatus(): boolean {
    return this.state.get(GROUP_BY_STATUS_STATE_KEY, false);
  }

  async setGroupByStatus(value: boolean): Promise<void> {
    await this.state.update(GROUP_BY_STATUS_STATE_KEY, value);
    this.refresh();
  }

  getProviderOverride(): string {
    return this.state.get(PROVIDER_OVERRIDE_STATE_KEY, "");
  }

  async setProviderOverride(value: string): Promise<void> {
    await this.state.update(PROVIDER_OVERRIDE_STATE_KEY, value);
    this.refresh();
  }

  getGenerateInfraOverview(): boolean {
    return this.state.get(INFRA_OVERVIEW_STATE_KEY, false);
  }

  async setGenerateInfraOverview(value: boolean): Promise<void> {
    await this.state.update(INFRA_OVERVIEW_STATE_KEY, value);
    this.refresh();
  }

  refresh(): void {
    this._onDidChangeTreeData.fire();
  }

  getTreeItem(element: vscode.TreeItem): vscode.TreeItem {
    return element;
  }

  /** Splits repos into RepoStatusGroupItem buckets using the already-populated dirtyCache -- shared by the category and workspace-section branches of getChildren. */
  private buildStatusGroups(repos: Array<[string, RepoMeta]>): RepoStatusGroupItem[] {
    const buckets: Record<RepoStatusBucket, Array<[string, RepoMeta]>> = { dirty: [], "needs-index": [], indexed: [] };
    for (const entry of repos) {
      buckets[repoStatusBucket(entry[1], this.dirtyCache.get(entry[0]) ?? false)].push(entry);
    }
    const order: RepoStatusBucket[] = ["dirty", "needs-index", "indexed"];
    return order.filter((bucket) => buckets[bucket].length > 0).map((bucket) => new RepoStatusGroupItem(bucket, buckets[bucket], this.dirtyCache));
  }

  async getChildren(
    element?: RepoCategoryItem | WorkspaceCategoryItem | FavoritesCategoryItem | OptionsSectionItem | SearchSectionItem | RepoStatusGroupItem,
  ): Promise<vscode.TreeItem[]> {
    if (element instanceof OptionsSectionItem) {
      return [
        new BackgroundIndexingControlItem(this.getBackgroundIndexing()),
        new ProviderOverrideControlItem(this.getProviderOverride()),
        new InfraOverviewControlItem(this.getGenerateInfraOverview()),
        new GroupByStatusControlItem(this.getGroupByStatus()),
      ];
    }
    if (element instanceof SearchSectionItem) {
      return [new SearchControlItem(this.searchTerm), new FilterControlItem(summarizeFilters(this.filters))];
    }
    if (element instanceof RepoStatusGroupItem) {
      return element.repos.map(([repoPath, meta]) => new RepoTreeItem(repoPath, meta, element.dirtyByPath.get(repoPath) ?? false, this.isFavorite(repoPath)));
    }
    if (element instanceof WorkspaceCategoryItem) {
      // dirtyCache is already populated from this same tree refresh's root
      // getChildren() call below -- see its field comment for why that
      // ordering is guaranteed rather than assumed.
      if (this.getGroupByStatus()) return this.buildStatusGroups(element.repos);
      return element.repos.map(([repoPath, meta]) => new RepoTreeItem(repoPath, meta, this.dirtyCache.get(repoPath) ?? false, this.isFavorite(repoPath)));
    }
    if (element instanceof FavoritesCategoryItem) {
      return element.repos.map(([repoPath, meta]) => new RepoTreeItem(repoPath, meta, this.dirtyCache.get(repoPath) ?? false, true));
    }
    if (element) {
      if (this.getGroupByStatus()) return this.buildStatusGroups(element.repos);
      return element.repos.map(([repoPath, meta]) => new RepoTreeItem(repoPath, meta, this.dirtyCache.get(repoPath) ?? false, this.isFavorite(repoPath)));
    }
    try {
      const cacheEntries = parseRepoRadar(this.radarFilePath);
      // Summary counts stay against the full, unfiltered cache -- it's the
      // "state of the whole radar" line, not a count of what search/filter
      // happen to be narrowing the tree down to right now.
      const needsIndex = cacheEntries.filter(([, meta]) => hasIndexGap(meta)).length;

      const matchesSearchAndFilters = ([repoPath, meta]: [string, RepoMeta]) =>
        matchesSearch(repoPath, meta, this.searchTerm) && matchesFilters(repoPath, meta, this.filters, this.vcsRoot);
      const visibleEntries = cacheEntries.filter(matchesSearchAndFilters);

      const openRepos = findOpenWorkspaceRepos(cacheEntries).filter(matchesSearchAndFilters);
      const workspaceSection = openRepos.length > 0 ? [new WorkspaceCategoryItem(openRepos)] : [];

      const metaByPath = new Map([...cacheEntries, ...openRepos]);
      const favoriteEntries: Array<[string, RepoMeta]> = this.getFavoritePaths()
        .filter((repoPath) => metaByPath.has(repoPath))
        .map((repoPath): [string, RepoMeta] => [repoPath, metaByPath.get(repoPath)!])
        .filter(matchesSearchAndFilters);
      const favoritesSection = favoriteEntries.length > 0 ? [new FavoritesCategoryItem(favoriteEntries)] : [];

      // One `git status --porcelain` per known repo (cached + open, deduped),
      // run in parallel -- ~100 short-lived child processes is well within
      // what a sidebar refresh can afford, and this is the one place the
      // whole tree's dirty state is computed; every branch above reads the
      // result back out of dirtyCache rather than re-running git itself.
      const allPaths = [...metaByPath.keys()];
      const dirtyFlags = await Promise.all(allPaths.map((repoPath) => isDirty(repoPath)));
      this.dirtyCache = new Map(allPaths.map((repoPath, i) => [repoPath, dirtyFlags[i]]));
      const dirtyCount = dirtyFlags.filter(Boolean).length;

      const summary = new SummaryItem(cacheEntries.length, needsIndex, dirtyCount);
      const optionsSection = new OptionsSectionItem();
      const searchSection = new SearchSectionItem();

      return [
        summary,
        optionsSection,
        searchSection,
        ...favoritesSection,
        ...workspaceSection,
        ...groupByCategory(visibleEntries, this.vcsRoot),
      ];
    } catch (err) {
      return [new RepoErrorItem(err instanceof Error ? err.message : String(err))];
    }
  }
}
