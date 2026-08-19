import assert from "node:assert/strict";
import test from "node:test";
import { McpxWizardOverlay } from "../src/tui/mcpx-wizard.ts";

function makeWizard(overrides: { onWrite?: () => void } = {}) {
  const calls: string[] = [];
  const overlay = new McpxWizardOverlay({
    cwd: "D:/demo",
    requestRender: () => calls.push("render"),
    close: () => calls.push("close"),
  });
  return { overlay, calls };
}

const renderText = (overlay: McpxWizardOverlay) => overlay.render(100).join("\n");

test("wizard starts at the listen step and shows all options", () => {
  const { overlay } = makeWizard();
  const text = renderText(overlay);
  assert.match(text, /1\/7 监听地址/);
  assert.match(text, /host: 127\.0\.0\.1/);
  assert.match(text, /port: 9090/);
  assert.match(text, /下一步/);
});

test("enter opens field editing and confirm closes it", () => {
  const { overlay } = makeWizard();
  overlay.handleInput("\r"); // edit host
  let text = renderText(overlay);
  assert.match(text, /127\.0\.0\.1▌/);
  overlay.handleInput("1");
  overlay.handleInput("2");
  overlay.handleInput("7");
  text = renderText(overlay);
  assert.match(text, /127▌/);
  overlay.handleInput("\r"); // commit
  text = renderText(overlay);
  assert.match(text, /host: 127/);
  assert.doesNotMatch(text, /▌/);
});

test("down+enter advances from listen to the policy step", () => {
  const { overlay } = makeWizard();
  overlay.handleInput("\x1b[B"); // down -> port
  overlay.handleInput("\x1b[B"); // down -> next
  overlay.handleInput("\r"); // confirm next
  const text = renderText(overlay);
  assert.match(text, /2\/7 命令策略/);
  assert.match(text, /allow/);
  assert.match(text, /confirm/);
  assert.match(text, /deny/);
});

test("auth step is gone — policy follows listen directly", () => {
  const { overlay } = makeWizard();
  overlay.handleInput("\x1b[B");
  overlay.handleInput("\x1b[B");
  overlay.handleInput("\r"); // listen -> policy
  assert.match(renderText(overlay), /2\/7 命令策略/);
  assert.doesNotMatch(renderText(overlay), /认证模式/);
});

test("tunnel step offers only the Cloudflare quick tunnel", async (t) => {
  const { overlay } = makeWizard();
  const s = overlay;
  ["\x1b[B", "\x1b[B", "\r", "\x1b[B", "\r", "\r", "\x1b[B", "\r", "\r"].forEach((k) => overlay.handleInput(k));
  const text = renderText(overlay);
  assert.match(text, /6\/7 公网隧道/);
  assert.match(text, /唯一模式/);
  assert.doesNotMatch(text, /命名隧道/);
  assert.doesNotMatch(text, /自定义 URL/);
});

test("full flow reaches the write step and renders a summary", async (t) => {
  const { mkdtemp, mkdir, rm, writeFile, chmod } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const dir = await mkdtemp(join(tmpdir(), "mcpx-flow-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const binDir = join(dir, "bin");
  await mkdir(binDir);
  const isWin = process.platform === "win32";
  const shim = join(binDir, isWin ? "cloudflared.cmd" : "cloudflared");
  await writeFile(shim, isWin
    ? '@echo off\r\necho Your quick Tunnel has been created! Visit it at https://abc-123.trycloudflare.com\r\nping -n 30 127.0.0.1 >nul\r\n'
    : '#!/bin/sh\necho "Your quick Tunnel has been created! Visit it at https://abc-123.trycloudflare.com"\nsleep 30\n', "utf8");
  if (!isWin) await chmod(shim, 0o755);
  const previousPath = process.env.PATH;
  process.env.PATH = `${binDir}${isWin ? ";" : ":"}${previousPath ?? ""}`;
  t.after(() => { process.env.PATH = previousPath; });

  const { overlay } = makeWizard();
  const s = overlay;
  // listen -> next
  overlay.handleInput("\x1b[B");
  overlay.handleInput("\x1b[B");
  overlay.handleInput("\r");
  // policy -> confirm (index 1)
  overlay.handleInput("\x1b[B");
  overlay.handleInput("\r");
  // pi -> add
  overlay.handleInput("\r");
  // skills -> skip (index 1) — avoid depending on the host's .pi/skills
  overlay.handleInput("\x1b[B");
  overlay.handleInput("\r");
  // workspace -> register
  overlay.handleInput("\r");
  // tunnel -> start the quick tunnel (Enter on the only option), wait for URL
  overlay.handleInput("\r");
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline && s["changes"]?.tunnelUrl !== "https://abc-123.trycloudflare.com") {
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  assert.equal(s["changes"]?.tunnelUrl, "https://abc-123.trycloudflare.com", "URL should be parsed from cloudflared output");
  // stop the fake tunnel while still on the tunnel step (x is ignored elsewhere)
  overlay.handleInput("x");
  await new Promise((resolve) => setTimeout(resolve, 1500));
  overlay.handleInput("\x1b[B"); // -> next
  overlay.handleInput("\r");
  const text = renderText(overlay);
  assert.match(text, /7\/7 写入确认/);
  assert.match(text, /公网暴露下认证已升级为 oauth/);
  assert.match(text, /命令默认策略: confirm/);
  assert.match(text, /Pi 白名单/);
  assert.match(text, /云端 MCP 连接信息/);
  assert.match(text, /服务器 URL: https:\/\/abc-123\.trycloudflare\.com\/mcp/);
  assert.match(text, /身份验证: OAuth/);
  assert.match(text, /w 写入并保存/);
});

test("escape closes from the first step and backs out of later steps", () => {
  const { overlay, calls } = makeWizard();
  overlay.handleInput("\x1b"); // close from listen
  assert.ok(calls.includes("close"));

  const second = makeWizard();
  second.overlay.handleInput("\x1b[B");
  second.overlay.handleInput("\x1b[B");
  second.overlay.handleInput("\r"); // -> policy
  second.overlay.handleInput("\x1b"); // back to listen
  assert.match(renderText(second.overlay), /1\/7 监听地址/);
});
