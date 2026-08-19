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
  // tunnel -> no exposure (first option), then advance to write
  overlay.handleInput("\r");
  overlay.handleInput("\x1b[B");
  overlay.handleInput("\x1b[B");
  overlay.handleInput("\x1b[B");
  overlay.handleInput("\x1b[B");
  overlay.handleInput("\r");
  const text = renderText(overlay);
  assert.match(text, /9\/10 写入确认/);
  assert.match(text, /认证: open/);
  assert.match(text, /命令默认策略: confirm/);
  assert.match(text, /Pi 白名单/);
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
