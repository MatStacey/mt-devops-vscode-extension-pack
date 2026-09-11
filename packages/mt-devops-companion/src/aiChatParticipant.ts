import * as fs from "node:fs";
import * as path from "node:path";
import * as vscode from "vscode";
import { runInteractiveShell, shellQuote, stripAnsi } from "./framework";

const PARTICIPANT_ID = "mtdevops.ai";
const SAVED_TO_PATTERN = /^Saved to:\s*(.+)$/m;

/**
 * `ai`'s code-generation replies (see __ai_parse_response in
 * .bash.d/30-ai/60-ai.sh) save the generated code straight to a file
 * and only print a one-line "Saved to: <path>" summary to stdout --
 * the actual code content never reaches stdout at all. Rather than
 * reimplementing any part of that save/categorize logic here (which
 * would duplicate framework policy in TypeScript), this reads the
 * exact file the framework already decided to save and inlines it,
 * purely a presentation-layer addition on top of what `ai` already did.
 */
async function inlineSavedFile(stream: vscode.ChatResponseStream, plainOutput: string): Promise<void> {
  const match = plainOutput.match(SAVED_TO_PATTERN);
  if (!match) return;

  const savedPath = match[1].trim();
  let content: string;
  try {
    content = await fs.promises.readFile(savedPath, "utf8");
  } catch {
    // Saved path may be outside this extension's read access, or the
    // command emitted a "Saved to:"-shaped line for an unrelated
    // reason -- the summary line printed to chat already covers this.
    return;
  }

  const lang = path.extname(savedPath).replace(/^\./, "") || "text";
  stream.markdown(`\n\n\`\`\`${lang}\n${content}\n\`\`\`\n`);
  stream.button({
    command: "vscode.open",
    title: "Open Generated File",
    arguments: [vscode.Uri.file(savedPath)],
  });
}

async function runAndStream(stream: vscode.ChatResponseStream, command: string): Promise<void> {
  try {
    const output = await runInteractiveShell(command);
    const plain = stripAnsi(output);
    stream.markdown(plain || "_(no output)_");
    await inlineSavedFile(stream, plain);
  } catch (err) {
    stream.markdown(`Error: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/**
 * Runs one of the framework's own AI commands (ai / ai-explain /
 * tf-ai-iam) and streams the result as markdown. This never calls an
 * LLM API directly -- the framework already owns provider selection,
 * API keys, and prompt construction (see .bash.d/30-ai/60-ai.sh), so
 * the chat participant is a thin client over it, same as every other
 * view in this extension.
 */
const handler: vscode.ChatRequestHandler = async (request, _context, stream, _token) => {
  const prompt = request.prompt.trim();

  if (request.command === "iam") {
    const folder = vscode.workspace.workspaceFolders?.[0];
    if (!folder) {
      stream.markdown("Open a workspace folder containing Terraform files first.");
      return;
    }
    stream.progress("Analyzing this workspace's Terraform IAM requirements (tf-ai-iam)...");
    await runAndStream(stream, `cd ${shellQuote(folder.uri.fsPath)} && tf-ai-iam`);
    return;
  }

  if (request.command === "explain") {
    if (!prompt) {
      stream.markdown("Give me a command to explain, e.g. `@mtdevops /explain docker ps -a`.");
      return;
    }
    stream.progress("Explaining that command (ai-explain)...");
    await runAndStream(stream, `ai-explain ${shellQuote(prompt)}`);
    return;
  }

  if (!prompt) {
    stream.markdown("Ask me anything, e.g. `@mtdevops how do I roll back a Helm release?`");
    return;
  }
  stream.progress("Asking the configured AI provider (ai)...");
  await runAndStream(stream, `ai ${shellQuote(prompt)}`);
};

export function registerAiChatParticipant(context: vscode.ExtensionContext): void {
  const participant = vscode.chat.createChatParticipant(PARTICIPANT_ID, handler);
  context.subscriptions.push(participant);
}
