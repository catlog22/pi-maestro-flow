import assert from "node:assert/strict";
import test from "node:test";
import { GatewayWizardOverlay } from "../src/tui/gateway-wizard.ts";
import { setGatewayControlClientForTest } from "../src/gateway/workspace-client.ts";
import type { GatewayTunnelPublicState } from "../src/gateway/tunnel/provider.ts";

function stoppedState(): GatewayTunnelPublicState {
  return {
    version: 1,
    provider: "cloudflare",
    instance: "default",
    desiredState: "stopped",
    observed: { phase: "stopped", changedAt: 1 },
    generation: 0,
    restartHistory: [],
    updatedAt: 1,
  };
}

function readyState(generation = 3, endpoint = "https://native-ready.trycloudflare.com"): GatewayTunnelPublicState {
  return {
    version: 1,
    provider: "cloudflare",
    instance: "default",
    desiredState: "running",
    observed: { phase: "ready", changedAt: 2, endpoint, detail: "local: ready; provider: URL acquired; public: OAuth challenge reachable" },
    generation,
    pid: 4242,
    executableRealpath: "/usr/bin/cloudflared",
    processStartIdentity: "boot:1",
    invocationDigest: "a".repeat(64),
    restartHistory: [],
    updatedAt: 2,
  };
}

let state: GatewayTunnelPublicState;
let startCalls: Array<{ provider: string; options: Record<string, unknown> }>;
let stopCalls: Array<{ provider: string; options: Record<string, unknown> }>;
let startError: Error | undefined;
let restoreControl: (() => void) | undefined;

test.beforeEach(() => {
  state = stoppedState();
  startCalls = [];
  stopCalls = [];
  startError = undefined;
  const fake = {
    tunnelStatus: async () => state,
    tunnelStart: async (provider: string, options: Record<string, unknown>) => {
      startCalls.push({ provider, options });
      if (startError) throw startError;
      state = readyState();
      return state;
    },
    tunnelStop: async (provider: string, options: Record<string, unknown>) => {
      stopCalls.push({ provider, options });
      state = { ...stoppedState(), generation: state.generation };
      return state;
    },
  };
  restoreControl = setGatewayControlClientForTest(fake as never);
});

test.afterEach(() => {
  restoreControl?.();
  restoreControl = undefined;
});

function makeWizard() {
  const calls: string[] = [];
  const overlay = new GatewayWizardOverlay({
    cwd: "D:/demo",
    requestRender: () => calls.push("render"),
    close: () => calls.push("close"),
  });
  return { overlay, calls };
}

const renderText = (overlay: GatewayWizardOverlay) => overlay.render(100).join("\n");

function enterTunnelStep(overlay: GatewayWizardOverlay): void {
  // listen next -> policy confirm -> pi -> skills skip -> workspace continue
  ["\x1b[B", "\x1b[B", "\r", "\x1b[B", "\r", "\r", "\x1b[B", "\r", "\r"].forEach((key) => overlay.handleInput(key));
}

async function waitFor(predicate: () => boolean, timeoutMs = 1_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("condition timed out");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

test("wizard starts at the listen step and keeps the canonical Gateway flow", () => {
  const { overlay } = makeWizard();
  const text = renderText(overlay);
  assert.match(text, /Pi Maestro Gateway 配置向导/);
  assert.match(text, /1\/7 监听地址/);
  assert.match(text, /host: 127\.0\.0\.1/);
  assert.match(text, /port: 9090/);
});

test("enter opens field editing and policy follows listen directly", () => {
  const { overlay } = makeWizard();
  overlay.handleInput("\r");
  assert.match(renderText(overlay), /127\.0\.0\.1▌/);
  overlay.handleInput("1");
  overlay.handleInput("2");
  overlay.handleInput("7");
  overlay.handleInput("\r");
  assert.match(renderText(overlay), /host: 127/);
  overlay.handleInput("\x1b[B");
  overlay.handleInput("\x1b[B");
  overlay.handleInput("\r");
  assert.match(renderText(overlay), /2\/7 命令策略/);
  assert.doesNotMatch(renderText(overlay), /认证模式/);
});

test("tunnel step offers only Cloudflare Quick Tunnel through the Gateway supervisor", () => {
  const { overlay } = makeWizard();
  enterTunnelStep(overlay);
  const text = renderText(overlay);
  assert.match(text, /6\/7 公网隧道/);
  assert.match(text, /唯一模式/);
  assert.match(text, /Gateway supervisor/);
  assert.doesNotMatch(text, /命名隧道|自定义 URL/);
});

test("wizard starts the provider with Quick mode and the selected local port", async () => {
  const { overlay } = makeWizard();
  enterTunnelStep(overlay);
  overlay.handleInput("g");
  await waitFor(() => startCalls.length === 1 && overlay["tunnelStarting"] === false);
  assert.equal(startCalls[0]!.provider, "cloudflare");
  assert.deepEqual((startCalls[0]!.options as { input?: unknown }).input, { mode: "quick", localPort: 9090 });
  assert.equal(overlay["tunnelGeneration"], 3);
  assert.equal(overlay["changes"].tunnelUrl, "https://native-ready.trycloudflare.com");
  assert.match(overlay["status"], /generation 3/);
  assert.match(renderText(overlay), /native-ready\.trycloudflare\.com/);
});

test("an existing native ready generation is reused without duplicate spawn or PID-file adoption", async () => {
  state = readyState(8, "https://existing.trycloudflare.com");
  const previousPidFile = process.env.PI_MAESTRO_GATEWAY_TUNNEL_PID_FILE;
  process.env.PI_MAESTRO_GATEWAY_TUNNEL_PID_FILE = "must-not-be-read";
  try {
    const { overlay } = makeWizard();
    enterTunnelStep(overlay);
    overlay.handleInput("\r");
    await waitFor(() => overlay["tunnelStarting"] === false && overlay["tunnelGeneration"] === 8);
    assert.equal(startCalls.length, 0);
    assert.equal(overlay["changes"].tunnelUrl, "https://existing.trycloudflare.com");
    assert.match(overlay["status"], /已在运行（generation 8）/);
  } finally {
    if (previousPidFile === undefined) delete process.env.PI_MAESTRO_GATEWAY_TUNNEL_PID_FILE;
    else process.env.PI_MAESTRO_GATEWAY_TUNNEL_PID_FILE = previousPidFile;
  }
});

test("provider stderr/exit diagnostics surface through the canonical control error", async () => {
  startError = new Error("cloudflared exited before readiness (exit=7): context deadline exceeded");
  const { overlay } = makeWizard();
  enterTunnelStep(overlay);
  overlay.handleInput("g");
  await waitFor(() => overlay["tunnelStarting"] === false && /启动失败/.test(overlay["status"]));
  assert.match(overlay["status"], /exit=7/);
  assert.match(overlay["status"], /context deadline exceeded/);
  assert.equal(overlay["changes"].tunnelUrl, undefined);
});

test("duplicate guard errors remain actionable in the wizard", async () => {
  startError = Object.assign(new Error("Found 2 existing Cloudflare Quick Tunnel process(es) for 127.0.0.1:9090"), { code: "tunnel_duplicate" });
  const { overlay } = makeWizard();
  enterTunnelStep(overlay);
  overlay.handleInput("g");
  await waitFor(() => overlay["tunnelStarting"] === false && /启动失败/.test(overlay["status"]));
  assert.match(overlay["status"], /Found 2 existing/);
  assert.equal(overlay["tunnelGeneration"], undefined);
});

test("explicit stop passes the ready generation fence and clears the draft URL", async () => {
  const { overlay } = makeWizard();
  enterTunnelStep(overlay);
  overlay.handleInput("g");
  await waitFor(() => overlay["tunnelGeneration"] === 3);
  overlay.handleInput("x");
  await waitFor(() => stopCalls.length === 1 && overlay["changes"].tunnelUrl === undefined);
  assert.equal(stopCalls[0]!.provider, "cloudflare");
  assert.equal(stopCalls[0]!.options.expectedGeneration, 3);
  assert.equal(overlay["changes"].tunnelUrl, undefined);
  assert.match(overlay["status"], /已停止 Cloudflare Quick Tunnel/);
});

test("next remains blocked without a ready supervisor endpoint", () => {
  const { overlay } = makeWizard();
  enterTunnelStep(overlay);
  overlay.handleInput("\x1b[B");
  overlay.handleInput("\r");
  assert.equal(overlay["step"], "tunnel");
  assert.match(renderText(overlay), /请先启动隧道获取公网 URL/);
});

test("dispose stops only a tunnel generation created by this wizard", async () => {
  const owned = makeWizard().overlay;
  enterTunnelStep(owned);
  owned.handleInput("g");
  await waitFor(() => owned["tunnelGeneration"] === 3);
  owned.dispose();
  await waitFor(() => stopCalls.length === 1);
  assert.equal(stopCalls[0]!.options.expectedGeneration, 3);

  stopCalls = [];
  state = readyState(9, "https://borrowed.trycloudflare.com");
  const borrowed = makeWizard().overlay;
  enterTunnelStep(borrowed);
  borrowed.handleInput("g");
  await waitFor(() => borrowed["tunnelGeneration"] === 9);
  borrowed.dispose();
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(stopCalls.length, 0);
});
