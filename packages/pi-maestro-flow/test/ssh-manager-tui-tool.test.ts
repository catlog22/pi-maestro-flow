import assert from "node:assert/strict";
import test from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { Value } from "typebox/value";
import {
  createBoundSshToolContext,
  MaskedSecretInput,
  SshExecutor,
  SshHostManagerOverlay,
  SshToolParams,
  type SshHost,
  type SshHostManagerAction,
  type SshKey,
} from "../src/ssh-manager/index.ts";

const theme = {
  fg: (_role: string, text: string) => text,
  bold: (text: string) => text,
};
const PIN = `SHA256:${"A".repeat(43)}`;

const hosts: SshHost[] = [
  {
    id: "alpha-1",
    label: "Alpha server",
    host: "alpha.example.test",
    user: "alice",
    port: 22,
    shell: "bash",
    hostKey: PIN,
    auth: { kind: "password", password: "password-list-secret" },
    tags: ["production", "linux"],
    jumpHostId: null,
    monitorEnabled: true,
  },
  {
    id: "beta-1",
    label: "Beta server",
    host: "beta.example.test",
    user: "bob",
    port: 2200,
    shell: "powershell",
    hostKey: PIN,
    auth: { kind: "identity", path: "/secret/location/id_beta", passphrase: "passphrase-list-secret" },
    tags: ["windows"],
    jumpHostId: "alpha-1",
    monitorEnabled: false,
  },
];

test("masked secret input never renders the master/auth secret and clears it after submit", () => {
  let submitted: string | undefined;
  const input = new MaskedSecretInput({
    title: "Master password",
    prompt: "Unlock encrypted SSH hosts",
    theme,
    requestRender() {},
    done(secret) { submitted = secret; },
  });
  input.handleInput("\x1b[200~master-password-secret\x1b[201~");
  const rendered = input.render(80).join("\n");
  assert.doesNotMatch(rendered, /master-password-secret/);
  assert.match(rendered, /\*+/);
  input.handleInput("\r");
  assert.equal(submitted, "master-password-secret");
  assert.doesNotMatch(input.render(80).join("\n"), /\*/);
});

test("SSH host manager lists no secrets and implements explicit slash filtering and actions", () => {
  let action: SshHostManagerAction | undefined;
  const overlay = new SshHostManagerOverlay({
    hosts,
    theme,
    requestRender() {},
    done(next) { action = next; },
  });

  const rendered = overlay.render(140).join("\n");
  assert.match(rendered, /Alpha server/);
  assert.match(rendered, /alice@alpha\.example\.test:22/);
  assert.match(rendered, /tags production,linux.*jump direct.*trusted.*monitor checking/);
  assert.match(rendered, /jump Alpha server.*monitor disabled/);
  assert.doesNotMatch(rendered, /password-list-secret|passphrase-list-secret|secret\/location|SHA256:/);
  for (let width = 1; width <= 120; width += 1) {
    for (const line of overlay.render(width)) assert.ok(visibleWidth(line) <= width, `width ${width}: ${line}`);
  }

  overlay.handleInput("/");
  overlay.handleInput("windows");
  const filtered = overlay.render(100).join("\n");
  assert.match(filtered, /Beta server/);
  assert.doesNotMatch(filtered, /Alpha server/);
  overlay.handleInput("T");
  assert.equal(action, undefined, "action keys are text while filter mode is active");
  overlay.handleInput("\x1b");
  overlay.handleInput("\x1b[B");
  overlay.handleInput("T");
  assert.equal(action?.kind, "test");
  assert.equal(action?.hostId, "beta-1");

  action = undefined;
  const emptyOverlay = new SshHostManagerOverlay({ hosts: [], theme, requestRender() {}, done(next) { action = next; } });
  const emptyRendered = emptyOverlay.render(100).join("\n");
  assert.match(emptyRendered, /no SSH servers configured/);
  assert.match(emptyRendered, /Press A to add your first SSH server/);
  emptyOverlay.handleInput("A");
  assert.equal(action?.kind, "add");

  action = undefined;
  const addOverlay = new SshHostManagerOverlay({ hosts, theme, requestRender() {}, done(next) { action = next; } });
  addOverlay.handleInput("A");
  assert.equal(action?.kind, "add");
  const lockOverlay = new SshHostManagerOverlay({ hosts, theme, requestRender() {}, done(next) { action = next; } });
  lockOverlay.handleInput("L");
  assert.equal(action?.kind, "lock");
});

test("SSH manager Keys view renders metadata only and exposes managed-key CRUD", () => {
  const keys: SshKey[] = [{
    id: "key-1", label: "Deploy key", privateKey: "private-key-secret", passphrase: "key-passphrase-secret",
    publicKeyFingerprint: PIN, createdAt: "2026-01-01T00:00:00.000Z",
  }];
  let action: SshHostManagerAction | undefined;
  const overlay = new SshHostManagerOverlay({ hosts, keys, theme, requestRender() {}, done(next) { action = next; } });
  overlay.handleInput("K");
  const rendered = overlay.render(120).join("\n");
  assert.match(rendered, /\[Keys\].*1\/1/);
  assert.match(rendered, new RegExp(`Deploy key.*${PIN.replace(/[+]/gu, "\\+")}.*2026-01-01.*18 bytes`));
  assert.doesNotMatch(rendered, /private-key-secret|key-passphrase-secret/);
  overlay.handleInput("R");
  assert.equal(action?.kind, "replace-key");
  assert.equal(action?.keyId, "key-1");
});

test("LLM SSH tool schema keeps legacy commands and Gateway actions hostless", async () => {
  assert.equal(Value.Check(SshToolParams, { command: "id", cwd: "/srv", timeout: 5 }), true);
  assert.equal(Value.Check(SshToolParams, { action: "describe", tool: "host" }), true);
  assert.equal(Value.Check(SshToolParams, { command: "id", action: "status" }), false);
  assert.equal(Value.Check(SshToolParams, { action: "status", host: "alpha.example.test" }), false);
  assert.equal(Value.Check(SshToolParams, { action: "call", tool: "host", auth: {}, password: "secret" }), false);

  const provider = { current: [...hosts], getHosts() { return this.current; } };
  const context = createBoundSshToolContext(provider, new SshExecutor(), "alpha-1");
  assert.equal(context.hostId, "alpha-1");
  assert.match(context.systemContext, /command, cwd, and timeout only/);
  assert.doesNotMatch(context.systemContext, /password-list-secret|alpha\.example\.test/);
  provider.current = [];
  await assert.rejects(context.execute({ command: "id" }), /selected SSH host is unavailable/i);
});
