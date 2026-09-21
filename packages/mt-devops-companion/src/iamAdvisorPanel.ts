import * as crypto from "node:crypto";
import * as path from "node:path";
import * as vscode from "vscode";
import { runFrameworkJson, runInteractiveShell, shellQuote } from "./framework";
import { pickGcpProject } from "./gcpProjectPicker";
import { renderMarkdownSafe } from "./repoReportPanel";
import { WEBVIEW_BASE_STYLES } from "./webviewChrome";

type RoleVerdict = "required" | "excessive" | "not-needed";

/** A role an existing service account holds, as judged against the recommendation (.bash.d/20-vcs/60-iam-advisor.sh). */
interface IamRoleAssessment {
  role: string;
  verdict?: RoleVerdict | string;
  reason?: string;
}

/** An existing service account found in the scanned project's IAM policy and the roles it holds there. */
interface IamCurrentAccount {
  email: string;
  roles: IamRoleAssessment[];
}

interface IamRecommendedRole {
  role: string;
  reason?: string;
}

/** A service account the codebase needs. "replaces" is the email of an existing account from the current configuration that plays the same role, null for a brand-new account. */
interface IamRecommendedAccount {
  name: string;
  purpose?: string;
  replaces?: string | null;
  roles: IamRecommendedRole[];
}

/** From __mt_radar_iam_analyze_repo, cached in .vcs_iam.json. "error" carries a "message" (AI failure, or the project's IAM policy couldn't be read); "no-terraform" means nothing to analyze; "not-analyzed" is synthesized by __mt_radar_iam_show when the cache has no entry. "recommended" is null (with "analysis" holding the raw text) for a reply that wasn't a structured report, and for entries cached before the structured format existed. "current" is null when no GCP project was scanned. */
interface IamOverview {
  status: "ok" | "not-analyzed" | "no-terraform" | "error";
  analyzed_at: number | null;
  provider: string | null;
  gcp_project?: string | null;
  recommended?: IamRecommendedAccount[] | null;
  current?: IamCurrentAccount[] | null;
  analysis?: string | null;
  message?: string | null;
}

/** Colour is never the only signal -- every verdict also carries an icon and a text label. Ordered most-actionable first, which is also the order roles are listed in. */
const VERDICT_ORDER = ["not-needed", "excessive", "required"] as const;
const VERDICT_STYLE: Record<(typeof VERDICT_ORDER)[number], { icon: string; label: string; color: string }> = {
  "not-needed": { icon: "❌", label: "Not needed", color: "var(--vscode-charts-red)" },
  excessive: { icon: "⚠️", label: "Excessive", color: "var(--vscode-charts-yellow)" },
  required: { icon: "✅", label: "Required", color: "var(--vscode-charts-green)" },
};
const UNKNOWN_VERDICT_STYLE = { icon: "❔", label: "Review", color: "var(--vscode-descriptionForeground)" };

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function verdictRank(verdict: string | undefined): number {
  const index = VERDICT_ORDER.indexOf(verdict as (typeof VERDICT_ORDER)[number]);
  return index === -1 ? VERDICT_ORDER.length : index;
}

function verdictStyle(verdict: string | undefined): { icon: string; label: string; color: string } {
  return VERDICT_STYLE[verdict as (typeof VERDICT_ORDER)[number]] ?? UNKNOWN_VERDICT_STYLE;
}

function buildEmptyStateHtml(repoName: string, iam: IamOverview): string {
  if (iam.status === "no-terraform") {
    return /* html */ `<p>No Terraform was found in <strong>${escapeHtml(repoName)}</strong> -- this feature only covers repos that deploy infrastructure via Terraform.</p>`;
  }
  if (iam.status === "error") {
    return /* html */ `
      <p>The last IAM analysis attempt for <strong>${escapeHtml(repoName)}</strong> failed.</p>
      <p class="dim">${escapeHtml(iam.message ?? "Check your AI provider configuration (mt-ai-quota) and try again.")}</p>
      <button id="generateBtn">🔑 Retry IAM Analysis</button>
    `;
  }
  return /* html */ `
    <p><strong>${escapeHtml(repoName)}</strong> hasn't had an IAM analysis generated yet.</p>
    <p class="dim">Calls the configured AI provider (real cost/latency) to recommend GCP service accounts and least-privilege roles for this repo's Terraform, and -- given a GCP project -- compares them against the roles its service accounts hold today.</p>
    <button id="generateBtn">🔑 Generate IAM Analysis</button>
  `;
}

function buildRoleCountsHtml(roles: IamRoleAssessment[]): string {
  const counts = VERDICT_ORDER.map((verdict) => ({ verdict, count: roles.filter((r) => r.verdict === verdict).length })).filter((c) => c.count > 0);
  return counts.map((c) => `${VERDICT_STYLE[c.verdict].icon} ${c.count} ${VERDICT_STYLE[c.verdict].label.toLowerCase()}`).join(" · ");
}

function buildCurrentAccountHtml(account: IamCurrentAccount): string {
  const roles = [...(account.roles ?? [])].sort((a, b) => verdictRank(a.verdict) - verdictRank(b.verdict));
  const rows = roles
    .map((r) => {
      const style = verdictStyle(r.verdict);
      return `<div class="roleRow">
        <span class="badge" style="border-color: ${style.color};">${style.icon} ${escapeHtml(style.label)}</span>
        <div><code>${escapeHtml(r.role)}</code>${r.reason ? `<div class="dim">${escapeHtml(r.reason)}</div>` : ""}</div>
      </div>`;
    })
    .join("");
  return /* html */ `
    <details class="saCard" open>
      <summary><code>${escapeHtml(account.email)}</code> <span class="dim">${buildRoleCountsHtml(roles)}</span></summary>
      ${rows || '<p class="dim">No roles granted.</p>'}
    </details>
  `;
}

function buildCurrentSectionHtml(iam: IamOverview): string {
  const heading = "<h2>Current IAM Configuration</h2>";
  if (!iam.gcp_project) {
    return /* html */ `${heading}<p class="dim">Not scanned. Click Regenerate and enter a GCP project to compare this repo's recommendation against the roles its service accounts hold today.</p>`;
  }
  const accounts = iam.current ?? [];
  const intro = `<p class="dim">Service accounts in <code>${escapeHtml(iam.gcp_project)}</code> that this codebase appears to use, with the roles each holds there.</p>`;
  if (accounts.length === 0) {
    return /* html */ `${heading}${intro}<p class="dim">No existing service accounts in this project matched this codebase.</p>`;
  }
  return /* html */ `${heading}${intro}${accounts.map(buildCurrentAccountHtml).join("")}`;
}

function buildRecommendedAccountHtml(account: IamRecommendedAccount): string {
  const replaces = account.replaces
    ? `Replaces <code>${escapeHtml(account.replaces)}</code>`
    : "New account -- replaces nothing that exists today";
  const rows = (account.roles ?? [])
    .map(
      (r) => `<div class="roleRow plain">
        <div><code>${escapeHtml(r.role)}</code>${r.reason ? `<div class="dim">${escapeHtml(r.reason)}</div>` : ""}</div>
      </div>`,
    )
    .join("");
  return /* html */ `
    <details class="saCard" open>
      <summary><code>${escapeHtml(account.name)}</code> <span class="dim">${(account.roles ?? []).length} role${(account.roles ?? []).length === 1 ? "" : "s"}</span></summary>
      ${account.purpose ? `<p class="saPurpose">${escapeHtml(account.purpose)}</p>` : ""}
      <p class="dim saMeta">${replaces}</p>
      ${rows || '<p class="dim">No roles required.</p>'}
    </details>
  `;
}

function buildRecommendedSectionHtml(accounts: IamRecommendedAccount[]): string {
  const heading = "<h2>Recommended IAM Configuration</h2>";
  if (accounts.length === 0) {
    return /* html */ `${heading}<p class="dim">No IAM requirements were identified for this codebase.</p>`;
  }
  return /* html */ `${heading}${accounts.map(buildRecommendedAccountHtml).join("")}`;
}

async function buildOverviewHtml(iam: IamOverview): Promise<string> {
  const analyzedAt = iam.analyzed_at ? new Date(iam.analyzed_at * 1000).toLocaleString() : "Unknown";
  const summary = /* html */ `
    <table>
      <tr><td class="label">AI Provider</td><td>${escapeHtml(iam.provider ?? "Unknown")}</td></tr>
      <tr><td class="label">GCP Project</td><td>${iam.gcp_project ? escapeHtml(iam.gcp_project) : '<span class="dim">Not scanned</span>'}</td></tr>
      <tr><td class="label">Last Analyzed</td><td>${escapeHtml(analyzedAt)}</td></tr>
    </table>
    <div class="actions"><button id="regenerateBtn">🔄 Regenerate</button></div>
  `;

  if (!Array.isArray(iam.recommended)) {
    const legacy = iam.analysis ? await renderMarkdownSafe(iam.analysis) : "<p class='dim'>No analysis text returned.</p>";
    return /* html */ `${summary}
      <p class="dim">This result isn't in the structured format (older analysis, or the model didn't return a report) -- showing the raw text. Regenerate for the current-versus-recommended view.</p>
      <div class="analysis">${legacy}</div>`;
  }

  return /* html */ `${summary}${buildCurrentSectionHtml(iam)}${buildRecommendedSectionHtml(iam.recommended)}`;
}

function buildHtml(repoName: string, bodyHtml: string, nonce: string): string {
  return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">
<style>
  ${WEBVIEW_BASE_STYLES}
  h2 { margin-top: 32px; }
  .analysis { border-top: 1px solid var(--vscode-panel-border); padding-top: 12px; max-width: 900px; }
  .analysis code { background: var(--vscode-textCodeBlock-background); padding: 1px 5px; border-radius: 3px; }
  .analysis pre { background: var(--vscode-textCodeBlock-background); padding: 10px; overflow-x: auto; }
  code { background: var(--vscode-textCodeBlock-background); padding: 1px 5px; border-radius: 3px; overflow-wrap: anywhere; }
  .saCard { border: 1px solid var(--vscode-panel-border); border-radius: 4px; padding: 8px 14px; margin: 10px 0; max-width: 900px; }
  .saCard > summary { cursor: pointer; padding: 2px 0; overflow-wrap: anywhere; }
  .saPurpose { margin: 10px 0 4px; }
  .saMeta { margin: 4px 0 8px; }
  .roleRow { display: grid; grid-template-columns: 120px 1fr; gap: 12px; padding: 6px 0; border-top: 1px solid var(--vscode-panel-border); }
  .roleRow.plain { grid-template-columns: 1fr; }
  .roleRow .dim { margin-top: 2px; font-size: 0.92em; }
  .badge { border: 1px solid; border-radius: 10px; padding: 1px 8px; font-size: 0.85em; white-space: nowrap; align-self: start; justify-self: start; }
</style>
</head>
<body>
  <h1>🔑 IAM Recommendations: ${escapeHtml(repoName)}</h1>
  <div id="body">${bodyHtml}</div>
  <div id="error"></div>

  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    function wire() {
      const genBtn = document.getElementById("generateBtn");
      if (genBtn) genBtn.addEventListener("click", () => {
        genBtn.disabled = true;
        genBtn.textContent = "Analyzing...";
        vscode.postMessage({ command: "generate" });
      });
      const regenBtn = document.getElementById("regenerateBtn");
      if (regenBtn) regenBtn.addEventListener("click", () => {
        regenBtn.disabled = true;
        regenBtn.textContent = "Regenerating...";
        vscode.postMessage({ command: "generate" });
      });
    }
    wire();
    window.addEventListener("message", (event) => {
      if (event.data.command === "updateBody") {
        document.getElementById("body").innerHTML = event.data.html;
        document.getElementById("error").innerHTML = "";
        wire();
      } else if (event.data.command === "generateFailed") {
        document.getElementById("error").innerHTML = '<p style="color: var(--vscode-terminal-ansiRed);">🚨 ' + event.data.message + '</p>';
        const genBtn = document.getElementById("generateBtn");
        const regenBtn = document.getElementById("regenerateBtn");
        if (genBtn) { genBtn.disabled = false; genBtn.textContent = "🔑 Generate IAM Analysis"; }
        if (regenBtn) { regenBtn.disabled = false; regenBtn.textContent = "🔄 Regenerate"; }
      }
    });
  </script>
</body>
</html>`;
}

function getNonce(): string {
  return crypto.randomBytes(24).toString("base64");
}

let activePanel: vscode.WebviewPanel | undefined;
let displayedRepoPath = "";

async function fetchIam(repoPath: string): Promise<IamOverview> {
  return runFrameworkJson<IamOverview>(`mt-radar --show-iam ${shellQuote(repoPath)} --json`);
}

/**
 * Runs mt-radar --iam (a real AI provider call -- cost/latency, unlike
 * infraOverviewPanel's generateAndFetch) then re-fetches the cached
 * result, same two-call pattern (generate via runInteractiveShell so its
 * own progress text doesn't have to be JSON, then a separate --json read
 * back) as infraOverviewPanel.ts/generateAndFetch and
 * scanGcpAndFetch use for their own on-demand, AI/API-backed actions.
 * A non-empty gcpProject also makes the framework read that project's live
 * service-account role grants, for the "current" section.
 */
async function generateAndFetch(repoPath: string, gcpProject: string): Promise<IamOverview> {
  const projectFlag = gcpProject ? ` --gcp-project ${shellQuote(gcpProject)}` : "";
  await runInteractiveShell(`mt-radar --iam -r ${shellQuote(path.basename(repoPath))}${projectFlag}`);
  return fetchIam(repoPath);
}

async function renderBody(iam: IamOverview, repoName: string): Promise<string> {
  return iam.status === "ok" ? buildOverviewHtml(iam) : buildEmptyStateHtml(repoName, iam);
}

async function postBody(iam: IamOverview): Promise<void> {
  const html = await renderBody(iam, path.basename(displayedRepoPath));
  activePanel?.webview.postMessage({ command: "updateBody", html });
}

/**
 * Shows the AI-generated GCP IAM analysis for one repo's Terraform:
 * a "Current IAM Configuration" section (the roles its service accounts
 * hold today in a chosen GCP project, each labeled required / excessive /
 * not needed) and a "Recommended IAM Configuration" section (each service
 * account the codebase needs, its purpose, the existing account it
 * replaces, and its required roles). Unlike showInfraOverview, this always
 * calls the configured AI provider (real cost/latency), so nothing here
 * runs automatically; the panel only ever reads the cache until the user
 * clicks Generate/Regenerate.
 */
export async function showIamAdvisor(repoPath: string): Promise<void> {
  const repoName = path.basename(repoPath);
  displayedRepoPath = repoPath;
  const nonce = getNonce();

  let iam: IamOverview;
  try {
    iam = await fetchIam(repoPath);
  } catch (err) {
    vscode.window.showErrorMessage(`MT DevOps: couldn't read the IAM analysis -- ${err instanceof Error ? err.message : String(err)}`);
    return;
  }

  const bodyHtml = await renderBody(iam, repoName);

  if (!activePanel) {
    activePanel = vscode.window.createWebviewPanel("mtDevopsIamAdvisor", "IAM Recommendations", vscode.ViewColumn.Active, {
      enableScripts: true,
      retainContextWhenHidden: false,
    });
    activePanel.onDidDispose(() => {
      activePanel = undefined;
    });
    activePanel.webview.onDidReceiveMessage(async (message: { command: string }) => {
      if (message.command !== "generate") return;
      try {
        const previous = await fetchIam(displayedRepoPath);
        const gcpProject = await pickGcpProject(displayedRepoPath, {
          title: "IAM analysis -- project to read current IAM from",
          noProjectLabel: "Skip the current-configuration comparison",
          noProjectDetail: "Only recommend IAM for the Terraform; don't read any project's live IAM",
          previous: previous.gcp_project,
        });
        if (gcpProject === undefined) {
          // Cancelled -- re-render the unchanged body so the button re-enables.
          await postBody(previous);
          return;
        }
        await postBody(await generateAndFetch(displayedRepoPath, gcpProject.trim()));
      } catch (err) {
        activePanel?.webview.postMessage({
          command: "generateFailed",
          message: escapeHtml(err instanceof Error ? err.message : String(err)),
        });
      }
    });
  }

  activePanel.title = `IAM: ${repoName}`;
  activePanel.webview.html = buildHtml(repoName, bodyHtml, nonce);
  activePanel.reveal(vscode.ViewColumn.Active);
}
