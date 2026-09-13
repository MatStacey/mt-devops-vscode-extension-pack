import * as fs from "node:fs";
import * as vscode from "vscode";

type LogLevel = "INFO" | "SUCCESS" | "WARN" | "ERROR" | "OTHER";

interface LogEntry {
  timestamp: string;
  level: LogLevel;
  message: string;
}

/** Only the most recent entries are ever shown -- the underlying file can grow up to LOG_ROTATE_BYTES (1MB default, see mt-log in 02-utilities/35-logging.sh) before rotating, far more than a sidebar list should ever render. */
const MAX_DISPLAYED_ENTRIES = 300;

const LEVEL_ICONS: Record<LogLevel, vscode.ThemeIcon> = {
  ERROR: new vscode.ThemeIcon("error", new vscode.ThemeColor("testing.iconFailed")),
  WARN: new vscode.ThemeIcon("warning", new vscode.ThemeColor("testing.iconQueued")),
  SUCCESS: new vscode.ThemeIcon("pass", new vscode.ThemeColor("testing.iconPassed")),
  INFO: new vscode.ThemeIcon("info"),
  OTHER: new vscode.ThemeIcon("circle-outline"),
};

// Mirrors mt-logs' own jq capture pattern exactly
// (`^\[(?<ts>[^]]+)\] \[(?<level>[^]]+)\] (?<message>.*)$`) so a line
// this doesn't match is genuinely not one mt-log wrote (e.g. edited by
// hand), not a regex drift between the two implementations.
const LOG_LINE_PATTERN = /^\[([^\]]+)\] \[([^\]]+)\] (.*)$/;

/**
 * Reads and parses `$LOG_DIR/framework.log` directly rather than
 * shelling out to `mt-logs -j` -- this view auto-refreshes on every
 * file change (mt-log appends on nearly every framework command), and
 * a `bash -ic` round trip per append would be both slow and wasteful
 * for something this cheap to parse in-process. The line format itself
 * is simple enough that duplicating it here doesn't risk drifting from
 * real framework policy the way reimplementing e.g. secrets or index
 * logic would.
 */
function parseLogFile(logFilePath: string): LogEntry[] {
  if (!fs.existsSync(logFilePath)) return [];
  const lines = fs.readFileSync(logFilePath, "utf8").split("\n").filter((l) => l.trim().length > 0);
  const entries: LogEntry[] = lines.map((line) => {
    const match = line.match(LOG_LINE_PATTERN);
    if (!match) return { timestamp: "", level: "OTHER", message: line };
    const [, timestamp, rawLevel, message] = match;
    const level: LogLevel = rawLevel in LEVEL_ICONS ? (rawLevel as LogLevel) : "OTHER";
    return { timestamp, level, message };
  });
  // Newest first -- a sidebar list is scanned top-down, and mt-log
  // appends chronologically, so the tail of the file (its most recent
  // activity) is what belongs at the top.
  return entries.slice(-MAX_DISPLAYED_ENTRIES).reverse();
}

export class LogEntryItem extends vscode.TreeItem {
  constructor(entry: LogEntry) {
    super(entry.message, vscode.TreeItemCollapsibleState.None);
    this.description = entry.timestamp;
    this.iconPath = LEVEL_ICONS[entry.level];
    this.tooltip = new vscode.MarkdownString(
      `**${entry.level}**${entry.timestamp ? ` -- ${entry.timestamp}` : ""}\n\n${entry.message}`,
    );
    this.contextValue = "mtDevopsLogEntry";
  }
}

class LogErrorItem extends vscode.TreeItem {
  constructor(message: string) {
    super(message, vscode.TreeItemCollapsibleState.None);
    this.iconPath = new vscode.ThemeIcon("error");
  }
}

export class LogProvider implements vscode.TreeDataProvider<LogEntryItem> {
  private readonly _onDidChangeTreeData = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  constructor(private readonly logFilePath: string) {}

  refresh(): void {
    this._onDidChangeTreeData.fire();
  }

  getTreeItem(element: LogEntryItem): vscode.TreeItem {
    return element;
  }

  getChildren(): vscode.TreeItem[] {
    try {
      const entries = parseLogFile(this.logFilePath);
      return entries.length > 0 ? entries.map((entry) => new LogEntryItem(entry)) : [new LogErrorItem("No log entries yet.")];
    } catch (err) {
      return [new LogErrorItem(err instanceof Error ? err.message : String(err))];
    }
  }
}
