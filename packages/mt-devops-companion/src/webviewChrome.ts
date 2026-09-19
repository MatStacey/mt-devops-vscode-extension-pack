/**
 * CSS shared by every webview panel (repoReportPanel, infraOverviewPanel,
 * iamAdvisorPanel) -- extracted after the third near-verbatim copy of the
 * same body/heading/table/button rules appeared (rule of three). Each
 * panel's own `<style>` block still follows this with its panel-specific
 * rules (pills, gcpScanList, readme, ...); CSS cascade lets those override
 * a rule here by re-declaring the same selector when a panel genuinely
 * needs to (e.g. repoReportPanel's h1 adds `word-break: break-all` for
 * long repo names).
 *
 * `.prose` bounds AI-generated or free-form long-text blocks (the IAM
 * analysis, a rendered README) to a comfortable reading width -- full
 * viewport-width paragraphs are hard to scan once a panel is widened past
 * a narrow sidebar-docked column.
 */
export const WEBVIEW_BASE_STYLES = /* css */ `
  body { font-family: var(--vscode-font-family); color: var(--vscode-foreground); padding: 0 24px 24px; }
  h1 { font-size: 1.4em; }
  h2 { font-size: 1em; text-transform: uppercase; letter-spacing: 0.05em; color: var(--vscode-descriptionForeground); margin-top: 24px; }
  table { border-collapse: collapse; margin: 12px 0; }
  td { padding: 4px 12px 4px 0; vertical-align: top; }
  td.label { color: var(--vscode-descriptionForeground); white-space: nowrap; }
  .dim { color: var(--vscode-descriptionForeground); }
  .actions { display: flex; gap: 10px; align-items: center; margin: 16px 0; flex-wrap: wrap; }
  .prose { max-width: 900px; }
  button {
    background: var(--vscode-button-background);
    color: var(--vscode-button-foreground);
    border: none; padding: 6px 14px; border-radius: 2px; cursor: pointer; font-size: 0.95em;
  }
  button:hover { background: var(--vscode-button-hoverBackground); }
  button:disabled { opacity: 0.6; cursor: default; }
`;
