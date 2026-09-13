import * as crypto from "node:crypto";
import * as vscode from "vscode";
import { runFrameworkJson, shellQuote } from "./framework";

interface ExportPlan {
  status: string;
  target_dir: string;
  export_dir: string;
  output_file: string;
  schema: string;
  schema_name: string;
  format: string;
  total_files: number;
  total_bytes: number;
  extensions: string[];
}

interface ExportRunResult {
  status: string;
  output_file: string;
  total_files: number;
  total_bytes: number;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function humanBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB"];
  let n = bytes / 1024;
  let i = 0;
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024;
    i++;
  }
  return `${n.toFixed(1)} ${units[i]}`;
}

/**
 * The one place the wizard's controls (schema/extension-exclusions/zip)
 * and its tree's exclude list turn into real mt-export flags -- shared
 * between the plan call (adds -p) and the real run (doesn't), so the two
 * invocations can never drift into excluding different files than what
 * the plan showed. Excluded paths are comma-joined into a single -e, the
 * same form mt-export's own CLI already expects.
 */
function buildExportCommand(
  repoPath: string,
  schema: string,
  excludeExt: string,
  zip: boolean,
  excludedPaths: string[],
  extraFlags: string,
): string {
  const parts = [`cd ${shellQuote(repoPath)} &&`, "mt-export", "-s", shellQuote(schema)];
  if (excludedPaths.length > 0) parts.push("-e", shellQuote(excludedPaths.join(",")));
  if (excludeExt.trim()) parts.push("-x", shellQuote(excludeExt.trim()));
  if (zip) parts.push("-z");
  parts.push(extraFlags);
  return parts.join(" ");
}

function buildHtml(plan: ExportPlan, nonce: string): string {
  const extList = plan.extensions.length > 0 ? plan.extensions.join(", ") : "None/Unknown";
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
  .actions { display: flex; gap: 10px; align-items: center; margin-top: 20px; flex-wrap: wrap; }
  button {
    background: var(--vscode-button-background);
    color: var(--vscode-button-foreground);
    border: none; padding: 6px 14px; border-radius: 2px; cursor: pointer; font-size: 0.95em;
  }
  button:hover { background: var(--vscode-button-hoverBackground); }
  button:disabled { opacity: 0.6; cursor: default; }
  button.secondary { background: transparent; border: 1px solid var(--vscode-button-background); color: var(--vscode-foreground); }
  #result { margin-top: 16px; }
  .ok { color: var(--vscode-terminal-ansiGreen); }
  .err { color: var(--vscode-terminal-ansiRed); }
</style>
</head>
<body>
  <h1>📊 Export Plan</h1>
  <table>
    <tr><td class="label">Target Dir</td><td>${escapeHtml(plan.target_dir)}</td></tr>
    <tr><td class="label">Export Dir</td><td>${escapeHtml(plan.export_dir)}</td></tr>
    <tr><td class="label">Output File</td><td>${escapeHtml(plan.output_file)}</td></tr>
    <tr><td class="label">Schema</td><td>${escapeHtml(plan.schema)} (${escapeHtml(plan.schema_name)})</td></tr>
    <tr><td class="label">Format</td><td>${escapeHtml(plan.format.toUpperCase())}</td></tr>
    <tr><td class="label">Total Files</td><td>${plan.total_files}</td></tr>
    <tr><td class="label">Est. Size</td><td>~${humanBytes(plan.total_bytes)}</td></tr>
    <tr><td class="label">Extensions</td><td>${escapeHtml(extList)}</td></tr>
  </table>

  <div class="actions">
    <button id="runBtn">🚀 Proceed with Export</button>
    <button id="backBtn" class="secondary">◀ Back to Wizard (Make Changes)</button>
  </div>

  <div id="result"></div>

  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    const runBtn = document.getElementById("runBtn");
    const resultEl = document.getElementById("result");
    runBtn.addEventListener("click", () => {
      runBtn.disabled = true;
      runBtn.textContent = "Running...";
      vscode.postMessage({ command: "runExport" });
    });
    document.getElementById("backBtn").addEventListener("click", () => {
      vscode.postMessage({ command: "backToWizard" });
    });
    window.addEventListener("message", (event) => {
      if (event.data.command === "exportComplete") {
        const r = event.data.result;
        runBtn.textContent = "✅ Export Complete";
        resultEl.innerHTML =
          '<p class="ok">✅ Saved ' + r.total_files + ' file(s) to<br><code>' + r.output_file + '</code></p>' +
          '<button id="revealBtn">📂 Reveal in Explorer</button>';
        document.getElementById("revealBtn").addEventListener("click", () => {
          vscode.postMessage({ command: "revealOutput", path: event.data.rawOutputFile });
        });
      } else if (event.data.command === "exportFailed") {
        runBtn.disabled = false;
        runBtn.textContent = "🚀 Proceed with Export";
        resultEl.innerHTML = '<p class="err">🚨 ' + event.data.message + '</p>';
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

/**
 * Shows the read-only plan a wizard-configured mt-export call would
 * produce (via --plan --json, which never writes anything), with a
 * button to run that exact same command for real. Called fresh from
 * "Show Export Plan" every time -- the plan is a point-in-time snapshot
 * of the wizard's current controls, not a live view, so a new plan
 * requires going back to the wizard and re-triggering it after any
 * change.
 */
export async function showExportPlan(
  repoPath: string,
  schema: string,
  excludeExt: string,
  zip: boolean,
  excludedPaths: string[],
): Promise<void> {
  const planCommand = buildExportCommand(repoPath, schema, excludeExt, zip, excludedPaths, "-p -j");
  let plan: ExportPlan;
  try {
    plan = await runFrameworkJson<ExportPlan>(planCommand);
  } catch (err) {
    vscode.window.showErrorMessage(`MT DevOps: couldn't build the export plan -- ${err instanceof Error ? err.message : String(err)}`);
    return;
  }

  const nonce = getNonce();
  if (!activePanel) {
    activePanel = vscode.window.createWebviewPanel("mtDevopsExportPlan", "Export Plan", vscode.ViewColumn.Active, {
      enableScripts: true,
      retainContextWhenHidden: false,
    });
    activePanel.onDidDispose(() => {
      activePanel = undefined;
    });
  }

  activePanel.webview.onDidReceiveMessage(async (message: { command: string; path?: string }) => {
    if (message.command === "runExport") {
      const runCommand = buildExportCommand(repoPath, schema, excludeExt, zip, excludedPaths, "-j");
      try {
        const result = await runFrameworkJson<ExportRunResult>(runCommand);
        // output_file is a real absolute path built by mt-export from
        // config/computed names, not visitor-controlled -- escaped
        // anyway since the webview script inserts it via innerHTML,
        // same trust-boundary discipline as every other server-rendered
        // string reaching this webview.
        activePanel?.webview.postMessage({
          command: "exportComplete",
          result: { ...result, output_file: escapeHtml(result.output_file) },
          // The raw path is kept separate for the "Reveal in Explorer"
          // button's own postMessage back to the extension, which needs
          // the real filesystem path, not the HTML-escaped display copy.
          rawOutputFile: result.output_file,
        });
      } catch (err) {
        activePanel?.webview.postMessage({
          command: "exportFailed",
          message: escapeHtml(err instanceof Error ? err.message : String(err)),
        });
      }
      return;
    }
    if (message.command === "backToWizard") {
      await vscode.commands.executeCommand("mtDevopsExportWizard.focus");
      return;
    }
    if (message.command === "revealOutput" && message.path) {
      await vscode.commands.executeCommand("revealFileInOS", vscode.Uri.file(message.path));
    }
  });

  activePanel.title = "Export Plan";
  activePanel.webview.html = buildHtml(plan, nonce);
  activePanel.reveal(vscode.ViewColumn.Active);
}
