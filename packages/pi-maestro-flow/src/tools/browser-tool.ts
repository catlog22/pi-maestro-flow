import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import { Text } from "@earendil-works/pi-tui";
import { toolCallLine, toolResultLine, resultSummary } from "pi-cockpit/src/quiet-tools.ts";
import type { ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
  browserManager,
  canonicalizeBrowserOpenOptions,
  type BrowserCapture,
  type BrowserConnectionInfo,
  type BrowserManagerLike,
  type BrowserManagerStatus,
  type BrowserPickResult,
} from "./browser/manager.ts";
import type { PairingApproval } from "./browser/bridge-server.ts";
import { getSopRegistry, SOP_INDEX_EXTRAS, SOP_INDEX_HEADERS } from "./sop/sop-registry-singleton.ts";

type BrowserWaitUntil = "load" | "domcontentloaded" | "networkidle0" | "networkidle2";
type BrowserDialogPolicy = "accept" | "dismiss";

// Browser SOP documents live in two layers: an embedded baseline (zero-dependency
// fallback in `sop/embedded/browser.ts`) and knowhow entries with
// `tools: [browser]` + `sop_topic` that override/extend via the SopRegistry merge
// rules. `guide` with no topic returns the registry index; `guide` + topic loads
// one document. Knowhow updates flow through `maestro knowledge stage → promote`.

const BrowserAction = Type.Unsafe<"open" | "close" | "run" | "guide" | "status" | "pair" | "pick">({
  type: "string",
  enum: ["open", "close", "run", "guide", "status", "pair", "pick"],
  description: "open: launch or attach a tab; close: close one or all tabs; run: execute JavaScript in a tab; guide: return the SOP registry index; status: start/probe the extension bridge and report authMode, transportReady, authenticatedConnected and pending paired requests; pair: paired mode only, approve one pending request with request_id + code; pick: inject an in-page element/component selector and paste the user's captures into their input box",
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
    channel: Type.Optional(Type.Unsafe<"managed" | "profile" | "cdp" | "extension">({
      type: "string",
      enum: ["managed", "profile", "cdp", "extension"],
      description: "Canonical browser connection channel. extension is explicit, never falls back, and requires transportReady (NONE needs no pairing). Legacy inference remains: attach_user_profile selects profile, cdp_url selects cdp, otherwise managed.",
    })),
    cdp_url: Type.Optional(Type.String({ description: "Existing browser CDP endpoint" })),
    args: Type.Optional(Type.Array(Type.String(), { description: "Extra browser launch arguments" })),
    target: Type.Optional(Type.String({ description: "Existing page URL/title substring; extension borrows and exclusively leases the matched physical tab, failing tab_busy if another owner holds it." })),
    attach_user_profile: Type.Optional(Type.Boolean({ description: "Attach via CDP to app.user_profile_dir. Reuses a recorded debugging endpoint or auto-launches with a dynamic debugging port. Chrome 136+ requires a non-default user-data-dir; use the explicit extension channel for the daily default profile." })),
    user_profile_dir: Type.Optional(Type.String({ description: "Path to a Chromium user-data-dir to attach to; required with attach_user_profile. A recorded debugging endpoint is reused, otherwise pi launches the browser on this dir. Chrome 136+ blocks debugging of its default directory; profiles are never copied or switched automatically." })),
    policy: Type.Optional(Type.Object({
      allow: Type.Optional(Type.Array(Type.String(), { description: "Exact hosts or *.example.com wildcards (apex included). When set, only matching http(s) pages may load." })),
      deny: Type.Optional(Type.Array(Type.String(), { description: "Denied hosts win over allow." })),
    }, { description: "Navigation guard for managed/profile/cdp channels: tab.goto/page.goto pre-check plus main-frame and new-tab guards that bounce denied pages to about:blank or close them; violations are surfaced in run output. Best-effort, not a network sandbox; unsupported on the extension channel." })),
  })),
  visible: Type.Optional(Type.Boolean({ description: "Control visibility for a Pi-launched browser; managed defaults to headless. Ignored by an existing profile/CDP attachment and rejected by the extension channel." })),
  viewport: Type.Optional(Type.Object({
    width: Type.Number({ minimum: 1 }),
    height: Type.Number({ minimum: 1 }),
    scale: Type.Optional(Type.Number({ minimum: 0.1, maximum: 10 })),
  })),
  wait_until: Type.Optional(WaitUntil),
  dialogs: Type.Optional(DialogPolicy),
  code: Type.Optional(Type.String({ minLength: 1, description: "Async JavaScript for run, or the six-digit confirmation code for pair" })),
  request_id: Type.Optional(Type.String({ minLength: 1, description: "Pending pairing requestId returned by browser status; required for pair" })),
  topic: Type.Optional(Type.String({ description: "SOP document id for action=guide (see registry index): core | captcha-strategies | automation-antipatterns; omit to list available documents" })),
  timeout: Type.Optional(Type.Number({ minimum: 1, maximum: 300, description: "Total wall-clock timeout in seconds for the entire open/run operation" })),
  all: Type.Optional(Type.Boolean({ description: "Close all named tabs" })),
  kill: Type.Optional(Type.Boolean({ description: "Deprecated alias for close; owned browsers are always closed regardless of this flag" })),
}, {
  additionalProperties: false,
  allOf: [
    {
      if: { properties: { action: { const: "run" } }, required: ["action"] },
      then: { required: ["code"] },
    },
    {
      if: { properties: { action: { const: "pair" } }, required: ["action"] },
      then: {
        required: ["request_id", "code"],
        properties: { code: { type: "string", pattern: "^\\d{6}$" } },
      },
    },
  ],
});

export interface BrowserToolDetails {
  action: "open" | "close" | "run" | "guide" | "status" | "pair" | "pick";
  name?: string;
  url?: string;
  browser?: "headless" | "headed" | "connected" | "extension";
  connection?: BrowserConnectionInfo;
  viewport?: { width: number; height: number; deviceScaleFactor?: number };
  screenshots?: Array<{ path?: string; mimeType: string; bytes: number }>;
  result?: string;
  navigated?: boolean;
  newTabs?: Array<{ url: string }>;
  status?: BrowserManagerStatus;
  pairingApproval?: PairingApproval;
  pick?: BrowserPickResult;
}

export type BrowserToolDefinition = ToolDefinition<typeof BrowserParams, BrowserToolDetails> & {
  execute: ToolDefinition<typeof BrowserParams, BrowserToolDetails>["execute"] & (
    (id: string, params: never, signal: AbortSignal, onUpdate: undefined, ctx: ExtensionContext) => Promise<AgentToolResult<BrowserToolDetails>>
  );
};

export function createBrowserTool(manager: BrowserManagerLike = browserManager): BrowserToolDefinition {
  // Session-scoped flag: nudged on the first open/run before the agent reads the SOP registry.
  let sopRead = false;
  return {
    name: "browser",
    label: "Browser",
    description: "Control Chromium through named tabs. Open or attach a browser, inspect live bridge/named-tab status, run trusted host-level JavaScript with page/browser/tab helpers, capture screenshots, and close one or all tabs. The run action requires non-empty code, is shell-equivalent, and is blocked in Plan mode. For managed/profile/cdp entries, page is a puppeteer-core Page (page.setViewport({width,height}), page.goto, page.evaluate, page.screenshot — Puppeteer, not Playwright) and browser is a puppeteer Browser. Extension entries instead expose limited honest adapters: page.url/title/goto/evaluate, browser.pages, and tab.url/title/goto/evaluate/cdp/cdpBatch/cookies/tabs/screenshot; every other call fails closed with the capability list.\\n\\nBEFORE ANY browser operation: call action: guide to get the SOP registry index, then load the relevant document by topic (core: mode choice, Turnstile recipe, helpers, pitfalls; captcha-strategies; automation-antipatterns; network-mocking; auth-flows; form-widgets; list-scraping; antibot-landscape). Acting before reading the SOP risks silent failure.\\n\\nCAPABILITY MAP (when to use which):\\n  - Extension setup: status starts the default range 19222..19231. PI_BROWSER_BRIDGE_AUTH_MODE=none needs no token/pairing: transportReady=true, authenticatedConnected=false, pendingPairings empty. Default paired uses pendingPairings and pair, then reconnect authenticates. Custom PI_BROWSER_BRIDGE_PORT also needs popup Advanced port (no token for NONE). Per-entry opaque leases coordinate physical tabs; busy/draining never means stopped. Cookies/login state are shared, not isolated\\n  - Pure scraping (no login/CAPTCHA) → open with visible:false (headless default) + tab.extract('probe')\\n  - Login state / CAPTCHA / real fingerprint → FIRST call action:guide, then open with visible:true + app.attach_user_profile + app.user_profile_dir (profile auto-launch uses --remote-debugging-port=0 and reads DevToolsActivePort, or reuses a recorded endpoint; Chrome 136+ blocks the default user-data directory even after windows close, so explicitly choose a non-default profile or the extension channel (pair only in paired mode) for the daily browser; pure stealth is NOT enough for Cloudflare managed challenges)\\n  - Raw CDP domain call → tab.cdp(method, params) (e.g. Page.captureScreenshot, Network.getCookies, DOM.setFileInputFiles)\\n  - Cookie read/write → tab.cookies.get/set/delete (session-level; in attach mode the user's login cookies are present)\\n  - File upload → tab.uploadFile(selector, ...paths); transient <input type=file> without a persistent DOM node → tab.cdp('DOM.setFileInputFiles', ...)\\n  - Cross-origin iframe JS → tab.evalInFrame(matcher, fn, ...args) (matcher = url substring/RegExp/predicate)\\n  - Open Shadow DOM → tab.pierce(selector) → {x,y}; follow with tab.cdpClick(x,y)\\n  - Canvas / non-DOM / hover-dependent click → tab.cdpClick(x, y, {hoverMs?}) (CDP Input 3-event sequence)\\n  - Chrome autofill release → tab.autofillRelease(selector) (brings tab to front, clicks, re-dispatches input/change)\\n  - Download-dialog bypass → tab.setDownloadBehavior(dirPath)\\n  - Multi-CDP chain → tab.cdpBatch([{method,params},...]) with '$N.path' references\\n  - AX-tree semantic observation → tab.axTree({maxNodes?}) returns role/name/value + checked/pressed/disabled state + backendNodeId; act with tab.clickNode(id,{hoverMs?}) / tab.typeNode(id,text,{replace?})\\n  - One-shot CDP event wait → tab.waitForCdp(method,{predicate?,timeout?}) — register BEFORE the action that emits the event\\n  - Navigation guard → app.policy:{allow?,deny?} on open (managed/profile/cdp only; denied goto throws, denied frames bounce to about:blank, denied new tabs close; not a network sandbox)\\n  - On-page OCR / visual localization -> tab.ocr({region?,langs?}) returns {text, lines:[{bbox,text,confidence}]}; tab.detect({mode?,langs?}) returns {items:[{bbox,type,label,confidence}]} for canvas/non-DOM buttons. Follow with tab.cdpClick(cx, cy). Default langs is eng; pass eng+chi_sim for Chinese. Uses the shared local RapidOCR/OmniParser service and manifest-listed model assets; unavailable or unverified models return structured errors and OmniParser fails closed. For text-only needs without local models, describe_image can read text but cannot return reliable pixel coordinates\\n  - DOM observation → tab.observe() (interactive elements + numeric ids), tab.extract('probe'|'list'|'text'|'html'), tab.snapshot() + tab.diff(before) for change detection, tab.monitorStart/Stop for transient text\\n  - User-driven component pick → action:pick injects an in-page selector toolbar (hover shows <ComponentName />, click selects, Ctrl/Cmd/Shift multi-select, Send element / Send errors buttons, Esc exits); captures are pasted into the USER's input box for them to send — you will not receive them unless they do\n  - Navigation/new-tab detection is auto-reported in run output (navigated, newTabs).\\nSOP registry: action: guide returns the index; load a document with topic.\\nPass visible: true to open a headed (visible) browser window; the default is headless.",
    promptSnippet: "Use browser for interactive web navigation, DOM observation, form input, screenshots, user-driven component picking (action:pick pastes captures into the user's input box), and live connection status. Managed/profile/cdp run code receives a puppeteer-core Page and full tab helper. app.channel='extension' is opt-in and receives limited adapters (page.url/title/goto/evaluate, browser.pages, tab.url/title/goto/evaluate/cdp/cdpBatch/cookies/tabs/screenshot); unsupported calls fail closed and the channel never falls back to managed Chromium. Extension setup is zero-copy on 19222..19231: status reports authMode and transportReady. PI_BROWSER_BRIDGE_AUTH_MODE=none requires no token/pairing and has transportReady=true with authenticatedConnected=false. Default paired uses pendingPairings and pair, then reconnect authenticates. Physical-tab leases prevent competing owners, not cookie/login isolation. PI_BROWSER_BRIDGE_PORT changes the server anchor but a custom anchor must also be entered in popup Advanced settings; manual port/token is recovery only. Pass visible:true when Pi must launch a visible browser; for CAPTCHA/login use the profile channel with app.user_profile_dir.",
    promptGuidelines: [
      "Before ANY browser operation, call action:guide to get the SOP registry index, then read the relevant topic documents: core (mode choice, Turnstile recipe, helpers, CDP pitfalls), captcha-strategies, automation-antipatterns, network-mocking, auth-flows (login/2FA/OAuth), form-widgets (rich text/select/date/drag), list-scraping (infinite scroll/pagination), antibot-landscape (identify the WAF first). THEN choose the browser mode by scenario: pure scraping (no login/CAPTCHA) → open with visible:false (headless); login state / CAPTCHA / real fingerprint → open with visible:true + app.attach_user_profile + app.user_profile_dir. Profile auto-launch uses --remote-debugging-port=0 and reads DevToolsActivePort (or reuses a recorded endpoint). Chrome 136+ blocks the default user-data directory; use an explicitly chosen non-default profile or the extension channel (pair only in paired mode) for the daily browser. Pure stealth patches are NOT enough for Cloudflare managed challenges — attaching the user's real browser is the working path.",
      "Match the helper to the target: DOM elements → tab.observe()/tab.click()/tab.fill(); canvas / non-DOM / hover-dependent components → tab.cdpClick(x,y); open Shadow DOM → tab.pierce(selector) then tab.cdpClick; cross-origin iframe → tab.evalInFrame(matcher, fn); file upload → tab.uploadFile(selector, paths) or tab.cdp('DOM.setFileInputFiles') for transient inputs; raw CDP domain → tab.cdp(method, params).",
      "Use action:status for live bridge state. It starts the optional server in 19222..19231 and reports authMode, transportConnected/transportReady, serverInstanceId, connectionGeneration, pendingPairings, authenticatedConnected, drainingCommands, live tabCount, and named-tab capabilities. NONE is ready with authenticatedConnected=false and no pair controls; never request token/pair for NONE. For paired only, match pending requestId/code in popup and approve with action:pair; reconnect authenticates. /install mode-specific markers are historical evidence, never live readiness. PI_BROWSER_BRIDGE_PORT changes the server anchor, but an empty extension cannot read that environment variable, so a custom anchor must also be entered under popup Advanced settings. Caller timeout does not force-stop already-running page JavaScript; lifecycle ownership remains draining until a real terminal.",
      "Call browser open before run, and reuse a stable tab name across related steps.",
      "Treat timeout as one total wall-clock budget for the whole run, not a per-step allowance. Keep the sum of worst-case waits and polling below it with headroom; run one long case per invocation and split navigation, upload, submit, and terminal polling when needed. Wait on stable semantic state rather than incidental exact counts or toast text. A managed/profile/CDP run that exhausts its outer timeout closes the named tab to stop still-running code, so reopen it before retrying.",
      "Managed/profile/cdp run code receives page (puppeteer-core Page), browser (puppeteer Browser), and tab (high-level helper). Extension entries receive only the limited adapter capabilities listed in the tool description; unsupported properties fail closed.",
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
      "For CAPTCHA / login-state / real-fingerprint scenarios, use an explicitly chosen profile with visible:true and app.attach_user_profile:true plus app.user_profile_dir. Auto-launch uses --remote-debugging-port=0 and reads DevToolsActivePort; the borrowed browser survives pi's exit and is never forcibly reclaimed. Chrome 136+ blocks debugging of the default profile even after all windows close: use an explicitly chosen non-default profile or install Pi Browser Bridge (pair only in paired mode) and select app.channel='extension' for the daily browser. A manually started fixed-port browser uses app.channel='cdp' and app.cdp_url. Never silently copy profiles or switch channels. Pure stealth is NOT enough for Cloudflare managed challenges.",
      "Call tab.cdp(method, params) to invoke any raw CDP domain method (e.g. Page.captureScreenshot, Network.getCookies, DOM.setFileInputFiles); it returns the raw JSON result. High-risk methods like Page.crash / Browser.close terminate the session — confirm intent first.",
      "Manage session cookies with tab.cookies.get({domain?,name?}) / tab.cookies.set({...|[...]}) / tab.cookies.delete({domain?,name?}); in attach mode the user's login cookies are already present. Set HttpOnly cookies with httpOnly:true.",
      "Upload local files with tab.uploadFile(selector, ...filePaths) (paths relative to cwd) for <input type=file>; for transient inputs without a persistent DOM node use tab.cdp('DOM.setFileInputFiles', ...).",
      "Execute JS in a cross-origin iframe (e.g. third-party payment / embedded editor) with tab.evalInFrame(matcher, fn, ...args) where matcher is a url substring/RegExp/predicate; puppeteer frames already hold the cross-origin execution context.",
      "Reach into Shadow DOM (Web Components) with tab.pierce(selector) — it uses puppeteer's pierce/<selector> engine to cross OPEN shadow boundaries and returns { x, y } (element center); follow with tab.cdpClick(x, y) to click it. Closed shadow roots are a Chrome limitation no selector engine can cross; use CDP DOM.getDocument({pierce:true}) via tab.cdp() as a fallback.",
      "Click canvas / non-DOM elements or hover-dependent components (MUI Tooltip, Ant Dropdown) with tab.cdpClick(x, y, { hoverMs? }) — a CDP Input three-event sequence (mouseMoved → mousePressed → mouseReleased) with a hover dwell. Coordinates are page-relative; for iframe targets add the iframe offset.",
      "Release Chrome autofill-protected values with tab.autofillRelease(selector): it brings the tab to the front (Chrome only releases protected values in the foreground), physically clicks the field, then re-dispatches input/change events so the framework picks up the value.",
      "Bypass the \"download multiple files\" dialog with tab.setDownloadBehavior(dirPath) (relative to cwd) — sets CDP Browser.setDownloadBehavior to allow so Chrome does not block JS on the prompt.",
      "Chain multiple CDP commands in one round-trip with tab.cdpBatch([{method, params}, ...]); later params may reference earlier results via \"$N.dotted.path\" strings (0-indexed). Check each result's ok flag — a failed prior command makes $N references undefined.",
      "tab.axTree({maxNodes?}) returns the accessibility tree — role/name/value plus control state (checked/pressed/disabled/expanded) and a backendNodeId per node. It complements tab.observe(): AX exposes semantic state and survives CSS-only deception. Act on ids with tab.clickNode(id, {hoverMs?}) (scrollIntoViewIfNeeded + getBoxModel + CDP 3-event click at the content centroid) and tab.typeNode(id, text, {replace?}) (DOM.focus + Input.insertText; replace selects existing content first, replace+'' clears via Backspace).",
      "tab.waitForCdp(method, {predicate?, timeout?}) is a one-shot CDP event waiter on the page session: register it BEFORE the action that emits the event — events are not commands and are never replayed (e.g. const nav = tab.waitForCdp('Page.loadEventFired'); await tab.goto(url); await nav).",
      "app.policy:{allow?,deny?} on open guards navigation on managed/profile/cdp channels: exact hosts or *.example.com wildcards (deny wins); tab.goto/page.goto are pre-checked, denied main-frame navigations bounce to about:blank, denied new tabs are closed, and violations surface in run output. It is a navigation guard, not a network sandbox; unsupported on the extension channel; re-open without policy to clear it.",
      "Optional browser-bridge extension: install with /install browser-bridge, then explicitly open app.channel='extension' with app.target to borrow an existing tab or url to create an owned tab. Each named entry has an opaque owner and a lease on its fixed tabId. browser.pages secondary operation targets lazily claim; close releases all borrowed claims and closes owned tabs only after terminal. tab_busy means another owner/draining operation holds the resource. Batches reserve their target; global mutations coordinate across connections. Proven opener newTabs carry owned leases; unrelated new tabs are not owned. Cookies/login state are not isolated. The limited adapter supports URL/title, goto/evaluate, raw CDP and batch, cookies, tab listing, and CDP screenshot. Disconnects and unsupported calls fail closed with no managed-browser fallback.",
      "Let the user point at a UI element with action:pick — it injects a selector toolbar into the named tab's page (works on managed/profile/cdp and extension channels): hover highlights the element and shows its React/Vue component name, click selects, Ctrl/Cmd/Shift adds to the selection, [Send element] pastes the capture(s) into the user's input box, [Send errors] pastes buffered console.error output (up to 100), Esc exits. Captures include tag, CSS selector, trimmed outerHTML, and component source file:line when the page runs a dev build (production builds yield component names only). The tool call blocks until the user sends or exits; you do NOT receive the captures unless the user sends them.",
    ],
    parameters: BrowserParams,
    executionMode: "sequential",
    async execute(_id, params, signal, _onUpdate, ctx): Promise<AgentToolResult<BrowserToolDetails>> {
      const name = params.name?.trim() || "main";
      const timeoutMs = Math.min(300, Math.max(1, params.timeout ?? 30)) * 1_000;
      try {
        if (params.action === "open") {
          const info = await manager.open(canonicalizeBrowserOpenOptions({
            name,
            cwd: ctx.cwd,
            url: params.url,
            executablePath: params.app?.path,
            channel: params.app?.channel,
            cdpUrl: params.app?.cdp_url,
            args: params.app?.args,
            target: params.app?.target,
            attachUserProfile: params.app?.attach_user_profile,
            userProfileDir: params.app?.user_profile_dir,
            policy: params.app?.policy,
            visible: params.visible,
            viewport: params.viewport,
            waitUntil: parseWaitUntil(params.wait_until),
            dialogs: parseDialogPolicy(params.dialogs),
            signal,
            timeoutMs,
          }));
          const text = `${info.reused ? "Reused" : "Opened"} ${info.kind} tab ${JSON.stringify(name)} at ${info.url}${info.title ? ` — ${info.title}` : ""}${sopRead ? "" : "\nℹ SOP registry not read this session — call action:guide for the index (topic loads one document) before further operations."}`;
          return success(text, { action: "open", name, url: info.url, browser: info.kind, connection: info.connection, viewport: info.viewport, result: text });
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
        if (params.action === "status") {
          const status = await manager.status(signal);
          const text = `Browser status (live):\n${formatValue(status)}`;
          return success(text, { action: "status", status, result: text });
        }
        if (params.action === "pair") {
          const requestId = params.request_id?.trim();
          const code = params.code?.trim();
          if (!requestId) throw new Error("Browser pair requires request_id from browser status.");
          if (!code || !/^\d{6}$/.test(code)) throw new Error("Browser pair requires the exact six-digit code from browser status.");
          const approval = await manager.pair(requestId, code, signal);
          const text = `Approved browser pairing ${approval.requestId} on port ${approval.port}. The extension will store the credentials and reconnect with authenticated authority.`;
          return success(text, { action: "pair", pairingApproval: approval, result: text });
        }
        if (params.action === "pick") {
          // Devin browser_preview semantics: captures go into the USER's input
          // box for them to send — the agent does not receive them unless the
          // user sends. When no editor is available (RPC/print/test contexts)
          // the captures degrade to the tool result instead.
          const ui = (ctx as { ui?: { pasteToEditor?: (text: string) => void } }).ui;
          const canPaste = typeof ui?.pasteToEditor === "function";
          let counter = 0;
          const onCapture = canPaste
            ? (batch: BrowserCapture[]) => {
                const text = batch.map((capture) => formatBrowserCapture(capture, ++counter)).join("\n");
                try { ui.pasteToEditor!(text); } catch { /* editor delivery is best-effort */ }
              }
            : undefined;
          const pick = await manager.pick(name, onCapture, signal, timeoutMs);
          const elementCount = pick.captures.filter((capture) => capture.kind === "element").length;
          const consoleBatches = pick.captures.filter((capture) => capture.kind === "console").length;
          const statusNote = pick.status === "sent"
            ? ""
            : pick.status === "escape"
              ? " The user pressed Esc before sending."
              : pick.status === "navigated"
                ? " The page navigated mid-pick and wiped the picker; reopen pick if still needed."
                : pick.status === "closed"
                  ? " The pick was interrupted (tab closed or run aborted)."
                  : " The pick timed out waiting for the user.";
          const delivery = canPaste
            ? "Captures were pasted into the user's input box — they reach you only if the user sends them."
            : "No input editor is available, so captures are returned inline below.";
          let text = `Pick on tab ${JSON.stringify(name)} finished (status: ${pick.status}): ${elementCount} element(s), ${consoleBatches} console batch(es), ${pick.errorCount} console error(s) buffered.${statusNote} ${delivery}`;
          if (!canPaste && pick.captures.length > 0) {
            counter = 0;
            text += "\n" + pick.captures.map((capture) => formatBrowserCapture(capture, ++counter)).join("\n");
          }
          return success(text, { action: "pick", name, pick, result: text });
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
      const isError = ctx.isError || (result as { isError?: boolean }).isError === true;
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

// Mirrors Devin's "[Browser capture #N: …]" paste format: component/source line
// first, then the trimmed outerHTML the user can review before sending.
function formatBrowserCapture(capture: BrowserCapture, index: number): string {
  if (capture.kind === "console") {
    const lines = capture.errors.length > 0 ? capture.errors : ["(no console errors buffered)"];
    return `[Browser console errors (${capture.errors.length})]\n${lines.join("\n")}`;
  }
  const component = capture.reactComponentName
    ? ` <${capture.reactComponentName} />`
    : capture.vueComponentName
      ? ` <${capture.vueComponentName} />`
      : "";
  const source = capture.filePath ? ` ${capture.filePath}${capture.line ? `:${capture.line}` : ""}` : "";
  const header = `[Browser capture #${index}: <${capture.tagName}>${component}${source}]`;
  return `${header}\n${capture.outerHtml}`;
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
