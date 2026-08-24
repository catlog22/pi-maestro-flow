import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import type { AgentConfig } from "../src/agents/agents.ts";
import {
  MANAGED_WINDOW_ENV,
  MONITOR_SESSION_ENV_VAR,
  isManagedWorkerWindow,
  isMonitorSession,
  registerTeammateChildExtension,
} from "../src/public/v1/child-extensions.ts";
import {
  buildInheritedExtensionArgs,
  buildManagedWindowPiArgs,
  buildPiArgs,
  getInteractiveTerminalLaunchSpec,
  managedWindowSpawnEnv,
} from "../src/runs/execution-infra.ts";

const baseAgentConfig = { tools: ["read"] } as unknown as AgentConfig;

function extensionPathsOf(args: readonly string[]): string[] {
  return args.flatMap((arg, index) => arg === "--extension" ? [args[index + 1].replaceAll("\\", "/")] : []);
}

test("the public child-extension contract exposes stable managed-window identity", () => {
  const previous = process.env[MANAGED_WINDOW_ENV];
  try {
    delete process.env[MANAGED_WINDOW_ENV];
    assert.equal(isManagedWorkerWindow(), false);
    process.env[MANAGED_WINDOW_ENV] = "1";
    assert.equal(isManagedWorkerWindow(), true);
    process.env[MANAGED_WINDOW_ENV] = "true";
    assert.equal(isManagedWorkerWindow(), false);
  } finally {
    if (previous === undefined) delete process.env[MANAGED_WINDOW_ENV];
    else process.env[MANAGED_WINDOW_ENV] = previous;
  }
});

test("the public child-extension contract exposes exact Monitor session identity", () => {
  const previousChild = process.env.PI_TEAMMATE_CHILD;
  const previousMonitor = process.env[MONITOR_SESSION_ENV_VAR];
  try {
    delete process.env.PI_TEAMMATE_CHILD;
    delete process.env[MONITOR_SESSION_ENV_VAR];
    assert.equal(isMonitorSession(), false);
    process.env[MONITOR_SESSION_ENV_VAR] = "1";
    assert.equal(isMonitorSession(), false);
    process.env.PI_TEAMMATE_CHILD = "1";
    assert.equal(isMonitorSession(), true);
    process.env[MONITOR_SESSION_ENV_VAR] = "true";
    assert.equal(isMonitorSession(), false);
  } finally {
    if (previousChild === undefined) delete process.env.PI_TEAMMATE_CHILD;
    else process.env.PI_TEAMMATE_CHILD = previousChild;
    if (previousMonitor === undefined) delete process.env[MONITOR_SESSION_ENV_VAR];
    else process.env[MONITOR_SESSION_ENV_VAR] = previousMonitor;
  }
});

test("managed windows explicitly load the primary and inherited extensions", () => {
  const inheritedPath = "/tmp/fake-flow-ext.ts";
  const dispose = registerTeammateChildExtension(inheritedPath, { tools: ["ask-user-question"] });
  try {
    for (const presentation of ["headless", "interactive"] as const) {
      const args = buildManagedWindowPiArgs({ objective: "ship it", sessionName: `mw-${presentation}`, presentation });
      assert.equal(args[0], "--no-extensions");
      const paths = extensionPathsOf(args);
      assert.ok(paths[0].endsWith("packages/pi-maestro-teammate/src/extension/index.ts"));
      assert.equal(paths.filter((path) => path === inheritedPath).length, 1);
    }

    const managedPaths = extensionPathsOf(
      buildManagedWindowPiArgs({ objective: "o", sessionName: "mw-x", presentation: "headless" }),
    );
    const rpcChildPaths = extensionPathsOf(
      buildPiArgs(baseAgentConfig, { agent: "general" }, "prompt.md"),
    );
    assert.deepEqual(managedPaths, rpcChildPaths);

    const inherited = buildInheritedExtensionArgs("/tmp/primary-ext.ts");
    assert.deepEqual(inherited.slice(0, 2), ["--extension", "/tmp/primary-ext.ts"]);
    assert.equal(extensionPathsOf(inherited).filter((path) => path === inheritedPath).length, 1);
  } finally {
    dispose();
  }
});

test("managed-window argv preserves presentation and fork semantics", () => {
  const headless = buildManagedWindowPiArgs({
    objective: "ship it",
    sessionName: "mw-headless",
    presentation: "headless",
    forkSessionFile: "/tmp/prior-session.jsonl",
  });
  assert.deepEqual(headless.slice(-6), ["--fork", "/tmp/prior-session.jsonl", "-p", "ship it", "--name", "mw-headless"]);

  const interactive = buildManagedWindowPiArgs({
    objective: "ship it",
    sessionName: "mw-interactive",
    presentation: "interactive",
  });
  assert.deepEqual(interactive.slice(-3), ["--name", "mw-interactive", "ship it"]);
});

test("managed-window spawn environment preserves isolation and runtime values", async () => {
  const source = {
    HOME: "/sandbox/home",
    USERPROFILE: "C:/sandbox/home",
    PI_CODING_AGENT_DIR: "/sandbox/pi-agent",
    MAESTRO_HOME: "/sandbox/maestro",
    TMPDIR: "/sandbox/tmp",
    PATH: "/sandbox/bin",
    RUNTIME_PROBE: "preserved",
  };
  const env = managedWindowSpawnEnv(source);
  assert.deepEqual(env, { ...source, [MANAGED_WINDOW_ENV]: "1" });
  assert.notEqual(env, source);

  const sourceText = await readFile(new URL("../src/extension/index.ts", import.meta.url), "utf8");
  assert.match(sourceText, /const env = managedWindowSpawnEnv\(\);/);
  assert.match(sourceText, /getInteractiveTerminalLaunchSpec\(piCommand, cwd, \{ title: `Pi worker .*?\$\{name\}`, env \}\)/);
  assert.match(sourceText, /const child = crossSpawn\(launch\.command, launch\.args, \{\r?\n {6}cwd: launch\.cwd,\r?\n {6}env,/);
});

test("Terminal.app quotes allowed hostile values and excludes arbitrary environment entries", () => {
  const secret = "secret-value-that-must-not-reach-applescript";
  const hostile = "$(touch /tmp/pwn); 'quoted' & echo bad";
  const env = managedWindowSpawnEnv({
    HOME: "/sandbox/home",
    USERPROFILE: "C:/sandbox/home",
    PI_CODING_AGENT_DIR: hostile,
    MAESTRO_HOME: "/sandbox/maestro",
    XDG_CONFIG_HOME: "/sandbox/xdg/config",
    XDG_CACHE_HOME: "/sandbox/xdg/cache",
    XDG_DATA_HOME: "/sandbox/xdg/data",
    XDG_STATE_HOME: "/sandbox/xdg/state",
    TMPDIR: "/sandbox/tmpdir",
    TMP: "/sandbox/tmp",
    TEMP: "/sandbox/temp",
    npm_config_cache: "/sandbox/npm-cache",
    PATH: "/sandbox/bin",
    SHELL: "/bin/zsh",
    LANG: "en_US.UTF-8",
    LC_ALL: "en_US.UTF-8",
    NODE_OPTIONS: "--enable-source-maps",
    NODE_PATH: "/sandbox/node_modules",
    SERVICE_API_KEY: secret,
    HOSTILE_VALUE: secret,
  });
  const piCommand = { command: "/usr/bin/pi", args: ["-p", "quote ' and & stay data"] };

  const windows = getInteractiveTerminalLaunchSpec(piCommand, "C:/work tree", {
    platform: "win32",
    env,
  });
  assert.equal(windows.command, "wt.exe");
  assert.deepEqual(windows.args.slice(-2), [piCommand.command, ...piCommand.args].slice(-2));

  const linux = getInteractiveTerminalLaunchSpec(piCommand, "/tmp/work tree", {
    platform: "linux",
    terminalCommand: "konsole",
    env,
  });
  assert.deepEqual(linux.args, ["-e", piCommand.command, ...piCommand.args]);

  const mac = getInteractiveTerminalLaunchSpec(piCommand, "/tmp/work tree", {
    platform: "darwin",
    env,
  });
  const appleScript = mac.args.at(-1) ?? "";
  assert.equal(mac.command, "/usr/bin/osascript");
  assert.match(appleScript, /exec '\/usr\/bin\/env'/);
  assert.match(appleScript, /'PI_TEAMMATE_MANAGED_WINDOW=1'/);
  for (const assignment of [
    "HOME=/sandbox/home",
    "USERPROFILE=C:/sandbox/home",
    "MAESTRO_HOME=/sandbox/maestro",
    "XDG_CONFIG_HOME=/sandbox/xdg/config",
    "XDG_CACHE_HOME=/sandbox/xdg/cache",
    "XDG_DATA_HOME=/sandbox/xdg/data",
    "XDG_STATE_HOME=/sandbox/xdg/state",
    "TMPDIR=/sandbox/tmpdir",
    "TMP=/sandbox/tmp",
    "TEMP=/sandbox/temp",
    "npm_config_cache=/sandbox/npm-cache",
    "PATH=/sandbox/bin",
    "SHELL=/bin/zsh",
    "LANG=en_US.UTF-8",
    "LC_ALL=en_US.UTF-8",
    "NODE_OPTIONS=--enable-source-maps",
    "NODE_PATH=/sandbox/node_modules",
  ]) {
    assert.ok(appleScript.includes(`'${assignment}'`), assignment);
  }
  assert.match(appleScript, /'PI_CODING_AGENT_DIR=.*quoted.*echo bad'/);
  assert.doesNotMatch(appleScript, /'PI_CODING_AGENT_DIR=\$\(touch \/tmp\/pwn\); 'quoted' & echo bad'/);
  assert.doesNotMatch(appleScript, /SERVICE_API_KEY|HOSTILE_VALUE/);
  assert.doesNotMatch(appleScript, new RegExp(secret));
});

test("environment validation diagnostics never expose secret values", () => {
  const secret = "secret-value-that-must-not-leak";
  assert.throws(
    () => managedWindowSpawnEnv({ SERVICE_API_KEY: `${secret}\0tail` }),
    (error: Error) => {
      assert.match(error.message, /SERVICE_API_KEY/);
      assert.doesNotMatch(error.message, new RegExp(secret));
      return true;
    },
  );
  assert.throws(
    () => getInteractiveTerminalLaunchSpec(
      { command: "/usr/bin/pi", args: [] },
      "/tmp",
      { platform: "darwin", env: { PI_CODING_AGENT_DIR: `${secret}\0tail` } },
    ),
    (error: Error) => {
      assert.match(error.message, /PI_CODING_AGENT_DIR/);
      assert.doesNotMatch(error.message, new RegExp(secret));
      return true;
    },
  );
});
