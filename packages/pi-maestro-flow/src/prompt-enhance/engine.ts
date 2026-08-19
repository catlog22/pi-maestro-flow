/**
 * Prompt-enhance generation engine.
 *
 * Resolves the configured generation model (session model by default, or a
 * dedicated model pinned through the API manager), builds the enhancer user
 * message from the gathered context, and runs a single non-streaming
 * completion. The enhancer never blocks agent turns — wiring schedules it
 * on demand and only writes back to the editor when it settles.
 */
import { completeSimple, type Message, type ThinkingLevel as AiThinkingLevel } from "@earendil-works/pi-ai/compat";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { EnhanceConfig } from "./config.ts";
import type { EnhancerContext } from "./context.ts";
import { cleanEnhancedText, ENHANCE_SYSTEM_PROMPT, renderEnhancePrompt } from "./template.ts";

export interface EnhanceResult {
  kind: "enhanced" | "error";
  text: string;
  error?: string;
}

/** Resolve the configured model: "session" follows the active model; "provider/id" pins one. */
export function resolveEnhanceModel(
  _pi: ExtensionAPI,
  ctx: ExtensionContext,
  config: EnhanceConfig,
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

function clampEnhanced(value: string, maxChars: number): string {
  const collapsed = value
    .split("\n")
    .map((line) => line.trimEnd())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  if (!collapsed) return "";
  return collapsed.length > maxChars ? collapsed.slice(0, maxChars).trimEnd() : collapsed;
}

export async function generateEnhancedPrompt(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  config: EnhanceConfig,
  prompt: string,
  context: EnhancerContext,
): Promise<EnhanceResult> {
  const resolved = resolveEnhanceModel(pi, ctx, config);
  if (!resolved) {
    return { kind: "error", text: "", error: "No active model for prompt enhancement." };
  }

  const userMessage = renderEnhancePrompt({ ...context, prompt });
  const requestContext: Message[] = [
    {
      role: "user",
      content: [{ type: "text", text: userMessage }],
      timestamp: Date.now(),
    },
  ];

  try {
    const response = await completeSimple(
      resolved.model,
      { systemPrompt: ENHANCE_SYSTEM_PROMPT, messages: requestContext },
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
    const cleaned = cleanEnhancedText(raw);
    const text = clampEnhanced(cleaned, config.maxChars);
    if (!text) {
      return { kind: "error", text: "", error: "Model returned an empty enhanced prompt." };
    }
    return { kind: "enhanced", text };
  } catch (error) {
    return {
      kind: "error",
      text: "",
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
