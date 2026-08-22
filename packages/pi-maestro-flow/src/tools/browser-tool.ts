import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import { Text } from "@earendil-works/pi-tui";
import { toolCallLine, toolResultLine, resultSummary } from "../quiet-render.ts";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { browserManager, type BrowserManagerLike } from "./browser/manager.ts";

type BrowserWaitUntil = "load" | "domcontentloaded" | "networkidle0" | "networkidle2";
type BrowserDialogPolicy = "accept" | "dismiss";

// In-tool browser SOP registry, returned by `browser { action: "guide" }`. Keeps the agent's
// decision knowledge co-located with the tool instead of a separate skill: bare `guide` returns
// the directory index; `guide` + `topic` loads one document. The agent reads the relevant
// document BEFORE the matching operation instead of guessing.
const SOP_CORE = `Browser SOP — when to use which tab.* helper and field-tested recipes.

1. MODE CHOICE (first decision)
  - Pure scraping (no login/CAPTCHA): open { visible:false } (headless default).
  - Login state / CAPTCHA / real fingerprint: open { visible:true, app:{ attach_user_profile:true, user_profile_dir } }.
    Pure stealth is NOT enough for Cloudflare managed challenges — attaching the user's real browser is the working path.
  - attach setup: pi auto-launches the user's Chrome with --remote-debugging-port=9222 --user-data-dir=<dir> when no live debug port is found, so just pass attach_user_profile + user_profile_dir. If a Chrome with that profile is already running with a debug port, pi reuses it.

2. CLOUDFLARE TURNSTILE (verified on NewAPI)
  - Attach the real browser (step 1) — CF trusts the real fingerprint.
  - Fetch the real sitekey: GET /api/status -> data.turnstile_site_key (backend-configured, not hardcoded).
  - Explicit render (render=explicit sites do NOT auto-render):
      const token = await tab.evaluate((sitekey) => new Promise((resolve) => {
        const c = document.createElement("div"); c.id="pi-ts";
        c.style.cssText="position:fixed;top:60px;right:20px;z-index:99999;";
        document.body.appendChild(c);
        let done=false, tok="";
        const fin=(r)=>{ if(!done){done=true; resolve(r);} };
        window.turnstile.render("#pi-ts", { sitekey, callback:(t)=>{tok=t;},
          "error-callback":(e)=>fin({ok:false,error:"error:"+e}),
          "timeout-callback":()=>fin({ok:false,error:"timeout"}) });
        let w=0; const iv=setInterval(()=>{ w+=500; if(tok){clearInterval(iv);fin({ok:true,token:tok,waited:w});}
          else if(w>=20000){clearInterval(iv);fin({ok:false,error:"no-token",waited:w});} }, 500);
      }), sitekey);
  - Token transport varies per site: NewAPI sends it as URL query param (?turnstile=...), NOT a body field.
    Reverse-engineer: search the JS bundle for /api/user/register and check params:{turnstile:...}.
  - Token is one-shot, ~5min lifetime — render + submit inside one run.
  - Pitfalls: isolated launch profile -> checkbox bounces back / infinite "verifying"; re-goto before each render.

3. CAPABILITY -> HELPER
  - Raw CDP domain: tab.cdp(method, params) -> raw JSON. High-risk: Page.crash / Browser.close terminate the session.
  - Cookies: tab.cookies.get/set/delete (session-level; in attach mode user login cookies are present; HttpOnly set needs httpOnly:true).
  - File upload: tab.uploadFile(selector, ...paths) (paths relative to cwd); transient input -> tab.cdp('DOM.setFileInputFiles', ...).
  - Cross-origin iframe: tab.evalInFrame(matcher, fn, ...args) (matcher = url substring/RegExp/predicate).
  - Open Shadow DOM: tab.pierce(selector) -> {x,y}; follow with tab.cdpClick(x,y).
  - Closed Shadow DOM: no selector engine can cross it; fallback tab.cdp('DOM.getDocument',{depth:-1,pierce:true}) + DOM.querySelector stepwise (host first, then inside its shadow).
  - Physical-coord click: tab.cdpClick(x,y,{hoverMs?}) — CDP Input 3-event (moved->pressed->released); canvas/non-DOM/hover-dependent.
  - Autofill release: tab.autofillRelease(selector) — bringToFront + cdpClick + re-dispatch input/change (foreground tab only).
  - Download-dialog bypass: tab.setDownloadBehavior(dirPath).
  - Multi-CDP chain: tab.cdpBatch([{method,params},...]) with "$N.path" refs (0-indexed); check each result.ok.
  - On-page OCR / visual localization: tab.ocr({region?,langs?}) -> {text, lines:[{bbox,text,confidence}]}; tab.detect({mode?,langs?}) -> {items:[{bbox,type,label,confidence}]} for canvas/non-DOM buttons. Follow with tab.cdpClick(cx, cy). Default langs is "eng" (pass "eng+chi_sim" for Chinese). Requires the optional tesseract.js dependency; on missing/failure returns {ok:false,hint} (fall back to describe_image for text, but its pixel coords are NOT reliable).

4. CDP COORDINATE PITFALLS (field-tested)
  - Never skip mouseMoved: hover-dependent components (MUI Tooltip, Ant Dropdown) won't open without a hover dwell.
  - First-attach infobar offset: Chrome shows a ~20px "automated control" infobar on first CDP attach. If you measure coords before attach then click after, coords shift. Fix: send a harmless mouseMoved(0,0) first to stabilize.
  - Iframe targets: add iframe offset, finalX = iframeRect.x + elRect.x.
  - transform:scale/zoom: realX = x * zoom (zoom = parseFloat(getComputedStyle(document.documentElement).zoom) || 1).

5. FILE UPLOAD FALLBACK (isTrusted)
  puppeteer uploadFile does not fire isTrusted events; some frameworks don't notice. DataTransfer API fallback (pure JS):
    const file = new File([content], name, { type: "application/pdf" });
    const dt = new DataTransfer(); dt.items.add(file);
    input.files = dt.files;
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));

6. NAVIGATION SPLIT
  location.href nav + then operate in the SAME run -> "Inspected target navigated or closed" (context destroyed). Split into two runs: tab.goto -> wait -> separate run for operations.

7. CONNECT TROUBLESHOOTING
  - Browser not running? open a normal URL (about:blank does not load extensions / turnstile script).
  - Debug port not listening? pi auto-launches the user's Chrome with --remote-debugging-port=9222 on attach; if launch fails (profile locked, executable not found), set app.path / PUPPETEER_EXECUTABLE_PATH / CHROME_PATH, or start Chrome manually with --remote-debugging-port=9222 --user-data-dir=<dir> and retry.
  - attach error? if pi launched Chrome but no DevToolsActivePort appeared within ~15s, the profile may be locked by another Chrome instance — close it and retry. The auto-launched Chrome is detached and stays alive after pi exits; a later attach reuses the live port.
`;

const SOP_NETWORK = `Network interception & mocking — full access to requests/responses without a proxy server.

REQUEST-LEVEL (puppeteer native, inside run code)
- await page.setRequestInterception(true); page.on('request', (req) => { if (/analytics|ads|fonts/.test(req.url())) req.abort(); else req.continue(); });
- Blocking third-party noise speeds up loads and reduces detection surface.
- Mock an API fixture: req.respond({ status: 200, contentType: 'application/json', body: JSON.stringify(data) }) — stabler than clicking through UI to reach state.

RESPONSE-BODY REWRITE (puppeteer cannot do this natively; use a CDP session)
- const s = await page.createCDPSession();
- await s.send('Fetch.enable', { patterns: [{ urlPattern: '**/api/*', requestStage: 'Response' }] });
- s.on('Fetch.requestPaused', async (e) => { const r = await s.send('Fetch.getResponseBody', { requestId: e.requestId }); /* modify */ await s.send('Fetch.fulfillRequest', { requestId: e.requestId, responseCode: e.responseStatusCode ?? 200, body: newBody }); });
- PITFALL: every matching request pauses while Fetch is enabled — fulfill/fail/continue EACH paused event or the page hangs forever.
- Capture-only alternative: page.on('response') + response.json()/text() to harvest XHR payloads (batch APIs, tokens) without touching traffic.
`;

const SOP_AUTH = `Login, OAuth & verification-code flows.

SESSION REUSE FIRST
- The cheapest login is the one you skip: in attach mode the user's cookies are already present — probe an authed URL and confirm login state BEFORE driving any credential form.
- After a programmatic login, export cookies (tab.cookies.get) so later runs can restore the session instead of re-logging-in.

CREDENTIAL FORMS
- Password fields: prefer real key events (tab.type/keyboard) over value injection — some frameworks bind on keydown and ignore synthetic input.

TOTP 2FA
- Holding the TOTP secret? Generate codes locally (RFC 6238, e.g. npm otplib) and fill the code input — no phone needed. Generate right before typing; if the 30s window has <2s left, wait for rollover first.

EMAIL/SMS OTP
- Flow: trigger send -> poll the inbox via API (IMAP or provider REST) -> extract the code with a contextual regex (near "code"/"verification code", usually 4-8 digits) -> type it. Poll with backoff up to ~60s; codes are single-use and expire in ~5-10min.

OAUTH POPUPS
- Consent screens often open a popup/new target: detect via run-output newTabs or tab.tabs(), drive THAT tab, then return to the opener. Do not launch with popup-blocking flags.

POST-LOGIN ASSERTION
- Interstitials ("checking browser", device-verification prompts) sit between submit and success: assert a logged-in marker (avatar element, account URL, cookie name) before continuing — see automation-antipatterns.
`;

const SOP_WIDGETS = `Complex form controls — custom widgets that resist fill()/click().

CONTENTEDITABLE RICH TEXT (ProseMirror/Slate/Quill/Jodit/Lark editor)
- Focus the editor BEFORE setting text: fill()/value writes APPEND instead of replace when the element is not focused.
- These are not <input>: "Element is not an input" means click into the editor, then type with real key events; for structured content dispatch paste events with a text/html payload.

CUSTOM DROPDOWNS / COMBOBOXES (antd Select, react-select, typeahead)
- There are no native <option>s: click the trigger to open the listbox, then click the rendered option — overlays are usually portaled to document.body, so scope queries globally, not inside the form subtree.
- Typeahead: type to filter, WAIT for options to render, then click; assert the chosen value shows in the trigger afterwards.

DATE PICKERS
- Prefer typing over calendar-walking where allowed: focus the input, type the full date, press Enter (antd RangePicker pattern). Calendar-walking breaks across month/year boundaries.

DRAG & DROP
- HTML5 DnD ignores plain clicks: use CDP Input mouse primitives (move -> press -> move over target with hover dwell -> release) or dispatch synthetic dragstart/dragover/drop with ONE shared DataTransfer carrying the payload.

GENERAL
- Component libraries (antd/MUI/arco) hide real inputs behind styled divs — locate by label text then traverse, and verify the FRAMEWORK state (form value, chip, tag) changed, not just CSS classes.
`;

const SOP_LIST = `Infinite scroll, lazy loading & pagination — deterministic collection.

INFINITE SCROLL
- scrollTo(body.scrollHeight) + immediate read returns a STALE first batch: the IntersectionObserver has not fired and the next fetch has not landed. Never sleep-fixed loops — they break when the network slows down.
- Bounded loop: scroll one viewport -> wait for height growth OR item-count increase (with timeout) -> repeat until the count stabilizes across N rounds or a max-steps cap hits. Extract AFTER the loop; dedupe by stable keys (id/href).
- Best: harvest the batch API — observe responses (page.on('response')) to find the JSON endpoint feeding the list, then fetch it directly with page.evaluate (same cookies) and skip scrolling entirely.

LAZY CONTENT
- Scroll elements into view to trigger loading; for images wait naturalWidth > 0 before screenshots, otherwise you capture placeholders.

PAGINATION
- Prefer URL-pattern navigation (?page=N) over clicking when the site supports it. For SPA next-buttons: click, then diff the list container (tab.snapshot() + tab.diff()) to confirm the batch actually replaced.
- Stop conditions: disabled/missing next control, repeated identical content, or a hard page cap. Dedupe rows — sorted lists shift items across page boundaries.
`;

const SOP_ANTIBOT = `Beyond Cloudflare — identify the defense first, then pick the strategy.

IDENTIFY FIRST
- Challenge signatures differ per vendor — do not assume Cloudflare. is-antibot (npm) classifies 30+ providers (Cloudflare, Akamai, DataDome, PerimeterX/HUMAN, Kasada, Imperva, AWS WAF, Shape...) from headers/body. wafprobe-style probing mutates ONE client-fingerprint axis at a time (TLS JA3/JA4, header order, UA) to reveal which signal is actually checked.

VENDOR NOTES
- Cloudflare IUAM/Turnstile: see core + captcha-strategies (attach real browser; token/cf_clearance binding rules).
- DataDome, PerimeterX/HUMAN, Kasada, Akamai: heavier behavioral + TLS fingerprinting; headless/CDP leaks fail fast. COOKIE REPLAY is often more practical than re-solving: pass the challenge once, reuse the _datadome/_px*/cf_clearance cookie within its lifetime on the SAME IP+UA.
- Queue systems (Waiting Room, ticketing queues): keep the queue tab alive and poll position; never re-enter or you go to the back.

STRATEGY ORDER
1. Attach the user's real browser (core mode choice) — passes most JS + behavioral checks.
2. Cookie/session replay within the IP+UA binding (captcha-strategies).
3. Vendor-specific solver sidecars (self-hosted containers exposing a local HTTP solve endpoint).
`;

const SOP_CAPTCHA_STRATEGIES = `Turnstile & multi-CAPTCHA field strategies (distilled from github solver projects: B00H0O/cloudflare-solver, ismoiloffS/EzSolver, hasnainshahidx/turnstile_solver, gmh5225/captcha-solver).

BINDING RULES
- A Turnstile token AND a cf_clearance cookie are bound to the IP + User-Agent they were earned on. Solve and replay over the same egress IP; reuse the exact UA (solver APIs return it).
- Windows-launched Chrome leaks its fingerprint to CF (solver projects run on Linux for this reason). On a Windows desktop the equivalent working path is attaching the user's REAL daily browser (core section 1).

WIDGET BEHAVIOR
- Invisible/non-interactive widgets usually auto-resolve within seconds inside a trusted real browser — no click needed; poll the callback or hidden token input.
- Managed (checkbox) widgets need a human-like click on the checkbox INSIDE the widget iframe: locate the iframe rect, add offset, click via CDP Input with a hover dwell (see core coordinate pitfalls). When DOM queries fail (cross-origin / closed shadow), template image matching on a screenshot locates the checkbox.

STUB-PAGE PATTERN (token without touching the target)
- Render the widget on a stub page using the target's sitekey (+ cData/action if the site sets them), poll for the token (~2-5s), then submit the token to the real target. Token is one-shot, ~5min lifetime.
- Use a fresh isolated browser context per solve (own cookie jar) so solves do not leak into each other; discard the context afterwards.

FALLBACK LADDER (cheapest first)
1. Prevent: stealth/anti-detect browsers often pass Turnstile and reCAPTCHA v3 scoring with no challenge at all.
2. Click: find-and-click the checkbox in a real browser (free; Turnstile managed + some hCaptcha).
3. Paid solver API (2Captcha/CapSolver): reCAPTCHA v2/v3/Enterprise, hCaptcha, FunCaptcha, GeeTest v3/v4, DataDome, Akamai, Imperva, etc. Flow is always: send sitekey+pageurl(+proxy) -> poll for result -> inject the token into the form field / submit endpoint.
`;

const SOP_ANTIPATTERNS = `Puppeteer antipatterns — silent-failure modes to avoid.

WAITING
- Never substitute hardcoded sleeps for state: wait on a selector, network idle, or verify DOM change (tab.snapshot() + tab.diff()). A sleep that "usually works" fails under load.
- After a click triggers navigation, wait for the navigation or expected DOM change before reading state (run output reports navigated/newTabs).

CONTEXT HYGIENE
- Reuse one named browser/tab across related steps; relaunching per step loses profile warmup and CF trust.
- Close pages/contexts opened in loops; leaked targets accumulate memory until the tab crashes.

EVALUATE DISCIPLINE
- Code inside page/tab.evaluate runs in page context: no Node variables or APIs. Pass data as explicit args; return plain JSON (no functions/DOM nodes).
- Existence-check before $eval/click — a missing element throws and aborts mid-flow. Probe with tab.observe() / extract('probe') first.
- React/Vue controlled inputs ignore direct value writes: set value via the native prototype setter + dispatch input/change (or type real key events), then VERIFY the framework saw it (submit button enabled, state changed) before proceeding.

ASSERT OUTCOMES, NOT ACTIONS
- Clicking submit is not success: confirm navigation/DOM/toast (tab.monitorStart()/monitorStop(), tab.diff()) before declaring the step done.
`;

const BROWSER_SOPS: Record<string, { title: string; body: string }> = {
  "core": { title: "Mode choice, attach setup, Turnstile recipe (NewAPI-verified), helper map, CDP pitfalls", body: SOP_CORE },
  "captcha-strategies": { title: "Turnstile/cf_clearance binding rules, widget behavior, stub-page pattern, CAPTCHA fallback ladder", body: SOP_CAPTCHA_STRATEGIES },
  "automation-antipatterns": { title: "Waiting vs sleeping, context hygiene, evaluate discipline, assert outcomes", body: SOP_ANTIPATTERNS },
  "network-mocking": { title: "Request blocking/mocking, response-body rewrite via CDP Fetch, XHR harvesting", body: SOP_NETWORK },
  "auth-flows": { title: "Session reuse, TOTP generation, email/SMS OTP polling, OAuth popups, post-login assertions", body: SOP_AUTH },
  "form-widgets": { title: "Rich-text editors, custom dropdowns/typeahead, date pickers, drag & drop", body: SOP_WIDGETS },
  "list-scraping": { title: "Infinite-scroll bounded loops, lazy content triggers, deterministic pagination", body: SOP_LIST },
  "antibot-landscape": { title: "WAF identification (DataDome/Akamai/PX/Kasada), vendor notes, cookie replay, strategy order", body: SOP_ANTIBOT },
};

function renderSopIndex(): string {
  const lines = Object.entries(BROWSER_SOPS).map(([id, doc]) => `  ${id.padEnd(26)}${doc.title}`);
  return [
    `Browser SOP Registry — ${Object.keys(BROWSER_SOPS).length} documents.`,
    `Read BEFORE the matching operation: call browser { action: "guide", topic: "<id>" } to load one document.`,
    ``,
    ...lines,
    ``,
    `Helper quickref (available in run code as tab.* — pick by target, then load the matching SOP topic for pitfalls):`,
    `  CDP raw         tab.cdp(method, params) — raw JSON; high-risk (Page.crash/Browser.close end session)`,
    `  CDP batch       tab.cdpBatch([{method,params},...]) with "$N.path" refs — one round-trip; check each result.ok`,
    `  CDP click       tab.cdpClick(x, y, {hoverMs?}) — Input 3-event; canvas/non-DOM/hover-dependent`,
    `  Autofill        tab.autofillRelease(selector) — foreground-only; bringToFront+click+redispatch`,
    `  Download bypass tab.setDownloadBehavior(dirPath) — Browser.setDownloadBehavior allow`,
    `  Shadow DOM      tab.pierce(selector) -> {x,y}; then tab.cdpClick — pierce/ engine crosses open shadow`,
    `  Iframe JS       tab.evalInFrame(matcher, fn, ...args) — cross-origin; matcher=substr/RegExp/predicate`,
    `  File upload     tab.uploadFile(selector, ...paths) — transient input -> tab.cdp('DOM.setFileInputFiles')`,
    `  Cookies         tab.cookies.get/set/delete({domain?,name?}) — session-level; attach mode has user login cookies`,
    `  OCR             tab.ocr({region?,langs?}) -> {text,lines} — tesseract.js; {ok:false,hint} on miss/fail`,
    `  UI detect       tab.detect({mode?,langs?}) -> {items} — canvas/non-DOM buttons; follow with cdpClick`,
    `  Observe         tab.observe() / tab.extract('probe'|'list'|'text') — interactive elements+numeric ids / simplified HTML`,
    `  Change detect   tab.snapshot() + tab.diff(before) / monitorStart-Stop — structural diff / transient text`,
    `  Scroll          tab.scroll(dx, dy) / tab.scrollIntoView(selector) — relative scroll / bring element into view`,
    `  Drag            tab.drag(from, to) — mouse move->down->move->up; HTML5 DnD may still need CDP Input`,
    `  Select          tab.select(selector, ...values) — native <select> option picking`,
    `  Wait            tab.waitFor(selector) / waitForSelector / waitForUrl / waitForNavigation / waitForResponse — wait for DOM / url / nav / XHR`,
    ``,
    `Parameter reference: action enumeration and per-field semantics (url, app.attach_user_profile, app.user_profile_dir, code, topic, ...) live in the tool signature's schema description — inspect the tool definition, not this registry. This registry covers HOW (recipes, helpers, pitfalls); the schema covers WHAT (which params each action accepts).`,
  ].join("\n");
}

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
    description: "Control Chromium through named tabs. Open or attach a browser, run trusted host-level JavaScript with page/browser/tab helpers, capture screenshots, and close one or all tabs. The run action requires non-empty code, is shell-equivalent, and is blocked in Plan mode. In run code, page is a puppeteer-core Page (page.setViewport({width,height}), page.goto, page.evaluate, page.screenshot — Puppeteer, not Playwright, so there is no page.setViewportSize), browser is a puppeteer Browser, and tab is a high-level helper.\\n\\nBEFORE ANY browser operation: call action: guide to get the SOP registry index, then load the relevant document by topic (core: mode choice, Turnstile recipe, helpers, pitfalls; captcha-strategies; automation-antipatterns; network-mocking; auth-flows; form-widgets; list-scraping; antibot-landscape). Acting before reading the SOP risks silent failure.\\n\\nCAPABILITY MAP (when to use which):\\n  - Pure scraping (no login/CAPTCHA) → open with visible:false (headless default) + tab.extract('probe')\\n  - Login state / CAPTCHA / real fingerprint → FIRST call action:guide, then open with visible:true + app.attach_user_profile + app.user_profile_dir (attach the user's daily browser; pi auto-launches Chrome with --remote-debugging-port=9222 if no live debug port, or reuses a running instance; pure stealth is NOT enough for Cloudflare managed challenges)\\n  - Raw CDP domain call → tab.cdp(method, params) (e.g. Page.captureScreenshot, Network.getCookies, DOM.setFileInputFiles)\\n  - Cookie read/write → tab.cookies.get/set/delete (session-level; in attach mode the user's login cookies are present)\\n  - File upload → tab.uploadFile(selector, ...paths); transient <input type=file> without a persistent DOM node → tab.cdp('DOM.setFileInputFiles', ...)\\n  - Cross-origin iframe JS → tab.evalInFrame(matcher, fn, ...args) (matcher = url substring/RegExp/predicate)\\n  - Open Shadow DOM → tab.pierce(selector) → {x,y}; follow with tab.cdpClick(x,y)\\n  - Canvas / non-DOM / hover-dependent click → tab.cdpClick(x, y, {hoverMs?}) (CDP Input 3-event sequence)\\n  - Chrome autofill release → tab.autofillRelease(selector) (brings tab to front, clicks, re-dispatches input/change)\\n  - Download-dialog bypass → tab.setDownloadBehavior(dirPath)\\n  - Multi-CDP chain → tab.cdpBatch([{method,params},...]) with '$N.path' references\\n  - On-page OCR / visual localization -> tab.ocr({region?,langs?}) returns {text, lines:[{bbox,text,confidence}]}; tab.detect({mode?,langs?}) returns {items:[{bbox,type,label,confidence}]} for canvas/non-DOM buttons. Follow with tab.cdpClick(cx, cy). Default langs is eng; pass eng+chi_sim for Chinese. Requires the optional tesseract.js dependency; on missing/failure returns {ok:false,hint} (fall back to describe_image for text, but its pixel coords are NOT reliable)\\n  - DOM observation → tab.observe() (interactive elements + numeric ids), tab.extract('probe'|'list'|'text'|'html'), tab.snapshot() + tab.diff(before) for change detection, tab.monitorStart/Stop for transient text\\n  - Navigation/new-tab detection is auto-reported in run output (navigated, newTabs).\\nSOP registry: action: guide returns the index; load a document with topic.\\nPass visible: true to open a headed (visible) browser window; the default is headless.",
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
          const topic = params.topic?.trim();
          if (!topic) {
            const index = renderSopIndex();
            return success(index, { action: "guide", result: index });
          }
          const doc = BROWSER_SOPS[topic];
          if (!doc) throw new Error(`Unknown SOP topic ${JSON.stringify(topic)}. Available: ${Object.keys(BROWSER_SOPS).map((k) => `"${k}"`).join(", ")}.`);
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
