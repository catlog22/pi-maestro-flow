import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { browserManager, type BrowserManagerLike } from "./browser/manager.ts";

const BrowserAction = Type.Unsafe<"open" | "close" | "run">({ type: "string", enum: ["open", "close", "run"] });
const WaitUntil = Type.Unsafe<"load" | "domcontentloaded" | "networkidle0" | "networkidle2">({
  type: "string",
  enum: ["load", "domcontentloaded", "networkidle0", "networkidle2"],
});
const DialogPolicy = Type.Unsafe<"accept" | "dismiss">({ type: "string", enum: ["accept", "dismiss"] });

export const BrowserParams = Type.Object({
  action: BrowserAction,
  name: Type.Optional(Type.String({ description: "Named tab id; defaults to main" })),
  url: Type.Optional(Type.String({ description: "URL to navigate on open" })),
  app: Type.Optional(Type.Object({
    path: Type.Optional(Type.String({ description: "Chromium/Chrome/Edge executable path" })),
    cdp_url: Type.Optional(Type.String({ description: "Existing browser CDP endpoint" })),
    args: Type.Optional(Type.Array(Type.String(), { description: "Extra browser launch arguments" })),
    target: Type.Optional(Type.String({ description: "Existing page URL/title substring" })),
  })),
  visible: Type.Optional(Type.Boolean({ description: "Launch a headed (visible) browser window; default is headless. Ignored when attaching via app.cdp_url." })),
  viewport: Type.Optional(Type.Object({
    width: Type.Number({ minimum: 1 }),
    height: Type.Number({ minimum: 1 }),
    scale: Type.Optional(Type.Number({ minimum: 0.1, maximum: 10 })),
  })),
  wait_until: Type.Optional(WaitUntil),
  dialogs: Type.Optional(DialogPolicy),
  code: Type.Optional(Type.String({ description: "Async JavaScript function body executed with page/browser/tab helpers" })),
  timeout: Type.Optional(Type.Number({ minimum: 1, maximum: 300, description: "Timeout in seconds" })),
  all: Type.Optional(Type.Boolean({ description: "Close all named tabs" })),
  kill: Type.Optional(Type.Boolean({ description: "Compatibility flag; owned browsers (headless or headed) are always closed" })),
});

export interface BrowserToolDetails {
  action: "open" | "close" | "run";
  name?: string;
  url?: string;
  browser?: "headless" | "headed" | "connected";
  viewport?: { width: number; height: number; deviceScaleFactor?: number };
  screenshots?: Array<{ path?: string; mimeType: string; bytes: number }>;
  result?: string;
}

export function createBrowserTool(manager: BrowserManagerLike = browserManager): ToolDefinition<typeof BrowserParams, BrowserToolDetails> {
  return {
    name: "browser",
    label: "Browser",
    description: "Control Chromium through named tabs. Open or attach a browser, run trusted host-level JavaScript with page/browser/tab helpers, capture screenshots, and close one or all tabs. The run action is shell-equivalent and is blocked in Plan mode. In run code, page is a puppeteer-core Page (page.setViewport({width,height}), page.goto, page.evaluate, page.screenshot — Puppeteer, not Playwright, so there is no page.setViewportSize), browser is a puppeteer Browser, and tab is a high-level helper (tab.setViewport, tab.observe, tab.click, tab.screenshot). Pass visible: true to open a headed (visible) browser window; the default is headless.",
    promptSnippet: "Use browser for interactive web navigation, DOM observation, form input, and screenshots. In run code page is a puppeteer-core Page (page.setViewport/page.goto/page.evaluate); tab offers tab.setViewport/tab.observe/tab.click/tab.screenshot. Pass visible:true on open for a headed (visible) window.",
    promptGuidelines: [
      "Call browser open before run, and reuse a stable tab name across related steps.",
      "run code receives page (puppeteer-core Page), browser (puppeteer Browser), and tab (high-level helper). This is Puppeteer, not Playwright.",
      "Top-level const/let/class/function in run code are scoped safely: you may declare any name, even wait, page, assert, display, etc., without a redeclaration error (a reused name shadows that helper inside your code).",
      "Set the viewport with tab.setViewport({ width, height }) or page.setViewport({ width, height }); there is no page.setViewportSize.",
      "Pass visible: true on open to launch a headed (visible) browser window for debugging or interaction; omit it for the default headless mode.",
      "Prefer tab.observe() and numeric element ids before clicking or typing; use tab.click/type/fill with those ids.",
      "Capture screenshots with tab.screenshot({ save? }) — it saves the PNG and displays it inline; page.screenshot works too but does not surface the image.",
      "Close tabs when browser work is complete.",
      "Treat run code as trusted host code: it executes with the Pi process permissions, not in a security sandbox.",
    ],
    parameters: BrowserParams,
    executionMode: "sequential",
    async execute(_id, params, signal, _onUpdate, ctx): Promise<AgentToolResult<BrowserToolDetails>> {
      const name = params.name?.trim() || "main";
      const timeoutMs = Math.min(300, Math.max(1, params.timeout ?? 30)) * 1_000;
      try {
        if (params.action === "open") {
          const info = await manager.open({
            name,
            cwd: ctx.cwd,
            url: params.url,
            executablePath: params.app?.path,
            cdpUrl: params.app?.cdp_url,
            args: params.app?.args,
            target: params.app?.target,
            visible: params.visible,
            viewport: params.viewport,
            waitUntil: params.wait_until,
            dialogs: params.dialogs,
            signal,
            timeoutMs,
          });
          const text = `${info.reused ? "Reused" : "Opened"} ${info.kind} tab ${JSON.stringify(name)} at ${info.url}${info.title ? ` — ${info.title}` : ""}`;
          return success(text, { action: "open", name, url: info.url, browser: info.kind, viewport: info.viewport, result: text });
        }
        if (params.action === "close") {
          if (params.all) {
            const count = await manager.closeAll();
            const text = `Closed ${count} browser tab${count === 1 ? "" : "s"}.`;
            return success(text, { action: "close", result: text });
          }
          const closed = await manager.close(name);
          const text = closed ? `Closed tab ${JSON.stringify(name)}.` : `No tab named ${JSON.stringify(name)}.`;
          return success(text, { action: "close", name, result: text });
        }
        if (!params.code?.trim()) throw new Error("Browser run requires non-empty code.");
        const output = await manager.run(name, params.code, ctx.cwd, signal, timeoutMs);
        const content = [...output.displays];
        if (output.returnValue !== undefined) content.push({ type: "text" as const, text: formatValue(output.returnValue) });
        if (content.length === 0) content.push({ type: "text" as const, text: `Ran code on tab ${JSON.stringify(name)}.` });
        const text = content.filter((item) => item.type === "text").map((item) => item.text).join("\n");
        return {
          content,
          details: { action: "run", name, url: output.url, screenshots: output.screenshots, result: text },
        } as AgentToolResult<BrowserToolDetails>;
      } catch (error) {
        if (signal?.aborted || (error instanceof Error && error.name === "AbortError")) throw abortError();
        throw error instanceof Error ? error : new Error(String(error));
      }
    },
    renderCall(args, theme) {
      const action = String(args.action ?? "?");
      const name = args.name ? ` [${String(args.name)}]` : "";
      const url = args.url ? ` ${String(args.url).slice(0, 60)}` : "";
      return singleLine(`${theme.fg("toolTitle", theme.bold("browser "))}${action}${name}${theme.fg("accent", url)}`);
    },
    renderResult(result, _opts, theme) {
      const text = result.content.filter((item) => item.type === "text").map((item) => "text" in item ? item.text : "").join("\n");
      const isError = (result as { isError?: boolean }).isError === true;
      const firstLine = text.split("\n")[0]?.slice(0, 120) ?? "";
      if (isError) return singleLine(theme.fg("error", `✗ ${firstLine}`));
      return singleLine(`${theme.fg("success", "✓")} ${theme.fg("muted", firstLine)}`);
    },
  };
}

function success(text: string, details: BrowserToolDetails): AgentToolResult<BrowserToolDetails> {
  return { content: [{ type: "text", text }], details } as AgentToolResult<BrowserToolDetails>;
}

function formatValue(value: unknown): string {
  if (typeof value === "string") return value;
  const text = JSON.stringify(value, null, 2) ?? String(value);
  return text.length > 60_000 ? `${text.slice(0, 60_000)}\n…output truncated…` : text;
}

function abortError(): Error {
  const error = new Error("Browser operation aborted.");
  error.name = "AbortError";
  return error;
}
