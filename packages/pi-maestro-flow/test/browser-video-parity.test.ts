import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";
import type { Browser } from "puppeteer-core";
import test from "node:test";
import { BrowserManager } from "../src/tools/browser/manager.ts";
import { createBrowserTool } from "../src/tools/browser-tool.ts";
import { browserRunFailureDiagnostics } from "../src/tools/browser/run-diagnostics.ts";

const runFile = promisify(execFile);

test("all five MCP video capabilities render and produce decodable multi-page VP8 WebM", { timeout: 60000 }, async (t) => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "browser-video-parity-"));
  const manager = new BrowserManager();
  t.after(async () => { await manager.closeAll(); await fs.rm(cwd, { recursive: true, force: true }); });
  const tool = createBrowserTool(manager);
  const invoke = (input: Record<string, unknown>) => tool.execute("video", input as never, undefined, undefined, { cwd } as never);
  const run = async (code: string) => {
    try { return await manager.run("main", code, cwd, undefined, 15000); }
    catch (error) { t.diagnostic(JSON.stringify(browserRunFailureDiagnostics(error))); throw error; }
  };
  await invoke({ action: "open", url: "data:text/html," + encodeURIComponent('<title>Video</title><button id="target" style="margin:80px;padding:25px">Checkout</button>'), viewport: { width: 800, height: 600 } });
  await run(`const prior = await browser.newPage(); await prior.goto('data:text/html,<h1>Previously admitted page</h1>');`);
  const browserResult = await run("return page.browser();");
  const unrelated = await (browserResult.returnValue as Browser).newPage();
  await unrelated.goto("data:text/html,<h1>Unrelated tab: do not record</h1>");
  await invoke({ action: "video_show_actions" });
  const started = await invoke({ action: "start_video", filename: "demo.webm", size: { width: 321, height: 241 }, ffmpeg_path: process.env.PI_BROWSER_VIDEO_FFMPEG ?? "ffmpeg", fps: 20 });
  assert.deepEqual(started.details?.video?.size, { width: 320, height: 240 });
  const annotated = await run(`
    await tab.click('#target');
    return await page.evaluate(() => {
      const root = document.querySelector('[data-browser-video-presentation]');
      const shadow = root.shadowRoot;
      return { label: shadow.querySelector('.label').textContent, highlight: shadow.querySelector('.target').style.opacity,
        pointer: shadow.querySelector('.cursor').style.opacity, right: shadow.querySelector('.label').style.right };
    });
  `);
  assert.deepEqual(annotated.returnValue, { label: "click", highlight: "1", pointer: "1", right: "24px" });
  const chapterStart = performance.now();
  await invoke({ action: "video_chapter", title: "Checkout", description: "Confirm the order", duration: 250 });
  assert.ok(performance.now() - chapterStart >= 250, "chapter blocks for its display duration");
  await run(`
    const other = await browser.newPage();
    await other.goto('data:text/html,<title>Second</title><h1>Popup recording</h1>');
    await wait(200);
  `);
  const stopped = await invoke({ action: "stop_video" });
  const video = stopped.details?.video;
  assert.equal(video?.recording, false);
  assert.equal(video?.videos?.length, 3, "prior/new admitted pages are recorded but the unrelated tab is excluded");
  for (const artifact of video!.videos!) {
    const bytes = await fs.readFile(artifact.path);
    assert.deepEqual([...bytes.subarray(0, 4)], [0x1a, 0x45, 0xdf, 0xa3]);
    assert.equal(bytes.length, artifact.bytes);
    assert.ok(artifact.size!.width <= 321 && artifact.size!.height <= 241);
    assert.equal(artifact.size!.width % 2, 0);
    assert.equal(artifact.size!.height % 2, 0);
    const decoded = path.join(cwd, path.basename(artifact.path, ".webm") + "-decoded.webm");
    const result = await runFile(process.env.PI_BROWSER_VIDEO_FFMPEG ?? "ffmpeg", [
      "-hide_banner", "-i", artifact.path, "-an", "-c:v", "libvpx", "-threads", "1", "-f", "webm", "-y", decoded,
    ], { windowsHide: true });
    assert.match(result.stderr, /Video: vp8/);
    assert.match(result.stderr, /frame=\s*[1-9]/);
    assert.ok((await fs.stat(decoded)).size > 0);
  }
  const idle = await invoke({ action: "stop_video" });
  assert.equal(idle.details?.result, "No videos were recorded.");
  await invoke({ action: "video_hide_actions" });
  const hidden = await manager.run("main", "return await page.evaluate(() => !!document.querySelector('[data-browser-video-presentation]'));", cwd, undefined, 15000);
  assert.equal(hidden.returnValue, false);
  await invoke({ action: "video_show_actions", cursor: "none", position: "bottom-left", duration: 1000 });
  const noCursor = await manager.run("main", `await tab.click('#target'); return await page.evaluate(() => document.querySelector('[data-browser-video-presentation]').shadowRoot.querySelector('.cursor').style.opacity);`, cwd, undefined, 15000);
  assert.equal(noCursor.returnValue, "0");
  await manager.closeAll();
  assert.equal((await fs.stat(video!.path)).size, video!.bytes, "artifacts survive session cleanup");
});

test("chapter participates in named-tab busy, abort and closeAll lifecycle", { timeout: 30000 }, async (t) => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "browser-chapter-lifecycle-"));
  const manager = new BrowserManager();
  t.after(async () => { await manager.closeAll(); await fs.rm(cwd, { recursive: true, force: true }); });
  await manager.open({ name: "chapter", cwd, url: "data:text/html,<h1>Chapter</h1>", timeoutMs: 15000 });
  const controller = new AbortController();
  const showing = manager.videoChapter("chapter", { title: "Long chapter", duration: 10000 }, controller.signal, 15000);
  const rejected = assert.rejects(showing, { name: "AbortError" });
  await assert.rejects(manager.run("chapter", "return true;", cwd, undefined, 1000), /busy/);
  controller.abort();
  await rejected;
  await manager.closeAll();
  assert.equal(manager.has("chapter"), false);
});
