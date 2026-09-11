import * as fs from "node:fs";
import * as vscode from "vscode";

interface Job {
  id: string;
  pid: string;
  name: string;
  startTime: number;
  endTime: number | null;
  status: string;
  logFile: string;
  cmd: string;
}

const STATUS_ICONS: Record<string, vscode.ThemeIcon> = {
  RUNNING: new vscode.ThemeIcon("sync~spin"),
  SUCCESS: new vscode.ThemeIcon("pass", new vscode.ThemeColor("testing.iconPassed")),
  FAILED: new vscode.ThemeIcon("error", new vscode.ThemeColor("testing.iconFailed")),
};

/**
 * Parses `$CACHE_DIR/.mt_jobs.tsv`, the background job registry written
 * by __mt_bg_run (.bash.d/02-utilities/34-jobs.sh). Schema per line:
 * job_id|pid|job_name|start_time|end_time|status|log_file|cmd_string
 * (end_time is empty while a job is still RUNNING).
 */
function parseJobsFile(jobsFilePath: string): Job[] {
  if (!fs.existsSync(jobsFilePath)) return [];

  const lines = fs.readFileSync(jobsFilePath, "utf8").split("\n").filter((l) => l.trim().length > 0);
  const jobs: Job[] = [];

  for (const line of lines) {
    const [id, pid, name, startTime, endTime, status, logFile, cmd] = line.split("|");
    if (!id) continue;
    jobs.push({
      id,
      pid,
      name,
      startTime: Number(startTime) || 0,
      endTime: endTime ? Number(endTime) : null,
      status: status || "UNKNOWN",
      logFile,
      cmd,
    });
  }

  return jobs.sort((a, b) => b.startTime - a.startTime);
}

function formatDuration(job: Job): string {
  if (!job.startTime) return "";
  const end = job.endTime ?? Math.floor(Date.now() / 1000);
  const seconds = Math.max(0, end - job.startTime);
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  return `${Math.floor(seconds / 3600)}h ${Math.floor((seconds % 3600) / 60)}m`;
}

class JobTreeItem extends vscode.TreeItem {
  constructor(job: Job) {
    super(job.name, vscode.TreeItemCollapsibleState.None);
    this.description = `${job.status} · ${formatDuration(job)}`;
    this.iconPath = STATUS_ICONS[job.status] ?? new vscode.ThemeIcon("question");
    this.tooltip = new vscode.MarkdownString(
      `**${job.name}**\n\n` +
        `- Status: ${job.status}\n` +
        `- PID: ${job.pid}\n` +
        `- Started: ${job.startTime ? new Date(job.startTime * 1000).toLocaleString() : "unknown"}\n` +
        `- Command: \`${job.cmd}\`\n` +
        `- Log: ${job.logFile}`,
    );
    if (job.logFile && fs.existsSync(job.logFile)) {
      this.command = {
        command: "vscode.open",
        title: "Open Log",
        arguments: [vscode.Uri.file(job.logFile)],
      };
    }
    this.contextValue = "mtDevopsJob";
  }
}

export class JobsProvider implements vscode.TreeDataProvider<JobTreeItem> {
  private readonly _onDidChangeTreeData = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  constructor(private readonly jobsFilePath: string) {}

  refresh(): void {
    this._onDidChangeTreeData.fire();
  }

  getTreeItem(element: JobTreeItem): vscode.TreeItem {
    return element;
  }

  getChildren(): JobTreeItem[] {
    return parseJobsFile(this.jobsFilePath).map((job) => new JobTreeItem(job));
  }
}
