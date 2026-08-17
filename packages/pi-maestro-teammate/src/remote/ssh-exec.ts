/**
 * Direct SSH exec backend for ssh-mode `cli/<tool>` tools.
 *
 * Each run opens its own ssh2 connection and exec's the remote ACP CLI over a
 * channel. The channel is adapted to the small child-process surface that
 * AcpRunHandle consumes (stdin/stdout/stderr, kill, error/close events), so the
 * full ACP client pipeline — initialize, session/new, prompt loop, result
 * settlement — is reused exactly as for local CLIs. A pinned host-key verifier
 * and the same auth rules as the remote gateway (identity file or ssh-agent)
 * apply; environment variables are forwarded to the remote process only from
 * the whitelisted set the AcpDriver already computed.
 *
 * The ssh2 surface is typed through minimal structural interfaces (SshExecClient
 * / SshExecChannel) so the exec path is unit-testable with in-process mocks;
 * the default factory casts the real ssh2 Client onto that surface.
 */

import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { Client, type ConnectConfig } from "ssh2";
import type { RemoteHostConfig } from "./types.ts";
import {
  SSH_DEFAULT_CONNECT_TIMEOUT_MS,
  SSH_DEFAULT_HANDSHAKE_TIMEOUT_MS,
  SSH_DEFAULT_KEEPALIVE_MS,
  SSH_DEFAULT_KEEPALIVE_COUNT,
  createPinnedHostKeyVerifier,
  readPrivateIdentityFile,
} from "./ssh.ts";

/** Minimal writable channel surface consumed by the adapter (duplex in practice). */
export interface SshExecChannel extends NodeJS.WritableStream {
  readonly stderr: NodeJS.ReadableStream;
  on(event: string | symbol, listener: (...args: unknown[]) => void): this;
  once(event: string | symbol, listener: (...args: unknown[]) => void): this;
  signal(name: string): void;
  destroy(error?: Error): this;
}

/** Minimal ssh2 client surface used by the direct-exec backend. */
export interface SshExecClient {
  connect(config: ConnectConfig): unknown;
  once(event: string | symbol, listener: (...args: unknown[]) => void): unknown;
  off(event: string | symbol, listener: (...args: unknown[]) => void): unknown;
  removeAllListeners(event?: string | symbol): unknown;
  exec(
    command: string,
    options: { env?: NodeJS.ProcessEnv },
    callback: (error: Error | undefined, channel: SshExecChannel) => void,
  ): unknown;
  end(): unknown;
  destroy(): unknown;
}

export interface SshDirectExecOptions {
  /** Injectable client factory (tests). */
  createClient?: () => SshExecClient;
  /** Injectable identity-file reader (tests). */
  readIdentityFile?: (filePath: string) => Buffer;
  /** ssh-agent socket; defaults to $SSH_AUTH_SOCK. */
  agentSocket?: string;
  connectTimeoutMs?: number;
  handshakeTimeoutMs?: number;
  keepaliveIntervalMs?: number;
  keepaliveCountMax?: number;
  /** Timeout for a CLI-availability probe round trip. */
  probeTimeoutMs?: number;
}

export interface SshCliProbeResult {
  ok: boolean;
  error?: string;
}

const SIGNALS: Record<number, NodeJS.Signals> = {
  1: "SIGINT",
  2: "SIGINT",
  3: "SIGQUIT",
  9: "SIGKILL",
  15: "SIGTERM",
};

function signalName(signal?: NodeJS.Signals | number): NodeJS.Signals {
  if (typeof signal === "number") return SIGNALS[signal] ?? "SIGTERM";
  return signal ?? "SIGTERM";
}

function defaultCreateClient(): SshExecClient {
  return new Client() as unknown as SshExecClient;
}

/** POSIX-quote a single argv token so remote commands survive shell wrapping. */
function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

/** Wrap argv into a remote shell command, optionally cd-ing to a trust dir. */
function buildRemoteCommand(argv: readonly string[], cwd?: string): string {
  const joined = argv.map((part) => shellQuote(part)).join(" ");
  return cwd ? `cd ${shellQuote(cwd)} && exec ${joined}` : `exec ${joined}`;
}

function connectDirect(
  client: SshExecClient,
  host: RemoteHostConfig,
  options: SshDirectExecOptions,
): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false;
    let hostKeyRejected = false;
    const connectTimeoutMs = options.connectTimeoutMs ?? SSH_DEFAULT_CONNECT_TIMEOUT_MS;
    const handshakeTimeoutMs = options.handshakeTimeoutMs ?? SSH_DEFAULT_HANDSHAKE_TIMEOUT_MS;
    const connectTimer = setTimeout(
      () => finish(new Error(`SSH connect to ${host.user}@${host.host} timed out`)),
      connectTimeoutMs,
    );
    const handshakeTimer = setTimeout(
      () => finish(new Error(`SSH handshake with ${host.user}@${host.host} timed out`)),
      handshakeTimeoutMs,
    );
    const finish = (error?: Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(connectTimer);
      clearTimeout(handshakeTimer);
      client.off("ready", onReady);
      client.off("error", onError);
      client.off("close", onClose);
      if (error) {
        client.destroy();
        reject(error);
      } else {
        resolve();
      }
    };
    const onReady = (): void => finish();
    const onError = (error: unknown): void => {
      finish(new Error(hostKeyRejected
        ? `SSH host key fingerprint mismatch for ${host.user}@${host.host}`
        : `SSH connection to ${host.user}@${host.host} failed: ${error instanceof Error ? error.message : String(error)}`));
    };
    const onClose = (): void => finish(new Error(`SSH connection to ${host.user}@${host.host} closed before setup completed`));
    connectTimer.unref?.();
    handshakeTimer.unref?.();
    client.once("ready", onReady);
    client.once("error", onError);
    client.once("close", onClose);

    const agentSocket = options.agentSocket ?? process.env.SSH_AUTH_SOCK;
    let privateKey: Buffer | undefined;
    if (host.identityFile) {
      try {
        privateKey = options.readIdentityFile?.(host.identityFile) ?? readPrivateIdentityFile(host.identityFile);
      } catch (error) {
        finish(error instanceof Error ? error : new Error(String(error)));
        return;
      }
    } else if (!agentSocket) {
      finish(new Error(`SSH tool "${host.host}" requires an identityFile or an available ssh-agent`));
      return;
    }

    const config: ConnectConfig = {
      host: host.host,
      port: host.port,
      username: host.user,
      hostVerifier: (key: Buffer) => {
        const accepted = createPinnedHostKeyVerifier(host.hostKeySha256)(key);
        hostKeyRejected = !accepted;
        return accepted;
      },
      ...(privateKey ? {
        privateKey,
        authHandler: ["publickey" as const],
      } : {
        agent: agentSocket,
        authHandler: ["agent" as const],
      }),
      keepaliveInterval: options.keepaliveIntervalMs ?? SSH_DEFAULT_KEEPALIVE_MS,
      keepaliveCountMax: options.keepaliveCountMax ?? SSH_DEFAULT_KEEPALIVE_COUNT,
      timeout: connectTimeoutMs,
      readyTimeout: handshakeTimeoutMs,
      strictVendor: true,
      tryKeyboard: false,
    };
    try {
      client.connect(config);
    } catch (error) {
      finish(error instanceof Error ? error : new Error(String(error)));
    }
  });
}

/**
 * Probe whether a remote CLI is reachable: connect to the host and check that
 * the executable resolves (command -v / which). No ACP traffic is sent.
 */
export async function probeSshCliExecutable(
  host: RemoteHostConfig,
  command: string,
  options: SshDirectExecOptions = {},
): Promise<SshCliProbeResult> {
  const client = options.createClient?.() ?? defaultCreateClient();
  const probeTimeoutMs = options.probeTimeoutMs ?? 8_000;
  return new Promise((resolve) => {
    let settled = false;
    const timer = setTimeout(() => finish({ ok: false, error: "SSH probe timed out" }), probeTimeoutMs);
    const finish = (result: SshCliProbeResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      client.removeAllListeners();
      client.end();
      resolve(result);
    };
    timer.unref?.();
    client.once("ready", () => {
      client.exec(`command -v ${shellQuote(command)} || which ${shellQuote(command)}`, {}, (error, channel) => {
        if (error) {
          finish({ ok: false, error: `remote exec failed: ${error.message}` });
          return;
        }
        channel.on("exit", (...args: unknown[]) => {
          finish(Number(args[0]) === 0 ? { ok: true } : { ok: false, error: `remote executable "${command}" not found` });
        });
        channel.on("error", (...args: unknown[]) => finish({ ok: false, error: `remote exec error: ${String(args[0])}` }));
        channel.on("close", () => finish({ ok: false, error: "remote probe channel closed" }));
      });
    });
    client.once("error", (...args: unknown[]) => finish({ ok: false, error: `SSH connect failed: ${String(args[0])}` }));
    void connectDirect(client, host, options).catch((error) => finish({
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    }));
  });
}

/**
 * Create a spawn function that launches the remote CLI over a fresh ssh2
 * connection, adapted to the child-process surface AcpRunHandle consumes.
 * `remoteCwd` becomes the remote working directory (cd wrapper); when omitted,
 * the AcpDriver-supplied spawnOptions.cwd is used. The whitelisted `env` set in
 * spawnOptions is forwarded to the remote process via exec options.
 */
export function spawnSshChild(
  host: RemoteHostConfig,
  options: SshDirectExecOptions = {},
  remoteCwd?: string,
): (command: string, args: readonly string[], spawnOptions: { cwd?: string; env?: NodeJS.ProcessEnv }) => ChildProcessLike {
  return (command, args, spawnOptions) => {
    const client = options.createClient?.() ?? defaultCreateClient();
    return new SshChildAdapter(
      client,
      host,
      buildRemoteCommand([command, ...args], remoteCwd ?? spawnOptions?.cwd),
      spawnOptions?.env,
      options,
    );
  };
}

/** Minimal child-process surface consumed by AcpRunHandle. */
export interface ChildProcessLike {
  readonly pid: number | undefined;
  exitCode: number | null;
  signalCode: string | null;
  stdin: NodeJS.WritableStream;
  stdout: NodeJS.ReadableStream;
  stderr: NodeJS.ReadableStream;
  kill(signal?: NodeJS.Signals | number): boolean;
  on(event: "error", listener: (error: Error) => void): this;
  on(event: "close", listener: (code: number | null, signal: NodeJS.Signals | null) => void): this;
}

class SshChildAdapter extends EventEmitter implements ChildProcessLike {
  readonly pid: number | undefined = undefined;
  exitCode: number | null = null;
  signalCode: string | null = null;
  readonly stdin: PassThrough;
  readonly stdout: PassThrough;
  readonly stderr: PassThrough;
  readonly #client: SshExecClient;
  #channel: SshExecChannel | undefined;
  #closed = false;

  constructor(
    client: SshExecClient,
    host: RemoteHostConfig,
    remoteCommand: string,
    env: NodeJS.ProcessEnv | undefined,
    options: SshDirectExecOptions,
  ) {
    super();
    this.#client = client;
    this.stdin = new PassThrough();
    this.stdout = new PassThrough();
    this.stderr = new PassThrough();
    this.stdin.on("error", () => {});
    void this.#open(host, remoteCommand, env, options);
  }

  async #open(
    host: RemoteHostConfig,
    remoteCommand: string,
    env: NodeJS.ProcessEnv | undefined,
    options: SshDirectExecOptions,
  ): Promise<void> {
    try {
      await connectDirect(this.#client, host, options);
    } catch (error) {
      this.#fail(error instanceof Error ? error : new Error(String(error)));
      return;
    }
    this.#client.exec(remoteCommand, { env }, (error, channel) => {
      if (error) {
        this.#fail(new Error(`remote exec failed: ${error.message}`));
        return;
      }
      this.#channel = channel;
      channel.on("data", (chunk: unknown) => {
        if (!this.#closed && chunk) this.stdout.write(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
      });
      channel.stderr.on("data", (chunk: unknown) => {
        if (!this.#closed && chunk) this.stderr.write(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
      });
      channel.on("exit", (...args: unknown[]) => {
        this.exitCode = typeof args[0] === "number" ? args[0] : null;
        this.signalCode = typeof args[1] === "string" ? args[1] : null;
        this.emit("exit", this.exitCode, this.signalCode);
      });
      channel.on("error", (...args: unknown[]) => this.#fail(args[0] instanceof Error ? args[0] : new Error(String(args[0]))));
      channel.on("close", () => this.#close());
      this.stdin.pipe(channel);
    });
  }

  #close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#channel = undefined;
    this.stdout.end();
    this.stderr.end();
    this.stdin.end();
    this.#client.end();
    this.emit("close", this.exitCode, this.signalCode);
  }

  #fail(error: Error): void {
    if (this.#closed) return;
    this.#closed = true;
    this.emit("error", error);
    this.stdout.destroy(error);
    this.stderr.destroy(error);
    this.stdin.destroy();
    try {
      this.#client.end();
    } catch {
      // closing anyway
    }
    this.emit("close", this.exitCode, this.signalCode);
  }

  kill(signal?: NodeJS.Signals | number): boolean {
    const name = signalName(signal);
    const channel = this.#channel;
    if (channel) {
      try {
        channel.signal(name);
      } catch {
        return false;
      }
      // Remote processes may ignore the signal; force-close as a fallback.
      const timer = setTimeout(() => channel.destroy(), 2_000);
      timer.unref?.();
    } else {
      try {
        this.#client.end();
      } catch {
        return false;
      }
    }
    return true;
  }
}