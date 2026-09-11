import * as vscode from "vscode";
import { runFrameworkJson } from "./framework";

interface K8sStatus {
  context: string;
  namespace: string;
  server_version: string;
  nodes: number;
  pods: number;
}

// Subset of kubectl's own pod JSON shape (`kubectl get pods -o json`) --
// only the fields this view actually renders.
interface K8sPod {
  metadata: { name: string; namespace?: string };
  status: {
    phase: string;
    containerStatuses?: { ready: boolean; restartCount: number }[];
  };
  spec: { nodeName?: string };
}

interface K8sPodList {
  items: K8sPod[];
}

const PHASE_ICONS: Record<string, vscode.ThemeIcon> = {
  Running: new vscode.ThemeIcon("play-circle", new vscode.ThemeColor("testing.iconPassed")),
  Pending: new vscode.ThemeIcon("clock", new vscode.ThemeColor("testing.iconQueued")),
  Succeeded: new vscode.ThemeIcon("pass", new vscode.ThemeColor("testing.iconPassed")),
  Failed: new vscode.ThemeIcon("error", new vscode.ThemeColor("testing.iconFailed")),
};

class K8sContextItem extends vscode.TreeItem {
  constructor(status: K8sStatus) {
    super(status.context, vscode.TreeItemCollapsibleState.None);
    this.description = `ns: ${status.namespace} · ${status.nodes} node(s)`;
    this.iconPath = new vscode.ThemeIcon("cloud");
    this.tooltip = new vscode.MarkdownString(
      `**${status.context}**\n\n` +
        `- Namespace: ${status.namespace}\n` +
        `- Server: ${status.server_version}\n` +
        `- Nodes: ${status.nodes}\n` +
        `- Pods (namespace): ${status.pods}`,
    );
  }
}

class K8sPodItem extends vscode.TreeItem {
  constructor(pod: K8sPod) {
    super(pod.metadata.name, vscode.TreeItemCollapsibleState.None);
    const statuses = pod.status.containerStatuses ?? [];
    const ready = statuses.filter((c) => c.ready).length;
    const restarts = statuses.reduce((sum, c) => sum + c.restartCount, 0);
    this.description = `${pod.status.phase} · ${ready}/${statuses.length} ready${restarts > 0 ? ` · ${restarts} restart(s)` : ""}`;
    this.iconPath = PHASE_ICONS[pod.status.phase] ?? new vscode.ThemeIcon("question");
    this.tooltip = new vscode.MarkdownString(
      `**${pod.metadata.name}**\n\n` +
        `- Namespace: ${pod.metadata.namespace ?? "unknown"}\n` +
        `- Phase: ${pod.status.phase}\n` +
        `- Ready: ${ready}/${statuses.length}\n` +
        `- Restarts: ${restarts}\n` +
        `- Node: ${pod.spec.nodeName ?? "unassigned"}`,
    );
    this.contextValue = "mtDevopsPod";
  }
}

class K8sErrorItem extends vscode.TreeItem {
  constructor(message: string) {
    super(message, vscode.TreeItemCollapsibleState.None);
    this.iconPath = new vscode.ThemeIcon("error");
  }
}

export class KubernetesProvider implements vscode.TreeDataProvider<vscode.TreeItem> {
  private readonly _onDidChangeTreeData = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  refresh(): void {
    this._onDidChangeTreeData.fire();
  }

  getTreeItem(element: vscode.TreeItem): vscode.TreeItem {
    return element;
  }

  async getChildren(): Promise<vscode.TreeItem[]> {
    let status: K8sStatus;
    try {
      status = await runFrameworkJson<K8sStatus>("k8s-status --json");
    } catch (err) {
      return [new K8sErrorItem(err instanceof Error ? err.message : String(err))];
    }

    const items: vscode.TreeItem[] = [new K8sContextItem(status)];
    try {
      const podList = await runFrameworkJson<K8sPodList>("k8s-pods --json");
      items.push(...podList.items.map((pod) => new K8sPodItem(pod)));
    } catch (err) {
      items.push(new K8sErrorItem(`Pods: ${err instanceof Error ? err.message : String(err)}`));
    }
    return items;
  }
}
