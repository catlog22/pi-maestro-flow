/**
 * Next-step suggestion engine.
 *
 * Builds a lightweight turn context from the finished agent transcript,
 * resolves the configured generation model (session model by default, or a
 * dedicated model pinned through the API manager), and runs a single
 * non-streaming completion. Generation never blocks the caller: wiring
 * schedules it in the background and only renders when it settles.
 */
import { completeSimple, type Message, type ThinkingLevel as AiThinkingLevel } from "@earendil-works/pi-ai/compat";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { NO_SUGGESTION_TOKEN, type NextSuggestConfig } from "./config.ts";
import { renderSuggestionPrompt } from "./template.ts";

export interface SuggestionResult {
  kind: "suggestion" | "no_suggestion" | "error";
  text: string;
  error?: string;
}

export interface TurnContext {
  turnStatus: string;
  recentUserPrompts: string[];
  toolSignals: string[];
  touchedFiles: string[];
  unresolvedQuestions: string[];
  latestAssistantText: string;
}

const MAX_CONTEXT_MESSAGES = 24;

function messageText(message: unknown): string {
  if (!message || typeof message !== "object") return "";
  const record = message as { content?: unknown };
  if (typeof record.content === "string") return record.content;
  if (!Array.isArray(record.content)) return "";
  return record.content
    .map((block) => {
      if (block && typeof block === "object" && (block as { type?: unknown }).type === "text") {
        const text = (block as { text?: unknown }).text;
        return typeof text === "string" ? text : "";
      }
      return "";
    })
    .join("\n")
    .trim();
}

function toolSummary(message: unknown): string | undefined {
  if (!message || typeof message !== "object") return undefined;
  const record = message as { content?: unknown };
  if (!Array.isArray(record.content)) return undefined;
  for (const block of record.content) {
    if (!block || typeof block !== "object") continue;
    const type = (block as { type?: unknown }).type;
    if (type === "tool_call") {
      const name = (block as { name?: unknown }).name;
      const input = (block as { input?: unknown }).input;
      if (typeof name === "string") return `tool_call:${name}`;
    }
    if (type === "tool_result") {
      const name = (block as { name?: unknown }).name;
      const error = (block as { error?: unknown }).error;
      if (typeof name === "string") return error ? `tool_result:${name} (error)` : `tool_result:${name}`;
    }
  }
  return undefined;
}

export function extractTurnContext(messages: AgentMessage[]): TurnContext {
  const recentUserPrompts: string[] = [];
  const toolSignals: string[] = [];
  const touchedFiles = new Set<string>();
  const unresolvedQuestions: string[] = [];
  let latestAssistantText = "";
  let turnStatus = "success";

  const windowed = messages.slice(-MAX_CONTEXT_MESSAGES);
  for (const message of windowed) {
    // Tool blocks may live inside assistant (tool_call) or tool (tool_result) messages.
    const summary = toolSummary(message);
    if (summary && toolSignals.length < 8) toolSignals.push(summary);
    const role = (message as { role?: unknown }).role;
    if (role === "user") {
      const text = messageText(message);
      if (text && recentUserPrompts.length < 4) recentUserPrompts.unshift(text.slice(0, 500));
    } else if (role === "assistant") {
      const text = messageText(message);
      if (text) latestAssistantText = text.slice(-2000);
    }
  }

  // Tool mentions of files feed the touched-files signal; keep it cheap by
  // scanning only tool call arguments for a few common path keys.
  for (const message of windowed) {
    const record = message as { content?: unknown };
    if (!Array.isArray(record.content)) continue;
    for (const block of record.content) {
      if (!block || typeof block !== "object") continue;
      if ((block as { type?: unknown }).type !== "tool_call") continue;
      const input = (block as { input?: unknown }).input;
      if (!input || typeof input !== "object") continue;
      for (const key of ["path", "file", "command"]) {
        const value = (input as Record<string, unknown>)[key];
        if (typeof value !== "string") continue;
        const candidates = key === "command"
          ? [...value.matchAll(/[\w./-]+\.(?:ts|tsx|js|jsx|mjs|cjs|json|md|css|html|py|rs|go|java|sh)\b/g)].map((match) => match[0])
          : [value];
        for (const candidate of candidates) {
          if (/[\.](?:ts|tsx|js|jsx|mjs|cjs|json|md|css|html|py|rs|go|java|sh)$/.test(candidate)) {
            touchedFiles.add(candidate.slice(0, 200));
          }
        }
      }
    }
  }

  return {
    turnStatus,
    recentUserPrompts,
    toolSignals,
    touchedFiles: [...touchedFiles].slice(0, 8),
    unresolvedQuestions,
    latestAssistantText,
  };
}

/** Resolve the configured model: "session" follows the active model; "provider/id" pins one. */
export function resolveSuggestionModel(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  config: NextSuggestConfig,
): { model: NonNullable<ExtensionContext["model"]> } | undefined {
  const currentModel = ctx.model;
  if (!currentModel) return undefined;
  const modelRef = (config.modelRef ?? "session").trim();
  if (!modelRef || modelRef === "session") return { model: currentModel };
  const allModels = typeof ctx.modelRegistry?.getAll === "function" ? ctx.modelRegistry.getAll() : [];
  const [provider, ...rest] = modelRef.split("/");
  const modelId = rest.join("/");
  const exact = allModels.find((entry) => entry.provider === provider && entry.id === modelId);
  if (exact) return { model: exact };
  return { model: currentModel };
}

function normalizeSuggestion(value: string, maxChars: number): string {
  const collapsed = value
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .split("\n")
    .map((line) => line.trimEnd())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  if (!collapsed) return "";
  return collapsed.length > maxChars ? collapsed.slice(0, maxChars).trimEnd() : collapsed;
}

export async function generateNextSuggestion(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  config: NextSuggestConfig,
  messages: AgentMessage[],
): Promise<SuggestionResult> {
  const resolved = resolveSuggestionModel(pi, ctx, config);
  if (!resolved) {
    return { kind: "error", text: "", error: "No active model for suggestion generation." };
  }

  const turn = extractTurnContext(messages);
  const prompt = renderSuggestionPrompt({
    ...turn,
    maxSuggestionChars: config.maxSuggestionChars,
    noSuggestionToken: NO_SUGGESTION_TOKEN,
  });

  const requestContext: Message[] = [
    {
      role: "user",
      content: [{ type: "text", text: prompt }],
      timestamp: Date.now(),
    },
  ];

  try {
    const response = await completeSimple(
      resolved.model,
      {
        systemPrompt: "You are the suggestion engine of a coding agent. Return only the requested format.",
        messages: requestContext,
      },
      {
        reasoning: config.thinking === "default" ? undefined : (config.thinking as AiThinkingLevel),
        sessionId: ctx.sessionManager.getSessionId(),
      },
    );
    const raw = response.content
      ? typeof response.content === "string"
        ? response.content
        : response.content
            .map((block: { type?: string; text?: string }) => (block.type === "text" ? block.text ?? "" : ""))
            .join("")
            .trim()
      : "";
    const text = normalizeSuggestion(raw, config.maxSuggestionChars);
    if (!text || text === NO_SUGGESTION_TOKEN) {
      return { kind: "no_suggestion", text: "" };
    }
    return { kind: "suggestion", text };
  } catch (error) {
    return {
      kind: "error",
      text: "",
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
