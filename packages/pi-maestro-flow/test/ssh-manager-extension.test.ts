import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ExtensionAPI, ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Value } from "typebox/value";
import { EncryptedSshStore } from "../src/ssh-manager/encrypted-store.ts";
import {
  activateSshHost,
  getSshHostProvider,
  listSshHostPickerEntries,
  listSshHostRefs,
  resolveSshHostRef,
  SshHostProviderError,
} from "pi-maestro-teammate/v1/ssh-hosts";
import {
  findDefaultSshIdentityPath,
  identityPassphraseAfterEdit,
  normalizeSshHostKeyFingerprint,
  registerSshManager,
  sshAuthenticationChoices,
  testAndTrustSshHost,
} from "../src/ssh-manager/extension.ts";
import type { SshExecutionResult, SshExecutor } from "../src/ssh-manager/executor.ts";
import type { SshGatewayClientPool, SshGatewayInput } from "../src/ssh-manager/gateway-client.ts";
import type { SshHost } from "../src/ssh-manager/model.ts";

const PIN = `SHA256:${"A".repeat(43)}`;
const host: SshHost = {
  id: "server-1",
  label: "Production",
  host: "prod.example.test",
  user: "deploy",
  port: 22,
  shell: "bash",
  hostKey: PIN,
  auth: { kind: "password", password: "encrypted-secret" },
};

test("identity passphrase edits distinguish keep, replace, and remove", () => {
  assert.equal(identityPassphraseAfterEdit("existing-secret", "keep"), "existing-secret");
  assert.equal(identityPassphraseAfterEdit("existing-secret", "replace", "new-secret"), "new-secret");
  assert.equal(identityPassphraseAfterEdit("existing-secret", "remove"), undefined);
  assert.throws(
    () => identityPassphraseAfterEdit("existing-secret", "replace", ""),
    /cannot be empty/,
  );
});

test("SSH host key input accepts one direct or ssh-keygen SHA256 fingerprint without guessing", () => {
  const otherPin = `SHA256:${"B".repeat(43)}`;
  assert.equal(normalizeSshHostKeyFingerprint(`  ${PIN}  `), PIN);
  assert.equal(normalizeSshHostKeyFingerprint(`256 ${PIN} server.example.test (ED25519)`), PIN);
  const ambiguous = `256 ${PIN} first (ED25519)\n256 ${otherPin} second (RSA)`;
  assert.equal(normalizeSshHostKeyFingerprint(ambiguous), ambiguous);
});

test("SSH authentication choices lead with user intent and expose agent mode only when relevant", () => {
  const withoutAgent = sshAuthenticationChoices(undefined, "");
  assert.deepEqual(withoutAgent.map((choice) => choice.kind), ["identity", "password"]);
  assert.match(withoutAgent[0]!.label, /ssh user@host already works/);

  const withAgent = sshAuthenticationChoices(undefined, "/agent/socket");
  assert.deepEqual(withAgent.map((choice) => choice.kind), ["agent", "identity", "password"]);
  assert.equal(withAgent[0]!.available, true);
  assert.match(withAgent[0]!.label, /SSH_AUTH_SOCK.*advanced/);

  const existingAgent = sshAuthenticationChoices("agent", "");
  assert.deepEqual(existingAgent.map((choice) => choice.kind), ["agent", "identity", "password"]);
  assert.equal(existingAgent[0]!.available, false);
  assert.match(existingAgent[0]!.label, /currently unavailable/);
  assert.equal(sshAuthenticationChoices("password", "")[0]!.kind, "password");
});

test("SSH identity suggestion prefers modern conventional regular key files", async () => {
  const root = await mkdtemp(join(tmpdir(), "ssh-manager-identity-suggestion-"));
  const sshDirectory = join(root, ".ssh");
  await mkdir(sshDirectory);
  try {
    const rsa = join(sshDirectory, "id_rsa");
    await writeFile(rsa, "test key");
    assert.equal(await findDefaultSshIdentityPath(root), rsa);

    const ed25519 = join(sshDirectory, "id_ed25519");
    await writeFile(ed25519, "test key");
    assert.equal(await findDefaultSshIdentityPath(root), ed25519);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("SSH manager retries recoverable setup and host errors while preserving the draft", async () => {
  const root = await mkdtemp(join(tmpdir(), "ssh-manager-wizard-"));
  const store = new EncryptedSshStore({ path: join(root, "ssh.enc.json") });
  const commands = new Map<string, { handler(args: string, ctx: ExtensionContext): Promise<void> }>();
  const shutdownHandlers: Array<(event: unknown, ctx: ExtensionContext) => unknown> = [];
  const notifications: string[] = [];
  const customResults: unknown[] = [
    "short",
    "first-master-password",
    "mismatch",
    "second-master-password",
    "second-master-password",
    { kind: "add", query: "" },
    `256 ${PIN} prod.example.test (ED25519)`,
    "server-password",
    "",
    "",
    { kind: "close", query: "" },
  ];
  const inputSteps = [
    { title: "SSH server label", current: "", answer: "Production" },
    { title: "SSH hostname or IP", current: "", answer: "prod.example.test" },
    { title: "SSH username", current: "", answer: "deploy" },
    { title: "SSH port", current: "22", answer: "not-a-port" },
    { title: "Tags (comma separated)", current: "", answer: "prod, linux" },
    { title: "SSH server label", current: "Production", answer: "Production" },
    { title: "SSH hostname or IP", current: "prod.example.test", answer: "prod.example.test" },
    { title: "SSH username", current: "deploy", answer: "deploy" },
    { title: "SSH port", current: "not-a-port", answer: "22" },
    { title: "Tags (comma separated)", current: "prod, linux", answer: "prod, linux" },
  ];
  let inputIndex = 0;
  const api = {
    registerTool() {},
    registerCommand(name: string, command: unknown) {
      commands.set(name, command as { handler(args: string, ctx: ExtensionContext): Promise<void> });
    },
    on(name: string, handler: (event: unknown, ctx: ExtensionContext) => unknown) {
      if (name === "session_shutdown") shutdownHandlers.push(handler);
    },
  } as unknown as ExtensionAPI;
  const ctx = {
    cwd: root,
    ui: {
      async custom() {
        assert.ok(customResults.length > 0, "unexpected custom overlay");
        return customResults.shift();
      },
      async input(title: string, current: string) {
        const step = inputSteps[inputIndex++];
        assert.ok(step, `unexpected input: ${title}`);
        assert.equal(title, step.title);
        assert.equal(current, step.current);
        return step.answer;
      },
      async select(title: string, choices: string[]) {
        assert.match(title, /Remote shell|Authentication|Jump host|Monitoring/);
        return title.startsWith("Authentication")
          ? choices.find((choice) => choice.toLowerCase().includes("password"))
          : choices[0];
      },
      notify(message: string) { notifications.push(message); },
      setStatus() {},
    },
  } as unknown as ExtensionContext;

  try {
    registerSshManager(api, { store });
    await commands.get("ssh")!.handler("", ctx);
    assert.equal(inputIndex, inputSteps.length);
    assert.equal(customResults.length, 0);
    assert.match(notifications.join("\n"), /at least 8 characters/);
    assert.match(notifications.join("\n"), /do not match/);
    assert.match(notifications.join("\n"), /Previous values were kept/);
    assert.deepEqual(store.getHosts().map(({ label, host, user, port, hostKey, auth }) => ({
      label,
      host,
      user,
      port,
      hostKey,
      auth,
    })), [{
      label: "Production",
      host: "prod.example.test",
      user: "deploy",
      port: 22,
      hostKey: PIN,
      auth: { kind: "password", password: "server-password" },
    }]);
  } finally {
    for (const shutdown of shutdownHandlers) await shutdown({}, ctx);
    store.lock();
    await rm(root, { recursive: true, force: true });
  }
});

test("Test-only TOFU saves an observed pin after confirmation and revalidates the snapshot", async () => {
  const root = await mkdtemp(join(tmpdir(), "ssh-manager-tofu-"));
  const store = new EncryptedSshStore({ path: join(root, "ssh.enc.json") });
  const untrusted: SshHost = { ...host, hostKey: null, tags: ["prod"], jumpHostId: null, monitorEnabled: false };
  await store.create("master-password", [untrusted]);
  const confirmations: string[] = [];
  const ctx = { ui: { async confirm(title: string) { confirmations.push(title); return true; } } } as unknown as ExtensionContext;
  const executor = {
    async testConnection(hostId: unknown) {
      assert.equal(hostId, untrusted.id, "TOFU resolves through the revisioned store, not a caller-provided host object");
      return { fingerprint: PIN, effectiveDigest: store.getEffectiveHostDigest(untrusted.id) };
    },
  } as unknown as SshExecutor;
  try {
    const notice = await testAndTrustSshHost(ctx, store, executor, untrusted);
    assert.match(notice, /trust saved/);
    assert.deepEqual(confirmations, ["Trust Production?"]);
    assert.equal(store.getHosts()[0]!.hostKey, PIN);
    assert.equal(store.getHosts()[0]!.monitorEnabled, false);
  } finally {
    store.lock();
    await rm(root, { recursive: true, force: true });
  }
});

test("TOFU revalidates after confirmation before writing trust", async () => {
  for (const race of ["different-change", "same-pin"] as const) {
    const root = await mkdtemp(join(tmpdir(), `ssh-manager-tofu-${race}-`));
    const store = new EncryptedSshStore({ path: join(root, "ssh.enc.json") });
    const untrusted: SshHost = { ...host, hostKey: null, tags: ["prod"], jumpHostId: null, monitorEnabled: false };
    await store.create("master-password", [untrusted]);
    const ctx = {
      ui: {
        async confirm() {
          await store.updateHost(untrusted.id, race === "same-pin"
            ? { ...untrusted, hostKey: PIN }
            : { ...untrusted, label: "Changed while confirming" });
          return true;
        },
      },
    } as unknown as ExtensionContext;
    const executor = {
      async testConnection() {
        return { fingerprint: PIN, effectiveDigest: store.getEffectiveHostDigest(untrusted.id) };
      },
    } as unknown as SshExecutor;
    try {
      if (race === "same-pin") {
        assert.match(await testAndTrustSshHost(ctx, store, executor, untrusted), /saved concurrently/);
        assert.equal(store.getHosts()[0]!.hostKey, PIN);
      } else {
        await assert.rejects(
          testAndTrustSshHost(ctx, store, executor, untrusted),
          /changed while trust confirmation was open/,
        );
        assert.equal(store.getHosts()[0]!.hostKey, null, "a concurrent host edit is never overwritten by trust confirmation");
      }
    } finally {
      store.lock();
      await rm(root, { recursive: true, force: true });
    }
  }
});

test("independent SSH extension binds #ssh selection to a hostless tool without Monitor", async () => {
  const root = await mkdtemp(join(tmpdir(), "ssh-manager-extension-"));
  const store = new EncryptedSshStore({ path: join(root, "ssh.enc.json") });
  const displayHost = { ...host, host: "192.0.2.10" };
  await store.create("master-password", [displayHost]);
  const tools = new Map<string, ToolDefinition>();
  const commands = new Map<string, unknown>();
  const handlers = new Map<string, Array<(event: any, ctx: ExtensionContext) => any>>();
  const statuses = new Map<string, string | undefined>();
  let selectorChoices: string[] = [];
  const executed: Array<{ host: SshHost; request: unknown }> = [];
  const executor = {
    async execute(selectedHost: SshHost, request: unknown): Promise<SshExecutionResult> {
      executed.push({ host: selectedHost, request });
      return { stdout: "ok", stderr: "", exitCode: 0, signal: null, durationMs: 1 };
    },
  } as unknown as SshExecutor;
  const gatewayExecutions: Array<{ hostId: string; input: SshGatewayInput }> = [];
  const invalidatedGatewayHosts: string[] = [];
  let gatewayCloseCount = 0;
  const gatewayPool = {
    async execute(selectedHost: SshHost, _digest: string, input: SshGatewayInput) {
      gatewayExecutions.push({ hostId: selectedHost.id, input });
      return {
        action: input.action,
        data: { connected: true, tools: ["host"] },
        text: JSON.stringify({ connected: true, tools: ["host"] }),
        summary: "gateway connected · 1 tools",
        durationMs: 2,
      };
    },
    async invalidateHost(hostId: string) { invalidatedGatewayHosts.push(hostId); },
    async close() { gatewayCloseCount += 1; },
  } as unknown as SshGatewayClientPool;
  const syncAudit: unknown[] = [];
  let syncSawSentinel = false;
  let failSync = false;
  const syncSentinel = "FAKE_SYNC_SECRET_SENTINEL";
  const configSource = {
    async read(category: "models" | "auth" | "teammate") {
      return Buffer.from(JSON.stringify(category === "models"
        ? { providers: { fake: { apiKey: syncSentinel, models: [] } } }
        : category === "auth"
          ? { fake: syncSentinel }
          : { version: 3, defaultProfile: "default", profiles: { default: { name: "Default", mappings: {}, thinkingLevels: {} } } }));
    },
  };
  const configSyncTransport = () => ({
    async apply(payload: Buffer) {
      syncSawSentinel = payload.includes(Buffer.from(syncSentinel));
      if (failSync) throw new Error(`unsafe ${syncSentinel}`);
      const newline = payload.indexOf(0x0a);
      const header = JSON.parse(payload.subarray(0, newline).toString("utf8")) as { entries: Array<{ category: string; bytes: number; digest: string }> };
      return { ok: true, receipts: header.entries.map((entry) => ({ ...entry, backup: true })) };
    },
  });
  const api = {
    registerTool(tool: ToolDefinition) { tools.set(tool.name, tool); },
    registerCommand(name: string, command: unknown) { commands.set(name, command); },
    on(name: string, handler: (event: unknown, ctx: ExtensionContext) => unknown) {
      const current = handlers.get(name) ?? [];
      current.push(handler as (event: any, ctx: ExtensionContext) => any);
      handlers.set(name, current);
    },
  } as unknown as ExtensionAPI;
  const ctx = {
    cwd: root,
    ui: {
      select: async (_title: string, choices: string[]) => {
        selectorChoices = choices;
        return choices[0];
      },
      notify() {},
      setStatus(key: string, value: string | undefined) { statuses.set(key, value); },
    },
  } as unknown as ExtensionContext;

  try {
    registerSshManager(api, { store, executor, gatewayPool, configSource, configSyncTransport, configSyncAudit: { record(event) { syncAudit.push(event); } } });
    assert.ok(getSshHostProvider());
    assert.deepEqual(await listSshHostRefs(), [{
      id: "server-1",
      label: "Production",
      compatible: false,
      issue: "unsupported-password-authentication",
    }]);
    assert.deepEqual(await listSshHostPickerEntries(), [{
      id: "server-1",
      label: "Production",
      host: "192.0.2.10",
      user: "deploy",
      port: 22,
      shell: "bash",
      selected: false,
    }]);
    assert.doesNotMatch(JSON.stringify(await listSshHostPickerEntries()), /encrypted-secret|SHA256/u);
    await assert.rejects(
      activateSshHost("server-1"),
      (error: unknown) => error instanceof SshHostProviderError && error.code === "provider-unavailable",
    );
    await assert.rejects(
      resolveSshHostRef("server-1"),
      (error: unknown) => error instanceof SshHostProviderError
        && error.code === "host-incompatible"
        && !error.message.includes("encrypted-secret"),
    );
    assert.ok(commands.has("ssh"));
    const tool = tools.get("ssh")!;
    assert.ok(tool);
    assert.equal(Value.Check(tool.parameters, { command: "id", cwd: "/srv", timeout: 5 }), true);
    assert.equal(Value.Check(tool.parameters, { command: "id", targetId: "server-1" }), true);
    assert.equal(Value.Check(tool.parameters, { action: "targets" }), true);
    assert.equal(Value.Check(tool.parameters, { action: "status" }), true);
    assert.equal(Value.Check(tool.parameters, { action: "status", targetId: "server-1" }), true);
    assert.equal(Value.Check(tool.parameters, { action: "sync_pi_config", targetId: "server-1", categories: ["models", "auth"] }), true);
    assert.equal(Value.Check(tool.parameters, { action: "sync_pi_config", targetId: "server-1", categories: ["models"], path: "secret" }), false);
    assert.equal(Value.Check(tool.parameters, { command: "id", action: "status" }), false);
    assert.equal(Value.Check(tool.parameters, { action: "status", targetId: "../server-1" }), false);
    assert.equal(Value.Check(tool.parameters, { action: "status", host: "other.example.test" }), false);

    const guide = await tool.execute("ssh-guide", { action: "guide" }, new AbortController().signal);
    assert.equal(guide.isError, undefined);
    assert.match((guide.content[0] as { text: string }).text, /pi-maestro-gateway serve/);
    assert.deepEqual(gatewayExecutions, [], "the local guide does not contact SSH");

    const input = handlers.get("input")![0]!;
    const handled = await input({ source: "interactive", text: "#ssh", images: [] }, ctx);
    assert.deepEqual(handled, { action: "handled" });
    assert.equal(selectorChoices[0], "Production · deploy@192.0.2.10:22 · bash · id=server-1");
    assert.equal(statuses.get("maestro-ssh"), "SSH · Production · 192.0.2.10:22");
    assert.equal((await listSshHostPickerEntries())[0]?.selected, true);
    await input({ source: "interactive", text: "  #SSH  ", images: [] }, ctx);
    assert.equal(selectorChoices[0], "Production (current) · deploy@192.0.2.10:22 · bash · id=server-1");

    const renderTheme = {
      fg: (_name: string, text: string) => text,
      bold: (text: string) => text,
    };
    const renderCall = tool.renderCall as unknown as (
      args: { command: string; cwd?: string },
      theme: typeof renderTheme,
      context: { isPartial: boolean; args: { command: string; cwd?: string } },
    ) => { render(width: number): string[] };
    const previewArgs = { command: "uname -a\nWrite-Output done", cwd: "/srv/repo" };
    assert.deepEqual(renderCall(previewArgs, renderTheme, { isPartial: true, args: previewArgs }).render(240), [
      "  … ssh Production · deploy@192.0.2.10:22 · bash · cwd /srv/repo · uname -a Write-Output done",
    ]);
    assert.deepEqual(renderCall(previewArgs, renderTheme, { isPartial: false, args: previewArgs }).render(240), []);

    const before = handlers.get("before_agent_start")![0]!;
    const context = await before({ systemPrompt: "base" }, ctx);
    assert.match(context.systemPrompt, /id "server-1", label "Production", and shell bash/);
    assert.match(context.systemPrompt, /does not select or configure teammate routing/);
    assert.match(context.systemPrompt, /Remote Monitor calls use the returned launch receipt/);
    assert.match(context.systemPrompt, /Never use remote-worker/);
    assert.doesNotMatch(context.systemPrompt, /192\.0\.2\.10|deploy|encrypted-secret|SHA256/);

    const result = await tool.execute("ssh-call", { command: "uname -a" }, new AbortController().signal);
    assert.equal(result.isError, undefined);
    assert.equal(executed.length, 1);
    assert.equal(executed[0]!.host.id, "server-1");
    assert.deepEqual(executed[0]!.request, { command: "uname -a" });
    assert.deepEqual((result.details as { target?: unknown }).target, {
      label: "Production",
      host: "192.0.2.10",
      user: "deploy",
      port: 22,
      shell: "bash",
    });
    assert.doesNotMatch(JSON.stringify(result.details), /encrypted-secret|SHA256/);

    const synced = await tool.execute("ssh-sync", { action: "sync_pi_config", targetId: "server-1", categories: ["models", "auth"] }, new AbortController().signal);
    assert.equal(synced.isError, undefined);
    assert.equal(syncSawSentinel, true, "the fake secret crosses only the injected byte transport");
    assert.doesNotMatch(JSON.stringify(synced), new RegExp(syncSentinel));
    assert.doesNotMatch(JSON.stringify(syncAudit), new RegExp(syncSentinel));
    assert.equal((synced.details as { action?: string }).action, "sync_pi_config");
    failSync = true;
    const syncFailure = await tool.execute("ssh-sync-failure", { action: "sync_pi_config", targetId: "server-1", categories: ["auth"] }, new AbortController().signal);
    assert.equal(syncFailure.isError, true);
    assert.doesNotMatch(JSON.stringify(syncFailure), new RegExp(syncSentinel));
    failSync = false;

    const gatewayStatus = await tool.execute("ssh-gateway", { action: "status" }, new AbortController().signal);
    assert.equal(gatewayStatus.isError, undefined);
    assert.deepEqual(gatewayExecutions, [{ hostId: "server-1", input: { action: "status" } }]);
    assert.equal((gatewayStatus.details as { summary?: string }).summary, "gateway connected · 1 tools");
    const renderResult = tool.renderResult as unknown as (
      result: typeof result,
      options: { expanded: boolean; isPartial: boolean },
      theme: typeof renderTheme,
      context: { args: { command: string } },
    ) => { render(width: number): string[] };
    assert.deepEqual(renderResult(
      result,
      { expanded: false, isPartial: false },
      renderTheme,
      { args: { command: "uname -a" } },
    ).render(240), [
      "  ✓ ssh Production · deploy@192.0.2.10:22 · bash · uname -a · exit 0 · 1ms",
    ]);

    const start = handlers.get("session_start")![0]!;
    await start({}, ctx);
    assert.ok(invalidatedGatewayHosts.includes("server-1"), "session reset invalidates the selected host client");
    const rejected = await tool.execute("ssh-after-reset", { command: "id" }, new AbortController().signal);
    assert.equal(rejected.isError, true);
    assert.match((rejected.content[0] as { text: string }).text, /No SSH server is selected/);

    await activateSshHost("server-1");
    assert.equal(statuses.get("maestro-ssh"), "SSH · Production · 192.0.2.10:22");
    assert.equal((await listSshHostPickerEntries())[0]?.selected, true, "selection survives provider refresh");
    await assert.rejects(
      activateSshHost("missing-host"),
      (error: unknown) => error instanceof SshHostProviderError && error.code === "host-not-found",
    );
    assert.equal((await listSshHostPickerEntries())[0]?.selected, true, "failed activation preserves selection");

    selectorChoices = [];
    assert.deepEqual(
      await input({ source: "interactive", text: "#ssh:server-1", images: [] }, ctx),
      { action: "handled" },
    );
    assert.deepEqual(selectorChoices, [], "canonical bind-only input does not open the legacy picker");

    await input({ source: "interactive", text: "#ssh", images: [] }, ctx);
    assert.equal(statuses.get("maestro-ssh"), "SSH · Production · 192.0.2.10:22");
    await writeFile(store.path, "{}\n", "utf8");
    assert.equal(await before({ systemPrompt: "base" }, ctx), undefined);
    assert.equal(statuses.get("maestro-ssh"), undefined, "reload failure clears the visible selection status");

    const shutdown = handlers.get("session_shutdown")![0]!;
    await shutdown({}, ctx);
    assert.equal(getSshHostProvider(), undefined);
    assert.equal(gatewayCloseCount, 1);
  } finally {
    await handlers.get("session_shutdown")?.[0]?.({}, ctx);
    store.lock();
    await rm(root, { recursive: true, force: true });
  }
});

test("unlocked SSH manager exposes all provider-owned targets without requiring a default selection", async () => {
  const root = await mkdtemp(join(tmpdir(), "ssh-manager-all-targets-"));
  const store = new EncryptedSshStore({ path: join(root, "ssh.enc.json") });
  const secondHost: SshHost = {
    ...host,
    id: "server-2",
    label: "Staging",
    host: "192.0.2.20",
    user: "operator",
    shell: "powershell",
    auth: { kind: "password", password: "second-secret" },
  };
  await store.create("master-password", [{ ...host, host: "192.0.2.10" }, secondHost]);
  const tools = new Map<string, ToolDefinition>();
  const handlers = new Map<string, Array<(event: any, ctx: ExtensionContext) => any>>();
  const executions: Array<{ hostId: string; request: unknown }> = [];
  const gatewayExecutions: Array<{ hostId: string; digest: string; cacheFence: string; input: SshGatewayInput }> = [];
  const executor = {
    async execute(selectedHost: SshHost, request: unknown): Promise<SshExecutionResult> {
      executions.push({ hostId: selectedHost.id, request });
      return { stdout: "ok", stderr: "", exitCode: 0, signal: null, durationMs: 1 };
    },
  } as unknown as SshExecutor;
  const gatewayPool = {
    async execute(
      selectedHost: SshHost,
      digest: string,
      input: SshGatewayInput,
      _signal?: AbortSignal,
      _startPiContext?: unknown,
      cacheFence = digest,
    ) {
      gatewayExecutions.push({ hostId: selectedHost.id, digest, cacheFence, input });
      return {
        action: input.action,
        data: { connected: true },
        text: JSON.stringify({ connected: true }),
        summary: "gateway connected",
        durationMs: 1,
      };
    },
    async invalidateHost() {},
    async close() {},
  } as unknown as SshGatewayClientPool;
  const api = {
    registerTool(tool: ToolDefinition) { tools.set(tool.name, tool); },
    registerCommand() {},
    on(name: string, handler: (event: unknown, ctx: ExtensionContext) => unknown) {
      const current = handlers.get(name) ?? [];
      current.push(handler as (event: any, ctx: ExtensionContext) => any);
      handlers.set(name, current);
    },
  } as unknown as ExtensionAPI;
  const ctx = { ui: { setStatus() {} } } as unknown as ExtensionContext;

  try {
    registerSshManager(api, { store, executor, gatewayPool });
    const tool = tools.get("ssh")!;
    const targetsResult = await tool.execute("ssh-targets", { action: "targets" }, new AbortController().signal);
    assert.equal(targetsResult.isError, undefined);
    const targetsText = (targetsResult.content[0] as { text: string }).text;
    assert.deepEqual(JSON.parse(targetsText), {
      targets: [
        { targetId: "server-1", label: "Production", shell: "bash", selected: false },
        { targetId: "server-2", label: "Staging", shell: "powershell", selected: false },
      ],
    });
    assert.doesNotMatch(targetsText, /192\.0\.2|deploy|operator|encrypted-secret|second-secret|SHA256/u);

    const commandResult = await tool.execute(
      "ssh-explicit-command",
      { targetId: "server-2", command: "Write-Output ok" },
      new AbortController().signal,
    );
    assert.equal(commandResult.isError, undefined);
    assert.deepEqual(executions, [{ hostId: "server-2", request: { command: "Write-Output ok" } }]);

    const gatewayResult = await tool.execute(
      "ssh-explicit-gateway",
      { action: "status", targetId: "server-2" },
      new AbortController().signal,
    );
    assert.equal(gatewayResult.isError, undefined);
    assert.equal(gatewayExecutions.length, 1);
    assert.equal(gatewayExecutions[0]!.hostId, "server-2");
    assert.deepEqual(gatewayExecutions[0]!.input, { action: "status" });

    const noDefault = await tool.execute("ssh-no-default", { command: "id" }, new AbortController().signal);
    assert.equal(noDefault.isError, true);
    assert.match((noDefault.content[0] as { text: string }).text, /action=targets.*targetId/u);
    const unknown = await tool.execute(
      "ssh-unknown-target",
      { targetId: "missing-host", command: "id" },
      new AbortController().signal,
    );
    assert.equal(unknown.isError, true);
    assert.match((unknown.content[0] as { text: string }).text, /target "missing-host" is unavailable/u);
    assert.equal(executions.length, 1);

    const before = handlers.get("before_agent_start")![0]!;
    const context = await before({ systemPrompt: "base" }, ctx);
    assert.match(context.systemPrompt, /SSH manager is unlocked/u);
    assert.match(context.systemPrompt, /No default server is selected; call action=targets/u);
    assert.doesNotMatch(context.systemPrompt, /192\.0\.2|deploy|operator|encrypted-secret|second-secret|SHA256|Production|Staging/u);

    await activateSshHost("server-2");
    const writer = new EncryptedSshStore({ path: store.path });
    await writer.unlock("master-password");
    await writer.updateHost("server-2", {
      ...secondHost,
      auth: { kind: "password", password: "rotated-secret" },
    });
    writer.lock();
    const rotatedGateway = await tool.execute(
      "ssh-rotated-gateway",
      { action: "status", targetId: "server-2" },
      new AbortController().signal,
    );
    assert.equal(rotatedGateway.isError, undefined);
    assert.equal(gatewayExecutions.length, 2);
    assert.equal(gatewayExecutions[1]!.digest, gatewayExecutions[0]!.digest, "credential rotation does not corrupt the effective chain digest contract");
    assert.notEqual(gatewayExecutions[1]!.cacheFence, gatewayExecutions[0]!.cacheFence, "credential rotation changes the Gateway cache fence");
    const staleDefault = await tool.execute("ssh-stale-default", { command: "id" }, new AbortController().signal);
    assert.equal(staleDefault.isError, true);
    assert.match((staleDefault.content[0] as { text: string }).text, /selected SSH server changed/u);
    assert.equal(executions.length, 1);
  } finally {
    await handlers.get("session_shutdown")?.[0]?.({}, ctx);
    store.lock();
    await rm(root, { recursive: true, force: true });
  }
});

test("SSH lock and shutdown fence new target access before asynchronous Gateway cleanup", async () => {
  for (const mode of ["manager-lock", "session-shutdown"] as const) {
    const root = await mkdtemp(join(tmpdir(), `ssh-manager-lock-fence-${mode}-`));
    const store = new EncryptedSshStore({ path: join(root, "ssh.enc.json") });
    await store.create("master-password", [host]);
    const tools = new Map<string, ToolDefinition>();
    const commands = new Map<string, { handler(args: string, ctx: ExtensionContext): Promise<void> }>();
    const handlers = new Map<string, Array<(event: any, ctx: ExtensionContext) => any>>();
    let releaseClose!: () => void;
    let markCloseStarted!: () => void;
    const closeGate = new Promise<void>((resolve) => { releaseClose = resolve; });
    const closeStarted = new Promise<void>((resolve) => { markCloseStarted = resolve; });
    const gatewayPool = {
      async execute() { throw new Error("unexpected Gateway execution"); },
      async invalidateHost() {},
      async close() {
        markCloseStarted();
        await closeGate;
      },
    } as unknown as SshGatewayClientPool;
    const api = {
      registerTool(tool: ToolDefinition) { tools.set(tool.name, tool); },
      registerCommand(name: string, command: unknown) {
        commands.set(name, command as { handler(args: string, ctx: ExtensionContext): Promise<void> });
      },
      on(name: string, handler: (event: unknown, ctx: ExtensionContext) => unknown) {
        const current = handlers.get(name) ?? [];
        current.push(handler as (event: any, ctx: ExtensionContext) => any);
        handlers.set(name, current);
      },
    } as unknown as ExtensionAPI;
    const ctx = {
      ui: {
        async custom() { return { kind: "lock", query: "", view: "hosts" }; },
        notify() {},
        setStatus() {},
      },
    } as unknown as ExtensionContext;

    try {
      registerSshManager(api, { store, gatewayPool });
      const pending = mode === "manager-lock"
        ? commands.get("ssh")!.handler("", ctx)
        : Promise.resolve(handlers.get("session_shutdown")![0]!({}, ctx));
      await closeStarted;
      assert.equal(store.locked, true, `${mode} must lock before Gateway cleanup settles`);
      const targets = await tools.get("ssh")!.execute("ssh-during-lock", { action: "targets" }, new AbortController().signal);
      assert.equal(targets.isError, true);
      assert.match((targets.content[0] as { text: string }).text, /SSH manager is locked/u);
      releaseClose();
      await pending;
    } finally {
      releaseClose();
      await handlers.get("session_shutdown")?.[0]?.({}, ctx);
      store.lock();
      await rm(root, { recursive: true, force: true });
    }
  }
});

test("SSH manager provider refreshes compatible profiles and fails closed for unsupported hosts", async () => {
  const root = await mkdtemp(join(tmpdir(), "ssh-manager-provider-"));
  const path = join(root, "ssh.enc.json");
  const agentHost: SshHost = {
    id: "agent-host",
    label: "Agent Host",
    host: "agent.example.test",
    user: "runner",
    port: 2222,
    shell: "bash",
    hostKey: PIN,
    auth: { kind: "agent" },
    tags: [],
    jumpHostId: null,
    monitorEnabled: false,
  };
  const identityHost: SshHost = {
    ...agentHost,
    id: "identity-host",
    label: "Identity Host",
    auth: { kind: "identity", path: "/home/runner/.ssh/id_ed25519" },
  };
  const passphraseHost: SshHost = {
    ...identityHost,
    id: "passphrase-host",
    label: "Passphrase Host",
    auth: { kind: "identity", path: "/home/runner/.ssh/id_locked", passphrase: "hidden-passphrase" },
  };
  const powershellHost: SshHost = {
    ...agentHost,
    id: "powershell-host",
    label: "PowerShell Host",
    shell: "powershell",
  };
  const managedKeyHost: SshHost = {
    ...agentHost,
    id: "managed-key-host",
    label: "Managed Key Host",
    auth: { kind: "key", keyId: "managed-key" },
  };
  const jumpHost: SshHost = {
    ...agentHost,
    id: "jump-host",
    label: "Jump Host",
    jumpHostId: "agent-host",
  };
  const untrustedHost: SshHost = {
    ...agentHost,
    id: "untrusted-host",
    label: "Untrusted Host",
    hostKey: null,
  };
  const store = new EncryptedSshStore({ path });
  await store.create("master-password", [agentHost, identityHost, passphraseHost, powershellHost, host]);
  await store.addKey({
    id: "managed-key",
    label: "Managed Key",
    privateKey: "private-key-material-must-not-cross-provider",
    publicKeyFingerprint: PIN,
    createdAt: "2026-01-01T00:00:00.000Z",
  });
  await store.addHost(managedKeyHost);
  await store.addHost(jumpHost);
  await store.addHost(untrustedHost);
  const handlers = new Map<string, Array<(event: unknown, ctx: ExtensionContext) => unknown>>();
  const api = {
    registerTool() {},
    registerCommand() {},
    on(name: string, handler: (event: unknown, ctx: ExtensionContext) => unknown) {
      const current = handlers.get(name) ?? [];
      current.push(handler);
      handlers.set(name, current);
    },
  } as unknown as ExtensionAPI;

  try {
    registerSshManager(api, { store });
    const summaries = await listSshHostRefs();
    assert.deepEqual(summaries.map((entry) => [entry.id, entry.compatible, entry.issue]), [
      ["agent-host", true, undefined],
      ["identity-host", true, undefined],
      ["passphrase-host", false, "unsupported-identity-passphrase"],
      ["powershell-host", false, "unsupported-shell"],
      ["server-1", false, "unsupported-password-authentication"],
      ["managed-key-host", false, "unsupported-managed-key"],
      ["jump-host", false, "unsupported-jump-host"],
      ["untrusted-host", false, "untrusted-host"],
    ]);
    assert.doesNotMatch(JSON.stringify(summaries), /hidden-passphrase|encrypted-secret|id_locked|private-key-material/u);

    assert.deepEqual(await resolveSshHostRef("agent-host"), {
      id: "agent-host",
      label: "Agent Host",
      host: "agent.example.test",
      user: "runner",
      port: 2222,
      shell: "bash",
      hostKeySha256: PIN,
      authentication: { kind: "agent" },
    });
    assert.deepEqual((await resolveSshHostRef("identity-host")).authentication, {
      kind: "identity",
      identityFile: "/home/runner/.ssh/id_ed25519",
    });

    for (const ref of ["passphrase-host", "powershell-host", "server-1", "managed-key-host", "jump-host", "untrusted-host"]) {
      await assert.rejects(
        resolveSshHostRef(ref),
        (error: unknown) => error instanceof SshHostProviderError
          && error.code === "host-incompatible"
          && !/hidden-passphrase|encrypted-secret|private-key-material/u.test(error.message),
      );
    }

    const writer = new EncryptedSshStore({ path });
    await writer.unlock("master-password");
    await writer.save([
      { ...agentHost, label: "Agent Host Updated" },
      identityHost,
      passphraseHost,
      powershellHost,
      host,
      managedKeyHost,
      jumpHost,
      untrustedHost,
    ]);
    writer.lock();
    assert.equal((await resolveSshHostRef("agent-host")).label, "Agent Host Updated", "resolve reloads the store");

    store.lock();
    await assert.rejects(
      resolveSshHostRef("agent-host"),
      (error: unknown) => error instanceof SshHostProviderError && error.code === "manager-locked",
    );
    await assert.rejects(
      listSshHostPickerEntries(),
      (error: unknown) => error instanceof SshHostProviderError && error.code === "manager-locked",
    );

    const shutdown = handlers.get("session_shutdown")![0]!;
    await shutdown({}, {} as ExtensionContext);
    assert.equal(getSshHostProvider(), undefined);
  } finally {
    await handlers.get("session_shutdown")?.[0]?.({}, {} as ExtensionContext);
    store.lock();
    await rm(root, { recursive: true, force: true });
  }
});
