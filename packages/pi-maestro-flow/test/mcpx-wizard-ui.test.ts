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
  assert.match(text, /1\/10 监听地址/);
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

test("down+enter advances from listen to the auth step", () => {
  const { overlay } = makeWizard();
  overlay.handleInput("\x1b[B"); // down -> port
  overlay.handleInput("\x1b[B"); // down -> next
  overlay.handleInput("\r"); // confirm next
  const text = renderText(overlay);
  assert.match(text, /2\/10 认证模式/);
  assert.match(text, /open/);
  assert.match(text, /bearer/);
  assert.match(text, /oauth/);
});

test("auth selection advances to policy (open) or bearer/oauth sub-steps", () => {
  const { overlay } = makeWizard();
  // go to auth first
  overlay.handleInput("\x1b[B");
  overlay.handleInput("\x1b[B");
  overlay.handleInput("\r");
  // select open (first option) -> policy
  overlay.handleInput("\r");
  assert.match(renderText(overlay), /4\/10 命令策略/);

  // re-run with bearer
  const second = makeWizard();
  second.overlay.handleInput("\x1b[B");
  second.overlay.handleInput("\x1b[B");
  second.overlay.handleInput("\r");
  second.overlay.handleInput("\x1b[B"); // bearer
  second.overlay.handleInput("\r");
  assert.match(renderText(second.overlay), /3\/10 Bearer Token/);
  second.overlay.handleInput("\r"); // continue -> policy
  assert.match(renderText(second.overlay), /4\/10 命令策略/);
});

test("oauth step can advance via the next option", () => {
  const { overlay } = makeWizard();
  overlay.handleInput("\x1b[B");
  overlay.handleInput("\x1b[B");
  overlay.handleInput("\r");
  overlay.handleInput("\x1b[B");
  overlay.handleInput("\x1b[B"); // oauth
  overlay.handleInput("\r");
  assert.match(renderText(overlay), /3\/10 OAuth 配置/);
  overlay.handleInput("\x1b[B");
  overlay.handleInput("\x1b[B"); // next option
  overlay.handleInput("\r");
  assert.match(renderText(overlay), /4\/10 命令策略/);
});

test("full flow reaches the write step and renders a summary", () => {
  const { overlay } = makeWizard();
  // listen -> next
  overlay.handleInput("\x1b[B");
  overlay.handleInput("\x1b[B");
  overlay.handleInput("\r");
  // auth -> open
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
  // tunnel -> move to the URL row (3), edit it (required), then advance
  overlay.handleInput("\x1b[B");
  overlay.handleInput("\x1b[B");
  overlay.handleInput("\x1b[B");
  overlay.handleInput("\r"); // enter URL editing
  for (const ch of "https://mcpx.example.com") overlay.handleInput(ch);
  overlay.handleInput("\r"); // commit URL
  overlay.handleInput("\x1b[B"); // next option
  overlay.handleInput("\r");
  const text = renderText(overlay);
  assert.match(text, /9\/10 写入确认/);
  assert.match(text, /认证已升级为 oauth/);
  assert.match(text, /命令默认策略: confirm/);
  assert.match(text, /Pi 白名单/);
  assert.match(text, /云端 MCP 连接信息/);
  assert.match(text, /服务器 URL: https:\/\/mcpx\.example\.com\/mcp/);
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
  second.overlay.handleInput("\r"); // -> auth
  second.overlay.handleInput("\x1b"); // back to listen
  assert.match(renderText(second.overlay), /1\/10 监听地址/);
});

test("tunnel step auto-parses the generated trycloudflare URL from cloudflared output", async (t) => {
  const { mkdtemp, mkdir, rm, writeFile, chmod } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const dir = await mkdtemp(join(tmpdir(), "mcpx-cf-"));
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

  const overlay = new McpxWizardOverlay({ cwd: "D:/demo", requestRender: () => undefined, close: () => undefined });
  const s = overlay;
  // navigate to the tunnel step
  ["\x1b[B", "\x1b[B", "\r", "\r", "\x1b[B", "\r", "\r", "\x1b[B", "\r", "\r", "\r"].forEach((k) => overlay.handleInput(k));
  assert.equal(s["step"], "tunnel");
  // press g to start the quick tunnel
  overlay.handleInput("g");
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline && s["changes"]?.tunnelUrl !== "https://abc-123.trycloudflare.com") {
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  assert.equal(s["changes"]?.tunnelUrl, "https://abc-123.trycloudflare.com", "URL should be parsed from cloudflared output");
  // stop the tunnel and clean up
  overlay.handleInput("x");
  const stopped = await new Promise<boolean>((resolve) => {
    const end = Date.now() + 8_000;
    const poll = () => {
      if (s["tunnelProcess"] === undefined) return resolve(true);
      if (Date.now() > end) return resolve(false);
      setTimeout(poll, 200);
    };
    poll();
  });
  assert.equal(stopped, true, "tunnel process should be cleared");
});
