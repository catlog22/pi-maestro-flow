import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ExtensionAPI, ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { EncryptedSshStore } from "../src/ssh-manager/encrypted-store.ts";
import {
  getSshHostProvider,
  listSshHostRefs,
  resolveSshHostRef,
  SshHostProviderError,
} from "pi-maestro-teammate/v1/ssh-hosts";
import {
  identityPassphraseAfterEdit,
  registerSshManager,
} from "../src/ssh-manager/extension.ts";
import type { SshExecutionResult, SshExecutor } from "../src/ssh-manager/executor.ts";
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

test("independent SSH extension binds #ssh selection to a hostless tool without Monitor", async () => {
  const root = await mkdtemp(join(tmpdir(), "ssh-manager-extension-"));
  const store = new EncryptedSshStore({ path: join(root, "ssh.enc.json") });
  await store.create("master-password", [host]);
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
    registerSshManager(api, { store, executor });
    assert.ok(getSshHostProvider());
    assert.deepEqual(await listSshHostRefs(), [{
      id: "server-1",
      label: "Production",
      compatible: false,
      issue: "unsupported-password-authentication",
    }]);
    await assert.rejects(
      resolveSshHostRef("server-1"),
      (error: unknown) => error instanceof SshHostProviderError
        && error.code === "host-incompatible"
        && !error.message.includes("encrypted-secret"),
    );
    assert.ok(commands.has("ssh"));
    const tool = tools.get("ssh")!;
    assert.ok(tool);
    const schema = tool.parameters as unknown as { properties: Record<string, unknown>; additionalProperties: boolean };
    assert.deepEqual(Object.keys(schema.properties).sort(), ["command", "cwd", "timeout"]);
    assert.equal(schema.additionalProperties, false);

    const input = handlers.get("input")![0]!;
    const handled = await input({ source: "interactive", text: "#ssh", images: [] }, ctx);
    assert.deepEqual(handled, { action: "handled" });
    assert.match(selectorChoices[0]!, /id=server-1/);
    assert.equal(statuses.get("maestro-ssh"), "SSH · Production");

    const before = handlers.get("before_agent_start")![0]!;
    const context = await before({ systemPrompt: "base" }, ctx);
    assert.match(context.systemPrompt, /independent encrypted SSH server "Production"/);
    assert.match(context.systemPrompt, /does not select or configure teammate routing/);
    assert.match(context.systemPrompt, /Never enter Monitor, use remote-worker/);
    assert.doesNotMatch(context.systemPrompt, /prod\.example|deploy|encrypted-secret|SHA256/);

    const result = await tool.execute("ssh-call", { command: "uname -a" }, new AbortController().signal);
    assert.equal(result.isError, undefined);
    assert.equal(executed.length, 1);
    assert.equal(executed[0]!.host.id, "server-1");
    assert.deepEqual(executed[0]!.request, { command: "uname -a" });

    const start = handlers.get("session_start")![0]!;
    await start({}, ctx);
    const rejected = await tool.execute("ssh-after-reset", { command: "id" }, new AbortController().signal);
    assert.equal(rejected.isError, true);
    assert.match((rejected.content[0] as { text: string }).text, /No SSH server is selected/);

    await input({ source: "interactive", text: "#ssh", images: [] }, ctx);
    assert.equal(statuses.get("maestro-ssh"), "SSH · Production");
    await writeFile(store.path, "{}\n", "utf8");
    assert.equal(await before({ systemPrompt: "base" }, ctx), undefined);
    assert.equal(statuses.get("maestro-ssh"), undefined, "reload failure clears the visible selection status");

    const shutdown = handlers.get("session_shutdown")![0]!;
    await shutdown({}, ctx);
    assert.equal(getSshHostProvider(), undefined);
  } finally {
    await handlers.get("session_shutdown")?.[0]?.({}, ctx);
    store.lock();
    await rm(root, { recursive: true, force: true });
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
  const store = new EncryptedSshStore({ path });
  await store.create("master-password", [agentHost, identityHost, passphraseHost, powershellHost, host]);
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
    ]);
    assert.doesNotMatch(JSON.stringify(summaries), /hidden-passphrase|encrypted-secret|id_locked/u);

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

    for (const ref of ["passphrase-host", "powershell-host", "server-1"]) {
      await assert.rejects(
        resolveSshHostRef(ref),
        (error: unknown) => error instanceof SshHostProviderError
          && error.code === "host-incompatible"
          && !/hidden-passphrase|encrypted-secret/u.test(error.message),
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
    ]);
    writer.lock();
    assert.equal((await resolveSshHostRef("agent-host")).label, "Agent Host Updated", "resolve reloads the store");

    store.lock();
    await assert.rejects(
      resolveSshHostRef("agent-host"),
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
