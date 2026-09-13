import * as vscode from "vscode";
import { runFrameworkJson } from "./framework";

// Fields as emitted by `docker ps --format '{{json .}}'` -- docker's own
// per-container shape, not something this extension defines.
interface DockerContainer {
  ID: string;
  Names: string;
  Image: string;
  State: string;
  Status: string;
  Ports: string;
  RunningFor: string;
  Labels: string;
}

const RUNNING_ICON = new vscode.ThemeIcon("play-circle", new vscode.ThemeColor("testing.iconPassed"));
const STOPPED_ICON = new vscode.ThemeIcon("stop-circle", new vscode.ThemeColor("disabledForeground"));

/** Name shown for containers with no Compose project label (a plain `docker run`, not a compose stack). */
const UNGROUPED_LABEL = "Ungrouped";

/**
 * Docker Compose stamps `com.docker.compose.project.working_dir` on every
 * container it starts -- the exact absolute path of the directory holding
 * its `docker-compose.yml`, which for this user's homelab stacks is also
 * the repo root. Parsed from the flat `Labels` string (`docker ps`'s own
 * comma-joined `key=value,...` format) rather than a real object, since
 * that's the shape `docker ps --format json` gives it.
 */
function dockerComposeRepo(container: DockerContainer): string | undefined {
  const match = container.Labels.match(/(?:^|,)com\.docker\.compose\.project\.working_dir=([^,]*)/);
  if (!match || !match[1]) return undefined;
  return match[1].split(/[/\\]/).filter(Boolean).pop();
}

export class DockerContainerItem extends vscode.TreeItem {
  /** Container name -- what docker's own CLI (start/stop/restart/exec/logs) accepts as a target, same as the Names column shown here. */
  readonly containerName: string;

  constructor(container: DockerContainer) {
    super(container.Names, vscode.TreeItemCollapsibleState.None);
    this.containerName = container.Names;
    this.description = container.Status;
    this.iconPath = container.State === "running" ? RUNNING_ICON : STOPPED_ICON;
    this.tooltip = new vscode.MarkdownString(
      `**${container.Names}**\n\n` +
        `- Image: ${container.Image}\n` +
        `- Status: ${container.Status}\n` +
        `- Ports: ${container.Ports || "none"}\n` +
        `- Running for: ${container.RunningFor}`,
    );
    // Suffixed with the container's running/stopped state so package.json's
    // view/item/context menu can show Start only for a stopped container and
    // Stop/Restart/Shell only for a running one -- the same adaptive action
    // set docker-containers' own interactive console already applies.
    this.contextValue = container.State === "running" ? "mtDevopsContainer-running" : "mtDevopsContainer-stopped";
  }
}

export class DockerRepoGroupItem extends vscode.TreeItem {
  constructor(
    public readonly repo: string,
    public readonly containers: DockerContainer[],
  ) {
    super(repo, vscode.TreeItemCollapsibleState.Expanded);
    this.description = `${containers.length} container${containers.length === 1 ? "" : "s"}`;
    this.iconPath = new vscode.ThemeIcon(repo === UNGROUPED_LABEL ? "folder" : "repo");
    this.contextValue = "mtDevopsDockerRepoGroup";
  }
}

class DockerErrorItem extends vscode.TreeItem {
  constructor(message: string) {
    super(message, vscode.TreeItemCollapsibleState.None);
    this.iconPath = new vscode.ThemeIcon("error");
  }
}

const GROUP_BY_REPO_STATE_KEY = "mtDevops.dockerGroupByRepo";

/**
 * Groups containers by their Compose project's repo directory, sorted
 * alphabetically with the label-less "Ungrouped" bucket last since it's
 * leftover containers rather than a deliberate group.
 */
function groupByRepo(containers: DockerContainer[]): DockerRepoGroupItem[] {
  const byRepo = new Map<string, DockerContainer[]>();
  for (const container of containers) {
    const repo = dockerComposeRepo(container) ?? UNGROUPED_LABEL;
    if (!byRepo.has(repo)) byRepo.set(repo, []);
    byRepo.get(repo)!.push(container);
  }

  const repos = [...byRepo.keys()].sort((a, b) => {
    if (a === UNGROUPED_LABEL) return 1;
    if (b === UNGROUPED_LABEL) return -1;
    return a.localeCompare(b);
  });
  return repos.map((repo) => new DockerRepoGroupItem(repo, byRepo.get(repo)!.sort((a, b) => a.Names.localeCompare(b.Names))));
}

export class DockerProvider implements vscode.TreeDataProvider<vscode.TreeItem> {
  private readonly _onDidChangeTreeData = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  constructor(private readonly state: vscode.Memento) {}

  get groupByRepo(): boolean {
    return this.state.get(GROUP_BY_REPO_STATE_KEY, false);
  }

  async toggleGroupByRepo(): Promise<void> {
    await this.state.update(GROUP_BY_REPO_STATE_KEY, !this.groupByRepo);
    this.refresh();
  }

  refresh(): void {
    this._onDidChangeTreeData.fire();
  }

  getTreeItem(element: vscode.TreeItem): vscode.TreeItem {
    return element;
  }

  async getChildren(element?: DockerRepoGroupItem): Promise<vscode.TreeItem[]> {
    if (element) {
      return element.containers.map((container) => new DockerContainerItem(container));
    }
    try {
      const containers = await runFrameworkJson<DockerContainer[]>("docker-ls --json");
      if (this.groupByRepo) return groupByRepo(containers);
      return containers
        .sort((a, b) => a.Names.localeCompare(b.Names))
        .map((container) => new DockerContainerItem(container));
    } catch (err) {
      return [new DockerErrorItem(err instanceof Error ? err.message : String(err))];
    }
  }
}
