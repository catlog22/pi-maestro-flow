import assert from "node:assert/strict";
import test from "node:test";
import { McpxWizardOverlay } from "../src/tui/mcpx-wizard.ts";
import { setQuickTunnelDiscoveryForTest } from "../src/mcpx-bridge.ts";

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

let restoreDefaultDiscovery: (() => void) | undefined;
test.beforeEach(() => {
  // Keep host cloudflared processes out of shim-based UI tests. Individual
  // adoption tests install a narrower override and restore this default.
  restoreDefaultDiscovery = setQuickTunnelDiscoveryForTest(() => []);
});
test.afterEach(() => {
  restoreDefaultDiscovery?.();
  restoreDefaultDiscovery = undefined;
});

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

test("wizard adopts a discovered Quick Tunnel without relying on a PID file", async (t) => {
  const { mkdtemp, rm, readFile } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const dir = await mkdtemp(join(tmpdir(), "mcpx-adopt-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const pidPath = join(dir, "cloudflared.pid");
  const previousPidFile = process.env.MCPX_TUNNEL_PID_FILE;
  process.env.MCPX_TUNNEL_PID_FILE = pidPath;
  t.after(() => {
    if (previousPidFile === undefined) delete process.env.MCPX_TUNNEL_PID_FILE;
    else process.env.MCPX_TUNNEL_PID_FILE = previousPidFile;
  });
  const restoreDiscovery = setQuickTunnelDiscoveryForTest((port) => port === 9090
    ? [{ pid: 424242, commandLine: "cloudflared tunnel --url http://127.0.0.1:9090" }]
    : []);
  t.after(restoreDiscovery);

  const { overlay } = makeWizard();
  // Navigate to the tunnel step and start with no PID file present.
  ["\x1b[B", "\x1b[B", "\r", "\x1b[B", "\r", "\r", "\x1b[B", "\r", "\r"].forEach((key) => overlay.handleInput(key));
  overlay.handleInput("g");
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(overlay["tunnelProcess"], undefined, "an existing candidate must be adopted, not spawned");
  assert.equal(overlay["tunnelAdoptedPid"], 424242);
  assert.match(overlay["status"], /隧道已在运行（PID 424242）/);
  assert.equal(await readFile(pidPath, "utf8"), "424242");
});

test("wizard refuses to spawn when multiple matching Quick Tunnels exist", async (t) => {
  const restoreDiscovery = setQuickTunnelDiscoveryForTest((port) => port === 9090
    ? [
      { pid: 424242, commandLine: "cloudflared tunnel --url http://127.0.0.1:9090" },
      { pid: 424243, commandLine: "cloudflared tunnel --url http://127.0.0.1:9090" },
    ]
    : []);
  t.after(restoreDiscovery);

  const { overlay } = makeWizard();
  ["\x1b[B", "\x1b[B", "\r", "\x1b[B", "\r", "\r", "\x1b[B", "\r", "\r"].forEach((key) => overlay.handleInput(key));
  overlay.handleInput("g");
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(overlay["tunnelProcess"], undefined);
  assert.equal(overlay["tunnelAdoptedPid"], undefined);
  assert.match(overlay["status"], /未启动新进程/);
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
  const pidPath = join(dir, "cloudflared.pid");
  const previousPidFile = process.env.MCPX_TUNNEL_PID_FILE;
  process.env.MCPX_TUNNEL_PID_FILE = pidPath;
  t.after(async () => {
    process.env.PATH = previousPath;
    if (previousPidFile === undefined) delete process.env.MCPX_TUNNEL_PID_FILE;
    else process.env.MCPX_TUNNEL_PID_FILE = previousPidFile;
    // kill any lingering fake tunnel child (spawned detached+unref'd)
    try {
      const pid = Number(await (await import("node:fs/promises")).readFile(pidPath, "utf8").catch(() => ""));
      if (Number.isInteger(pid) && pid > 0) {
        if (isWin) (await import("node:child_process")).spawnSync("taskkill", ["/pid", String(pid), "/T", "/F"], { stdio: "ignore" });
        else process.kill(pid, "SIGKILL");
      }
    } catch { /* best-effort */ }
  });

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
  // the tunnel is live: advance straight to write (stopping it would clear the URL)
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

test("next without a tunnel URL shows the guard message and stays on the tunnel step", () => {
  const { overlay } = makeWizard();
  const s = overlay;
  ["\x1b[B", "\x1b[B", "\r", "\x1b[B", "\r", "\r", "\x1b[B", "\r", "\r"].forEach((k) => overlay.handleInput(k));
  assert.equal(s["step"], "tunnel");
  overlay.handleInput("\x1b[B"); // -> next (selected 1)
  overlay.handleInput("\r");
  assert.equal(s["step"], "tunnel", "guard must keep the step on tunnel");
  assert.match(renderText(overlay), /请先启动隧道获取公网 URL/);
});

test("stopping the tunnel clears the URL and blocks the write step", async (t) => {
  const { mkdtemp, mkdir, rm, writeFile, chmod } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const dir = await mkdtemp(join(tmpdir(), "mcpx-stop-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const binDir = join(dir, "bin");
  await mkdir(binDir);
  const isWin = process.platform === "win32";
  const shim = join(binDir, isWin ? "cloudflared.cmd" : "cloudflared");
  await writeFile(shim, isWin
    ? '@echo off\r\necho Your quick Tunnel has been created! Visit it at https://stop-me.trycloudflare.com\r\nping -n 30 127.0.0.1 >nul\r\n'
    : '#!/bin/sh\necho "Your quick Tunnel has been created! Visit it at https://stop-me.trycloudflare.com"\nsleep 30\n', "utf8");
  if (!isWin) await chmod(shim, 0o755);
  const previousPath = process.env.PATH;
  process.env.PATH = `${binDir}${isWin ? ";" : ":"}${previousPath ?? ""}`;
  const pidPath = join(dir, "cloudflared.pid");
  const previousPidFile = process.env.MCPX_TUNNEL_PID_FILE;
  process.env.MCPX_TUNNEL_PID_FILE = pidPath;
  t.after(() => {
    process.env.PATH = previousPath;
    if (previousPidFile === undefined) delete process.env.MCPX_TUNNEL_PID_FILE;
    else process.env.MCPX_TUNNEL_PID_FILE = previousPidFile;
  });

  const { overlay } = makeWizard();
  const s = overlay;
  ["\x1b[B", "\x1b[B", "\r", "\x1b[B", "\r", "\r", "\x1b[B", "\r", "\r"].forEach((k) => overlay.handleInput(k));
  overlay.handleInput("\r"); // start the tunnel
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline && s["changes"]?.tunnelUrl !== "https://stop-me.trycloudflare.com") {
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  assert.equal(s["changes"]?.tunnelUrl, "https://stop-me.trycloudflare.com");
  overlay.handleInput("x"); // stop it
  await new Promise((resolve) => setTimeout(resolve, 1500));
  assert.equal(s["changes"]?.tunnelUrl, undefined, "stopping must clear the URL");
  overlay.handleInput("\x1b[B"); // -> next
  overlay.handleInput("\r");
  assert.equal(s["step"], "tunnel", "write step must be blocked after the tunnel stopped");
  assert.match(renderText(overlay), /请先启动隧道获取公网 URL/);
});

test("pressing g again while the tunnel is ready reports it running (no duplicate spawn)", async (t) => {
  const { mkdtemp, mkdir, rm, writeFile, chmod } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const dir = await mkdtemp(join(tmpdir(), "mcpx-again-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const binDir = join(dir, "bin");
  await mkdir(binDir);
  const isWin = process.platform === "win32";
  const shim = join(binDir, isWin ? "cloudflared.cmd" : "cloudflared");
  await writeFile(shim, isWin
    ? '@echo off\r\necho Your quick Tunnel has been created! Visit it at https://again-1.trycloudflare.com\r\nping -n 30 127.0.0.1 >nul\r\n'
    : '#!/bin/sh\necho "Your quick Tunnel has been created! Visit it at https://again-1.trycloudflare.com"\nsleep 30\n', "utf8");
  if (!isWin) await chmod(shim, 0o755);
  const previousPath = process.env.PATH;
  process.env.PATH = `${binDir}${isWin ? ";" : ":"}${previousPath ?? ""}`;
  const pidPath = join(dir, "cloudflared.pid");
  const previousPidFile = process.env.MCPX_TUNNEL_PID_FILE;
  process.env.MCPX_TUNNEL_PID_FILE = pidPath;
  t.after(() => {
    process.env.PATH = previousPath;
    if (previousPidFile === undefined) delete process.env.MCPX_TUNNEL_PID_FILE;
    else process.env.MCPX_TUNNEL_PID_FILE = previousPidFile;
    try {
      const pid = Number(require("node:fs").readFileSync(pidPath, "utf8"));
      if (Number.isInteger(pid) && pid > 0) {
        if (isWin) require("node:child_process").spawnSync("taskkill", ["/pid", String(pid), "/T", "/F"], { stdio: "ignore" });
        else process.kill(pid, "SIGKILL");
      }
    } catch { /* best-effort */ }
  });

  const { overlay } = makeWizard();
  const s = overlay;
  ["\x1b[B", "\x1b[B", "\r", "\x1b[B", "\r", "\r", "\x1b[B", "\r", "\r"].forEach((k) => overlay.handleInput(k));
  overlay.handleInput("\r"); // start
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline && s["changes"]?.tunnelUrl !== "https://again-1.trycloudflare.com") {
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  const firstPid = s["tunnelProcess"]?.pid;
  assert.ok(firstPid, "tunnel process should exist");
  overlay.handleInput("g"); // again — must not spawn a second tunnel
  const statusDeadline = Date.now() + 4_000;
  while (Date.now() < statusDeadline && !/隧道运行中/.test(s["status"] ?? "")) {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.equal(s["tunnelProcess"]?.pid, firstPid, "no duplicate spawn");
  assert.match(s["status"] ?? "", /隧道运行中/);
});

test("a cloudflared child that exits before yielding a URL fails fast with exit code in status", async (t) => {
  const { mkdtemp, mkdir, rm, writeFile, chmod } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const dir = await mkdtemp(join(tmpdir(), "mcpx-die-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const binDir = join(dir, "bin");
  await mkdir(binDir);
  const isWin = process.platform === "win32";
  const shim = join(binDir, isWin ? "cloudflared.cmd" : "cloudflared");
  // Print an error line then exit non-zero — emulates a real cloudflared failure
  // (e.g. port conflict / QUIC handshake) without ever emitting a trycloudflare URL.
  await writeFile(shim, isWin
    ? '@echo off\r\necho context deadline exceeded: no edge server available\r\nexit /b 7\r\n'
    : '#!/bin/sh\necho "context deadline exceeded: no edge server available"\r\nexit 7\r\n', "utf8");
  if (!isWin) await chmod(shim, 0o755);
  const previousPath = process.env.PATH;
  process.env.PATH = `${binDir}${isWin ? ";" : ":"}${previousPath ?? ""}`;
  const pidPath = join(dir, "cloudflared.pid");
  const previousPidFile = process.env.MCPX_TUNNEL_PID_FILE;
  process.env.MCPX_TUNNEL_PID_FILE = pidPath;
  t.after(() => {
    process.env.PATH = previousPath;
    if (previousPidFile === undefined) delete process.env.MCPX_TUNNEL_PID_FILE;
    else process.env.MCPX_TUNNEL_PID_FILE = previousPidFile;
  });

  const { overlay } = makeWizard();
  const s = overlay;
  // Navigate to the tunnel step and start it.
  ["\x1b[B", "\x1b[B", "\r", "\x1b[B", "\r", "\r", "\x1b[B", "\r", "\r"].forEach((k) => overlay.handleInput(k));
  overlay.handleInput("\r"); // start
  // The child exits immediately; the wizard should fail fast — well under the old 30s.
  const failDeadline = Date.now() + 8_000;
  while (Date.now() < failDeadline && s["tunnelProcess"] !== undefined) {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.equal(s["tunnelProcess"], undefined, "dead child must clear tunnelProcess promptly");
  assert.equal(s["changes"]?.tunnelUrl, undefined, "no URL should be parsed");
  assert.ok(s["tunnelExit"], "tunnelExit must be recorded");
  // Exit code 7 surfaces (Windows shim uses exit /b 7 → code 7).
  assert.match(s["status"] ?? "", /退出代码 7/, "status must show the exit code");
  assert.match(s["status"] ?? "", /context deadline exceeded/, "status must surface cloudflared output tail");
  assert.match(s["status"] ?? "", /按 g 重试/, "status must offer the retry affordance");
});

test("a live cloudflared that never prints a URL times out with output tail in status", async (t) => {
  const { mkdtemp, mkdir, rm, writeFile, chmod } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const dir = await mkdtemp(join(tmpdir(), "mcpx-silent-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const binDir = join(dir, "bin");
  await mkdir(binDir);
  const isWin = process.platform === "win32";
  const shim = join(binDir, isWin ? "cloudflared.cmd" : "cloudflared");
  // Emit a non-URL progress line and stay alive — emulates a slow / stalled tunnel.
  await writeFile(shim, isWin
    ? '@echo off\r\necho Connection registered, waiting for edge...\r\nping -n 60 127.0.0.1 >nul\r\n'
    : '#!/bin/sh\necho "Connection registered, waiting for edge..."\r\nsleep 60\r\n', "utf8");
  if (!isWin) await chmod(shim, 0o755);
  const previousPath = process.env.PATH;
  process.env.PATH = `${binDir}${isWin ? ";" : ":"}${previousPath ?? ""}`;
  const pidPath = join(dir, "cloudflared.pid");
  const previousPidFile = process.env.MCPX_TUNNEL_PID_FILE;
  process.env.MCPX_TUNNEL_PID_FILE = pidPath;
  // Shorten the URL-wait window so this timeout case runs in ~1.5s, not the 30s default.
  const previousTimeout = process.env.MCPX_TUNNEL_URL_TIMEOUT_MS;
  process.env.MCPX_TUNNEL_URL_TIMEOUT_MS = "1500";
  t.after(async () => {
    process.env.PATH = previousPath;
    if (previousPidFile === undefined) delete process.env.MCPX_TUNNEL_PID_FILE;
    else process.env.MCPX_TUNNEL_PID_FILE = previousPidFile;
    if (previousTimeout === undefined) delete process.env.MCPX_TUNNEL_URL_TIMEOUT_MS;
    else process.env.MCPX_TUNNEL_URL_TIMEOUT_MS = previousTimeout;
    try {
      const pid = Number(require("node:fs").readFileSync(pidPath, "utf8"));
      if (Number.isInteger(pid) && pid > 0) {
        if (isWin) require("node:child_process").spawnSync("taskkill", ["/pid", String(pid), "/T", "/F"], { stdio: "ignore" });
        else process.kill(pid, "SIGKILL");
      }
    } catch { /* best-effort */ }
  });

  const { overlay } = makeWizard();
  const s = overlay;
  ["\x1b[B", "\x1b[B", "\r", "\x1b[B", "\r", "\r", "\x1b[B", "\r", "\r"].forEach((k) => overlay.handleInput(k));
  overlay.handleInput("\r"); // start
  // The shortened poll must elapse; then status shows the timeout + captured output tail.
  const timeoutDeadline = Date.now() + 8_000;
  while (Date.now() < timeoutDeadline && !/未取得 URL|尚未打印 URL/.test(s["status"] ?? "")) {
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  assert.match(s["status"] ?? "", /未取得 URL/);
  assert.match(s["status"] ?? "", /Connection registered/, "timeout status must surface the output tail");
  assert.equal(s["changes"]?.tunnelUrl, undefined);
  assert.ok(s["tunnelProcess"], "child still alive at timeout (not killed)");
  // Stop the lingering child to clean up.
  overlay.handleInput("x");
});

test("a .cmd shim delegating to an external exe still delivers the URL (not just builtins)", async (t) => {
  // Regression guard for the shim branch: real cloudflared.cmd wrappers invoke
  // the external cloudflared.exe, and shell:true+detached:true drops that exe's
  // pipe output (0 bytes). The shim branch now uses detached:false so the URL
  // banner reaches Node. The existing echo-based shims can't detect this because
  // cmd builtins' output is never lost — only external-exe grandchildren are.
  const { mkdtemp, mkdir, rm, writeFile, chmod } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const dir = await mkdtemp(join(tmpdir(), "mcpx-shim-delegate-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const binDir = join(dir, "bin");
  await mkdir(binDir);
  const isWin = process.platform === "win32";
  // A helper script the shim invokes via node (an external exe). It prints the
  // URL banner to stderr — where real cloudflared emits its INF lines — then
  // stays alive briefly so the wizard's poll can observe it.
  const helper = join(binDir, "printer.js");
  await writeFile(helper, [
    "process.stderr.write('Your quick Tunnel at https://shim-delegate.trycloudflare.com\\n');",
    "setTimeout(() => {}, 30000);",
  ].join("\n"), "utf8");
  const shim = join(binDir, isWin ? "cloudflared.cmd" : "cloudflared");
  await writeFile(shim, isWin
    ? `@echo off\r\nnode "${helper}"\r\n`
    : `#!/bin/sh\nnode "${helper}"\n`, "utf8");
  if (!isWin) await chmod(shim, 0o755);
  const previousPath = process.env.PATH;
  process.env.PATH = `${binDir}${isWin ? ";" : ":"}${previousPath ?? ""}`;
  const pidPath = join(dir, "cloudflared.pid");
  const previousPidFile = process.env.MCPX_TUNNEL_PID_FILE;
  process.env.MCPX_TUNNEL_PID_FILE = pidPath;
  t.after(async () => {
    process.env.PATH = previousPath;
    if (previousPidFile === undefined) delete process.env.MCPX_TUNNEL_PID_FILE;
    else process.env.MCPX_TUNNEL_PID_FILE = previousPidFile;
    try {
      const pid = Number(require("node:fs").readFileSync(pidPath, "utf8"));
      if (Number.isInteger(pid) && pid > 0) {
        if (isWin) require("node:child_process").spawnSync("taskkill", ["/pid", String(pid), "/T", "/F"], { stdio: "ignore" });
        else process.kill(pid, "SIGKILL");
      }
    } catch { /* best-effort */ }
  });

  const { overlay } = makeWizard();
  const s = overlay;
  ["\x1b[B", "\x1b[B", "\r", "\x1b[B", "\r", "\r", "\x1b[B", "\r", "\r"].forEach((k) => overlay.handleInput(k));
  overlay.handleInput("\r"); // start the shim-delegating tunnel
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline && s["changes"]?.tunnelUrl !== "https://shim-delegate.trycloudflare.com") {
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  // On win32 this is the production-critical path (shim wrapping an exe); on
  // posix the shim runs node directly. Either way the URL must arrive.
  assert.equal(s["changes"]?.tunnelUrl, "https://shim-delegate.trycloudflare.com",
    "external-exe output via a shim must reach Node (not lost to detached+shell)");
});
