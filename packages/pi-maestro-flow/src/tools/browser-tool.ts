import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import { Text } from "@earendil-works/pi-tui";
import { toolCallLine, toolResultLine, resultSummary } from "../quiet-render.ts";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { browserManager, type BrowserManagerLike } from "./browser/manager.ts";
import { getSopRegistry, SOP_INDEX_EXTRAS, SOP_INDEX_HEADERS } from "./sop/sop-registry-singleton.ts";

type BrowserWaitUntil = "load" | "domcontentloaded" | "networkidle0" | "networkidle2";
type BrowserDialogPolicy = "accept" | "dismiss";

// Browser SOP documents live in two layers: an embedded baseline (zero-dependency
// fallback in `sop/embedded/browser.ts`) and knowhow entries with
// `tools: [browser]` + `sop_topic` that override/extend via the SopRegistry merge
// rules. `guide` with no topic returns the registry index; `guide` + topic loads
// one document. Knowhow updates flow through `maestro knowledge stage → promote`.

const BrowserAction = Type.Unsafe<"open" | "close" | "run" | "guide">({
  type: "string",
  enum: ["open", "close", "run", "guide"],
  description: "open: launch or attach a tab; close: close one or all tabs; run: execute JavaScript in a tab; guide: return the SOP registry index (pass topic to load one document)",
});
const WaitUntil = Type.Unsafe<BrowserWaitUntil>({
  type: "string",
  enum: ["load", "domcontentloaded", "networkidle0", "networkidle2"],
});
const DialogPolicy = Type.Unsafe<BrowserDialogPolicy>({ type: "string", enum: ["accept", "dismiss"] });

export const BrowserParams = Type.Object({
  action: BrowserAction,
  name: Type.Optional(Type.String({ description: "Named tab id; defaults to main" })),
  url: Type.Optional(Type.String({ description: "URL to navigate on open" })),
  app: Type.Optional(Type.Object({
    path: Type.Optional(Type.String({ description: "Chromium/Chrome/Edge executable path" })),
    cdp_url: Type.Optional(Type.String({ description: "Existing browser CDP endpoint" })),
    args: Type.Optional(Type.Array(Type.String(), { description: "Extra browser launch arguments" })),
    target: Type.Optional(Type.String({ description: "Existing page URL/title substring" })),
    attach_user_profile: Type.Optional(Type.Boolean({ description: "Attach to the user's daily browser at app.user_profile_dir. pi auto-launches it with --remote-debugging-port=9222 if no live debug port is found, or reuses a running instance; preserves login state and fingerprint. Use for CAPTCHA / login scenarios." })),
    user_profile_dir: Type.Optional(Type.String({ description: "Path to a Chrome user-data-dir to attach to; required with attach_user_profile. A running instance with a debug port is reused, otherwise pi launches Chrome on this dir." })),
  })),
  visible: Type.Optional(Type.Boolean({ description: "Launch a headed (visible) browser window; default is headless. Ignored when attaching via app.cdp_url." })),
  viewport: Type.Optional(Type.Object({
    width: Type.Number({ minimum: 1 }),
    height: Type.Number({ minimum: 1 }),
    scale: Type.Optional(Type.Number({ minimum: 0.1, maximum: 10 })),
  })),
  wait_until: Type.Optional(WaitUntil),
  dialogs: Type.Optional(DialogPolicy),
  code: Type.Optional(Type.String({ minLength: 1, description: "Async JavaScript function body executed with page/browser/tab helpers; required for run" })),
  topic: Type.Optional(Type.String({ description: "SOP document id for action=guide (see registry index): core | captcha-strategies | automation-antipatterns; omit to list available documents" })),
  timeout: Type.Optional(Type.Number({ minimum: 1, maximum: 300, description: "Timeout in seconds" })),
  all: Type.Optional(Type.Boolean({ description: "Close all named tabs" })),
  kill: Type.Optional(Type.Boolean({ description: "Deprecated alias for close; owned browsers are always closed regardless of this flag" })),
}, {
  additionalProperties: false,
  if: { properties: { action: { const: "run" } }, required: ["action"] },
  then: { required: ["code"] },
});

export interface BrowserToolDetails {
  action: "open" | "close" | "run" | "guide";
  name?: string;
  url?: string;
  browser?: "headless" | "headed" | "connected";
  viewport?: { width: number; height: number; deviceScaleFactor?: number };
  screenshots?: Array<{ path?: string; mimeType: string; bytes: number }>;
  result?: string;
  navigated?: boolean;
  newTabs?: Array<{ url: string }>;
}

export function createBrowserTool(manager: BrowserManagerLike = browserManager): ToolDefinition<typeof BrowserParams, BrowserToolDetails> {
  // Session-scoped flag: nudged on the first open/run before the agent reads the SOP registry.
  let sopRead = false;
  return {
    name: "browser",
    label: "Browser",
    description: "Control Chromium through named tabs. Open or attach a browser, run trusted host-level JavaScript with page/browser/tab helpers, capture screenshots, and close one or all tabs. The run action requires non-empty code, is shell-equivalent, and is blocked in Plan mode. In run code, page is a puppeteer-core Page (page.setViewport({width,height}), page.goto, page.evaluate, page.screenshot — Puppeteer, not Playwright, so there is no page.setViewportSize), browser is a puppeteer Browser, and tab is a high-level helper.\\n\\nBEFORE ANY browser operation: call action: guide to get the SOP registry index, then load the relevant document by topic (core: mode choice, Turnstile recipe, helpers, pitfalls; captcha-strategies; automation-antipatterns; network-mocking; auth-flows; form-widgets; list-scraping; antibot-landscape). Acting before reading the SOP risks silent failure.\\n\\nCAPABILITY MAP (when to use which):\\n  - Pure scraping (no login/CAPTCHA) → open with visible:false (headless default) + tab.extract('probe')\\n  - Login state / CAPTCHA / real fingerprint → FIRST call action:guide, then open with visible:true + app.attach_user_profile + app.user_profile_dir (attach the user's daily browser; pi auto-launches Chrome with --remote-debugging-port=9222 if no live debug port, or reuses a running instance; pure stealth is NOT enough for Cloudflare managed challenges)\\n  - Raw CDP domain call → tab.cdp(method, params) (e.g. Page.captureScreenshot, Network.getCookies, DOM.setFileInputFiles)\\n  - Cookie read/write → tab.cookies.get/set/delete (session-level; in attach mode the user's login cookies are present)\\n  - File upload → tab.uploadFile(selector, ...paths); transient <input type=file> without a persistent DOM node → tab.cdp('DOM.setFileInputFiles', ...)\\n  - Cross-origin iframe JS → tab.evalInFrame(matcher, fn, ...args) (matcher = url substring/RegExp/predicate)\\n  - Open Shadow DOM → tab.pierce(selector) → {x,y}; follow with tab.cdpClick(x,y)\\n  - Canvas / non-DOM / hover-dependent click → tab.cdpClick(x, y, {hoverMs?}) (CDP Input 3-event sequence)\\n  - Chrome autofill release → tab.autofillRelease(selector) (brings tab to front, clicks, re-dispatches input/change)\\n  - Download-dialog bypass → tab.setDownloadBehavior(dirPath)\\n  - Multi-CDP chain → tab.cdpBatch([{method,params},...]) with '$N.path' references\\n  - On-page OCR / visual localization -> tab.ocr({region?,langs?}) returns {text, lines:[{bbox,text,confidence}]}; tab.detect({mode?,langs?}) returns {items:[{bbox,type,label,confidence}]} for canvas/non-DOM buttons. Follow with tab.cdpClick(cx, cy). Default langs is eng; pass eng+chi_sim for Chinese. Uses the shared local RapidOCR/OmniParser service and manifest-listed model assets; unavailable or unverified models return structured errors and OmniParser fails closed. For text-only needs without local models, describe_image can read text but cannot return reliable pixel coordinates\\n  - DOM observation → tab.observe() (interactive elements + numeric ids), tab.extract('probe'|'list'|'text'|'html'), tab.snapshot() + tab.diff(before) for change detection, tab.monitorStart/Stop for transient text\\n  - Navigation/new-tab detection is auto-reported in run output (navigated, newTabs).\\nSOP registry: action: guide returns the index; load a document with topic.\\nPass visible: true to open a headed (visible) browser window; the default is headless.",
    promptSnippet: "Use browser for interactive web navigation, DOM observation, form input, and screenshots. In run code page is a puppeteer-core Page (page.setViewport/page.goto/page.evaluate); tab offers tab.setViewport/tab.observe/tab.click/tab.screenshot/tab.extract('probe')/tab.snapshot()/tab.diff()/tab.monitorStart()/tab.cdp(method,params)/tab.cdpBatch(commands)/tab.cookies.get-set-delete/tab.uploadFile/tab.evalInFrame/tab.pierce/tab.cdpClick/tab.autofillRelease/tab.setDownloadBehavior/tab.ocr()/tab.detect(). Pass visible:true on open for a headed (visible) window; for CAPTCHA/login attach the user's browser with app.attach_user_profile + app.user_profile_dir.",
    promptGuidelines: [
      "Before ANY browser operation, call action:guide to get the SOP registry index, then read the relevant topic documents: core (mode choice, Turnstile recipe, helpers, CDP pitfalls), captcha-strategies, automation-antipatterns, network-mocking, auth-flows (login/2FA/OAuth), form-widgets (rich text/select/date/drag), list-scraping (infinite scroll/pagination), antibot-landscape (identify the WAF first). THEN choose the browser mode by scenario: pure scraping (no login/CAPTCHA) → open with visible:false (headless); login state / CAPTCHA / real fingerprint → open with visible:true + app.attach_user_profile + app.user_profile_dir. pi auto-launches Chrome with --remote-debugging-port=9222 if no live debug port is found (or reuses a running instance). Pure stealth patches are NOT enough for Cloudflare managed challenges — attaching the user's real browser is the working path.",
      "Match the helper to the target: DOM elements → tab.observe()/tab.click()/tab.fill(); canvas / non-DOM / hover-dependent components → tab.cdpClick(x,y); open Shadow DOM → tab.pierce(selector) then tab.cdpClick; cross-origin iframe → tab.evalInFrame(matcher, fn); file upload → tab.uploadFile(selector, paths) or tab.cdp('DOM.setFileInputFiles') for transient inputs; raw CDP domain → tab.cdp(method, params).",
      "Call browser open before run, and reuse a stable tab name across related steps.",
      "run code receives page (puppeteer-core Page), browser (puppeteer Browser), and tab (high-level helper). This is Puppeteer, not Playwright.",
      "Top-level const/let/class/function in run code are scoped safely: you may declare any name, even wait, page, assert, display, etc., without a redeclaration error (a reused name shadows that helper inside your code).",
      "page.evaluate()/tab.evaluate() callbacks run in the browser page context, where Node-side variables from your run code are NOT visible. Pass them explicitly: await tab.evaluate((v) => …, v), or compute values inside the callback. tab.click()/type()/fill() return undefined, not a boolean — test existence with tab.observe(), tab.waitFor(), or page.$",
      "Set the viewport with tab.setViewport({ width, height }) or page.setViewport({ width, height }); there is no page.setViewportSize.",
      "Pass visible: true on open to launch a headed (visible) browser window for debugging or interaction; omit it for the default headless mode.",
      "Prefer tab.observe() and numeric element ids before clicking or typing; use tab.click/type/fill with those ids.",
      "Capture screenshots with tab.screenshot({ save? }) — it saves the PNG and displays it inline; page.screenshot works too but does not surface the image.",
      "Prefer tab.extract('probe') over tab.extract('html') for page structure: it returns simplified, token-optimized HTML (invisible nodes dropped, overlays/partitions collapsed, iframes/shadow pierced, form values preserved). Use tab.extract('list') to discover repetitive list containers and tab.snapshot() to capture { html, lists } before a change.",
      "For repetitive lists (search results, product grids), pass tab.extract('probe', { fold: 'keyword' }) — it keeps the first 3 items (or the first 6 mentioning the keyword) and replaces the rest with a [FAKE ELEMENT] hint, saving most of the token cost while keeping the list visible.",
      "After click/fill/submit, detect what changed with tab.diff(before) where before is a prior tab.snapshot() result (or its .html); omit the after arg to diff against the current page. It returns { changed, topChange? } where changed is the count of changed elements and topChange is the largest changed subtree (omitted when nothing changed).",
      "To catch transient text (toasts/popups) during an action, await tab.monitorStart() before it and tab.monitorStop() after; monitorStop returns the strings that appeared and vanished.",
      "To list every page in the browser (including ones the agent did not open), use tab.tabs() or browser.pages(); each entry has { url, title }. The run output also reports navigated and newTabs when the page URL changed or a new tab appeared during the run.",
      "Close tabs when browser work is complete.",
      "Treat run code as trusted host code: it executes with the Pi process permissions, not in a security sandbox.",
      "For CAPTCHA / login-state / real-fingerprint scenarios, attach the user's daily browser: open with visible:true and app.attach_user_profile:true plus app.user_profile_dir. pi auto-launches Chrome with --remote-debugging-port=9222 on that dir if no live debug port is found (or reuses a running instance); the launched Chrome is detached and survives pi's exit. Pure stealth is NOT enough for Cloudflare managed challenges.",
      "Call tab.cdp(method, params) to invoke any raw CDP domain method (e.g. Page.captureScreenshot, Network.getCookies, DOM.setFileInputFiles); it returns the raw JSON result. High-risk methods like Page.crash / Browser.close terminate the session — confirm intent first.",
      "Manage session cookies with tab.cookies.get({domain?,name?}) / tab.cookies.set({...|[...]}) / tab.cookies.delete({domain?,name?}); in attach mode the user's login cookies are already present. Set HttpOnly cookies with httpOnly:true.",
      "Upload local files with tab.uploadFile(selector, ...filePaths) (paths relative to cwd) for <input type=file>; for transient inputs without a persistent DOM node use tab.cdp('DOM.setFileInputFiles', ...).",
      "Execute JS in a cross-origin iframe (e.g. third-party payment / embedded editor) with tab.evalInFrame(matcher, fn, ...args) where matcher is a url substring/RegExp/predicate; puppeteer frames already hold the cross-origin execution context.",
      "Reach into Shadow DOM (Web Components) with tab.pierce(selector) — it uses puppeteer's pierce/<selector> engine to cross OPEN shadow boundaries and returns { x, y } (element center); follow with tab.cdpClick(x, y) to click it. Closed shadow roots are a Chrome limitation no selector engine can cross; use CDP DOM.getDocument({pierce:true}) via tab.cdp() as a fallback.",
      "Click canvas / non-DOM elements or hover-dependent components (MUI Tooltip, Ant Dropdown) with tab.cdpClick(x, y, { hoverMs? }) — a CDP Input three-event sequence (mouseMoved → mousePressed → mouseReleased) with a hover dwell. Coordinates are page-relative; for iframe targets add the iframe offset.",
      "Release Chrome autofill-protected values with tab.autofillRelease(selector): it brings the tab to the front (Chrome only releases protected values in the foreground), physically clicks the field, then re-dispatches input/change events so the framework picks up the value.",
      "Bypass the \"download multiple files\" dialog with tab.setDownloadBehavior(dirPath) (relative to cwd) — sets CDP Browser.setDownloadBehavior to allow so Chrome does not block JS on the prompt.",
      "Chain multiple CDP commands in one round-trip with tab.cdpBatch([{method, params}, ...]); later params may reference earlier results via \"$N.dotted.path\" strings (0-indexed). Check each result's ok flag — a failed prior command makes $N references undefined.",
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
            attachUserProfile: params.app?.attach_user_profile,
            userProfileDir: params.app?.user_profile_dir,
            visible: params.visible,
            viewport: params.viewport,
            waitUntil: parseWaitUntil(params.wait_until),
            dialogs: parseDialogPolicy(params.dialogs),
            signal,
            timeoutMs,
          });
          const text = `${info.reused ? "Reused" : "Opened"} ${info.kind} tab ${JSON.stringify(name)} at ${info.url}${info.title ? ` — ${info.title}` : ""}${sopRead ? "" : "\nℹ SOP registry not read this session — call action:guide for the index (topic loads one document) before further operations."}`;
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
        if (params.action === "guide") {
          sopRead = true;
          const registry = getSopRegistry(ctx.cwd);
          await registry.ensureLoaded();
          const topic = params.topic?.trim();
          if (!topic) {
            const index = registry.renderIndex("browser", SOP_INDEX_HEADERS.browser, SOP_INDEX_EXTRAS.browser);
            return success(index, { action: "guide", result: index });
          }
          const doc = registry.get("browser", topic);
          if (!doc) throw new Error(`Unknown SOP topic ${JSON.stringify(topic)}. Available: ${registry.topics("browser").map((k) => `"${k}"`).join(", ")}.`);
          return success(doc.body, { action: "guide", result: doc.body });
        }
        if (!params.code?.trim()) throw new Error("Browser run requires non-empty code.");
        const output = await manager.run(name, params.code, ctx.cwd, signal, timeoutMs);
        const content = [...output.displays];
        if (output.returnValue !== undefined) content.push({ type: "text" as const, text: formatValue(output.returnValue) });
        if (output.navigated) content.push({ type: "text" as const, text: `Page navigated: ${output.url}` });
        if (!sopRead) content.push({ type: "text" as const, text: "ℹ SOP registry not read this session — call action:guide for the index (topic loads one document) before further operations." });
        if (output.newTabs && output.newTabs.length > 0) content.push({ type: "text" as const, text: `New tab(s) opened during run: ${output.newTabs.map((t) => t.url).join(", ")}` });
        if (content.length === 0) content.push({ type: "text" as const, text: `Ran code on tab ${JSON.stringify(name)}.` });
        const text = content.filter((item) => item.type === "text").map((item) => item.text).join("\n");
        return {
          content,
          details: { action: "run", name, url: output.url, screenshots: output.screenshots, result: text, navigated: output.navigated, newTabs: output.newTabs },
        } as AgentToolResult<BrowserToolDetails>;
      } catch (error) {
        if (signal?.aborted || (error instanceof Error && error.name === "AbortError")) throw abortError();
        throw error instanceof Error ? error : new Error(String(error));
      }
    },
    renderShell: "self",
    renderCall(args, theme, ctx) {
      if (ctx?.isPartial === false) return new Text("", 0, 0);
      const action = String(args.action ?? "?");
      const url = args.url ? ` ${String(args.url).slice(0, 60)}` : "";
      return toolCallLine(theme, "browser", `${action}${url}`);
    },
    renderResult(result, opts, theme, ctx) {
      if (opts.isPartial) return new Text("", 0, 0);
      const text = result.content.filter((item) => item.type === "text").map((item) => "text" in item ? item.text : "").join("\n");
      const isError = (result as { isError?: boolean }).isError === true;
      const action = String(ctx.args.action ?? "?");
      const url = ctx.args.url ? ` ${String(ctx.args.url).slice(0, 60)}` : "";
      return toolResultLine(theme, {
        name: "browser",
        ok: !isError,
        arg: `${action}${url}`,
        summary: resultSummary(result),
        expanded: opts.expanded,
        detail: text,
      });
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

function parseWaitUntil(value: unknown): BrowserWaitUntil | undefined {
  if (value === undefined) return undefined;
  if (value === "load" || value === "domcontentloaded" || value === "networkidle0" || value === "networkidle2") {
    return value;
  }
  throw new Error("Browser wait_until is invalid.");
}

function parseDialogPolicy(value: unknown): BrowserDialogPolicy | undefined {
  if (value === undefined) return undefined;
  if (value === "accept" || value === "dismiss") return value;
  throw new Error("Browser dialogs policy is invalid.");
}
