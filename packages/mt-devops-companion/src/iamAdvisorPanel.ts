import * as crypto from "node:crypto";
import * as path from "node:path";
import * as vscode from "vscode";
import { runFrameworkJson, runInteractiveShell, shellQuote } from "./framework";
import { renderMarkdownSafe } from "./repoReportPanel";

/** From __mt_radar_iam_analyze_repo (.bash.d/20-vcs/60-iam-advisor.sh) -- an AI-generated analysis of a repo's Terraform, cached in .vcs_iam.json. "error" means the AI query itself failed (provider/key misconfiguration, rate limit, ...), distinct from "no-terraform" (nothing to analyze) and "not-analyzed" (never run yet, synthesized client-side by __mt_radar_iam_show when the cache has no entry). */
interface IamOverview {
  status: "ok" | "not-analyzed" | "no-terraform" | "error";
  analyzed_at: number | null;
  provider: string | null;
  analysis: string | null;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function buildEmptyStateHtml(repoName: string, status: IamOverview["status"]): string {
  if (status === "no-terraform") {
    return /* html */ `<p>No Terraform was found in <strong>${escapeHtml(repoName)}</strong> -- this feature only covers repos that deploy infrastructure via Terraform.</p>`;
  }
  if (status === "error") {
    return /* html */ `
      <p>The last IAM analysis attempt for <strong>${escapeHtml(repoName)}</strong> failed -- check your AI provider configuration (<code>mt-ai-quota</code>) and try again.</p>
      <button id="generateBtn">🔑 Retry IAM Analysis</button>
    `;
  }
  return /* html */ `
    <p><strong>${escapeHtml(repoName)}</strong> hasn't had an IAM analysis generated yet.</p>
    <p class="dim">Calls the configured AI provider (real cost/latency) to recommend GCP service accounts and least-privilege roles for this repo's Terraform.</p>
    <button id="generateBtn">🔑 Generate IAM Analysis</button>
  `;
}

async function buildOverviewHtml(iam: IamOverview): Promise<string> {
  const analyzedAt = iam.analyzed_at ? new Date(iam.analyzed_at * 1000).toLocaleString() : "Unknown";
  const analysisHtml = iam.analysis ? await renderMarkdownSafe(iam.analysis) : "<p class='dim'>No analysis text returned.</p>";

  return /* html */ `
    <table>
      <tr><td class="label">AI Provider</td><td>${escapeHtml(iam.provider ?? "Unknown")}</td></tr>
      <tr><td class="label">Last Analyzed</td><td>${escapeHtml(analyzedAt)}</td></tr>
    </table>
    <div class="actions"><button id="regenerateBtn">🔄 Regenerate</button></div>
    <div class="analysis">${analysisHtml}</div>
  `;
}

function buildHtml(repoName: string, bodyHtml: string, nonce: string): string {
  return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">
<style>
  body { font-family: var(--vscode-font-family); color: var(--vscode-foreground); padding: 0 24px 24px; }
  h1 { font-size: 1.4em; }
  table { border-collapse: collapse; margin: 12px 0; }
  td { padding: 4px 12px 4px 0; vertical-align: top; }
  td.label { color: var(--vscode-descriptionForeground); white-space: nowrap; }
  .dim { color: var(--vscode-descriptionForeground); }
  .actions { margin: 16px 0; }
  .analysis { border-top: 1px solid var(--vscode-panel-border); padding-top: 12px; max-width: 900px; }
  .analysis code { background: var(--vscode-textCodeBlock-background); padding: 1px 5px; border-radius: 3px; }
  .analysis pre { background: var(--vscode-textCodeBlock-background); padding: 10px; overflow-x: auto; }
  button {
    background: var(--vscode-button-background);
    color: var(--vscode-button-foreground);
    border: none; padding: 6px 14px; border-radius: 2px; cursor: pointer; font-size: 0.95em;
  }
  button:hover { background: var(--vscode-button-hoverBackground); }
  button:disabled { opacity: 0.6; cursor: default; }
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
 */
async function generateAndFetch(repoPath: string): Promise<IamOverview> {
  await runInteractiveShell(`mt-radar --iam -r ${shellQuote(path.basename(repoPath))}`);
  return fetchIam(repoPath);
}

async function renderBody(iam: IamOverview, repoName: string): Promise<string> {
  return iam.status === "ok" ? buildOverviewHtml(iam) : buildEmptyStateHtml(repoName, iam.status);
}

/**
 * Shows the AI-generated GCP IAM recommendations (service accounts +
 * least-privilege roles) for one repo's Terraform -- generating it on
 * first view if it hasn't been already. Unlike showInfraOverview, this
 * always calls the configured AI provider (real cost/latency), so nothing
 * here runs automatically; the panel only ever reads the cache until the
 * user clicks Generate/Regenerate.
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
        const result = await generateAndFetch(displayedRepoPath);
        const html = await renderBody(result, path.basename(displayedRepoPath));
        activePanel?.webview.postMessage({ command: "updateBody", html });
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
