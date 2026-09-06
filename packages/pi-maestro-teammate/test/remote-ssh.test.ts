import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import test from "node:test";
import type { ClientChannel, ConnectConfig } from "ssh2";
import {
  TEAMMATE_REMOTE_GATEWAY_COMMAND,
  SshHostProviderError,
  registerSshHostProvider,
} from "../src/public/v1/ssh-hosts.ts";
import {
  REMOTE_GATEWAY_COMMAND,
  RemoteRpcResponseError,
  SshRemoteConnectionFactory,
  SshTransportError,
  createPinnedHostKeyVerifier,
  diagnoseRemoteWindowBridgeError,
  type SshClientLike,
} from "../src/remote/ssh.ts";
import type {
  RemoteHostConfig,
  ResolvedRemoteTarget,
  ResolvedRemoteWorkspace,
} from "../src/remote/types.ts";

const PRESENTED_KEY = Buffer.from("pinned-test-host-key");
const HOST_KEY = `SHA256:${createHash("sha256").update(PRESENTED_KEY).digest("base64").replace(/=+$/, "")}`;

function target(overrides: Partial<RemoteHostConfig> = {}): ResolvedRemoteTarget {
  return {
    id: "linux-a/pi",
    host: "linux-a",
    cwd: "/srv/project",
    driver: "pi-rpc",
    command: ["pi", "--mode", "rpc"],
    hostConfig: {
      host: "linux-a.example",
      user: "dev",
      port: 22,
      hostKeySha256: HOST_KEY,
      identityFile: "/local/id_ed25519",
      ...overrides,
    },
  };
}

function workspace(): ResolvedRemoteWorkspace {
  return {
    workspaceRef: "prod/app",
    host: "linux-a",
    cwd: "/srv/project",
    requiredPlugin: "pi-maestro-teammate",
    minimumWindowProtocol: 1,
    hostConfig: target().hostConfig,
  };
}

function channel(): ClientChannel {
  const stream = new PassThrough() as PassThrough & { stderr: PassThrough; server: false };
  stream.stderr = new PassThrough();
  stream.server = false;
  stream.once("finish", () => stream.destroy());
  return stream as unknown as ClientChannel;
}

class FakeSshClient extends EventEmitter {
  readonly mode: "ready" | "connect-timeout" | "handshake-timeout";
  readonly presentedKey: Buffer;
  readonly connectConfigs: ConnectConfig[] = [];
  readonly commands: string[] = [];
  readonly channels: ClientChannel[] = [];
  endCalls = 0;

  constructor(mode: FakeSshClient["mode"] = "ready", presentedKey = PRESENTED_KEY) {
    super();
    this.mode = mode;
    this.presentedKey = presentedKey;
  }

  connect(config: ConnectConfig): this {
    this.connectConfigs.push(config);
    queueMicrotask(() => {
      if (this.mode === "connect-timeout") return;
      const verifier = config.hostVerifier as ((key: Buffer) => boolean) | undefined;
      if (!verifier?.(this.presentedKey)) {
        const error = new Error("host rejected");
        this.emit("error", error);
        return;
      }
      this.emit("connect");
      if (this.mode === "ready") queueMicrotask(() => this.emit("ready"));
    });
    return this;
  }

  exec(command: string, callback: (error: Error | undefined, stream: ClientChannel) => void): this {
    this.commands.push(command);
    const stream = channel();
    this.channels.push(stream);
    queueMicrotask(() => callback(undefined, stream));
    return this;
  }

  end(): this {
    this.endCalls += 1;
    queueMicrotask(() => this.emit("close"));
    return this;
  }

  destroy(): this {
    queueMicrotask(() => this.emit("close"));
    return this;
  }
}

function factoryFor(clients: FakeSshClient[], options: Record<string, unknown> = {}): SshRemoteConnectionFactory {
  return new SshRemoteConnectionFactory({
    createClient: () => {
      const client = clients.shift();
      if (!client) throw new Error("No fake SSH client available");
      return client as unknown as SshClientLike;
    },
    readIdentityFile: () => Buffer.from("PRIVATE KEY"),
    connectTimeoutMs: 20,
    handshakeTimeoutMs: 20,
    requestTimeoutMs: 50,
    ...options,
  });
}

test("SSH host verification accepts only the configured raw-key SHA256 fingerprint", async () => {
  const verifier = createPinnedHostKeyVerifier(HOST_KEY);
  assert.equal(verifier(PRESENTED_KEY), true);
  assert.equal(verifier(Buffer.from("replacement-host-key")), false);

  const rejected = new FakeSshClient("ready", Buffer.from("replacement-host-key"));
  const factory = factoryFor([rejected]);
  await assert.rejects(
    factory.connect(target()),
    (error: unknown) => error instanceof SshTransportError && error.code === "host-key",
  );
  assert.equal(rejected.commands.length, 0, "gateway exec must not run after host-key rejection");
  await factory.close();
});

test("SSH setup enforces separate transport and handshake deadlines", async () => {
  const keepAlive = setTimeout(() => {}, 200);
  const connectFactory = factoryFor([new FakeSshClient("connect-timeout")]);
  await assert.rejects(
    connectFactory.connect(target()),
    (error: unknown) => error instanceof SshTransportError && error.code === "connect-timeout",
  );
  await connectFactory.close();

  const handshakeFactory = factoryFor([new FakeSshClient("handshake-timeout")]);
  await assert.rejects(
    handshakeFactory.connect(target()),
    (error: unknown) => error instanceof SshTransportError && error.code === "handshake-timeout",
  );
  await handshakeFactory.close();
  clearTimeout(keepAlive);
});

test("SSH uses identity-only auth, keepalive, and the literal fixed gateway command", async () => {
  const client = new FakeSshClient();
  const factory = factoryFor([client], { keepaliveIntervalMs: 1234, keepaliveCountMax: 7 });
  const configured = target({ identityFile: "/local/configured-key" });
  configured.cwd = "/srv/project with ' quote";
  configured.command = ["pi", "$(touch /tmp/not-allowed)"];
  const connection = await factory.connect(configured);
  const config = client.connectConfigs[0];
  assert.equal(config.password, undefined);
  assert.equal(config.tryKeyboard, false);
  assert.deepEqual(config.authHandler, ["publickey"]);
  assert.equal(config.keepaliveInterval, 1234);
  assert.equal(config.keepaliveCountMax, 7);
  assert.equal(Buffer.isBuffer(config.privateKey), true);
  assert.equal((config.privateKey as Buffer).every((byte) => byte === 0), true, "identity bytes are cleared after authentication");
  assert.deepEqual(client.commands, [REMOTE_GATEWAY_COMMAND]);
  assert.equal(client.commands[0], "pi-teammate-remote connect --stdio");
  assert.equal(REMOTE_GATEWAY_COMMAND, TEAMMATE_REMOTE_GATEWAY_COMMAND);
  assert.equal(client.commands[0].includes("/srv/project"), false);
  assert.equal(client.commands[0].includes("touch"), false);
  await connection.close();
  await factory.close();
});

test("explicit workspaces reuse the pinned pool and fixed gateway without deriving a run target", async () => {
  const client = new FakeSshClient();
  const factory = factoryFor([client]);
  const connection = await factory.connectWorkspace(workspace());
  assert.deepEqual(client.commands, [REMOTE_GATEWAY_COMMAND]);
  assert.equal(client.commands[0]?.includes("/srv/project"), false);
  assert.equal(client.commands[0]?.includes("pi-rpc"), false);
  await connection.close();
  await factory.close();
});

test("late-bound fixed-purpose channels serve targets and workspaces, bypass SSH, and release once", async () => {
  const inlineClient = new FakeSshClient();
  const factory = factoryFor([inlineClient]);
  let openCalls = 0;
  let resolveCalls = 0;
  let closeCalls = 0;
  const registration = registerSshHostProvider({
    async list() { return []; },
    async resolve() { resolveCalls += 1; return profileForRemote("managed-host"); },
    async openTeammateRemoteChannel(hostRef) {
      assert.equal(hostRef, "managed-host");
      openCalls += 1;
      return { stream: channel(), close() { closeCalls += 1; }, fence: `open-${openCalls}` };
    },
  });
  const referenced = { sshHostRef: "managed-host" } as const;
  try {
    const targetConnection = await factory.connect({ ...target(), hostConfig: referenced });
    const workspaceConnection = await factory.connectWorkspace({ ...workspace(), hostConfig: referenced });
    assert.equal(openCalls, 2);
    assert.equal(resolveCalls, 0, "capable providers must bypass profile resolution");
    assert.equal(inlineClient.connectConfigs.length, 0, "capable providers must bypass internal SSH");

    await targetConnection.close();
    await targetConnection.close();
    await workspaceConnection.close();
    assert.equal(closeCalls, 2, "each provider channel must release exactly once");

    const inlineConnection = await factory.connect(target());
    assert.equal(openCalls, 2, "inline hosts must never invoke the host-ref capability");
    assert.equal(inlineClient.connectConfigs.length, 1);
    await inlineConnection.close();
  } finally {
    registration.dispose();
    await factory.close();
  }
});

test("factory shutdown closes and releases provider-backed connections", async () => {
  const factory = factoryFor([]);
  let closeCalls = 0;
  const registration = registerSshHostProvider({
    async list() { return []; },
    async resolve() { return profileForRemote("managed-host"); },
    async openTeammateRemoteChannel() {
      return { stream: channel(), close() { closeCalls += 1; } };
    },
  });
  try {
    const connection = await factory.connect({ ...target(), hostConfig: { sshHostRef: "managed-host" } });
    await factory.close();
    assert.equal(closeCalls, 1);
    assert.equal(connection.status, "disconnected");
    await connection.close();
    assert.equal(closeCalls, 1, "connection close after factory shutdown remains idempotent");
  } finally {
    registration.dispose();
    await factory.close();
  }
});

test("provider channels closed before handoff are rejected and released", async () => {
  const factory = factoryFor([]);
  const stream = channel();
  const closed = new Promise<void>((resolve) => stream.once("close", resolve));
  stream.destroy();
  await closed;
  let closeCalls = 0;
  const registration = registerSshHostProvider({
    async list() { return []; },
    async resolve() { return profileForRemote("managed-host"); },
    async openTeammateRemoteChannel() {
      return { stream, close() { closeCalls += 1; } };
    },
  });
  try {
    await assert.rejects(
      factory.connect({ ...target(), hostConfig: { sshHostRef: "managed-host" } }),
      (error: unknown) => error instanceof SshTransportError
        && /before connection handoff/u.test(error.message),
    );
    assert.equal(closeCalls, 1);
  } finally {
    registration.dispose();
    await factory.close();
  }
});

for (const failingListener of ["stream.on", "stream.stderr.on"] as const) {
  test(`provider channel ${failingListener} setup failures are sanitized and released once`, async () => {
    const factory = factoryFor([]);
    const stream = channel();
    const secret = `provider-stream-secret-${failingListener}`;
    if (failingListener === "stream.on") {
      (stream as unknown as { on: (...args: unknown[]) => never }).on = () => { throw new Error(secret); };
    } else {
      (stream.stderr as unknown as { on: (...args: unknown[]) => never }).on = () => { throw new Error(secret); };
    }
    let closeCalls = 0;
    const registration = registerSshHostProvider({
      async list() { return []; },
      async resolve() { return profileForRemote("managed-host"); },
      async openTeammateRemoteChannel() {
        return {
          stream,
          close() {
            closeCalls += 1;
            stream.destroy();
          },
        };
      },
    });
    try {
      await assert.rejects(
        factory.connect({ ...target(), hostConfig: { sshHostRef: "managed-host" } }),
        (error: unknown) => error instanceof SshTransportError
          && error.code === "transport"
          && error.message.length <= 128
          && !error.message.includes(secret),
      );
      await factory.close();
      assert.equal(closeCalls, 1);
    } finally {
      registration.dispose();
      await factory.close();
    }
  });
}

test("implemented fixed-purpose channel failure never falls back to resolve or internal SSH", async () => {
  let resolveCalls = 0;
  let clientCalls = 0;
  const factory = new SshRemoteConnectionFactory({
    createClient: () => { clientCalls += 1; return new FakeSshClient() as unknown as SshClientLike; },
  });
  const registration = registerSshHostProvider({
    async list() { return []; },
    async resolve() { resolveCalls += 1; return profileForRemote("managed-host"); },
    async openTeammateRemoteChannel() { throw new Error("secret capability detail"); },
  });
  try {
    await assert.rejects(
      factory.connect({ ...target(), hostConfig: { sshHostRef: "managed-host" } }),
      (error: unknown) => error instanceof SshHostProviderError
        && error.code === "refresh-failed"
        && !error.message.includes("secret capability detail"),
    );
    assert.equal(resolveCalls, 0);
    assert.equal(clientCalls, 0);
  } finally {
    registration.dispose();
    await factory.close();
  }
});

function profileForRemote(id: string) {
  return {
    id,
    label: "Managed",
    host: "managed.example",
    user: "dev",
    port: 22,
    shell: "bash" as const,
    hostKeySha256: HOST_KEY,
    authentication: { kind: "identity" as const, identityFile: "/local/managed-key" },
  };
}

test("SSH host references resolve on every new connection and retire changed pools after active channels finish", async () => {
  const firstClient = new FakeSshClient();
  const secondClient = new FakeSshClient();
  const thirdClient = new FakeSshClient();
  let hostname = "first.example";
  const registration = registerSshHostProvider({
    async list() { return [{ id: "manager-host", label: "Managed", compatible: true }]; },
    async resolve(hostRef) {
      return {
        id: hostRef,
        label: "Managed",
        host: hostname,
        user: "dev",
        port: 22,
        shell: "bash",
        hostKeySha256: HOST_KEY,
        authentication: { kind: "identity" as const, identityFile: "/local/managed-key" },
      };
    },
  });
  const factory = factoryFor([firstClient, secondClient, thirdClient]);
  const referenced: ResolvedRemoteTarget = { ...target(), hostConfig: { sshHostRef: "manager-host" } };
  try {
    const first = await factory.connect(referenced);
    assert.equal(firstClient.connectConfigs[0]?.host, "first.example");
    hostname = "second.example";
    const second = await factory.connect(referenced);
    assert.equal(secondClient.connectConfigs[0]?.host, "second.example");
    assert.equal(firstClient.endCalls, 0, "changing a reference must not kill an active channel");
    hostname = "first.example";
    const third = await factory.connect(referenced);
    assert.equal(thirdClient.connectConfigs[0]?.host, "first.example", "a cycled profile must not reuse its retired pool");

    await first.close();
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(firstClient.endCalls, 1, "retired pool should close once its active channel releases");
    await second.close();
    await third.close();
  } finally {
    registration.dispose();
    await factory.close();
  }
});

test("remote workspaces resolve agent-backed host references before opening the fixed gateway", async () => {
  const client = new FakeSshClient();
  const registration = registerSshHostProvider({
    async list() { return [{ id: "workspace-host", label: "Workspace", compatible: true }]; },
    async resolve(hostRef) {
      return {
        id: hostRef,
        label: "Workspace",
        host: "workspace.example",
        user: "ops",
        port: 2222,
        shell: "bash",
        hostKeySha256: HOST_KEY,
        authentication: { kind: "agent" as const },
      };
    },
  });
  const factory = factoryFor([client], { agentSocket: "/tmp/test-agent.sock" });
  try {
    const connection = await factory.connectWorkspace({
      ...workspace(),
      hostConfig: { sshHostRef: "workspace-host" },
    });
    assert.equal(client.connectConfigs[0]?.host, "workspace.example");
    assert.equal(client.connectConfigs[0]?.agent, "/tmp/test-agent.sock");
    assert.deepEqual(client.connectConfigs[0]?.authHandler, ["agent"]);
    assert.deepEqual(client.commands, [REMOTE_GATEWAY_COMMAND]);
    await connection.close();
  } finally {
    registration.dispose();
    await factory.close();
  }
});

test("locked SSH host references fail before any transport is opened", async () => {
  const registration = registerSshHostProvider({
    async list() { throw new SshHostProviderError("manager-locked", "Open /ssh to unlock it."); },
    async resolve() { throw new SshHostProviderError("manager-locked", "Open /ssh to unlock it."); },
  });
  const factory = factoryFor([]);
  try {
    await assert.rejects(
      factory.connect({ ...target(), hostConfig: { sshHostRef: "manager-host" } }),
      (error: unknown) => error instanceof SshHostProviderError
        && error.code === "manager-locked"
        && /Open \/ssh/u.test(error.message),
    );
  } finally {
    registration.dispose();
    await factory.close();
  }
});

test("window bridge diagnostics distinguish unreachable hosts from incompatible daemons", () => {
  assert.deepEqual(diagnoseRemoteWindowBridgeError(new SshTransportError(
    "connect-timeout",
    "secret host detail",
  )), {
    status: "unsupported",
    code: "host-unreachable",
    message: "Configured SSH host is unreachable or could not be authenticated",
  });
  assert.deepEqual(diagnoseRemoteWindowBridgeError(new RemoteRpcResponseError(
    -32601,
    "unknown remote method",
  )), {
    status: "upgrade-required",
    code: "daemon-incompatible",
    message: "Remote daemon is incompatible with the window bridge handshake",
  });
  assert.equal(diagnoseRemoteWindowBridgeError(new SshTransportError("protocol", "bad wire")).code, "daemon-incompatible");
});

test("SSH gateway stderr is bounded and fails the notification stream without exposing content", async () => {
  const client = new FakeSshClient();
  const factory = factoryFor([client], { maxStderrBytes: 8 });
  const connection = await factory.connect(target());
  const next = connection.notifications()[Symbol.asyncIterator]().next();
  (client.channels[0].stderr as PassThrough).write("secret-value-that-must-not-be-reported");
  await assert.rejects(
    next,
    (error: unknown) => error instanceof SshTransportError
      && error.code === "output-limit"
      && !error.message.includes("secret-value"),
  );
  await connection.close();
  await factory.close();
});

test("SSH host pools bound channels and pending admissions while reusing a ready client", async () => {
  const client = new FakeSshClient();
  const factory = factoryFor([client], {
    maxConnectionsPerHost: 1,
    maxChannelsPerConnection: 1,
    maxPendingPerHost: 1,
  });
  const first = await factory.connect(target());
  const secondPromise = factory.connect(target());
  await assert.rejects(
    factory.connect(target()),
    (error: unknown) => error instanceof SshTransportError && error.code === "pool-limit",
  );
  await first.close();
  const second = await secondPromise;
  assert.equal(client.connectConfigs.length, 1);
  assert.deepEqual(client.commands, [REMOTE_GATEWAY_COMMAND, REMOTE_GATEWAY_COMMAND]);
  await second.close();
  await factory.close();
});
