import * as vscode from "vscode";
import { runInteractiveShell, shellQuote, stripAnsi } from "./framework";

const PARTICIPANT_ID = "mtdevops.ai";

/**
 * Runs one of the framework's own AI commands (ai / ai-explain /
 * tf-ai-iam) and streams the result as markdown. This never calls an
 * LLM API directly -- the framework already owns provider selection,
 * API keys, and prompt construction (see .bash.d/30-ai/60-ai.sh), so
 * the chat participant is a thin client over it, same as every other
 * view in this extension.
 *
 * Known limitation: `ai`'s code-generation replies save the generated
 * code straight to a file and only print a one-line "Saved to: <path>"
 * summary to stdout (see __ai_parse_response) -- so this chat
 * participant works well for direct Q&A, but won't show generated code
 * inline the way a native chat-based code assistant would.
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
    try {
      const output = await runInteractiveShell(`cd ${shellQuote(folder.uri.fsPath)} && tf-ai-iam`);
      stream.markdown(stripAnsi(output) || "_(no output)_");
    } catch (err) {
      stream.markdown(`Error: ${err instanceof Error ? err.message : String(err)}`);
    }
    return;
  }

  if (request.command === "explain") {
    if (!prompt) {
      stream.markdown("Give me a command to explain, e.g. `@mtdevops /explain docker ps -a`.");
      return;
    }
    stream.progress("Explaining that command (ai-explain)...");
    try {
      const output = await runInteractiveShell(`ai-explain ${shellQuote(prompt)}`);
      stream.markdown(stripAnsi(output) || "_(no output)_");
    } catch (err) {
      stream.markdown(`Error: ${err instanceof Error ? err.message : String(err)}`);
    }
    return;
  }

  if (!prompt) {
    stream.markdown("Ask me anything, e.g. `@mtdevops how do I roll back a Helm release?`");
    return;
  }
  stream.progress("Asking the configured AI provider (ai)...");
  try {
    const output = await runInteractiveShell(`ai ${shellQuote(prompt)}`);
    stream.markdown(stripAnsi(output) || "_(no output)_");
  } catch (err) {
    stream.markdown(`Error: ${err instanceof Error ? err.message : String(err)}`);
  }
};

export function registerAiChatParticipant(context: vscode.ExtensionContext): void {
  const participant = vscode.chat.createChatParticipant(PARTICIPANT_ID, handler);
  context.subscriptions.push(participant);
}
