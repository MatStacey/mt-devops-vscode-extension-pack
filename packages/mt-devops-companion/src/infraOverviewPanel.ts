import * as crypto from "node:crypto";
import * as path from "node:path";
import * as vscode from "vscode";
import { runFrameworkJson, runInteractiveShell, shellQuote } from "./framework";

interface InfraResourceEntry {
  type: string;
  name: string;
}

interface InfraOverview {
  status: "ok" | "not-analyzed" | "no-terraform";
  analyzed_at: number | null;
  tf_file_count: number;
  providers: string[];
  modules: Array<{ name: string }>;
  resources: Record<string, InfraResourceEntry[]>;
  resource_count: number;
}

/** Display order and colour per __mt_hub_infra_categorize_resource's category vocabulary (.bash.d/20-vcs/57-infra.sh) -- restricted to VS Code's standard chart tokens (no "charts-cyan" exists), reused where the palette runs out rather than falling back to a generic default for every remaining category. */
const CATEGORY_ORDER = ["compute", "networking", "storage", "database", "messaging", "iam", "data", "other"] as const;
const CATEGORY_LABEL: Record<string, string> = {
  compute: "Compute",
  networking: "Networking",
  storage: "Storage",
  database: "Database",
  messaging: "Messaging",
  iam: "IAM",
  data: "Data/Analytics",
  other: "Other",
};
const CATEGORY_COLOR: Record<string, string> = {
  compute: "var(--vscode-charts-green)",
  networking: "var(--vscode-charts-blue)",
  storage: "var(--vscode-charts-yellow)",
  database: "var(--vscode-charts-purple)",
  messaging: "var(--vscode-charts-orange)",
  iam: "var(--vscode-charts-red)",
  data: "var(--vscode-charts-blue)",
  other: "var(--vscode-badge-background)",
};

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function buildNotAnalyzedHtml(repoName: string, noTerraform: boolean): string {
  const message = noTerraform
    ? `No Terraform was found in <strong>${escapeHtml(repoName)}</strong> -- this feature only covers repos that deploy infrastructure via Terraform.`
    : `<strong>${escapeHtml(repoName)}</strong> hasn't had an infrastructure overview generated yet.`;
  const button = noTerraform ? "" : `<button id="generateBtn">🏗️ Generate Infrastructure Overview</button>`;
  return /* html */ `<p>${message}</p>${button}`;
}

function buildOverviewHtml(infra: InfraOverview): string {
  const providers = infra.providers.length > 0 ? infra.providers.join(", ") : "None detected";
  const modules = infra.modules.length > 0 ? infra.modules.map((m) => escapeHtml(m.name)).join(", ") : "None";
  const analyzedAt = infra.analyzed_at ? new Date(infra.analyzed_at * 1000).toLocaleString() : "Unknown";

  const sections = CATEGORY_ORDER.map((category) => {
    const entries = infra.resources[category];
    if (!entries || entries.length === 0) return "";
    const color = CATEGORY_COLOR[category];
    const pills = entries
      .map((e) => `<span class="resPill" style="border-color: ${color};">${escapeHtml(e.type)}<span class="dim">.${escapeHtml(e.name)}</span></span>`)
      .join("");
    return `<h2>${escapeHtml(CATEGORY_LABEL[category])} <span class="dim">(${entries.length})</span></h2><div class="resources">${pills}</div>`;
  }).join("");

  return /* html */ `
    <table>
      <tr><td class="label">Providers</td><td>${escapeHtml(providers)}</td></tr>
      <tr><td class="label">Terraform Files</td><td>${infra.tf_file_count}</td></tr>
      <tr><td class="label">Total Resources</td><td>${infra.resource_count}</td></tr>
      <tr><td class="label">Modules Used</td><td>${modules}</td></tr>
      <tr><td class="label">Last Analyzed</td><td>${escapeHtml(analyzedAt)}</td></tr>
    </table>
    <div class="actions"><button id="regenerateBtn">🔄 Regenerate</button></div>
    ${sections || '<p class="dim">No resources found in this repo\'s Terraform.</p>'}
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
  h2 { font-size: 1em; text-transform: uppercase; letter-spacing: 0.05em; color: var(--vscode-descriptionForeground); margin-top: 24px; }
  table { border-collapse: collapse; margin: 12px 0; }
  td { padding: 4px 12px 4px 0; vertical-align: top; }
  td.label { color: var(--vscode-descriptionForeground); white-space: nowrap; }
  .resources { display: flex; flex-wrap: wrap; gap: 8px; }
  .resPill { border: 1px solid; border-radius: 12px; padding: 3px 10px; font-size: 0.9em; }
  .dim { color: var(--vscode-descriptionForeground); }
  .actions { margin: 16px 0; }
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
  <h1>🏗️ Infrastructure Overview: ${escapeHtml(repoName)}</h1>
  <div id="body">${bodyHtml}</div>
  <div id="error"></div>

  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    function wire() {
      const genBtn = document.getElementById("generateBtn");
      if (genBtn) genBtn.addEventListener("click", () => {
        genBtn.disabled = true;
        genBtn.textContent = "Generating...";
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
        if (genBtn) { genBtn.disabled = false; genBtn.textContent = "🏗️ Generate Infrastructure Overview"; }
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

async function fetchInfra(repoPath: string): Promise<InfraOverview> {
  return runFrameworkJson<InfraOverview>(`mt-hub --show-infra ${shellQuote(repoPath)} --json`);
}

/**
 * Analyzes (mt-hub --infra -- no AI call, so no confirmation/cost warning
 * needed) then re-fetches the cached result. mt-hub --infra itself has no
 * --json mode (it's a bulk-capable scan with plain progress text, unlike
 * --show-infra's single-repo read), so this is two calls: one to generate,
 * one to read back the structured result -- if the second call still
 * comes back "not-analyzed" after a successful generate, that reliably
 * means no Terraform was found (the only way --infra completes without
 * writing a cache entry), not that the generate silently failed.
 */
async function generateAndFetch(repoPath: string): Promise<InfraOverview> {
  // -r <name> alone is enough to target this exact repo, same as every
  // other index/update command in this extension -- __mt_hub_infra_run
  // matches by basename against every repo under VCS_ROOT regardless of
  // which type/subfolder it lives in.
  await runInteractiveShell(`mt-hub --infra -r ${shellQuote(path.basename(repoPath))}`).catch(() => {
    // Ignore -- __mt_hub_infra_run's own progress text isn't JSON and
    // runInteractiveShell's marker-extraction can be finicky with it;
    // the follow-up fetchInfra call is the real source of truth here.
  });
  return fetchInfra(repoPath);
}

/**
 * Shows the Terraform-derived infrastructure overview for one repo:
 * resources grouped by category (compute/networking/storage/database/
 * messaging/IAM/data/other), providers, and modules used -- generating
 * it on first view if it hasn't been already (mt-hub --infra has no AI
 * cost, so this never needs the confirm-first treatment AI actions get).
 */
export async function showInfraOverview(repoPath: string): Promise<void> {
  const repoName = path.basename(repoPath);
  displayedRepoPath = repoPath;
  const nonce = getNonce();

  let infra: InfraOverview;
  try {
    infra = await fetchInfra(repoPath);
  } catch (err) {
    vscode.window.showErrorMessage(`MT DevOps: couldn't read the infrastructure overview -- ${err instanceof Error ? err.message : String(err)}`);
    return;
  }

  const bodyHtml = infra.status === "ok" ? buildOverviewHtml(infra) : buildNotAnalyzedHtml(repoName, infra.status === "no-terraform");

  if (!activePanel) {
    activePanel = vscode.window.createWebviewPanel("mtDevopsInfraOverview", "Infrastructure Overview", vscode.ViewColumn.Active, {
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
        const html =
          result.status === "ok" ? buildOverviewHtml(result) : buildNotAnalyzedHtml(path.basename(displayedRepoPath), result.status === "no-terraform");
        activePanel?.webview.postMessage({ command: "updateBody", html });
      } catch (err) {
        activePanel?.webview.postMessage({
          command: "generateFailed",
          message: escapeHtml(err instanceof Error ? err.message : String(err)),
        });
      }
    });
  }

  activePanel.title = `Infra: ${repoName}`;
  activePanel.webview.html = buildHtml(repoName, bodyHtml, nonce);
  activePanel.reveal(vscode.ViewColumn.Active);
}
