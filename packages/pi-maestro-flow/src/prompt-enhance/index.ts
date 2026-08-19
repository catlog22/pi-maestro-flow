/**
 * Prompt-enhance wiring.
 *
 * On demand (/enhance command or Alt+Shift+E), the editor's draft prompt is
 * rewritten in the background with the configured model plus gathered codebase
 * + knowledge context, then written back into the editor for the user to
 * review. Nothing is submitted automatically; /enhance revert restores the
 * pre-enhance text.
 *
 * Feature switch, model, thinking level, length cap and context depth are
 * configured independently through the API manager (`/api-manager enhance`
 * or the settings shell action `api.enhance`), persisted in
 * `api-manager.json` under the `enhance` section.
 */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { loadEnhanceConfig, saveEnhanceConfig } from "./config.ts";
import { gatherEnhancerContext } from "./context.ts";
import { generateEnhancedPrompt } from "./engine.ts";

export interface PromptEnhanceOptions {
  /** api-manager.json path; the `enhance` section holds the config. */
  defaultsPath: string;
}

export function registerPromptEnhance(
  pi: ExtensionAPI,
  options: PromptEnhanceOptions,
): () => void {
  // lastOriginal = the editor snapshot captured right before enhancement.
  // The empty-string sentinel distinguishes "enhanced from inline arg, editor
  // was empty" from "nothing to revert" (undefined).
  let lastOriginal: string | undefined;

  const modelLabel = (ref: string): string => (ref === "session" || !ref ? "会话模型" : ref);

  const runEnhance = async (ctx: ExtensionContext, providedText: string | undefined): Promise<void> => {
    if (!ctx.hasUI) {
      ctx.ui.notify("提示词增强需要交互模式（它读写编辑器）。", "warning");
      return;
    }
    const config = await loadEnhanceConfig(options.defaultsPath);
    if (!config.enabled) {
      ctx.ui.notify("提示词增强已关闭（/enhance on 开启）。", "info");
      return;
    }

    const editorText = ctx.ui.getEditorText();
    const original = (providedText ?? editorText).trim();
    if (!original) {
      ctx.ui.notify("输入框为空，没有可增强的内容。", "info");
      return;
    }

    // RV-013: surface a pinned-model fallback so billing/quality expectations
    // are not silently swapped to the session model.
    const resolved = resolveEnhanceModelForNotify(config, ctx);
    const usingFallback = config.modelRef !== "session" && resolved !== config.modelRef;
    ctx.ui.notify(
      `正在用 ${modelLabel(resolved)} 增强提示词${usingFallback ? "（钉选模型未找到，已回退会话模型）" : ""}…`,
      "info",
    );
    const context = await gatherEnhancerContext(original, ctx.cwd, config, ctx.sessionManager);
    const result = await generateEnhancedPrompt(pi, ctx, config, original, context);
    if (result.kind !== "enhanced") {
      ctx.ui.notify(`增强失败：${result.error ?? "未知错误"}`, "error");
      return;
    }

    // RV-002: if the user typed while the LLM was working, the editor no
    // longer holds the snapshot we enhanced from — abort the write rather
    // than clobber their new input (which revert could not restore).
    const nowEditor = ctx.ui.getEditorText();
    if (nowEditor !== editorText) {
      ctx.ui.notify("编辑器内容已变更，已放弃写入增强结果（未覆盖你的输入）。", "warning");
      return;
    }

    // RV-005: keep the pre-enhance editor text verbatim (incl. empty string)
    // so /enhance revert can restore it even when enhancing from inline args.
    lastOriginal = editorText;
    ctx.ui.setEditorText(result.text);
    ctx.ui.notify("提示词已增强（/enhance revert 回退）。", "info");
  };

  pi.registerShortcut("alt+shift+e" as Parameters<ExtensionAPI["registerShortcut"]>[0], {
    description: "Enhance the current editor prompt with codebase + knowledge context",
    handler: async (ctx) => {
      await runEnhance(ctx, undefined);
    },
  });

  pi.registerCommand("enhance", {
    description: "Enhance the prompt in the editor (or supplied text). Subcommands: revert | status | on | off",
    handler: async (args, ctx) => {
      const sub = args.trim().split(/\s+/)[0] ?? "";
      if (sub === "revert") {
        if (lastOriginal === undefined) {
          ctx.ui.notify("没有可回退的原文。", "info");
          return;
        }
        if (ctx.hasUI) {
          ctx.ui.setEditorText(lastOriginal);
          ctx.ui.notify("已回退到增强前的提示词。", "info");
        }
        lastOriginal = undefined;
        return;
      }
      if (sub === "status") {
        const config = await loadEnhanceConfig(options.defaultsPath);
        ctx.ui.notify(
          `提示词增强：${config.enabled ? "已启用" : "已停用"} · 模型：${modelLabel(config.modelRef)} · 上下文：${config.contextDepth}（设置：/api-manager enhance）`,
          "info",
        );
        return;
      }
      if (sub === "on" || sub === "off") {
        const config = await loadEnhanceConfig(options.defaultsPath);
        config.enabled = sub === "on";
        await saveEnhanceConfig(config, options.defaultsPath);
        ctx.ui.notify(`提示词增强已${sub === "on" ? "启用" : "停用"}。`, "info");
        return;
      }
      // Default: enhance. Args may carry inline text; otherwise read the editor.
      const provided = args.trim() || undefined;
      await runEnhance(ctx, provided);
    },
  });

  pi.on("session_shutdown", () => {
    lastOriginal = undefined;
  });

  return () => undefined;
}

/** Resolve the modelRef that will actually be used, for notify purposes. */
function resolveEnhanceModelForNotify(config: { modelRef: string }, ctx: ExtensionContext): string {
  const modelRef = (config.modelRef ?? "session").trim();
  if (!modelRef || modelRef === "session") return "session";
  const allModels = typeof ctx.modelRegistry?.getAll === "function" ? ctx.modelRegistry.getAll() : [];
  const [provider, ...rest] = modelRef.split("/");
  const modelId = rest.join("/");
  const exact = allModels.find((entry) => entry.provider === provider && entry.id === modelId);
  return exact ? modelRef : "session";
}
