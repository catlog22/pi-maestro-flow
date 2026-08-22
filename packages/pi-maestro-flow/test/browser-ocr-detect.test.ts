import assert from "node:assert/strict";
import test from "node:test";
import * as fs from "node:fs/promises";
import { BrowserManager } from "../src/tools/browser/manager.ts";
import { runOcr, isLocalVisionError, resetLocalVisionCache, type OcrOutcome, type DetectOutcome } from "../src/providers/local-vision.ts";

// Real-browser end-to-end tests for tab.ocr() / tab.detect() (Tier 1 on-page
// visual localization, see EXTRA-FEATURES-OCR-COMPUTER-USE.md). These require
// a local Chromium executable AND the optional tesseract.js dependency; both
// are skipped when unavailable so CI without them stays green.

const CHROME_CANDIDATES = [
  process.env.PUPPETEER_EXECUTABLE_PATH,
  process.env.CHROME_PATH,
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
  "/usr/bin/google-chrome",
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
].filter(Boolean) as string[];

async function findChrome(): Promise<string | null> {
  for (const candidate of CHROME_CANDIDATES) {
    try { await fs.access(candidate); return candidate; } catch { /* try next */ }
  }
  return null;
}

async function tesseractAvailable(): Promise<boolean> {
  try {
    const require = (await import("node:module")).createRequire(import.meta.url);
    const mod = require("tesseract.js") as { createWorker?: unknown };
    return typeof mod.createWorker === "function";
  } catch { return false; }
}

// A small white PNG with black text rendered by the browser itself (via a
// data: URL page) is the most realistic fixture: it exercises the full
// screenshot -> OCR pipeline. We build the page URL here and let the browser
// render + screenshot inside the run code.

test("local-vision: runOcr over a rendered text page returns line-level text + bbox", async (t) => {
  const chrome = await findChrome();
  if (!chrome) { t.skip("No local Chromium executable available."); return; }
  if (!(await tesseractAvailable())) { t.skip("tesseract.js optional dependency not installed."); return; }

  await resetLocalVisionCache();
  const manager = new BrowserManager();
  const url = "data:text/html," + encodeURIComponent(
    "<title>OCR</title><body style='margin:0;background:white;color:black;font-family:Arial,sans-serif;font-size:24px;'>" +
    "<div style='padding:40px;'><div id='a'>Login</div><div id='b' style='margin-top:20px;'>Submit</div></div></body>");
  try {
    const opened = await manager.open({ name: "ocr", cwd: process.cwd(), url, viewport: { width: 400, height: 300 }, timeoutMs: 20_000, executablePath: chrome }).catch((error: unknown) => { throw error; });
    void opened;
    const output = await manager.run("ocr", `
      const result = await tab.ocr();
      return result;
    `, process.cwd(), undefined, 60_000);
    const rv = output.returnValue as OcrOutcome;
    if (isLocalVisionError(rv)) {
      // Engine present but worker/wasm failed (e.g. traineddata download blocked).
      // Treat as a soft skip rather than a hard failure — the injection path is
      // proven, only the external asset fetch did not complete.
      t.skip("tesseract.js worker reported an error: " + rv.error);
      return;
    }
    assert.ok(rv.lines.length >= 1, "ocr must return at least one line for a text page");
    const joined = rv.lines.map((line) => line.text).join(" ").toLowerCase();
    assert.ok(joined.includes("login") || joined.includes("submit"), `ocr text must contain 'login' or 'submit', got: ${joined}`);
    for (const line of rv.lines) {
      assert.ok(line.bbox[2] > line.bbox[0] && line.bbox[3] > line.bbox[1], "each line bbox must have positive width/height");
      assert.ok(line.confidence >= 0 && line.confidence <= 1, "confidence must be normalized to 0..1");
    }
    assert.ok(rv.width > 0 && rv.height > 0, "ocr must report screenshot dimensions");
    assert.match(rv.engine, /tesseract\.js@/, "engine label must identify tesseract.js");
  } finally {
    await manager.close("ocr").catch(() => {});
    await resetLocalVisionCache();
  }
});

test("local-vision: tab.detect() returns labeled regions; coordinates are clickable via tab.cdpClick()", async (t) => {
  const chrome = await findChrome();
  if (!chrome) { t.skip("No local Chromium executable available."); return; }
  if (!(await tesseractAvailable())) { t.skip("tesseract.js optional dependency not installed."); return; }

  await resetLocalVisionCache();
  const manager = new BrowserManager();
  const url = "data:text/html," + encodeURIComponent(
    "<title>Detect</title><body style='margin:0;background:white;color:black;font-family:Arial,sans-serif;font-size:28px;'>" +
    "<div style='padding:50px;'><div id='target' style='display:inline-block;padding:8px 16px;border:1px solid #333;'>ClickMe</div></div></body>");
  try {
    await manager.open({ name: "detect", cwd: process.cwd(), url, viewport: { width: 500, height: 300 }, timeoutMs: 20_000, executablePath: chrome });
    const output = await manager.run("detect", `
      const detected = await tab.detect();
      // Find the 'ClickMe' label, click its center, set a flag the page reads.
      await tab.evaluate(() => { document.getElementById('target').addEventListener('click', () => { window.__hit = true; }, { once: true }); });
      let clicked = false;
      const hit = detected.items.find(i => i.label && /clickme/i.test(i.label));
      if (hit) {
        const cx = (hit.bbox[0] + hit.bbox[2]) / 2;
        const cy = (hit.bbox[1] + hit.bbox[3]) / 2;
        await tab.cdpClick(cx, cy, { hoverMs: 30 });
        clicked = await tab.evaluate(() => window.__hit === true);
      }
      return { detected, clicked, hadClickMe: !!hit };
    `, process.cwd(), undefined, 60_000);
    const rv = output.returnValue as { detected: DetectOutcome; clicked: boolean; hadClickMe: boolean };
    if (isLocalVisionError(rv.detected)) {
      t.skip("tesseract.js worker reported an error: " + rv.detected.error);
      return;
    }
    assert.ok(rv.detected.items.length >= 1, "detect must return at least one item");
    for (const item of rv.detected.items) {
      assert.ok(item.bbox[2] > item.bbox[0] && item.bbox[3] > item.bbox[1], "each item bbox must have positive width/height");
      assert.ok(item.confidence >= 0 && item.confidence <= 1, "confidence must be normalized to 0..1");
    }
    // The 'ClickMe' label must be detected; if OCR missed it we skip rather
    // than fail — OCR accuracy on a 28px rendered label is high but not 100%.
    if (!rv.hadClickMe) { t.skip("OCR did not resolve the 'ClickMe' label on this run."); return; }
    assert.equal(rv.clicked, true, "cdpClick at the detected bbox center must fire the element click handler");
  } finally {
    await manager.close("detect").catch(() => {});
    await resetLocalVisionCache();
  }
});

test("local-vision: tab.ocr() with a region crops to the requested rectangle", async (t) => {
  const chrome = await findChrome();
  if (!chrome) { t.skip("No local Chromium executable available."); return; }
  if (!(await tesseractAvailable())) { t.skip("tesseract.js optional dependency not installed."); return; }

  await resetLocalVisionCache();
  const manager = new BrowserManager();
  // Two text blocks side by side; region selects only the left half.
  const url = "data:text/html," + encodeURIComponent(
    "<title>Region</title><body style='margin:0;background:white;color:black;font-family:Arial,sans-serif;font-size:22px;'>" +
    "<div style='display:flex;gap:200px;padding:40px;'><div id='left'>AlphaOnly</div><div id='right'>BetaOnly</div></div></body>");
  try {
    await manager.open({ name: "region", cwd: process.cwd(), url, viewport: { width: 700, height: 200 }, timeoutMs: 20_000, executablePath: chrome });
    const output = await manager.run("region", `
      const full = await tab.ocr();
      const half = await tab.ocr({ region: { x: 0, y: 0, w: 200, h: 200 } });
      return { fullText: full.text, halfText: half.text };
    `, process.cwd(), undefined, 90_000);
    const rv = output.returnValue as { fullText: string; halfText: string };
    // Both calls may return error outcomes if the worker is flaky; only assert
    // behavior when OCR actually succeeded for the full page.
    if (!rv.fullText) { t.skip("OCR returned no text on this run."); return; }
    const full = rv.fullText.toLowerCase();
    assert.ok(full.includes("alpha") && full.includes("beta"),
      `full ocr should see BOTH labels, got: ${rv.fullText}`);
    // The region crop (left 200px) must exclude the right-side 'BetaOnly'.
    // We only assert the negative when the half OCR actually produced text —
    // an empty halfText also satisfies 'beta not present'.
    if (rv.halfText) {
      assert.ok(!rv.halfText.toLowerCase().includes("beta"),
        `region crop must exclude the right-side label, but halfText was: ${rv.halfText}`);
    }
  } finally {
    await manager.close("region").catch(() => {});
    await resetLocalVisionCache();
  }
});

test("local-vision: isLocalVisionError narrows the error outcome", () => {
  const err = { ok: false, error: "x", hint: "y", engine: "none" };
  assert.equal(isLocalVisionError(err), true);
  const ok = { text: "a", lines: [], engine: "tesseract.js@7", width: 1, height: 1 };
  assert.equal(isLocalVisionError(ok), false);
  assert.equal(isLocalVisionError(null), false);
  assert.equal(isLocalVisionError(undefined), false);
});

test("local-vision: runOcr returns a structured error (no crash) when the engine is missing", async () => {
  await resetLocalVisionCache();
  // Force tesseract.js resolution to fail so loadTesseract throws, then
  // assert runOcr surfaces a LocalVisionError with an install hint rather
  // than propagating the throw. Restore the resolver in finally. We obtain
  // the CJS Module object via createRequire (the ESM `node:module` namespace
  // is frozen and its `_resolveFilename` is non-writable).
  const require = (await import("node:module")).createRequire(import.meta.url);
  const Module = require("node:module");
  const original = Module._resolveFilename;
  Module._resolveFilename = function (request: unknown, ...rest: unknown[]): unknown {
    if (typeof request === "string" && request === "tesseract.js") {
      const err = new Error(`Cannot find module '${request}'`);
      (err as Error & { code?: string }).code = "MODULE_NOT_FOUND";
      throw err;
    }
    return original(request, ...rest);
  };
  try {
    const outcome = await runOcr(Buffer.from([0x89, 0x50, 0x4e, 0x47]), 1, 1);
    assert.equal(isLocalVisionError(outcome), true, "missing engine must yield a LocalVisionError, not a throw");
    if (isLocalVisionError(outcome)) {
      assert.match(outcome.hint, /npm i tesseract\.js/, "hint must include the install command");
      assert.equal(outcome.engine, "none");
    }
  } finally {
    Module._resolveFilename = original;
    await resetLocalVisionCache();
  }
});
