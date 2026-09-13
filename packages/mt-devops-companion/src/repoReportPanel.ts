import { execFile } from "node:child_process";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { marked, Renderer } from "marked";
import * as vscode from "vscode";
import { openNewTerminalAt, runFrameworkJson, runInteractiveShell, runInTerminal, shellQuote } from "./framework";
import { showInfraOverview } from "./infraOverviewPanel";
import { getIndexModifierFlags } from "./repoHubProvider";
import type { RepoMeta } from "./repoHubProvider";

/** Same badge-style palette as other status-coded pills elsewhere in this webview, keyed by mt-hub's AI-inferred environment "type" vocabulary. */
const ENV_TYPE_COLOR: Record<string, string> = {
  dev: "var(--vscode-charts-blue)",
  staging: "var(--vscode-charts-yellow)",
  prod: "var(--vscode-charts-red)",
  test: "var(--vscode-charts-purple)",
};

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
  /** "owner/repo", only set for a github.com remote -- what `gh`'s own --repo flag expects. Null for every other host (Bitbucket, self-hosted GitLab, ...), since `gh` only ever talks to GitHub. */
  ghSlug: string | null;
}

interface GithubStatus {
  openPrCount: number;
  ciConclusion: string | null;
  ciUrl: string | null;
}

interface BranchInfo {
  name: string;
  hasLocal: boolean;
  lastCommitDate: number;
}

/** Remote branches are paginated client-side at this size once a repo has more than one page's worth. */
const BRANCHES_PER_PAGE = 10;

interface AiUpdateResult {
  status: "generated" | "pending";
  target: string;
  pending: string | null;
}

interface DependencyAuditResult {
  status: "ok" | "unsupported" | "tool-missing" | "error";
  tool: string | null;
  message: string | null;
  vulnerabilities: Record<string, number> | null;
}

const AI_UPDATE_KINDS = {
  readme: { command: "mt-ai-readme", label: "README" },
  gitignore: { command: "mt-ai-gitignore", label: ".gitignore" },
} as const;

export type AiUpdateKind = keyof typeof AI_UPDATE_KINDS;

interface ReportData {
  commits: CommitEntry[];
  remote: RemoteInfo | null;
  branches: BranchInfo[];
  behindCount: number;
  readmeHtml: string | null;
  /** Days the repo's latest commit is newer than the README's last edit, or null if there's no README or no commits to compare against. Only ever positive -- a README edited after the latest commit isn't "stale" by this measure. */
  readmeStaleDays: number | null;
  hasDockerCompose: boolean;
  hasHelmChart: boolean;
  github: GithubStatus | null;
}

/** A Compose file at the repo root -- the same thing DockerProvider's "group by repository" keys off of (com.docker.compose.project.working_dir), so this is "does the Docker panel have anything for this repo", not a generic Docker-usage guess. */
function detectDockerCompose(repoPath: string): boolean {
  return ["docker-compose.yml", "docker-compose.yaml", "compose.yml", "compose.yaml"].some((name) => fs.existsSync(path.join(repoPath, name)));
}

/** A Helm chart at the repo root or in a conventional charts/helm subfolder -- not exhaustive (a chart could live anywhere), just the common layouts worth a one-click link rather than a real dependency the Helm panel relies on. */
function detectHelmChart(repoPath: string): boolean {
  if (fs.existsSync(path.join(repoPath, "Chart.yaml"))) return true;
  for (const sub of ["helm", "chart", "charts"]) {
    const dir = path.join(repoPath, sub);
    if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) continue;
    if (fs.existsSync(path.join(dir, "Chart.yaml"))) return true;
    const nested = fs.readdirSync(dir).find((entry) => fs.existsSync(path.join(dir, entry, "Chart.yaml")));
    if (nested) return true;
  }
  return false;
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
  return { webUrl, commitUrlBase: `${webUrl}/${commitSegment}/`, ghSlug: host === "github.com" ? repoPath : null };
}

/** Memoized per activation -- `gh --version` is a cheap, static fact about this machine, not worth re-checking on every single report render. */
let ghAvailableCache: Promise<boolean> | undefined;
function isGhAvailable(): Promise<boolean> {
  if (!ghAvailableCache) {
    ghAvailableCache = new Promise((resolve) => {
      execFile("gh", ["--version"], (error) => resolve(!error));
    });
  }
  return ghAvailableCache;
}

/**
 * Open PR count and the default branch's latest CI run, both via `gh`
 * (already relied on elsewhere in this ecosystem for PR/merge workflows)
 * rather than a new framework command -- GitHub-only for now, since `gh`
 * itself only ever talks to GitHub; resolves null on any failure (not
 * installed, not authenticated, private repo without access, ...) so a
 * repo report never blocks or errors on this being unavailable.
 */
function fetchGithubStatus(slug: string): Promise<GithubStatus | null> {
  return new Promise((resolve) => {
    execFile(
      "gh",
      ["pr", "list", "--repo", slug, "--state", "open", "--json", "number"],
      { maxBuffer: 1024 * 1024 },
      (prError, prStdout) => {
        if (prError) {
          resolve(null);
          return;
        }
        let openPrCount = 0;
        try {
          openPrCount = (JSON.parse(prStdout) as unknown[]).length;
        } catch {
          resolve(null);
          return;
        }

        execFile(
          "gh",
          ["run", "list", "--repo", slug, "--limit", "1", "--json", "conclusion,status,url"],
          { maxBuffer: 1024 * 1024 },
          (runError, runStdout) => {
            let ciConclusion: string | null = null;
            let ciUrl: string | null = null;
            if (!runError) {
              try {
                const runs = JSON.parse(runStdout) as Array<{ conclusion: string; status: string; url: string }>;
                if (runs.length > 0) {
                  ciConclusion = runs[0].status === "completed" ? runs[0].conclusion : runs[0].status;
                  ciUrl = runs[0].url;
                }
              } catch {
                // No workflow runs, or gh's output changed shape -- leave CI status null rather than fail the whole report over it.
              }
            }
            resolve({ openPrCount, ciConclusion, ciUrl });
          },
        );
      },
    );
  });
}

/** Local branch names, via `git branch --format`, not the interactive picker used elsewhere. */
async function readLocalBranches(repoPath: string): Promise<Set<string>> {
  const output = await runGit(repoPath, ["branch", "--format=%(refname:short)"]);
  return new Set(output ? output.split("\n") : []);
}

/**
 * Whether a branch name is safe to pass as a git refspec argument --
 * rejects anything starting with "-" (which git/getopt would otherwise
 * parse as a flag, e.g. a branch named "--upload-pack=..." smuggling
 * arbitrary command execution into `git fetch`) plus whitespace,
 * shell/refspec metacharacters, and other control characters. This is
 * intentionally conservative (real git branch names are already far
 * more permissive) since the only cost of a false rejection here is
 * refusing to fetch, not a security gap.
 */
function isSafeBranchName(name: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9/_.-]*$/.test(name);
}

/**
 * Remote-tracking branches under origin/, newest-committed-first (git's own
 * --sort=-committerdate, not a client-side sort), with the "origin/" prefix
 * stripped and origin/HEAD excluded.
 */
async function readRemoteBranches(repoPath: string): Promise<Array<{ name: string; lastCommitDate: number }>> {
  const output = await runGit(repoPath, [
    "for-each-ref",
    "--sort=-committerdate",
    "refs/remotes/origin",
    "--format=%(refname)%09%(refname:short)%09%(committerdate:unix)",
  ]);
  if (!output) return [];
  return output
    .split("\n")
    .map((line) => {
      const [refname, rawShort, rawDate] = line.split("\t");
      return { refname, name: rawShort.replace(/^origin\//, ""), lastCommitDate: Number(rawDate) || 0 };
    })
    // origin/HEAD is a symbolic ref, not a real branch -- its refname:short
    // collapses to the bare "origin" (verified: `git branch -r --format=
    // %(refname:short)` prints the same thing), not "HEAD", which the
    // previous name-based filter here missed entirely; matching on the
    // full, unambiguous refname instead of guessing at its shortened form
    // is what actually excludes it.
    .filter((b) => b.refname !== "refs/remotes/origin/HEAD" && b.name && isSafeBranchName(b.name))
    .map(({ name, lastCommitDate }) => ({ name, lastCommitDate }));
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

/**
 * Days the repo's latest commit is newer than the README's own last
 * commit, or null if there's no README, no commits at all, or the
 * README is untracked (never committed, so git has no date for it).
 * Deliberately uses git's own commit history rather than the README
 * file's filesystem mtime -- a fresh clone stamps every file's mtime as
 * the checkout time, not its real last-edit time, which would make an
 * mtime-based comparison meaningless immediately after cloning.
 */
async function readReadmeStaleDays(repoPath: string, readmePath: string | null): Promise<number | null> {
  if (!readmePath) return null;
  const [latestRaw, readmeRaw] = await Promise.all([
    runGit(repoPath, ["log", "-1", "--format=%ct"]),
    runGit(repoPath, ["log", "-1", "--format=%ct", "--", path.basename(readmePath)]),
  ]);
  const latest = Number(latestRaw);
  const readmeDate = Number(readmeRaw);
  if (!Number.isFinite(latest) || !readmeRaw || !Number.isFinite(readmeDate)) return null;
  return Math.max(0, Math.floor((latest - readmeDate) / 86400));
}

/** Only these URL schemes (plus scheme-relative/relative paths) are allowed in a README's rendered links/images; anything else (e.g. "javascript:") is replaced with "#" rather than passed through. */
function sanitizeHref(href: string): string {
  if (/^(https?:|mailto:)/i.test(href)) return href;
  if (/^[/#.]/.test(href)) return href;
  return "#";
}

/**
 * A `marked` renderer that closes the two XSS routes raw README content
 * could otherwise open in this webview: raw HTML passthrough (marked's
 * default `html` renderer emits it completely unescaped) is instead
 * escaped to literal text, and link/image URLs are restricted to a
 * scheme allowlist so a `[x](javascript:...)` link can't execute script
 * when clicked. The CSP's `script-src 'nonce-...'` already blocks a
 * plain injected `<script>` tag, but neither event-handler attributes
 * nor `javascript:` URIs are reliably covered by CSP the same way, so
 * this is the actual enforcement point for those.
 */
const safeRenderer = new Renderer();
safeRenderer.html = ({ text }) => escapeHtml(text);
// `function` (not an arrow) so marked's own call-site binds `this` to the
// renderer instance, giving access to `this.parser.parseInline` the same
// way the default link renderer does -- an arrow function here would
// silently lose that binding.
safeRenderer.link = function (this: Renderer, { href, title, tokens }) {
  const text = this.parser.parseInline(tokens);
  const safeHref = sanitizeHref(href);
  const titleAttr = title ? ` title="${escapeHtml(title)}"` : "";
  return `<a href="${escapeHtml(safeHref)}"${titleAttr}>${text}</a>`;
};
safeRenderer.image = ({ href, title, text }) => {
  const safeHref = sanitizeHref(href);
  const titleAttr = title ? ` title="${escapeHtml(title)}"` : "";
  return `<img src="${escapeHtml(safeHref)}" alt="${escapeHtml(text)}"${titleAttr}>`;
};

async function renderReadme(repoPath: string): Promise<string | null> {
  const readmePath = findReadme(repoPath);
  if (!readmePath) return null;
  try {
    const raw = await fs.promises.readFile(readmePath, "utf8");
    return path.extname(readmePath).toLowerCase() === ".txt"
      ? `<pre>${escapeHtml(raw)}</pre>`
      : await marked.parse(raw, { renderer: safeRenderer });
  } catch {
    return null;
  }
}

async function collectReportData(repoPath: string): Promise<ReportData> {
  const remoteUrl = await runGit(repoPath, ["remote", "get-url", "origin"]);
  const remote = remoteUrl ? parseRemoteUrl(remoteUrl) : null;

  const readmePath = findReadme(repoPath);

  const [commits, localBranches, remoteBranches, behindCount, readmeHtml, readmeStaleDays] = await Promise.all([
    readRecentCommits(repoPath),
    readLocalBranches(repoPath),
    readRemoteBranches(repoPath),
    readBehindCount(repoPath),
    renderReadme(repoPath),
    readReadmeStaleDays(repoPath, readmePath),
  ]);

  const branches = remoteBranches.map((b) => ({ ...b, hasLocal: localBranches.has(b.name) }));

  let github: GithubStatus | null = null;
  if (remote?.ghSlug && (await isGhAvailable())) {
    github = await fetchGithubStatus(remote.ghSlug);
  }

  return {
    commits,
    remote,
    branches,
    behindCount,
    readmeHtml,
    readmeStaleDays,
    hasDockerCompose: detectDockerCompose(repoPath),
    hasHelmChart: detectHelmChart(repoPath),
    github,
  };
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

function buildEnvironmentsHtml(environments: RepoMeta["environments"]): string {
  if (!environments || environments.length === 0) return "";
  const pills = environments
    .map((env) => {
      const color = ENV_TYPE_COLOR[env.type.toLowerCase()] ?? "var(--vscode-badge-background)";
      return (
        `<span class="envPill" style="border-color: ${color};">` +
        `<strong>${escapeHtml(env.name)}</strong> <span class="dim">${escapeHtml(env.type)}</span></span>`
      );
    })
    .join("");
  return `<h2>Environments</h2><div class="environments">${pills}</div>`;
}

/** Renders __mt_hub_detect_gcp's result -- omitted entirely when nothing was detected, same as buildEnvironmentsHtml, rather than a "No GCP usage" line every non-GCP repo would otherwise show. "source" is surfaced only as a tooltip, not inline text, since "detected via Terraform" vs "detected via config files" matters far less than the fact/services themselves. */
function buildGcpHtml(gcp: RepoMeta["gcp"]): string {
  if (!gcp || !gcp.detected) return "";
  const sourceLabel = gcp.source === "terraform" ? "Detected via Terraform" : "Detected via config files (app.yaml/cloudbuild.yaml/registry references)";
  const pills =
    gcp.services.length > 0
      ? gcp.services.map((s) => `<span class="envPill" style="border-color: var(--vscode-charts-blue);">${escapeHtml(s)}</span>`).join("")
      : `<span class="envPill" style="border-color: var(--vscode-charts-blue);">GCP</span>`;
  return `<h2>Google Cloud Platform</h2><div class="environments" title="${escapeHtml(sourceLabel)}">${pills}</div>`;
}

const CI_ICON: Record<string, string> = { success: "✅", failure: "❌", cancelled: "⏹️", in_progress: "⏳", queued: "⏳" };

function buildGithubHtml(github: GithubStatus | null, webUrl: string | undefined): string {
  if (!github || !webUrl) return "";
  const prLine = `<a href="${escapeHtml(webUrl)}/pulls">${github.openPrCount} open PR${github.openPrCount === 1 ? "" : "s"}</a>`;
  let ciLine = "";
  if (github.ciConclusion) {
    const icon = CI_ICON[github.ciConclusion] ?? "❔";
    const text = `${icon} CI: ${escapeHtml(github.ciConclusion)}`;
    ciLine = ` · ${github.ciUrl ? `<a href="${escapeHtml(github.ciUrl)}">${text}</a>` : text}`;
  }
  return `<h2>GitHub</h2><div>${prLine}${ciLine}</div>`;
}

/** Renders mt-audit-deps --json's result for injection into #depsResult -- every interpolated value is either a fixed literal or passed through escapeHtml first. */
function buildDependencyAuditHtml(result: DependencyAuditResult): string {
  if (result.status === "ok" && result.vulnerabilities) {
    const total = result.vulnerabilities.total ?? 0;
    if (total === 0) {
      return `<div class="staleWarning" style="background:transparent;border-color:var(--vscode-panel-border);">✅ ${escapeHtml(result.tool ?? "")}: no known vulnerabilities.</div>`;
    }
    const counts = Object.entries(result.vulnerabilities)
      .filter(([key, value]) => key !== "total" && typeof value === "number" && value > 0)
      .map(([key, value]) => `${escapeHtml(key)}: ${value}`)
      .join(", ");
    return `<div class="staleWarning">⚠️ ${escapeHtml(result.tool ?? "")}: ${total} vulnerabilit${total === 1 ? "y" : "ies"}${counts ? ` (${counts})` : ""}.</div>`;
  }
  return `<div class="staleWarning">ℹ️ ${escapeHtml(result.message ?? "Dependency audit unavailable.")}</div>`;
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
    .map((b, i) => {
      const action = b.hasLocal
        ? `<span class="dim">Already local</span>`
        : `<button class="fetchBtn" data-branch="${escapeHtml(b.name)}">Fetch</button>`;
      const page = Math.floor(i / BRANCHES_PER_PAGE);
      const hidden = page === 0 ? "" : ' style="display:none"';
      return `<li data-page="${page}"${hidden}><code>${escapeHtml(b.name)}</code> ${action}</li>`;
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

  const README_STALE_THRESHOLD_DAYS = 30;
  const readmeStaleWarning =
    data.readmeStaleDays !== null && data.readmeStaleDays > README_STALE_THRESHOLD_DAYS
      ? `<div class="staleWarning">⚠️ README hasn't been touched in ${data.readmeStaleDays} days, though the codebase has moved on since -- consider Generate/Update README below.</div>`
      : "";

  const readmeSection = data.readmeHtml
    ? `<h2>README</h2>${readmeStaleWarning}<div class="readme">${data.readmeHtml}</div>`
    : "";

  const remoteRow = data.remote
    ? `<div class="remote" id="remoteRow" title="Open in browser">${escapeHtml(data.remote.webUrl)}</div>`
    : "";

  const paginationControls =
    data.branches.length > BRANCHES_PER_PAGE
      ? `<div class="pagination">
           <button id="branchPrevBtn">◀ Prev</button>
           <span id="branchPageLabel" class="dim"></span>
           <button id="branchNextBtn">Next ▶</button>
         </div>`
      : "";

  return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">
<style>
  body { font-family: var(--vscode-font-family); color: var(--vscode-foreground); padding: 0 24px 24px; }
  h1 { font-size: 1.4em; word-break: break-all; }
  .path, .remote { color: var(--vscode-descriptionForeground); font-size: 0.9em; word-break: break-all; cursor: pointer; }
  .path { margin-top: -8px; }
  .path:hover, .remote:hover { text-decoration: underline; color: var(--vscode-textLink-foreground); }
  .pagination { display: flex; align-items: center; gap: 10px; margin-top: 8px; }
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
  .environments { display: flex; flex-wrap: wrap; gap: 8px; }
  .envPill { border: 1px solid; border-radius: 12px; padding: 3px 10px; font-size: 0.9em; }
  .staleWarning { background: var(--vscode-inputValidation-warningBackground); border: 1px solid var(--vscode-inputValidation-warningBorder); padding: 8px 12px; border-radius: 3px; margin-bottom: 10px; font-size: 0.9em; }
</style>
</head>
<body>
  <h1>${escapeHtml(path.basename(repoPath))}</h1>
  <div class="path" id="pathRow" title="Open in a new terminal">${escapeHtml(repoPath)}</div>
  ${remoteRow}
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

  ${buildEnvironmentsHtml(meta.environments)}

  ${buildGcpHtml(meta.gcp)}

  ${buildGithubHtml(data.github, data.remote?.webUrl)}

  <h2>Recent Commits</h2>
  <ul>${buildCommitsHtml(data.commits, data.remote)}</ul>

  <h2>Remote Branches</h2>
  <ul id="branchList">${buildBranchesHtml(data.branches)}</ul>
  ${paginationControls}

  <div class="actions">
    <button id="openBtn">Open in VS Code</button>
    ${browserButton}
    ${pullButton}
    <button id="updateIndexBtn">Update Missing Index</button>
    <button id="generateReadmeBtn">Generate/Update README</button>
    <button id="generateGitignoreBtn">Generate/Update .gitignore</button>
    <button id="checkDepsBtn">Check Dependencies</button>
    <button id="infraOverviewBtn">Infrastructure Overview</button>
    ${data.hasDockerCompose ? `<button id="viewDockerBtn">View in Docker Panel</button>` : ""}
    ${data.hasHelmChart ? `<button id="viewHelmBtn">View in Helm Panel</button>` : ""}
  </div>

  <div id="depsResult"></div>

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
    document.getElementById("updateIndexBtn").addEventListener("click", () => {
      vscode.postMessage({ command: "updateIndex" });
    });
    document.getElementById("generateReadmeBtn").addEventListener("click", () => {
      vscode.postMessage({ command: "generateReadme" });
    });
    document.getElementById("generateGitignoreBtn").addEventListener("click", () => {
      vscode.postMessage({ command: "generateGitignore" });
    });
    const checkDepsBtn = document.getElementById("checkDepsBtn");
    checkDepsBtn.addEventListener("click", () => {
      checkDepsBtn.disabled = true;
      checkDepsBtn.textContent = "Checking...";
      vscode.postMessage({ command: "checkDependencies" });
    });
    window.addEventListener("message", (event) => {
      if (event.data.command !== "dependencyAuditResult") return;
      checkDepsBtn.disabled = false;
      checkDepsBtn.textContent = "Check Dependencies";
      // Safe: event.data.html is built extension-side by
      // buildDependencyAuditHtml, which escapeHtml()s every value it
      // interpolates -- same trust boundary as the rest of this file's
      // server-rendered HTML strings (buildGithubHtml, metaRow, ...).
      document.getElementById("depsResult").innerHTML = event.data.html;
    });
    document.getElementById("infraOverviewBtn").addEventListener("click", () => {
      vscode.postMessage({ command: "showInfraOverview" });
    });
    document.getElementById("pathRow").addEventListener("click", () => {
      vscode.postMessage({ command: "openNewTerminal" });
    });
    const remoteRow = document.getElementById("remoteRow");
    if (remoteRow) {
      remoteRow.addEventListener("click", () => {
        vscode.postMessage({ command: "openInBrowser" });
      });
    }
    const viewDockerBtn = document.getElementById("viewDockerBtn");
    if (viewDockerBtn) {
      viewDockerBtn.addEventListener("click", () => {
        vscode.postMessage({ command: "viewInDocker" });
      });
    }
    const viewHelmBtn = document.getElementById("viewHelmBtn");
    if (viewHelmBtn) {
      viewHelmBtn.addEventListener("click", () => {
        vscode.postMessage({ command: "viewInHelm" });
      });
    }
    (function () {
      const items = Array.from(document.querySelectorAll("#branchList li[data-page]"));
      const prevBtn = document.getElementById("branchPrevBtn");
      const nextBtn = document.getElementById("branchNextBtn");
      if (!items.length || !prevBtn || !nextBtn) return;
      const totalPages = Math.max(...items.map((el) => Number(el.dataset.page))) + 1;
      const label = document.getElementById("branchPageLabel");
      let page = 0;
      function render() {
        items.forEach((el) => {
          el.style.display = Number(el.dataset.page) === page ? "" : "none";
        });
        if (label) label.textContent = "Page " + (page + 1) + " of " + totalPages;
        prevBtn.disabled = page === 0;
        nextBtn.disabled = page >= totalPages - 1;
      }
      prevBtn.addEventListener("click", () => {
        if (page > 0) {
          page--;
          render();
        }
      });
      nextBtn.addEventListener("click", () => {
        if (page < totalPages - 1) {
          page++;
          render();
        }
      });
      render();
    })();
  </script>
</body>
</html>`;
}

/** A CSP nonce must be unpredictable to an attacker able to inject markup (e.g. via a crafted README) -- Math.random() is not cryptographically secure and was the actual weakness here, so this uses Node's CSPRNG instead. */
function getNonce(): string {
  return crypto.randomBytes(24).toString("base64");
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
// Set once from extension.ts (same context.globalState the Repo Hub tree's
// Background Indexing checkbox / AI Provider Override row write to) so the
// report panel's own "Update Missing Index" button honors the same
// sidebar-configured flags as every other mt-hub --index call site,
// without needing showRepoReport's own signature (and all its call sites)
// to thread a Memento through just for this one button.
let extensionState: vscode.Memento | undefined;

export function initRepoReportPanel(state: vscode.Memento): void {
  extensionState = state;
}

async function refreshPanel(): Promise<void> {
  if (!activePanel) return;
  const data = await collectReportData(displayedRepoPath);
  activePanel.webview.html = buildHtml(displayedRepoPath, displayedMeta, data, getNonce());
}

/**
 * Generates (or regenerates) a repo's README/.gitignore via the framework's
 * `mt-ai-readme`/`mt-ai-gitignore --update --json`, which writes any
 * regenerated content to a pending file rather than overwriting directly
 * (see .bash.d/20-vcs/51-git-ai.sh) -- reviewed here with VS Code's native
 * diff editor before the user chooses to apply or discard it. Shared
 * between the report panel's own buttons and the command-palette
 * equivalents in extension.ts.
 */
export async function runAiUpdateFlow(repoPath: string, kind: AiUpdateKind): Promise<void> {
  const { command, label } = AI_UPDATE_KINDS[kind];
  let result: AiUpdateResult;
  try {
    result = await runFrameworkJson<AiUpdateResult>(`cd ${shellQuote(repoPath)} && ${command} --update --json`);
  } catch (err) {
    vscode.window.showErrorMessage(`MT DevOps: ${label} generation failed -- ${err instanceof Error ? err.message : String(err)}`);
    return;
  }

  if (result.status === "generated" || !result.pending) {
    vscode.window.showInformationMessage(`MT DevOps: ${label} generated.`);
    await vscode.window.showTextDocument(vscode.Uri.file(result.target));
    if (activePanel && repoPath === displayedRepoPath) await refreshPanel();
    return;
  }

  await vscode.commands.executeCommand(
    "vscode.diff",
    vscode.Uri.file(result.target),
    vscode.Uri.file(result.pending),
    `${label}: current ↔ generated`,
  );

  const choice = await vscode.window.showInformationMessage(`Apply the generated ${label}?`, "Apply", "Discard");
  if (choice === "Apply") {
    await runInteractiveShell(`cd ${shellQuote(repoPath)} && ${command} --apply-pending`);
    vscode.window.showInformationMessage(`MT DevOps: ${label} updated.`);
  } else if (choice === "Discard") {
    await runInteractiveShell(`cd ${shellQuote(repoPath)} && ${command} --discard-pending`);
  }
  if (activePanel && repoPath === displayedRepoPath) await refreshPanel();
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
        if (message.command === "updateIndex") {
          // Gap-fill indexing calls the AI provider and can take a while,
          // and the Repo Hub tree already watches .vcs_hub.json and will
          // refresh itself once mt-hub rewrites it -- same reasoning as
          // the equivalent right-click actions, so this runs visibly in
          // the terminal rather than captured.
          runInTerminal(
            `mt-hub --index -u -r ${shellQuote(path.basename(displayedRepoPath))}${extensionState ? getIndexModifierFlags(extensionState) : ""}`,
          );
          return;
        }
        if (message.command === "openInBrowser") {
          const remoteUrl = await runGit(displayedRepoPath, ["remote", "get-url", "origin"]);
          const remote = remoteUrl ? parseRemoteUrl(remoteUrl) : null;
          if (remote) vscode.env.openExternal(vscode.Uri.parse(remote.webUrl));
          return;
        }
        if (message.command === "openNewTerminal") {
          openNewTerminalAt(displayedRepoPath);
          return;
        }
        if (message.command === "generateReadme") {
          await runAiUpdateFlow(displayedRepoPath, "readme");
          return;
        }
        if (message.command === "generateGitignore") {
          await runAiUpdateFlow(displayedRepoPath, "gitignore");
          return;
        }
        if (message.command === "checkDependencies") {
          // Deliberately on-demand only, per plan -- a real audit hits a
          // registry/database and can take several seconds, too slow to
          // run automatically as part of collectReportData on every open.
          let result: DependencyAuditResult;
          try {
            result = await runFrameworkJson<DependencyAuditResult>(`cd ${shellQuote(displayedRepoPath)} && mt-audit-deps --json`);
          } catch (err) {
            result = { status: "error", tool: null, message: err instanceof Error ? err.message : String(err), vulnerabilities: null };
          }
          activePanel?.webview.postMessage({ command: "dependencyAuditResult", html: buildDependencyAuditHtml(result) });
          return;
        }
        if (message.command === "showInfraOverview") {
          await showInfraOverview(displayedRepoPath);
          return;
        }
        // Each view contribution gets a VS Code-generated "<viewId>.focus"
        // command automatically -- just navigation, not a repo-filtered
        // view (the Docker/Helm panels don't take a repo argument), so
        // there's nothing more to pass through here.
        if (message.command === "viewInDocker") {
          await vscode.commands.executeCommand("mtDevopsDocker.focus");
          return;
        }
        if (message.command === "viewInHelm") {
          await vscode.commands.executeCommand("mtDevopsHelm.focus");
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
          if (!isSafeBranchName(branch)) {
            vscode.window.showErrorMessage(`MT DevOps: refusing to fetch unsafe branch name "${branch}".`);
            return;
          }
          // The trailing "--" stops git from treating a refspec that
          // happens to start with "-" (e.g. a maliciously named remote
          // branch like "--upload-pack=...") as an option instead of a
          // positional argument -- isSafeBranchName rejects a leading
          // "-" too, so this is defense in depth, not the only guard.
          const stderr = await execGit(displayedRepoPath, ["fetch", "origin", "--", `${branch}:${branch}`]);
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
