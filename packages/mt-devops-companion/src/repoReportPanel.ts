import { execFile } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { marked } from "marked";
import * as vscode from "vscode";
import type { RepoMeta } from "./repoHubProvider";

interface CommitEntry {
  hash: string;
  subject: string;
  relativeDate: string;
}

interface RemoteInfo {
  /** e.g. "https://github.com/MatStacey/mt-devops-framework" -- always without a trailing slash or ".git". */
  webUrl: string;
  /** e.g. "https://github.com/MatStacey/mt-devops-framework/commit/" -- append a hash directly. */
  commitUrlBase: string;
}

interface BranchInfo {
  name: string;
  hasLocal: boolean;
}

interface ReportData {
  commits: CommitEntry[];
  remote: RemoteInfo | null;
  branches: BranchInfo[];
  behindCount: number;
  readmeHtml: string | null;
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

function runGit(repoPath: string, args: string[]): Promise<string> {
  return new Promise((resolve) => {
    execFile("git", ["-C", repoPath, ...args], { maxBuffer: 1024 * 1024 }, (error, stdout) => {
      resolve(error ? "" : stdout.trim());
    });
  });
}

/** Runs a git command that mutates repo state (pull/fetch); resolves with stderr (or the error message) on failure, "" on success. */
function execGit(repoPath: string, args: string[]): Promise<string> {
  return new Promise((resolve) => {
    execFile("git", ["-C", repoPath, ...args], { maxBuffer: 1024 * 1024 }, (error, _stdout, stderr) => {
      resolve(error ? stderr.trim() || error.message : "");
    });
  });
}

/**
 * Parses `git remote get-url origin` into a browsable web URL and a
 * commit-permalink base, covering both SSH (`git@host:owner/repo.git`)
 * and HTTPS (`https://host/owner/repo.git`) remote forms. Bitbucket
 * Cloud uses `/commits/<hash>` (plural) while GitHub/GitLab use
 * `/commit/<hash>` (singular) -- everything else falls back to the
 * GitHub-style singular form, which also happens to be self-hosted
 * GitLab/Gitea's convention.
 */
function parseRemoteUrl(remoteUrl: string): RemoteInfo | null {
  const trimmed = remoteUrl.trim();
  if (!trimmed) return null;

  let host: string;
  let repoPath: string;

  const sshMatch = trimmed.match(/^(?:ssh:\/\/)?git@([^:/]+)[:/](.+)$/);
  const httpMatch = trimmed.match(/^https?:\/\/(?:[^@/]+@)?([^/]+)\/(.+)$/);

  if (sshMatch) {
    [, host, repoPath] = sshMatch;
  } else if (httpMatch) {
    [, host, repoPath] = httpMatch;
  } else {
    return null;
  }

  repoPath = repoPath.replace(/\.git$/, "").replace(/\/+$/, "");
  const webUrl = `https://${host}/${repoPath}`;
  const commitSegment = host === "bitbucket.org" ? "commits" : "commit";
  return { webUrl, commitUrlBase: `${webUrl}/${commitSegment}/` };
}

/** Local branch names, via `git branch --format`, not the interactive picker used elsewhere. */
async function readLocalBranches(repoPath: string): Promise<Set<string>> {
  const output = await runGit(repoPath, ["branch", "--format=%(refname:short)"]);
  return new Set(output ? output.split("\n") : []);
}

/** Remote-tracking branch names under origin/, with the "origin/" prefix stripped and origin/HEAD excluded. */
async function readRemoteBranches(repoPath: string): Promise<string[]> {
  const output = await runGit(repoPath, ["branch", "-r", "--format=%(refname:short)"]);
  if (!output) return [];
  return output
    .split("\n")
    .map((line) => line.replace(/^origin\//, ""))
    .filter((name) => name && name !== "HEAD");
}

/** How many commits the current branch is behind its upstream, or 0 if there's no upstream (e.g. a detached HEAD or a branch never pushed). */
async function readBehindCount(repoPath: string): Promise<number> {
  const output = await runGit(repoPath, ["rev-list", "--count", "HEAD..@{u}"]);
  const count = Number(output);
  return Number.isFinite(count) ? count : 0;
}

function findReadme(repoPath: string): string | null {
  const candidates = fs.existsSync(repoPath) ? fs.readdirSync(repoPath) : [];
  const readme = candidates.find((name) => /^readme(\.md|\.markdown|\.txt)?$/i.test(name));
  return readme ? path.join(repoPath, readme) : null;
}

async function renderReadme(repoPath: string): Promise<string | null> {
  const readmePath = findReadme(repoPath);
  if (!readmePath) return null;
  try {
    const raw = await fs.promises.readFile(readmePath, "utf8");
    return path.extname(readmePath).toLowerCase() === ".txt"
      ? `<pre>${escapeHtml(raw)}</pre>`
      : await marked.parse(raw);
  } catch {
    return null;
  }
}

async function collectReportData(repoPath: string): Promise<ReportData> {
  const remoteUrl = await runGit(repoPath, ["remote", "get-url", "origin"]);
  const remote = remoteUrl ? parseRemoteUrl(remoteUrl) : null;

  const [commits, localBranches, remoteBranchNames, behindCount, readmeHtml] = await Promise.all([
    readRecentCommits(repoPath),
    readLocalBranches(repoPath),
    readRemoteBranches(repoPath),
    readBehindCount(repoPath),
    renderReadme(repoPath),
  ]);

  const branches = remoteBranchNames.map((name) => ({ name, hasLocal: localBranches.has(name) }));
  return { commits, remote, branches, behindCount, readmeHtml };
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

function buildCommitsHtml(commits: CommitEntry[], remote: RemoteInfo | null): string {
  if (!commits.length) return "<li class='dim'>No commits yet.</li>";
  return commits
    .map((c) => {
      const hashHtml = remote
        ? `<a href="${escapeHtml(remote.commitUrlBase + c.hash)}">${escapeHtml(c.hash)}</a>`
        : escapeHtml(c.hash);
      return `<li><code>${hashHtml}</code> ${escapeHtml(c.subject)} <span class="dim">(${escapeHtml(c.relativeDate)})</span></li>`;
    })
    .join("");
}

function buildBranchesHtml(branches: BranchInfo[]): string {
  if (!branches.length) return "<li class='dim'>No remote branches found.</li>";
  return branches
    .map((b) => {
      const action = b.hasLocal
        ? `<span class="dim">Already local</span>`
        : `<button class="fetchBtn" data-branch="${escapeHtml(b.name)}">Fetch</button>`;
      return `<li><code>${escapeHtml(b.name)}</code> ${action}</li>`;
    })
    .join("");
}

function buildHtml(repoPath: string, meta: RepoMeta, data: ReportData, nonce: string): string {
  const lastIndexed = meta.last_indexed
    ? new Date(meta.last_indexed * 1000).toLocaleString()
    : "Never (run Index This Repo)";

  const browserButton = data.remote
    ? `<button id="openBrowserBtn">Open in Browser</button>`
    : `<span class="dim">No recognized remote (add a GitHub/Bitbucket "origin" to enable)</span>`;

  const pullButton =
    data.behindCount > 0
      ? `<button id="pullBtn">Update (Pull ${data.behindCount} commit${data.behindCount === 1 ? "" : "s"})</button>`
      : "";

  const readmeSection = data.readmeHtml
    ? `<h2>README</h2><div class="readme">${data.readmeHtml}</div>`
    : "";

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
  a { color: var(--vscode-textLink-foreground); }
  .dim { color: var(--vscode-descriptionForeground); }
  .actions { display: flex; gap: 10px; align-items: center; margin-top: 20px; flex-wrap: wrap; }
  .readme { border-top: 1px solid var(--vscode-panel-border); padding-top: 12px; max-width: 900px; }
  .readme img { max-width: 100%; }
  .readme pre { background: var(--vscode-textCodeBlock-background); padding: 10px; overflow-x: auto; }
  button, .fetchBtn {
    background: var(--vscode-button-background);
    color: var(--vscode-button-foreground);
    border: none; padding: 6px 14px; border-radius: 2px; cursor: pointer; font-size: 0.95em;
  }
  button:hover, .fetchBtn:hover { background: var(--vscode-button-hoverBackground); }
  #openBtn { margin-top: 0; }
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
  <ul>${buildCommitsHtml(data.commits, data.remote)}</ul>

  <h2>Remote Branches</h2>
  <ul>${buildBranchesHtml(data.branches)}</ul>

  <div class="actions">
    <button id="openBtn">Open in VS Code</button>
    ${browserButton}
    ${pullButton}
  </div>

  ${readmeSection}

  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    document.getElementById("openBtn").addEventListener("click", () => {
      vscode.postMessage({ command: "openInVSCode" });
    });
    const openBrowserBtn = document.getElementById("openBrowserBtn");
    if (openBrowserBtn) {
      openBrowserBtn.addEventListener("click", () => {
        vscode.postMessage({ command: "openInBrowser" });
      });
    }
    const pullBtn = document.getElementById("pullBtn");
    if (pullBtn) {
      pullBtn.addEventListener("click", () => {
        vscode.postMessage({ command: "pullRepo" });
      });
    }
    document.querySelectorAll(".fetchBtn").forEach((btn) => {
      btn.addEventListener("click", () => {
        vscode.postMessage({ command: "fetchBranch", branch: btn.getAttribute("data-branch") });
      });
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
// The repo path/meta the *currently displayed* report is for -- read by the
// message handler at click time rather than captured per-call, since the
// panel (and its onDidReceiveMessage subscription) is created only once
// and reused across every repo the user clicks through. Capturing these
// in a per-call listener instead would stack up one handler per repo
// viewed, each still firing for its own now-stale path, so clicking a
// button after viewing 3 repos would act on all 3.
let displayedRepoPath = "";
let displayedMeta: RepoMeta = {};

async function refreshPanel(): Promise<void> {
  if (!activePanel) return;
  const data = await collectReportData(displayedRepoPath);
  activePanel.webview.html = buildHtml(displayedRepoPath, displayedMeta, data, getNonce());
}

/**
 * Shows (or reuses, if already open) a single report panel for a repo's
 * cached mt-hub metadata plus its recent commit history, remote branch
 * list, and rendered README. Reused across clicks rather than opening a
 * new tab per repo, matching how the extension already reuses one
 * terminal for framework commands.
 */
export async function showRepoReport(repoPath: string, meta: RepoMeta): Promise<void> {
  const data = await collectReportData(repoPath);
  const nonce = getNonce();
  displayedRepoPath = repoPath;
  displayedMeta = meta;

  if (!activePanel) {
    activePanel = vscode.window.createWebviewPanel("mtDevopsRepoReport", "Repo Report", vscode.ViewColumn.Active, {
      enableScripts: true,
      retainContextWhenHidden: false,
    });
    activePanel.onDidDispose(() => {
      activePanel = undefined;
    });
    activePanel.webview.onDidReceiveMessage(
      async (message: { command: string; branch?: string }) => {
        if (message.command === "openInVSCode") {
          vscode.commands.executeCommand("vscode.openFolder", vscode.Uri.file(displayedRepoPath), {
            forceNewWindow: true,
          });
          return;
        }
        if (message.command === "openInBrowser") {
          const remoteUrl = await runGit(displayedRepoPath, ["remote", "get-url", "origin"]);
          const remote = remoteUrl ? parseRemoteUrl(remoteUrl) : null;
          if (remote) vscode.env.openExternal(vscode.Uri.parse(remote.webUrl));
          return;
        }
        if (message.command === "pullRepo") {
          const stderr = await execGit(displayedRepoPath, ["pull"]);
          if (stderr) vscode.window.showErrorMessage(`MT DevOps: git pull failed -- ${stderr}`);
          await refreshPanel();
          return;
        }
        if (message.command === "fetchBranch" && message.branch) {
          const branch = message.branch;
          const stderr = await execGit(displayedRepoPath, ["fetch", "origin", `${branch}:${branch}`]);
          if (stderr) vscode.window.showErrorMessage(`MT DevOps: fetch failed -- ${stderr}`);
          await refreshPanel();
        }
      },
    );
  }

  activePanel.title = path.basename(repoPath);
  activePanel.webview.html = buildHtml(repoPath, meta, data, nonce);
  activePanel.reveal(vscode.ViewColumn.Active);
}
