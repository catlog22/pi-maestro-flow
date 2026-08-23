---
title: Mode choice, attach setup, Turnstile recipe (NewAPI-verified), helper map, CDP pitfalls
type: recipe
tools: [browser]
sop_topic: core
sop_order: 0
category: browser-sop
created: 2026-08-23T00:00:00Z
tags: [browser, sop]
---

Browser SOP — when to use which tab.* helper and field-tested recipes.

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

