import assert from "node:assert/strict";
import { Duplex, PassThrough } from "node:stream";
import test from "node:test";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { runLocalCliTool, runSshCliTool } from "../src/cli-tools/local-acp.ts";
import type { SshExecChannel, SshExecClient } from "../src/remote/ssh-exec.ts";
import {
  SshHostProviderError,
  registerSshHostProvider,
} from "../src/public/v1/ssh-hosts.ts";
import type { CliToolConfig } from "../src/cli-tools/cli-tools-config.ts";

const fixturePath = fileURLToPath(new URL("./fixtures/mock-acp-server.mjs", import.meta.url));

const mockToolConfig: CliToolConfig = {
  enabled: true,
  command: "node",
  args: [fixturePath],
};

test("runLocalCliTool drives a local CLI over ACP and settles completed", async () => {
  const controller = new AbortController();
  const run = await runLocalCliTool({
    tool: "mock-acp",
    config: mockToolConfig,
    prompt: "say hi",
    cwd: path.dirname(fixturePath),
    signal: controller.signal,
    timeoutMs: 15_000,
  });
  assert.equal(run.terminalStatus, "completed");
  assert.equal(run.exitCode, 0);
  assert.equal(run.messages[0]?.role, "assistant");
  assert.match(run.messages[0]?.content ?? "", /hello from mock acp/);
  assert.equal(run.usage.inputTokens, 3);
  assert.equal(run.usage.outputTokens, 7);
});

test("a run reports the model the agent settled on, not the string it was asked for", async () => {
  const controller = new AbortController();
  const run = await runLocalCliTool({
    tool: "mock-acp",
    config: mockToolConfig,
    prompt: "say hi",
    cwd: path.dirname(fixturePath),
    signal: controller.signal,
    timeoutMs: 15_000,
    // Named, not the advertised value: resolution maps it to the catalogue
    // entry, and reporting the request back would hide which variant ran.
    acpSelections: { model: "Mock Deep" },
  });
  assert.equal(run.terminalStatus, "completed");
  assert.equal(run.selectedModel, "mock-deep[effort=high]");
  // The agent echoes what it was actually put on, so this fails if the client
  // reported a selection it never made on the wire.
  assert.match(run.messages[0]?.content ?? "", /model=mock-deep\[effort=high\]/);
});

test("a run that requested no model reports none rather than a model nobody chose", async () => {
  const controller = new AbortController();
  const run = await runLocalCliTool({
    tool: "mock-acp",
    config: mockToolConfig,
    prompt: "say hi",
    cwd: path.dirname(fixturePath),
    signal: controller.signal,
    timeoutMs: 15_000,
  });
  assert.equal(run.terminalStatus, "completed");
  assert.equal(run.selectedModel, undefined);
  assert.match(run.messages[0]?.content ?? "", /model=unset/);
});

test("every requested axis is set on one session, not just the model", async () => {
  const controller = new AbortController();
  const run = await runLocalCliTool({
    tool: "mock-acp",
    config: mockToolConfig,
    prompt: "say hi",
    cwd: path.dirname(fixturePath),
    signal: controller.signal,
    timeoutMs: 15_000,
    acpSelections: { model: "Mock Deep", mode: "plan" },
  });
  assert.equal(run.terminalStatus, "completed");
  assert.equal(run.selectedModel, "mock-deep[effort=high]");
  // The agent echoes both, so a client that dropped the second axis fails here
  // rather than settling as a run that quietly used the default mode.
  assert.match(run.messages[0]?.content ?? "", /model=mock-deep\[effort=high\] mode=plan/);
});

test("an axis the agent does not advertise fails the run rather than being skipped", async () => {
  const controller = new AbortController();
  const run = await runLocalCliTool({
    tool: "mock-acp",
    config: mockToolConfig,
    prompt: "say hi",
    cwd: path.dirname(fixturePath),
    signal: controller.signal,
    timeoutMs: 15_000,
    // This server publishes no reasoning-depth selector, as agents that bake it
    // into the model value do.
    acpSelections: { thought_level: "high" },
  });
  assert.equal(run.terminalStatus, "failed");
  assert.equal(run.selectedModel, undefined);
  const failure = run.messages[0]?.content ?? "";
  assert.match(failure, /no "thought_level" selector/);
  // Names what the agent did advertise, so the operator can see it was reached.
  assert.match(failure, /model/);
});

test("a model the agent does not advertise fails the run and lists what it does", async () => {
  const controller = new AbortController();
  const run = await runLocalCliTool({
    tool: "mock-acp",
    config: mockToolConfig,
    prompt: "say hi",
    cwd: path.dirname(fixturePath),
    signal: controller.signal,
    timeoutMs: 15_000,
    acpSelections: { model: "mock-imaginary" },
  });
  assert.equal(run.terminalStatus, "failed");
  assert.equal(run.selectedModel, undefined);
  const failure = run.messages[0]?.content ?? "";
  assert.match(failure, /does not advertise "mock-imaginary"/);
  assert.match(failure, /mock-deep\[effort=high\]/);
});

test("runLocalCliTool fails fast when the executable is missing", async () => {
  const controller = new AbortController();
  const run = await runLocalCliTool({
    tool: "mock-missing",
    config: {
      enabled: true,
      command: "definitely-not-a-real-executable-xyz",
    },
    prompt: "hi",
    cwd: process.cwd(),
    signal: controller.signal,
  });
  assert.equal(run.exitCode, 1);
  assert.equal(run.terminalStatus, "failed");
  assert.match(run.messages[0]?.content ?? "", /not launchable/);
});

// --- SSH direct-exec backend (in-process mock ssh2 client) ---

const PROTOCOL_VERSION = 1;

/** In-process ACP server speaking over a duplex channel (mirrors the fixture). */
class MockAcpChannel extends Duplex implements SshExecChannel {
  readonly stderr = new PassThrough();
  #buffer = "";
  #sessionId = "mock-ssh-session-1";
  readonly seenCommands: string[] = [];

  _write(chunk: Buffer, _enc: BufferEncoding, cb: (error?: Error | null) => void): void {
    this.#buffer += chunk.toString("utf8");
    let idx: number;
    while ((idx = this.#buffer.indexOf("\n")) !== -1) {
      const line = this.#buffer.slice(0, idx).trim();
      this.#buffer = this.#buffer.slice(idx + 1);
      if (line) this.#handleLine(line);
    }
    cb();
  }

  _read(): void {}

  #send(message: unknown): void {
    this.push(`${JSON.stringify(message)}\n`);
  }

  #handleLine(line: string): void {
    let message: { id?: unknown; method?: string; params?: Record<string, unknown> };
    try {
      message = JSON.parse(line);
    } catch {
      return;
    }
    if (message.method === "initialize") {
      this.#send({
        jsonrpc: "2.0",
        id: message.id,
        result: {
          protocolVersion: PROTOCOL_VERSION,
          clientCapabilities: {},
          agentCapabilities: { sessionCapabilities: {} },
        },
      });
      return;
    }
    if (message.method === "session/new") {
      this.#send({ jsonrpc: "2.0", id: message.id, result: { sessionId: this.#sessionId } });
      return;
    }
    if (message.method === "session/prompt") {
      const sessionId = message.params?.sessionId;
      this.#send({
        jsonrpc: "2.0",
        method: "session/update",
        params: {
          sessionId,
          update: {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: `hello from mock ssh acp (${message.params?.prompt})` },
          },
        },
      });
      this.#send({
        jsonrpc: "2.0",
        id: message.id,
        result: { stopReason: "end_turn", usage: { inputTokens: 5, outputTokens: 9, totalTokens: 14 } },
      });
      const timer = setTimeout(() => {
        this.emit("exit", 0, undefined);
        this.emit("close");
      }, 25);
      void timer;
      return;
    }
    this.#send({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: `unhandled: ${message.method}` } });
  }

  signal(_name: string): void {}
}

class MockSshClient implements SshExecClient {
  readonly channels: MockAcpChannel[] = [];
  readonly execCommands: string[] = [];
  readonly connectConfigs: unknown[] = [];
  connect(config: unknown): unknown {
    this.connectConfigs.push(config);
    setTimeout(() => this.#emit("ready"), 5);
    return this;
  }
  exec(
    command: string,
    _options: { env?: NodeJS.ProcessEnv },
    callback: (error: Error | undefined, channel: SshExecChannel) => void,
  ): unknown {
    this.execCommands.push(command);
    const channel = new MockAcpChannel();
    this.channels.push(channel);
    setTimeout(() => callback(undefined, channel), 5);
    return this;
  }
  #emit(event: string, ...args: unknown[]): void {
    for (const listener of this.#listeners.get(event) ?? []) listener(...args);
  }
  readonly #listeners = new Map<string, Array<(...args: unknown[]) => void>>();
  once(event: string | symbol, listener: (...args: unknown[]) => void): unknown {
    const key = String(event);
    const wrapped = (...args: unknown[]): void => {
      this.off(key, wrapped);
      listener(...args);
    };
    const list = this.#listeners.get(key) ?? [];
    list.push(wrapped);
    this.#listeners.set(key, list);
    return this;
  }
  off(event: string | symbol, listener: (...args: unknown[]) => void): unknown {
    const key = String(event);
    const list = this.#listeners.get(key);
    if (list) this.#listeners.set(key, list.filter((entry) => entry !== listener));
    return this;
  }
  removeAllListeners(event?: string | symbol): unknown {
    if (event) this.#listeners.delete(String(event));
    else this.#listeners.clear();
    return this;
  }
  end(): unknown {
    return this;
  }
  destroy(): unknown {
    return this;
  }
}

const sshToolConfig: CliToolConfig = {
  enabled: true,
  mode: "ssh",
  command: "node",
  args: ["mock-remote-cli"],
  cwd: "/remote/project",
  host: "devbox",
  user: "dyw",
  port: 22,
  hostKeySha256: "SHA256:abc",
  identityFile: "~/.ssh/id_ed25519",
};

test("runSshCliTool execs the remote CLI over the mock ssh channel and settles completed", async () => {
  const client = new MockSshClient();
  const controller = new AbortController();
  const run = await runSshCliTool({
    tool: "remote-cli",
    config: sshToolConfig,
    prompt: "say hi over ssh",
    cwd: process.cwd(),
    signal: controller.signal,
    timeoutMs: 15_000,
    sshOptions: {
      createClient: () => client,
      readIdentityFile: () => Buffer.from("fake-key"),
    },
  });
  assert.equal(run.terminalStatus, "completed");
  assert.equal(run.exitCode, 0);
  assert.equal(run.messages[0]?.role, "assistant");
  assert.match(run.messages[0]?.content ?? "", /hello from mock ssh acp/);
  assert.equal(run.usage.inputTokens, 5);
  assert.equal(run.usage.outputTokens, 9);
  // The remote command wraps the argv and cds into the remote cwd.
  assert.equal(client.execCommands.length, 1);
  assert.match(client.execCommands[0]!, /^cd '\/remote\/project' && exec 'node' 'mock-remote-cli'$/);
  const privateKey = (client.connectConfigs[0] as { privateKey?: Buffer }).privateKey;
  assert.equal(privateKey?.every((byte) => byte === 0), true, "identity bytes are cleared after authentication");
});

test("runSshCliTool resolves sshHostRef for every run and preserves the configured remote cwd", async () => {
  let resolutions = 0;
  const registration = registerSshHostProvider({
    async list() { return []; },
    async resolve(hostRef) {
      resolutions += 1;
      return {
        id: hostRef,
        label: "Managed host",
        host: "managed.example.test",
        user: "runner",
        port: 2222,
        shell: "bash",
        hostKeySha256: `SHA256:${"A".repeat(43)}`,
        authentication: { kind: "agent" },
      };
    },
  });
  try {
    const clients: MockSshClient[] = [];
    for (let index = 0; index < 2; index += 1) {
      const client = new MockSshClient();
      clients.push(client);
      const run = await runSshCliTool({
        tool: "remote-cli",
        config: {
          enabled: true,
          mode: "ssh",
          sshHostRef: "managed-1",
          command: "node",
          args: ["mock-remote-cli"],
          cwd: "/deployment/project",
        },
        prompt: "hi",
        cwd: process.cwd(),
        signal: new AbortController().signal,
        timeoutMs: 15_000,
        sshOptions: { createClient: () => client, agentSocket: "/tmp/mock-agent.sock" },
      });
      assert.equal(run.terminalStatus, "completed");
      assert.equal(client.execCommands[0], "cd '/deployment/project' && exec 'node' 'mock-remote-cli'");
      assert.equal((client.connectConfigs[0] as { host?: unknown }).host, "managed.example.test");
      assert.equal((client.connectConfigs[0] as { agent?: unknown }).agent, "/tmp/mock-agent.sock");
    }
    assert.equal(resolutions, 2);
  } finally {
    registration.dispose();
  }
});

test("runSshCliTool fails closed for locked missing and incompatible manager references", async () => {
  const cases = [
    ["manager-locked", "SSH manager is locked"],
    ["host-not-found", "SSH host reference was not found"],
    ["host-incompatible", "SSH host reference is incompatible"],
  ] as const;
  for (const [code, message] of cases) {
    const registration = registerSshHostProvider({
      async list() { return []; },
      async resolve() { throw new SshHostProviderError(code, message); },
    });
    let connections = 0;
    try {
      const run = await runSshCliTool({
        tool: "remote-cli",
        config: { enabled: true, mode: "ssh", sshHostRef: "managed-1", command: "node" },
        prompt: "hi",
        cwd: process.cwd(),
        signal: new AbortController().signal,
        sshOptions: {
          createClient: () => {
            connections += 1;
            return new MockSshClient();
          },
        },
      });
      assert.equal(run.terminalStatus, "failed");
      assert.match(run.messages[0]?.content ?? "", new RegExp(message));
      assert.doesNotMatch(run.messages[0]?.content ?? "", /password|passphrase|private-key-value/u);
      assert.equal(connections, 0);
    } finally {
      registration.dispose();
    }
  }
});

test("runSshCliTool rejects an incomplete ssh config without connecting", async () => {
  const controller = new AbortController();
  const run = await runSshCliTool({
    tool: "remote-cli",
    config: { enabled: true, mode: "ssh", host: "devbox" },
    prompt: "hi",
    cwd: process.cwd(),
    signal: controller.signal,
  });
  assert.equal(run.exitCode, 1);
  assert.equal(run.terminalStatus, "failed");
  assert.match(run.messages[0]?.content ?? "", /sshHostRef or host, user and hostKeySha256/);
});

test("runLocalCliTool honours a configured ACP startup timeout", async () => {
  // A launch command that fetches before it answers — `npx` on a cold cache is
  // the real instance — outlasts the driver's 15s default and fails as an
  // undiagnosable startup timeout. This pins that the operator's value reaches
  // the driver: a CLI that never answers `initialize` must fail at the
  // configured bound, not at the default one.
  const controller = new AbortController();
  const run = await runLocalCliTool({
    tool: "mock-silent",
    config: { enabled: true, command: "node", args: ["-e", "setTimeout(() => {}, 60_000);"] },
    prompt: "say hi",
    cwd: path.dirname(fixturePath),
    signal: controller.signal,
    startupTimeoutMs: 300,
  });
  assert.equal(run.terminalStatus, "failed");
  assert.match(run.messages[0]?.content ?? "", /timed out after 300ms/);
});
