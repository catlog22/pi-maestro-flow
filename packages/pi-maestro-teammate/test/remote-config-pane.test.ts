import assert from "node:assert/strict";
import test from "node:test";
import type { RemoteConfigState } from "../src/remote/config.ts";
import { REMOTE_CONFIG_VERSION } from "../src/remote/types.ts";
import type { TuiTranslator } from "../src/tui/locale.ts";
import {
  RemoteConfigPane,
  type RemotePaneAction,
  type RemoteConfigPaneOptions,
} from "../src/tui/remote-config-pane.ts";

const CATALOG: Record<string, string> = {
  "remote.title": "Remote targets",
  "remote.scopeGlobal": "global",
  "remote.scopeProject": "project",
  "connections.addDeployment": "a add deployment",
  "connections.scopeHint": "g/p scope",
  "connections.deploymentRow": "[D] {registration} · {model} · {harness}/{transport} · resolvable {resolvable}",
  "connections.hiddenHost": "(hidden) [H] {id}",
  "connections.hiddenWorkspace": "(hidden) [W] {workspace}",
  "connections.hiddenTarget": "(hidden) [T] {id}",
  "connections.hostRow": "[H] {id}  {user}@{host}:{port} · SHA256:{keyPrefix}",
  "connections.hostRefRow": "[H] {id}  /ssh reference · {sshHostRef}",
  "connections.workspaceRow": "[W] {workspace}  {cwd} · host {host} · protocol >= {protocol}",
  "connections.targetRow": "[T] {id}  {driver} · {cwd} · host {host}",
  "connections.connecting": "(connecting)",
  "connections.timedOut": "timed out after {timeout}",
  "remote.newHost": "n new host",
  "remote.newTarget": "N new target",
  "remote.newWorkspace": "w new workspace",
  "remote.test": "t test",
  "remote.delete": "d delete",
  "remote.filter": "/ filter",
  "remote.close": "Esc close",
  "remote.testing": "Testing {id}…",
  "remote.ok": "✓",
  "remote.fail": "✗",
  "remote.empty": "No remote hosts or targets configured.",
};

function makeT(): TuiTranslator {
  return ((key: string, params?: Readonly<Record<string, string | number | boolean>>) => {
    let text = CATALOG[key] ?? key;
    if (params) {
      for (const [name, value] of Object.entries(params)) {
        text = text.split(`{${name}}`).join(String(value));
      }
    }
    return text;
  }) as TuiTranslator;
}

function fixtureState(): RemoteConfigState {
  return {
    global: {
      version: REMOTE_CONFIG_VERSION,
      hosts: {
        alpha: { host: "alpha.example.com", user: "alice", port: 22, hostKeySha256: `SHA256:${"A".repeat(43)}=` },
        bravo: { host: "10.0.0.5", user: "bob", port: 2222, hostKeySha256: `SHA256:${"B".repeat(43)}=` },
      },
      targets: {
        dev: { host: "bravo", cwd: "/home/bob/dev", driver: "acp", command: ["/usr/bin/teammate-agent"] },
        prod: { host: "alpha", cwd: "/srv/app", driver: "pi-rpc", command: ["node", "server.mjs"] },
      },
      workspaces: {},
    },
    project: {
      version: REMOTE_CONFIG_VERSION,
      hosts: {
        alpha: null,
        local: { host: "127.0.0.1", user: "carol", port: 22, hostKeySha256: `SHA256:${"C".repeat(43)}=` },
      },
      targets: {
        dev: null,
        staging: { host: "local", cwd: "/srv/staging", driver: "pi-rpc", command: ["node", "staging.mjs"] },
      },
      workspaces: {
        "prod/app": null,
        "staging/app": {
          host: "local",
          cwd: "/srv/staging",
          requiredPlugin: "pi-maestro-teammate",
          minimumWindowProtocol: 2,
        },
      },
    },
    config: { version: REMOTE_CONFIG_VERSION, hosts: {}, targets: {}, workspaces: {} },
  };
}

function makePane(overrides: Partial<RemoteConfigPaneOptions> = {}) {
  const actions: Array<RemotePaneAction | null> = [];
  const fgCalls: Array<[role: string, text: string]> = [];
  const theme = {
    fg: (role: string, text: string) => {
      fgCalls.push([role, text]);
      return text;
    },
    bold: (text: string) => text,
  };
  const pane = new RemoteConfigPane({
    state: fixtureState(),
    theme,
    t: makeT(),
    requestRender: () => {},
    close: (action) => {
      actions.push(action);
    },
    onTest: async () => "ok",
    ...overrides,
  });
  return { pane, actions, fgCalls };
}

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 10));

test("renders hosts and targets of the global scope with badges and key prefixes", () => {
  const { pane } = makePane();
  const out = pane.render(100).join("\n");
  assert.ok(Array.isArray(pane.render(100)));
  assert.ok(out.includes("Remote targets"));
  assert.match(out, /\[global ●\]/);
  assert.match(out, /\[project ○\]/);
  assert.ok(out.includes("[H] alpha  alice@alpha.example.com:22 · SHA256:AAAAAAAAAAAA"));
  assert.ok(out.includes("[H] bravo  bob@10.0.0.5:2222 · SHA256:BBBBBBBBBBBB"));
  assert.ok(out.includes("[T] dev  acp · /home/bob/dev · host bravo"));
  assert.ok(out.includes("[T] prod  pi-rpc · /srv/app · host alpha"));
  assert.ok(out.includes("n new host · N new target · w new workspace · t test · d delete"));
  // Frame style follows TeammateControlCenter (box border with │ and ╭/╰─╮/╯).
  assert.ok(out.startsWith("╭"));
  assert.ok(out.includes("│"));
  assert.ok(out.trimEnd().endsWith("╯"));
});

test("referenced hosts render their stable /ssh reference without exposing connection details", () => {
  const state = fixtureState();
  state.global.hosts.managed = { sshHostRef: "manager-host" };
  const { pane } = makePane({ state });
  const out = pane.render(100).join("\n");
  assert.ok(out.includes("[H] managed  /ssh reference · manager-host"));
  assert.equal(out.includes("manager.example"), false);
});

test("g/p toggles scope and project null entries render as hidden rows", () => {
  const { pane } = makePane();
  pane.handleInput("p");
  const project = pane.render(100).join("\n");
  assert.match(project, /\[project ●\]/);
  assert.match(project, /\[global ○\]/);
  assert.ok(project.includes("(hidden) [H] alpha"));
  assert.ok(project.includes("[H] local  carol@127.0.0.1:22 · SHA256:CCCCCCCCCCCC"));
  assert.ok(project.includes("(hidden) [T] dev"));
  assert.ok(project.includes("[T] staging  pi-rpc · /srv/staging · host local"));
  assert.ok(!project.includes("[H] bravo"));
  assert.ok(!project.includes("[T] prod"));

  pane.handleInput("g");
  const global = pane.render(100).join("\n");
  assert.match(global, /\[global ●\]/);
  assert.ok(global.includes("[H] bravo"));
  assert.ok(!global.includes("(hidden) [H] alpha"));
  assert.ok(!global.includes("[T] staging"));
});

test("filtering narrows rows and typing resets the cursor", () => {
  const { pane } = makePane();
  // Move the cursor onto the last row ([T] prod), then start a filter.
  pane.handleInput("j");
  pane.handleInput("j");
  pane.handleInput("j");
  pane.handleInput("0");
  const out = pane.render(100).join("\n");
  assert.ok(out.includes("› 0"));
  assert.ok(out.includes("[H] bravo  bob@10.0.0.5:2222 · SHA256:BBBBBBBBBBBB"));
  assert.ok(!out.includes("[H] alpha"));
  assert.ok(!out.includes("[T] dev"));
  assert.ok(!out.includes("[T] prod"));
  // Typing resets the cursor to the first visible row.
  assert.ok(out.includes("▸ [H] bravo"));

  // A filter matching nothing shows the empty state.
  pane.handleInput("z");
  pane.handleInput("z");
  pane.handleInput("z");
  const empty = pane.render(100).join("\n");
  assert.ok(empty.includes("No remote hosts or targets configured."));
});

test("n/N/Enter/d/t emit the correct actions through close", async () => {
  const testCalls: string[] = [];
  const { pane, actions } = makePane({
    onTest: async (id) => {
      testCalls.push(id);
      return "reachable";
    },
  });
  pane.render(80);

  pane.handleInput("n");
  pane.handleInput("N");
  assert.deepEqual(actions[0], { kind: "remote-new-host", scope: "global" });
  assert.deepEqual(actions[1], { kind: "remote-new-target", scope: "global" });

  // Enter on the first row ([H] alpha) edits the host.
  pane.handleInput("\r");
  assert.deepEqual(actions[2], { kind: "remote-edit-host", hostId: "alpha", scope: "global" });

  // j j → [T] dev; Enter edits the target.
  pane.handleInput("j");
  pane.handleInput("j");
  pane.handleInput("\r");
  assert.deepEqual(actions[3], { kind: "remote-edit-target", targetId: "dev", scope: "global" });

  // j → [T] prod; d deletes the target.
  pane.handleInput("j");
  pane.handleInput("d");
  assert.deepEqual(actions[4], { kind: "remote-delete-target", targetId: "prod", scope: "global" });

  // k k → [H] bravo; d deletes the host.
  pane.handleInput("k");
  pane.handleInput("k");
  pane.handleInput("d");
  assert.deepEqual(actions[5], { kind: "remote-delete-host", hostId: "bravo", scope: "global" });

  // t on a target row runs the inline probe.
  pane.handleInput("j");
  pane.handleInput("t");
  await tick();
  assert.deepEqual(testCalls, ["dev"]);

  // t on a host row is ignored.
  pane.handleInput("k");
  pane.handleInput("t");
  await tick();
  assert.deepEqual(testCalls, ["dev"]);
});

test("inline test resolves to a success status", async () => {
  const { pane, fgCalls } = makePane({
    onTest: async (id) => `probe ${id} ok`,
  });
  pane.handleInput("j");
  pane.handleInput("j"); // [T] dev
  pane.handleInput("t");
  const during = pane.render(100).join("\n");
  assert.ok(during.includes("Testing dev… (connecting)"));
  await tick();
  const after = pane.render(100).join("\n");
  assert.ok(after.includes("✓ probe dev ok"));
  const tone = fgCalls.find(([role, text]) => text.includes("probe dev ok"));
  assert.equal(tone?.[0], "success");
});

test("inline test rejection shows an error status", async () => {
  const { pane, fgCalls } = makePane({
    onTest: async () => {
      throw new Error("connection refused");
    },
  });
  pane.handleInput("j");
  pane.handleInput("j"); // [T] dev
  pane.handleInput("t");
  await tick();
  const out = pane.render(100).join("\n");
  assert.ok(out.includes("✗ connection refused"));
  const tone = fgCalls.find(([role, text]) => text.includes("connection refused"));
  assert.equal(tone?.[0], "error");
});

test("concurrent t presses are ignored while a test is running", async () => {
  let calls = 0;
  let resolveProbe: ((value: string) => void) | undefined;
  const { pane } = makePane({
    onTest: (id) => {
      calls += 1;
      return new Promise<string>((resolve) => {
        resolveProbe = resolve;
      });
    },
  });
  pane.handleInput("j");
  pane.handleInput("j"); // [T] dev
  pane.handleInput("t");
  pane.handleInput("j"); // [T] prod
  pane.handleInput("t"); // ignored while testingId is set
  await tick();
  assert.equal(calls, 1);
  resolveProbe?.("done");
  await tick();
  const out = pane.render(100).join("\n");
  assert.ok(out.includes("✓ done"));
});

test("inline test times out and aborts the probe signal", async () => {
  let captured: AbortSignal | undefined;
  const { pane, fgCalls } = makePane({
    testTimeoutMs: 50,
    onTest: (_id, signal) => {
      captured = signal;
      return new Promise<string>(() => {});
    },
  });
  pane.handleInput("j");
  pane.handleInput("j"); // [T] dev
  pane.handleInput("t");
  await new Promise((resolve) => setTimeout(resolve, 150));
  assert.ok(captured, "onTest should have received a signal");
  assert.equal(captured!.aborted, true);
  const out = pane.render(100).join("\n");
  assert.ok(out.includes("✗ timed out after 50ms"));
  const tone = fgCalls.find(([role, text]) => text.includes("timed out after"));
  assert.equal(tone?.[0], "error");
});

test("Esc closes the pane", () => {
  const { pane, actions } = makePane();
  pane.render(80);
  pane.handleInput("\x1b");
  assert.deepEqual(actions, [null]);
});

test("narrow terminals only allow Esc", () => {
  const { pane, actions } = makePane();
  const narrow = pane.render(10);
  assert.ok(Array.isArray(narrow));
  pane.handleInput("n");
  pane.handleInput("g");
  pane.handleInput("\r");
  pane.handleInput("j");
  pane.handleInput("t");
  assert.deepEqual(actions, []);
  pane.handleInput("\x1b");
  assert.deepEqual(actions, [null]);
});
