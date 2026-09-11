import { execFile } from "node:child_process";
import * as path from "node:path";
import * as vscode from "vscode";
import type { RepoMeta } from "./repoHubProvider";

interface CommitEntry {
  hash: string;
  subject: string;
  relativeDate: string;
}

/** Reads the 5 most recent commits via a plain, read-only `git log` -- not framework policy, just a local git query, same as __mt_hub_preview's own bash equivalent. */
function readRecentCommits(repoPath: string): Promise<CommitEntry[]> {
  return new Promise((resolve) => {
    execFile(
      "git",
      ["-C", repoPath, "log", "-5", "--format=%h%x1f%s%x1f%cr"],
      { maxBuffer: 1024 * 1024 },
      (error, stdout) => {
        if (error || !stdout.trim()) {
          resolve([]);
          return;
        }
        const commits = stdout
          .trim()
          .split("\n")
          .map((line) => {
            const [hash, subject, relativeDate] = line.split("\x1f");
            return { hash, subject, relativeDate };
          });
        resolve(commits);
      },
    );
  });
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function metaRow(label: string, value: string): string {
  return `<tr><td class="label">${escapeHtml(label)}</td><td>${escapeHtml(value)}</td></tr>`;
}

function buildHtml(repoPath: string, meta: RepoMeta, commits: CommitEntry[], nonce: string): string {
  const commitsHtml = commits.length
    ? commits
        .map(
          (c) =>
            `<li><code>${escapeHtml(c.hash)}</code> ${escapeHtml(c.subject)} <span class="dim">(${escapeHtml(c.relativeDate)})</span></li>`,
        )
        .join("")
    : "<li class='dim'>No commits yet.</li>";

  const lastIndexed = meta.last_indexed
    ? new Date(meta.last_indexed * 1000).toLocaleString()
    : "Never (run Index This Repo)";

  return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">
<style>
  body { font-family: var(--vscode-font-family); color: var(--vscode-foreground); padding: 0 24px 24px; }
  h1 { font-size: 1.4em; word-break: break-all; }
  .path { color: var(--vscode-descriptionForeground); font-size: 0.9em; margin-top: -8px; word-break: break-all; }
  .description { font-size: 1.05em; margin: 16px 0; }
  table { border-collapse: collapse; margin: 12px 0; }
  td { padding: 4px 12px 4px 0; vertical-align: top; }
  td.label { color: var(--vscode-descriptionForeground); white-space: nowrap; }
  h2 { font-size: 1em; text-transform: uppercase; letter-spacing: 0.05em; color: var(--vscode-descriptionForeground); margin-top: 28px; }
  ul { padding-left: 18px; }
  li { margin: 4px 0; }
  code { background: var(--vscode-textCodeBlock-background); padding: 1px 5px; border-radius: 3px; }
  .dim { color: var(--vscode-descriptionForeground); }
  button {
    background: var(--vscode-button-background);
    color: var(--vscode-button-foreground);
    border: none; padding: 8px 16px; border-radius: 2px; cursor: pointer; font-size: 0.95em; margin-top: 20px;
  }
  button:hover { background: var(--vscode-button-hoverBackground); }
</style>
</head>
<body>
  <h1>${escapeHtml(path.basename(repoPath))}</h1>
  <div class="path">${escapeHtml(repoPath)}</div>
  <div class="description">${escapeHtml(meta.description || "No description available.")}</div>

  <h2>Architecture Metadata</h2>
  <table>
    ${metaRow("Category", meta.category ?? "Unknown")}
    ${metaRow("Tech Stack", meta.stack ?? "Unknown")}
    ${metaRow("Build Tools", meta.build ?? "None")}
    ${metaRow("CI/CD", meta.cicd ?? "None")}
    ${metaRow("Testing", meta.testing ?? "None")}
    ${metaRow("Last Indexed", lastIndexed)}
  </table>

  <h2>Recent Commits</h2>
  <ul>${commitsHtml}</ul>

  <button id="openBtn">Open in VS Code</button>

  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    document.getElementById("openBtn").addEventListener("click", () => {
      vscode.postMessage({ command: "openInVSCode" });
    });
  </script>
</body>
</html>`;
}

function getNonce(): string {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  return Array.from({ length: 32 }, () => chars[Math.floor(Math.random() * chars.length)]).join("");
}

let activePanel: vscode.WebviewPanel | undefined;
// The repo path the *currently displayed* report is for -- read by the
// message handler at click time rather than captured per-call, since the
// panel (and its onDidReceiveMessage subscription) is created only once
// and reused across every repo the user clicks through. Capturing
// `repoPath` in a per-call listener instead would stack up one handler
// per repo viewed, each still firing for its own now-stale path, so
// clicking "Open in VS Code" after viewing 3 repos would open all 3.
let displayedRepoPath = "";

/**
 * Shows (or reuses, if already open) a single report panel for a repo's
 * cached mt-hub metadata plus its recent commit history. Reused across
 * clicks rather than opening a new tab per repo, matching how the
 * extension already reuses one terminal for framework commands.
 */
export async function showRepoReport(repoPath: string, meta: RepoMeta): Promise<void> {
  const commits = await readRecentCommits(repoPath);
  const nonce = getNonce();
  displayedRepoPath = repoPath;

  if (!activePanel) {
    activePanel = vscode.window.createWebviewPanel("mtDevopsRepoReport", "Repo Report", vscode.ViewColumn.Active, {
      enableScripts: true,
      retainContextWhenHidden: false,
    });
    activePanel.onDidDispose(() => {
      activePanel = undefined;
    });
    activePanel.webview.onDidReceiveMessage((message: { command: string }) => {
      if (message.command === "openInVSCode") {
        vscode.commands.executeCommand("vscode.openFolder", vscode.Uri.file(displayedRepoPath), {
          forceNewWindow: true,
        });
      }
    });
  }

  activePanel.title = path.basename(repoPath);
  activePanel.webview.html = buildHtml(repoPath, meta, commits, nonce);
  activePanel.reveal(vscode.ViewColumn.Active);
}
