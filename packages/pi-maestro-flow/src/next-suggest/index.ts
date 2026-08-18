/**
 * Next-step suggestion wiring.
 *
 * After every settled agent turn a suggestion for the user's likely next
 * prompt is generated in the background with the configured model (session
 * model by default, or a dedicated model pinned in the API manager). The
 * suggestion is rendered as a widget below the editor; pressing the accept
 * shortcut (default F2) fills the editor, and any user input dismisses it.
 *
 * Feature switch, model, thinking level, length cap and accept key are
 * configured independently through the API manager (`/api-manager nextsuggest`
 * or the settings shell action `api.nextsuggest`), persisted in
 * `api-manager.json` under the `nextSuggest` section.
 */
import { readFileSync } from "node:fs";
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
  loadNextSuggestConfig,
  saveNextSuggestConfig,
  type NextSuggestAcceptKey,
} from "./config.ts";
import { generateNextSuggestion } from "./engine.ts";

const WIDGET_KEY = "next-suggest";
const WIDGET_PLACEMENT = { placement: "belowEditor" as const };
const GHOST = "\x1b[38;5;244m";
const RESET = "\x1b[0m";

export interface NextSuggestOptions {
  /** api-manager.json path; the `nextSuggest` section holds the config. */
  defaultsPath: string;
}

export interface NextSuggestStatus {
  enabled: boolean;
  modelRef: string;
  acceptKey: string;
  suggestion: string | undefined;
}

export function registerNextSuggest(
  pi: ExtensionAPI,
  options: NextSuggestOptions,
): () => NextSuggestStatus {
  let latestSuggestion: string | undefined;
  let generationEpoch = 0;

  const clearSuggestion = (ctx?: ExtensionContext): void => {
    generationEpoch += 1;
    latestSuggestion = undefined;
    if (ctx?.hasUI) ctx.ui.setWidget(WIDGET_KEY, undefined, WIDGET_PLACEMENT);
  };

  const renderWidgetLines = (text: string, acceptKey: string): string[] => [
    `${GHOST}下一步建议：${text}${RESET}`,
    `${GHOST}[${acceptKey}] 接受 · 输入内容后自动忽略${RESET}`,
  ];

  const showSuggestion = (ctx: ExtensionContext, text: string, acceptKey: string): void => {
    if (!ctx.hasUI) return;
    // Never render over an editor that already carries text.
    const current = ctx.ui.getEditorText();
    if (current.trim().length > 0) return;
    ctx.ui.setWidget(WIDGET_KEY, renderWidgetLines(text, acceptKey), WIDGET_PLACEMENT);
  };

  // Generate after each agent turn. Fire-and-forget: failures are silent
  // because the suggestion is a purely assistive surface.
  pi.on("agent_end", (event, ctx) => {
    void (async () => {
      const config = await loadNextSuggestConfig(options.defaultsPath);
      if (!config.enabled) return;
      const epoch = generationEpoch + 1;
      generationEpoch = epoch;
      const result = await generateNextSuggestion(pi, ctx, config, event.messages);
      if (epoch !== generationEpoch) return; // superseded by a new turn or user input
      if (result.kind === "suggestion") showSuggestion(ctx, result.text, config.acceptKey);
    })();
  });

  // Any user input dismisses the current suggestion.
  pi.on("input", () => {
    clearSuggestion();
  });

  // Accept: fill the editor with the suggestion. The shortcut is registered
  // with the configured key at load time (registerShortcut has no unregister
  // surface); changing acceptKey takes effect after a plugin reload.
  const acceptKey = readConfiguredAcceptKey(options.defaultsPath);
  pi.registerShortcut(acceptKey as Parameters<ExtensionAPI["registerShortcut"]>[0], {
    description: "Accept the next-step suggestion into the editor",
    handler: async (ctx) => {
      const config = await loadNextSuggestConfig(options.defaultsPath);
      if (!config.enabled || !latestSuggestion || !ctx.hasUI) return;
      ctx.ui.setEditorText(latestSuggestion);
      clearSuggestion(ctx);
      ctx.ui.notify("下一步建议已填入编辑器。", "info");
    },
  });

  pi.registerCommand("nextsuggest", {
    description: "next-suggest controls: status | on | off",
    handler: async (args, ctx) => {
      const config = await loadNextSuggestConfig(options.defaultsPath);
      const subcommand = args.trim().split(/\s+/)[0] ?? "status";
      if (subcommand === "on") {
        config.enabled = true;
        await saveNextSuggestConfig(config, options.defaultsPath);
        ctx.ui.notify("下一步建议已启用（F2 接受）。", "info");
        return;
      }
      if (subcommand === "off") {
        config.enabled = false;
        await saveNextSuggestConfig(config, options.defaultsPath);
        clearSuggestion(ctx as ExtensionContext);
        ctx.ui.notify("下一步建议已停用。", "info");
        return;
      }
      ctx.ui.notify(
        `下一步建议：${config.enabled ? "已启用" : "已停用"} · 模型：${config.modelRef} · 接受键：${config.acceptKey} · 当前建议：${latestSuggestion ? "有" : "无"}（设置：/api-manager nextsuggest）`,
        "info",
      );
    },
  });

  pi.on("session_shutdown", (_event, ctx) => {
    clearSuggestion(ctx);
  });

  return () => ({ enabled: false, modelRef: "", acceptKey: "", suggestion: latestSuggestion });
}

/** Synchronous best-effort read of the configured accept key at load time. */
function readConfiguredAcceptKey(defaultsPath: string): NextSuggestAcceptKey {
  try {
    const parsed = JSON.parse(readFileSync(defaultsPath, "utf8")) as {
      nextSuggest?: { acceptKey?: unknown };
    };
    return parsed.nextSuggest?.acceptKey === "alt+shift+n" ? "alt+shift+n" : "f2";
  } catch {
    return "f2";
  }
}
