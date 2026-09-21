import * as path from "node:path";
import * as vscode from "vscode";
import { runFrameworkJson, shellQuote } from "./framework";

/** From `mt-radar --suggest-projects --json` (__mt_radar_gcp_suggest_projects, .bash.d/20-vcs/58-infra-gcp-scan.sh). */
interface GcpProjectSuggestion {
  project: string;
  environment: string;
  references: number;
  sources: string[];
}

interface PickOptions {
  /** QuickPick title, e.g. "Scan GCP deployment". */
  title: string;
  /** Label of the "no project" choice, and what it means. */
  noProjectLabel: string;
  noProjectDetail: string;
  /** Project used last time, offered first when it is not already suggested. */
  previous?: string | null;
}

type PickItem = vscode.QuickPickItem & { project?: string; custom?: boolean };

const ENVIRONMENT_ICON: Record<string, string> = { dev: "$(beaker)", stage: "$(rocket)", test: "$(checklist)", prod: "$(shield)" };

async function suggestProjects(repoPath: string): Promise<GcpProjectSuggestion[]> {
  try {
    return await runFrameworkJson<GcpProjectSuggestion[]>(`mt-radar --suggest-projects -r ${shellQuote(path.basename(repoPath))} --json`);
  } catch {
    // Suggestions are a convenience -- fall back to free-text entry rather than blocking the action.
    return [];
  }
}

/**
 * Asks which GCP project to use, offering the project IDs mined from the repo's own
 * files (Terraform, tfvars, YAML/JSON config, CI pipelines) plus a free-text entry.
 * Resolves to the chosen project ID, "" for the "no project" choice, or undefined
 * when the user cancelled at any step.
 */
export async function pickGcpProject(repoPath: string, options: PickOptions): Promise<string | undefined> {
  const suggestions = await suggestProjects(repoPath);
  const suggested = new Set(suggestions.map((s) => s.project));

  const items: PickItem[] = [];
  if (options.previous && !suggested.has(options.previous)) {
    items.push({ label: options.previous, description: "last used", project: options.previous });
  }
  for (const s of suggestions) {
    const env = s.environment ? `${ENVIRONMENT_ICON[s.environment] ?? "$(cloud)"} ${s.environment}` : "$(cloud)";
    items.push({
      label: s.project,
      description: s.project === options.previous ? `${env} · last used` : env,
      detail: `${s.references} reference${s.references === 1 ? "" : "s"} in ${s.sources.join(", ")}`,
      project: s.project,
    });
  }
  items.push({ label: "", kind: vscode.QuickPickItemKind.Separator });
  items.push({ label: "$(edit) Enter another project…", custom: true });
  items.push({ label: `$(circle-slash) ${options.noProjectLabel}`, detail: options.noProjectDetail, project: "" });

  const picked = await vscode.window.showQuickPick(items, {
    title: options.title,
    placeHolder: suggestions.length > 0 ? "Projects found in this repo's files" : "No project IDs found in this repo's files",
    matchOnDescription: true,
    matchOnDetail: true,
  });
  if (!picked) return undefined;
  if (!picked.custom) return picked.project;

  const typed = await vscode.window.showInputBox({ title: options.title, prompt: "GCP project ID", placeHolder: "e.g. my-project-dev", value: options.previous ?? "" });
  return typed === undefined ? undefined : typed.trim();
}
