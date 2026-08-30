import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import test from "node:test";
import type { ClientChannel, ConnectConfig } from "ssh2";
import {
  REMOTE_GATEWAY_COMMAND,
  RemoteRpcResponseError,
  SshRemoteConnectionFactory,
  SshTransportError,
  createPinnedHostKeyVerifier,
  diagnoseRemoteWindowBridgeError,
  type SshClientLike,
} from "../src/remote/ssh.ts";
import type { ResolvedRemoteTarget, ResolvedRemoteWorkspace } from "../src/remote/types.ts";

const PRESENTED_KEY = Buffer.from("pinned-test-host-key");
const HOST_KEY = `SHA256:${createHash("sha256").update(PRESENTED_KEY).digest("base64").replace(/=+$/, "")}`;

function target(overrides: Partial<ResolvedRemoteTarget["hostConfig"]> = {}): ResolvedRemoteTarget {
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
  assert.deepEqual(client.commands, [REMOTE_GATEWAY_COMMAND]);
  assert.equal(client.commands[0], "pi-teammate-remote connect --stdio");
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
