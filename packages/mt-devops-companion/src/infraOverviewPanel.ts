import * as crypto from "node:crypto";
import * as path from "node:path";
import * as vscode from "vscode";
import { runFrameworkJson, runInteractiveShell, shellQuote } from "./framework";
import { WEBVIEW_BASE_STYLES } from "./webviewChrome";

interface InfraResourceEntry {
  type: string;
  name: string;
}

/** From __mt_radar_gcp_check_resource (.bash.d/20-vcs/58-infra-gcp-scan.sh) -- one Terraform google_* resource's live-deployment check. "reason" is set only when deployed is false: "unsupported-resource-type" (supported is also false in that case), "api-error", or "not-found-or-no-access". "matched_name" is set only when deployed is true via the repo-name fallback rather than an exact match on the Terraform resource label ("name") -- real deployments overwhelmingly name a resource after the repo (`name = var.service_name`) rather than its Terraform label. */
interface GcpScanResource {
  type: string;
  name: string;
  supported: boolean;
  deployed: boolean;
  region: string | null;
  console_url: string | null;
  live_url: string | null;
  matched_name: string | null;
  reason: string | null;
}

/** From __mt_radar_gcp_scan_repo -- an existence check against a live GCP project, not a `terraform plan` config/state drift check. sync_status: green = every checked resource deployed, red = none, amber = partial, unknown = nothing checkable (no google_* resources, or none of their types supported yet). */
interface GcpScan {
  scanned_at: number;
  project: string;
  sync_status: "green" | "amber" | "red" | "unknown";
  checked_count: number;
  deployed_count: number;
  unsupported_count: number;
  resources: GcpScanResource[];
}

interface InfraOverview {
  status: "ok" | "not-analyzed" | "no-terraform";
  analyzed_at: number | null;
  tf_file_count: number;
  providers: string[];
  modules: Array<{ name: string }>;
  resources: Record<string, InfraResourceEntry[]>;
  resource_count: number;
  gcp_scan?: GcpScan;
}

/** Display order and colour per __mt_radar_infra_categorize_resource's category vocabulary (.bash.d/20-vcs/57-infra.sh) -- restricted to VS Code's standard chart tokens (no "charts-cyan" exists), reused where the palette runs out rather than falling back to a generic default for every remaining category. */
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

const SYNC_STATUS_COLOR: Record<GcpScan["sync_status"], string> = {
  green: "var(--vscode-charts-green)",
  amber: "var(--vscode-charts-yellow)",
  red: "var(--vscode-charts-red)",
  unknown: "var(--vscode-descriptionForeground)",
};
const SYNC_STATUS_ICON: Record<GcpScan["sync_status"], string> = { green: "🟢", amber: "🟡", red: "🔴", unknown: "⚪" };

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

/** Renders __mt_radar_gcp_scan_repo's result -- an existence check ("does a resource with this Terraform label's name, or failing that the repo's own name, exist in the given project"), not a real terraform plan config/state drift check, called out explicitly here so the RAG badge isn't read as more authoritative than it is. Unsupported resource types (nothing to check yet, e.g. Pub/Sub) are listed separately from not-deployed ones so a false-red repo full of unsupported types doesn't look identical to one that's actually missing everything. */
function buildGcpScanHtml(scan: GcpScan | undefined): string {
  if (!scan) {
    return /* html */ `
      <div class="actions"><button id="scanGcpBtn" data-has-scan="false">☁️ Scan GCP Deployment</button></div>
    `;
  }
  const color = SYNC_STATUS_COLOR[scan.sync_status];
  const icon = SYNC_STATUS_ICON[scan.sync_status];
  const scannedAt = new Date(scan.scanned_at * 1000).toLocaleString();

  const rows = scan.resources
    .filter((r) => r.supported)
    .map((r) => {
      const label = `${escapeHtml(r.type)}<span class="dim">.${escapeHtml(r.name)}</span>`;
      if (r.deployed) {
        const link = r.console_url ? ` -- <a href="${escapeHtml(r.console_url)}">Console</a>` : "";
        const live = r.live_url ? ` <a href="${escapeHtml(r.live_url)}">↗</a>` : "";
        const matched = r.matched_name ? ` <span class="dim">(deployed as "${escapeHtml(r.matched_name)}", not the Terraform label)</span>` : "";
        return `<li>✅ ${label}${matched}${link}${live}</li>`;
      }
      const reason = r.reason && r.reason !== "not-found-or-no-access" ? ` <span class="dim">(${escapeHtml(r.reason)})</span>` : "";
      return `<li>❌ ${label} <span class="dim">-- not found in ${escapeHtml(scan.project)}</span>${reason}</li>`;
    })
    .join("");
  const unsupportedRows = scan.resources
    .filter((r) => !r.supported)
    .map((r) => `<li class="dim">⚪ ${escapeHtml(r.type)}.${escapeHtml(r.name)} -- not yet checkable</li>`)
    .join("");

  return /* html */ `
    <h2>GCP Deployment Status</h2>
    <table>
      <tr><td class="label">Project</td><td>${escapeHtml(scan.project)}</td></tr>
      <tr><td class="label">Status</td><td style="color: ${color};">${icon} ${scan.sync_status}</td></tr>
      <tr><td class="label">Deployed</td><td>${scan.deployed_count}/${scan.checked_count} checked resources</td></tr>
      <tr><td class="label">Last Scanned</td><td>${escapeHtml(scannedAt)}</td></tr>
    </table>
    <ul class="gcpScanList">${rows}</ul>
    ${unsupportedRows ? `<details><summary class="dim">${scan.unsupported_count} unsupported resource type(s)</summary><ul class="gcpScanList">${unsupportedRows}</ul></details>` : ""}
    <div class="actions"><button id="scanGcpBtn" data-has-scan="true">🔄 Rescan GCP Deployment</button></div>
  `;
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
    ${buildGcpScanHtml(infra.gcp_scan)}
  `;
}

function buildHtml(repoName: string, bodyHtml: string, nonce: string): string {
  return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">
<style>
  ${WEBVIEW_BASE_STYLES}
  .resources { display: flex; flex-wrap: wrap; gap: 8px; }
  .resPill { border: 1px solid; border-radius: 12px; padding: 3px 10px; font-size: 0.9em; }
  .gcpScanList { list-style: none; padding: 0; margin: 8px 0; }
  .gcpScanList li { padding: 3px 0; }
  details summary { cursor: pointer; margin: 8px 0; }
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
      const scanBtn = document.getElementById("scanGcpBtn");
      if (scanBtn) scanBtn.addEventListener("click", () => {
        scanBtn.disabled = true;
        scanBtn.textContent = "Scanning...";
        vscode.postMessage({ command: "scanGcp" });
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
        const scanBtn = document.getElementById("scanGcpBtn");
        if (genBtn) { genBtn.disabled = false; genBtn.textContent = "🏗️ Generate Infrastructure Overview"; }
        if (regenBtn) { regenBtn.disabled = false; regenBtn.textContent = "🔄 Regenerate"; }
        if (scanBtn) { scanBtn.disabled = false; scanBtn.textContent = scanBtn.dataset.hasScan === "true" ? "🔄 Rescan GCP Deployment" : "☁️ Scan GCP Deployment"; }
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
  return runFrameworkJson<InfraOverview>(`mt-radar --show-infra ${shellQuote(repoPath)} --json`);
}

/**
 * Analyzes (mt-radar --infra -- no AI call, so no confirmation/cost warning
 * needed) then re-fetches the cached result. mt-radar --infra itself has no
 * --json mode (it's a bulk-capable scan with plain progress text, unlike
 * --show-infra's single-repo read), so this is two calls: one to generate,
 * one to read back the structured result -- if the second call still
 * comes back "not-analyzed" after a successful generate, that reliably
 * means no Terraform was found (the only way --infra completes without
 * writing a cache entry), not that the generate silently failed.
 */
async function generateAndFetch(repoPath: string): Promise<InfraOverview> {
  // -r <name> alone is enough to target this exact repo, same as every
  // other index/update command in this extension -- __mt_radar_infra_run
  // matches by basename against every repo under VCS_ROOT regardless of
  // which type/subfolder it lives in.
  await runInteractiveShell(`mt-radar --infra -r ${shellQuote(path.basename(repoPath))}`).catch(() => {
    // Ignore -- __mt_radar_infra_run's own progress text isn't JSON and
    // runInteractiveShell's marker-extraction can be finicky with it;
    // the follow-up fetchInfra call is the real source of truth here.
  });
  return fetchInfra(repoPath);
}

/**
 * Runs mt-radar --scan-gcp (live, authenticated gcloud calls -- on-demand
 * only, same as generateAndFetch's --infra call has no AI cost but this
 * one does have live-API cost/latency) then re-fetches the merged
 * .vcs_infra.json entry, same two-call pattern as generateAndFetch.
 */
async function scanGcpAndFetch(repoPath: string, gcpProject: string | undefined): Promise<InfraOverview> {
  const projectFlag = gcpProject ? ` --gcp-project ${shellQuote(gcpProject)}` : "";
  await runInteractiveShell(`mt-radar --scan-gcp -r ${shellQuote(path.basename(repoPath))}${projectFlag}`);
  return fetchInfra(repoPath);
}

/**
 * Shows the Terraform-derived infrastructure overview for one repo:
 * resources grouped by category (compute/networking/storage/database/
 * messaging/IAM/data/other), providers, and modules used -- generating
 * it on first view if it hasn't been already (mt-radar --infra has no AI
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
      if (message.command === "generate") {
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
        return;
      }

      if (message.command === "scanGcp") {
        try {
          const gcpProject = await vscode.window.showInputBox({
            prompt: "GCP project to scan against (leave blank for gcloud's active project)",
            placeHolder: "e.g. my-project-dev",
          });
          if (gcpProject === undefined) {
            // User cancelled the prompt -- just re-render the unchanged body so the button re-enables.
            const current = await fetchInfra(displayedRepoPath);
            const html =
              current.status === "ok"
                ? buildOverviewHtml(current)
                : buildNotAnalyzedHtml(path.basename(displayedRepoPath), current.status === "no-terraform");
            activePanel?.webview.postMessage({ command: "updateBody", html });
            return;
          }
          const result = await scanGcpAndFetch(displayedRepoPath, gcpProject || undefined);
          const html =
            result.status === "ok" ? buildOverviewHtml(result) : buildNotAnalyzedHtml(path.basename(displayedRepoPath), result.status === "no-terraform");
          activePanel?.webview.postMessage({ command: "updateBody", html });
        } catch (err) {
          activePanel?.webview.postMessage({
            command: "generateFailed",
            message: escapeHtml(err instanceof Error ? err.message : String(err)),
          });
        }
      }
    });
  }

  activePanel.title = `Infra: ${repoName}`;
  activePanel.webview.html = buildHtml(repoName, bodyHtml, nonce);
  activePanel.reveal(vscode.ViewColumn.Active);
}
