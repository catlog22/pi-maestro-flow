/**
 * Embedded browser SOP baseline — the zero-dependency fallback served by
 * {@link SopRegistry} when the `.workflow/knowhow/` directory has no overriding
 * browser SOP documents. Content is the verbatim former `BROWSER_SOPS` map
 * extracted from `browser-tool.ts`; knowhow entries with `tools: [browser]` +
 * `sop_topic` override these by the registry's merge rules.
 */

import type { EmbeddedSopMap } from "../sop-types.ts";

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
  - On-page OCR / visual localization: tab.ocr({region?,langs?}) -> {text, lines:[{bbox,text,confidence}]}; tab.detect({mode?,langs?}) -> {items:[{bbox,type,label,confidence}]} for canvas/non-DOM buttons. Follow with tab.cdpClick(cx, cy). Default langs is "eng" (pass "eng+chi_sim" for Chinese). Uses the shared local RapidOCR/OmniParser service and manifest-listed model assets; missing or unverified assets return {ok:false,error,hint,engine} and detection fails closed (no fabricated icons). For text-only needs without local models, describe_image can read text but cannot return reliable pixel coordinates.

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

export const BROWSER_SOPS_BASELINE: EmbeddedSopMap = {
  "core": { title: "Mode choice, attach setup, Turnstile recipe (NewAPI-verified), helper map, CDP pitfalls", body: SOP_CORE },
  "captcha-strategies": { title: "Turnstile/cf_clearance binding rules, widget behavior, stub-page pattern, CAPTCHA fallback ladder", body: SOP_CAPTCHA_STRATEGIES },
  "automation-antipatterns": { title: "Waiting vs sleeping, context hygiene, evaluate discipline, assert outcomes", body: SOP_ANTIPATTERNS },
  "network-mocking": { title: "Request blocking/mocking, response-body rewrite via CDP Fetch, XHR harvesting", body: SOP_NETWORK },
  "auth-flows": { title: "Session reuse, TOTP generation, email/SMS OTP polling, OAuth popups, post-login assertions", body: SOP_AUTH },
  "form-widgets": { title: "Rich-text editors, custom dropdowns/typeahead, date pickers, drag & drop", body: SOP_WIDGETS },
  "list-scraping": { title: "Infinite-scroll bounded loops, lazy content triggers, deterministic pagination", body: SOP_LIST },
  "antibot-landscape": { title: "WAF identification (DataDome/Akamai/PX/Kasada), vendor notes, cookie replay, strategy order", body: SOP_ANTIBOT },
};

/**
 * Helper quickref appended to the browser guide index. Kept here (not in the
 * registry) because it documents `tab.*` helpers, not SOP topics; the tool
 * passes it to {@link SopRegistry.renderIndex} as the trailing section.
 */
export const BROWSER_HELPER_QUICKREF = `Helper quickref (available in run code as tab.* — pick by target, then load the matching SOP topic for pitfalls):
  CDP raw         tab.cdp(method, params) — raw JSON; high-risk (Page.crash/Browser.close end session)
  CDP batch       tab.cdpBatch([{method,params},...]) with "$N.path" refs — one round-trip; check each result.ok
  CDP click       tab.cdpClick(x, y, {hoverMs?}) — Input 3-event; canvas/non-DOM/hover-dependent
  Autofill        tab.autofillRelease(selector) — foreground-only; bringToFront+click+redispatch
  Download bypass tab.setDownloadBehavior(dirPath) — Browser.setDownloadBehavior allow
  Shadow DOM      tab.pierce(selector) -> {x,y}; then tab.cdpClick — pierce/ engine crosses open shadow
  Iframe JS       tab.evalInFrame(matcher, fn, ...args) — cross-origin; matcher=substr/RegExp/predicate
  File upload     tab.uploadFile(selector, ...paths) — transient input -> tab.cdp('DOM.setFileInputFiles')
  Cookies         tab.cookies.get/set/delete({domain?,name?}) — session-level; attach mode has user login cookies
  OCR             tab.ocr({region?,langs?}) -> {text,lines} — shared RapidOCR/ONNX service; {ok:false,error,hint,engine} when manifest assets/runtime are unavailable
  UI detect       tab.detect({mode?,langs?}) -> {items} — shared OmniParser/ONNX service; fail-closed when the manifest does not contain a verified model
  Observe         tab.observe() / tab.extract('probe'|'list'|'text') — interactive elements+numeric ids / simplified HTML
  Change detect   tab.snapshot() + tab.diff(before) / monitorStart-Stop — structural diff / transient text
  Scroll          tab.scroll(dx, dy) / tab.scrollIntoView(selector) — relative scroll / bring element into view
  Drag            tab.drag(from, to) — mouse move->down->move->up; HTML5 DnD may still need CDP Input
  Select          tab.select(selector, ...values) — native <select> option picking
  Wait            tab.waitFor(selector) / waitForSelector / waitForUrl / waitForNavigation / waitForResponse — wait for DOM / url / nav / XHR

Parameter reference: action enumeration and per-field semantics (url, app.attach_user_profile, app.user_profile_dir, code, topic, ...) live in the tool signature's schema description — inspect the tool definition, not this registry. This registry covers HOW (recipes, helpers, pitfalls); the schema covers WHAT (which params each action accepts).`;
