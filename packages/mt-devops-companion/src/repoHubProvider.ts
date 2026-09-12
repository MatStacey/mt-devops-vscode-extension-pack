import * as fs from "node:fs";
import * as path from "node:path";
import * as vscode from "vscode";

export interface RepoMeta {
  category?: string;
  description?: string;
  stack?: string;
  build?: string;
  cicd?: string;
  testing?: string;
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
  ) {
    super(path.basename(repoPath), vscode.TreeItemCollapsibleState.None);
    this.description = meta.stack || meta.category || "";
    this.iconPath = new vscode.ThemeIcon("repo");
    this.tooltip = new vscode.MarkdownString(
      `**${repoPath}**\n\n` +
        `${meta.description || "No description available."}\n\n` +
        `- Category: ${meta.category ?? "Unknown"}\n` +
        `- Stack: ${meta.stack ?? "Unknown"}\n` +
        `- Build: ${meta.build ?? "None"}\n` +
        `- CI/CD: ${meta.cicd ?? "None"}\n` +
        `- Testing: ${meta.testing ?? "None"}`,
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

class RepoErrorItem extends vscode.TreeItem {
  constructor(message: string) {
    super(message, vscode.TreeItemCollapsibleState.None);
    this.iconPath = new vscode.ThemeIcon("error");
  }
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

export class RepoHubProvider implements vscode.TreeDataProvider<vscode.TreeItem> {
  private readonly _onDidChangeTreeData = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  constructor(
    private readonly hubFilePath: string,
    private readonly vcsRoot: string,
  ) {}

  refresh(): void {
    this._onDidChangeTreeData.fire();
  }

  getTreeItem(element: vscode.TreeItem): vscode.TreeItem {
    return element;
  }

  getChildren(element?: RepoCategoryItem | WorkspaceCategoryItem): vscode.TreeItem[] {
    if (element) {
      return element.repos.map(([repoPath, meta]) => new RepoTreeItem(repoPath, meta));
    }
    try {
      const cacheEntries = parseRepoHub(this.hubFilePath);
      const openRepos = findOpenWorkspaceRepos(cacheEntries);
      const workspaceSection = openRepos.length > 0 ? [new WorkspaceCategoryItem(openRepos)] : [];
      return [...workspaceSection, ...groupByCategory(cacheEntries, this.vcsRoot)];
    } catch (err) {
      return [new RepoErrorItem(err instanceof Error ? err.message : String(err))];
    }
  }
}
