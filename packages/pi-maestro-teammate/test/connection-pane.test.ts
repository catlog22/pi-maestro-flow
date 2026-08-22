import assert from "node:assert/strict";
import test from "node:test";
import type { ModelCliRow } from "../src/models/cli-list.ts";
import type { RemoteConfigState } from "../src/remote/config.ts";
import type { TuiTranslator } from "../src/tui/locale.ts";
import {
  RemoteConfigPane,
  type RemoteConfigPaneOptions,
  type RemotePaneAction,
} from "../src/tui/remote-config-pane.ts";

const CATALOG: Record<string, string> = {
  "remote.title": "Remote targets",
  "remote.scopeGlobal": "global",
  "remote.scopeProject": "project",
  "connections.deploymentsTitle": "Deployments · v2 registry",
  "connections.hostsTitle": "Worker hosts",
  "connections.targetsTitle": "Worker targets",
  "connections.legacyNotice": "Legacy registry document · Enter to upgrade",
  "connections.addDeployment": "a add deployment",
  "connections.compactHint": "enter open · n host · N target · t test · esc close",
  "connections.scopeHint": "g/p scope",
  "connections.deploymentRow": "[D] {registration} · {model} · {harness}/{transport} · resolvable {resolvable}",
  "connections.hiddenHost": "(hidden) [H] {id}",
  "connections.hiddenTarget": "(hidden) [T] {id}",
  "connections.hostRow": "[H] {id}  {user}@{host}:{port} · SHA256:{keyPrefix}",
  "connections.targetRow": "[T] {id}  {driver} · {cwd} · host {host}",
  "remote.newHost": "n new host",
  "remote.newTarget": "N new target",
  "remote.test": "t test",
  "remote.delete": "d delete",
  "remote.filter": "/ filter",
  "remote.close": "Esc close",
  "remote.testing": "Testing {id}…",
  "remote.ok": "✓",
  "remote.fail": "✗",
  "remote.empty": "No remote hosts or targets configured.",
};

const t = ((key: string, params?: Readonly<Record<string, string | number | boolean>>) => {
  let text = CATALOG[key] ?? key;
  for (const [name, value] of Object.entries(params ?? {})) {
    text = text.split(`{${name}}`).join(String(value));
  }
  return text;
}) as TuiTranslator;

function state(): RemoteConfigState {
  return {
    global: {
      version: 2,
      hosts: {
        worker: {
          host: "worker.example.com",
          user: "ops",
          port: 22,
          hostKeySha256: `SHA256:${"A".repeat(43)}=`,
        },
      },
      targets: {
        build: {
          host: "worker",
          cwd: "/srv/build",
          driver: "acp",
          command: ["agent"],
        },
      },
    },
    project: {
      version: 2,
      hosts: {
        local: {
          host: "127.0.0.1",
          user: "dev",
          port: 2222,
          hostKeySha256: `SHA256:${"B".repeat(43)}=`,
        },
      },
      targets: {},
    },
    config: { version: 2, hosts: {}, targets: {} },
  };
}

const deploymentRows: readonly ModelCliRow[] = [
  {
    registrationId: "fast-model",
    modelId: "provider/fast",
    deploymentId: "local-acp",
    deploymentDefault: true,
    harness: "acp",
    transportKind: "stdio",
    protocol: "acp",
    modelSelection: "provider/fast",
    registered: true,
    resolvable: true,
    healthyStatic: true,
    sessionAvailable: "n/a",
  },
  {
    registrationId: "remote-model",
    modelId: "provider/remote",
    deploymentId: "remote-dsh",
    deploymentDefault: false,
    harness: "dsh",
    transportKind: "ssh",
    protocol: "rpc",
    modelSelection: "provider/remote",
    registered: true,
    resolvable: false,
    healthyStatic: false,
    sessionAvailable: "n/a",
  },
];

function makePane(overrides: Partial<RemoteConfigPaneOptions> = {}) {
  const actions: Array<RemotePaneAction | null> = [];
  const pane = new RemoteConfigPane({
    state: state(),
    deployments: {
      kind: "registry",
      rows: deploymentRows,
      defaultModel: "fast-model",
      diagnostics: [],
    },
    theme: {
      fg: (_role, text) => text,
      bold: (text) => text,
    },
    t,
    requestRender: () => {},
    close: (action) => actions.push(action),
    onTest: async () => "ok",
    ...overrides,
  });
  return { pane, actions };
}

test("renders deployment, host, and target sections in connection order", () => {
  const { pane } = makePane();
  const output = pane.render(112).join("\n");
  const deploymentTitle = output.indexOf("Deployments · v2 registry");
  const deployment = output.indexOf("[D] fast-model · provider/fast · acp/stdio · resolvable ✓");
  const hostsTitle = output.indexOf("Worker hosts");
  const host = output.indexOf("[H] worker");
  const targetsTitle = output.indexOf("Worker targets");
  const target = output.indexOf("[T] build");

  assert.ok(deploymentTitle >= 0);
  assert.ok(deploymentTitle < deployment);
  assert.ok(deployment < hostsTitle);
  assert.ok(hostsTitle < host);
  assert.ok(host < targetsTitle);
  assert.ok(targetsTitle < target);
  assert.ok(output.includes("a add deployment"));
});

test("filter matches deployment transport kind", () => {
  const { pane } = makePane();
  for (const character of "stdio") pane.handleInput(character);
  const output = pane.render(112).join("\n");

  assert.ok(output.includes("[D] fast-model"));
  assert.ok(!output.includes("[D] remote-model"));
  assert.ok(!output.includes("Worker hosts"));
  assert.ok(!output.includes("Worker targets"));
});

test("Enter edits the selected deployment and a emits add deployment", () => {
  const { pane, actions } = makePane();
  pane.render(112);
  pane.handleInput("d");
  assert.deepEqual(actions, [], "deployments do not expose delete actions");
  pane.handleInput("\r");
  pane.handleInput("a");

  assert.deepEqual(actions, [
    { kind: "connection-edit-deployment", registrationId: "fast-model" },
    { kind: "connection-add-deployment" },
  ]);
});

test("legacy notice is dim and Enter emits upgrade", () => {
  const dimmed: string[] = [];
  const { pane, actions } = makePane({
    deployments: { kind: "legacy" },
    theme: {
      fg: (role, text) => {
        if (role === "dim") dimmed.push(text);
        return text;
      },
      bold: (text) => text,
    },
  });
  const output = pane.render(112).join("\n");
  assert.ok(output.includes("Deployments · v2 registry"));
  assert.ok(output.includes("Legacy registry document · Enter to upgrade"));
  assert.ok(!output.includes("[D]"));
  assert.ok(dimmed.includes("Legacy registry document · Enter to upgrade"));

  pane.handleInput("\r");
  assert.deepEqual(actions, [{ kind: "connection-upgrade-legacy" }]);
});

test("empty state and scope switching remain available", () => {
  const emptyState: RemoteConfigState = {
    global: { version: 2, hosts: {}, targets: {} },
    project: { version: 2, hosts: {}, targets: {} },
    config: { version: 2, hosts: {}, targets: {} },
  };
  const { pane: empty } = makePane({
    state: emptyState,
    deployments: { kind: "registry", rows: [], defaultModel: "", diagnostics: [] },
  });
  assert.ok(empty.render(80).join("\n").includes("No remote hosts or targets configured."));

  const { pane } = makePane();
  pane.handleInput("p");
  const project = pane.render(112).join("\n");
  assert.ok(project.includes("[project ●]"));
  assert.ok(project.includes("[D] fast-model"));
  assert.ok(project.includes("[H] local"));
  assert.ok(!project.includes("[H] worker"));
});

test("widths below 20 preserve escape-only input", () => {
  const { pane, actions } = makePane();
  pane.render(19);
  pane.handleInput("a");
  pane.handleInput("n");
  pane.handleInput("p");
  pane.handleInput("\r");
  assert.deepEqual(actions, []);

  pane.handleInput("\x1b");
  assert.deepEqual(actions, [null]);
});

test("widths below 40 degrade to an action-first single column", () => {
  const { pane } = makePane();
  const rows = pane.render(32);
  const text = rows.join("\n");
  // No frame, scope, filter, or section chrome — just rows plus status/hint.
  assert.ok(!text.includes("╭"), "compact layout must drop the frame box");
  assert.ok(!text.includes("●"), "compact layout must drop the scope line");
  // The selectable content survives: a deployment row and the hint are present.
  assert.match(text, /\[D\]|fast-model/i);
  assert.match(text, /enter open|esc close/i);
});
