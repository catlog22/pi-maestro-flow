import { createHash, timingSafeEqual } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import { Client, type ClientChannel, type ConnectConfig } from "ssh2";
import { validateSshHost, type SshHost } from "./model.ts";

export const MAX_SSH_TIMEOUT_SECONDS = 300;
export const DEFAULT_SSH_TIMEOUT_SECONDS = 30;
export const MAX_SSH_COMMAND_BYTES = 64 * 1024;
export const MAX_SSH_CWD_BYTES = 4 * 1024;
export const DEFAULT_SSH_OUTPUT_BYTES = 1024 * 1024;
export const MAX_SSH_OUTPUT_BYTES = 1024 * 1024;
const MAX_IDENTITY_BYTES = 1024 * 1024;
const POWERSHELL_MAX_INVOCATION_CHARS = 8_000;

export interface SshExecuteRequest {
  command: string;
  cwd?: string;
  timeout?: number;
}

export interface SshExecuteOptions {
  signal?: AbortSignal;
  outputLimitBytes?: number;
  agentPath?: string;
}

export interface SshExecutionResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  signal: string | null;
  durationMs: number;
}

export type SshClientFactory = () => Client;

export class SshExecutor {
  constructor(private readonly clientFactory: SshClientFactory = () => new Client()) {}

  async execute(hostValue: unknown, request: SshExecuteRequest, options: SshExecuteOptions = {}): Promise<SshExecutionResult> {
    const host = validateSshHost(hostValue);
    const normalized = validateRequest(request, options.outputLimitBytes);
    if (options.signal?.aborted) throw abortError();
    const privateKey = await readAuthentication(host, options.agentPath);
    if (options.signal?.aborted) {
      privateKey?.fill(0);
      throw abortError();
    }
    const startedAt = Date.now();

    try {
      const client = this.clientFactory();
      return await new Promise<SshExecutionResult>((resolve, reject) => {
        let settled = false;
        let stream: ClientChannel | undefined;
        let stdout: Buffer[] = [];
        let stderr: Buffer[] = [];
        let outputBytes = 0;
        let exitCode: number | null = null;
        let exitSignal: string | null = null;

        const cleanup = (): void => {
          clearTimeout(timer);
          options.signal?.removeEventListener("abort", onAbort);
          client.removeListener("error", onClientError);
          client.removeListener("close", onClientClose);
        };
        const finishReject = (error: Error): void => {
          if (settled) return;
          settled = true;
          cleanup();
          stdout = [];
          stderr = [];
          stream?.destroy();
          client.end();
          reject(error);
        };
        const finishResolve = (): void => {
          if (settled) return;
          let decodedStdout: string;
          let decodedStderr: string;
          try {
            decodedStdout = decodeUtf8(Buffer.concat(stdout));
            decodedStderr = decodeUtf8(Buffer.concat(stderr));
          } catch {
            finishReject(new Error("SSH output was not valid UTF-8"));
            return;
          }
          if (Buffer.byteLength(decodedStdout, "utf8") + Buffer.byteLength(decodedStderr, "utf8") > normalized.outputLimitBytes) {
            finishReject(new Error("SSH output exceeded the configured limit"));
            return;
          }
          settled = true;
          cleanup();
          client.end();
          resolve({
            stdout: decodedStdout,
            stderr: decodedStderr,
            exitCode,
            signal: exitSignal,
            durationMs: Date.now() - startedAt,
          });
        };
        const onAbort = (): void => finishReject(abortError());
        const onClientError = (_error: Error): void => finishReject(new Error("SSH connection or authentication failed"));
        const onClientClose = (): void => finishReject(new Error(
          stream ? "SSH connection closed before command completed" : "SSH connection closed before command execution",
        ));
        const timer = setTimeout(() => finishReject(new Error("SSH command timed out")), normalized.timeout * 1000);

        options.signal?.addEventListener("abort", onAbort, { once: true });
        client.once("error", onClientError);
        client.once("close", onClientClose);
        client.once("ready", () => {
          if (settled) return;
          client.exec(buildRemoteCommand(host.shell, normalized.command, normalized.cwd), (error, channel) => {
            if (error) {
              finishReject(new Error("SSH command could not be started"));
              return;
            }
            if (settled) {
              channel.destroy();
              return;
            }
            stream = channel;
            const capture = (destination: Buffer[]) => (chunk: Buffer | string): void => {
              if (settled) return;
              const bytes = Buffer.isBuffer(chunk) ? Buffer.from(chunk) : Buffer.from(chunk, "utf8");
              outputBytes += bytes.length;
              if (outputBytes > normalized.outputLimitBytes) {
                bytes.fill(0);
                finishReject(new Error("SSH output exceeded the configured limit"));
                return;
              }
              destination.push(bytes);
            };
            channel.on("data", capture(stdout));
            channel.stderr.on("data", capture(stderr));
            channel.on("exit", (code: number | null, signal?: string) => {
              exitCode = code;
              exitSignal = signal ?? null;
            });
            channel.once("error", () => finishReject(new Error("SSH command stream failed")));
            channel.once("close", finishResolve);
          });
        });

        try {
          client.connect(buildConnectConfig(host, privateKey, options.agentPath, normalized.timeout));
        } catch {
          finishReject(new Error("SSH connection could not be started"));
        }
      });
    } finally {
      privateKey?.fill(0);
    }
  }
}

export function buildRemoteCommand(shell: SshHost["shell"], command: string, cwd?: string): string {
  validateCommandText(command, cwd);
  if (shell === "bash") {
    const script = cwd ? `cd -- ${quoteBash(cwd)} && ${command}` : command;
    return `exec bash -lc ${quoteBash(script)}`;
  }
  const script = [
    "$ErrorActionPreference = 'Stop'",
    ...(cwd ? [`Set-Location -LiteralPath ${quotePowerShell(cwd)} -ErrorAction Stop`] : []),
    command,
  ].join("; ");
  const invocation = `powershell.exe -NoLogo -NoProfile -NonInteractive -EncodedCommand ${Buffer.from(script, "utf16le").toString("base64")}`;
  if (invocation.length > POWERSHELL_MAX_INVOCATION_CHARS) {
    throw new Error("PowerShell command is too large for bounded Windows EncodedCommand execution");
  }
  return invocation;
}

export function sha256HostKeyFingerprint(key: Buffer): string {
  return `SHA256:${createHash("sha256").update(key).digest("base64").replace(/=+$/u, "")}`;
}

export function matchesPinnedHostKey(key: Buffer, pinned: string): boolean {
  const actual = Buffer.from(sha256HostKeyFingerprint(key), "utf8");
  const expected = Buffer.from(pinned, "utf8");
  try {
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  } finally {
    actual.fill(0);
    expected.fill(0);
  }
}

function validateRequest(request: SshExecuteRequest, outputLimit = DEFAULT_SSH_OUTPUT_BYTES): Required<Pick<SshExecuteRequest, "command" | "timeout">> & Pick<SshExecuteRequest, "cwd"> & { outputLimitBytes: number } {
  if (!request || typeof request !== "object") throw new Error("SSH request must be an object");
  const keys = Object.keys(request);
  if (keys.some((key) => key !== "command" && key !== "cwd" && key !== "timeout")) {
    throw new Error("SSH request contains unsupported parameters");
  }
  const timeout = request.timeout ?? DEFAULT_SSH_TIMEOUT_SECONDS;
  if (!Number.isInteger(timeout) || timeout < 1 || timeout > MAX_SSH_TIMEOUT_SECONDS) {
    throw new Error("SSH timeout must be an integer between 1 and 300 seconds");
  }
  if (!Number.isInteger(outputLimit) || outputLimit < 1 || outputLimit > MAX_SSH_OUTPUT_BYTES) {
    throw new Error("SSH output limit must be between 1 byte and 1 MiB");
  }
  validateCommandText(request.command, request.cwd);
  return { command: request.command, ...(request.cwd === undefined ? {} : { cwd: request.cwd }), timeout, outputLimitBytes: outputLimit };
}

function validateCommandText(command: unknown, cwd: unknown): asserts command is string {
  if (typeof command !== "string" || command.length === 0 || Buffer.byteLength(command, "utf8") > MAX_SSH_COMMAND_BYTES || command.includes("\0")) {
    throw new Error("SSH command must contain 1-65536 UTF-8 bytes and no NUL characters");
  }
  if (cwd !== undefined && (typeof cwd !== "string" || cwd.length === 0 || Buffer.byteLength(cwd, "utf8") > MAX_SSH_CWD_BYTES || cwd.includes("\0"))) {
    throw new Error("SSH cwd must contain 1-4096 UTF-8 bytes and no NUL characters");
  }
}

async function readAuthentication(host: SshHost, _explicitAgentPath?: string): Promise<Buffer | undefined> {
  if (host.auth.kind !== "identity") return undefined;
  let privateKey: Buffer | undefined;
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    const before = await lstat(host.auth.path);
    if (before.isSymbolicLink() || !before.isFile()) throw new Error("invalid identity");
    const flags = constants.O_RDONLY | (process.platform === "win32" ? 0 : constants.O_NOFOLLOW);
    handle = await open(host.auth.path, flags);
    const info = await handle.stat();
    if (!info.isFile() || info.size <= 0 || info.size > MAX_IDENTITY_BYTES) throw new Error("invalid identity");
    privateKey = Buffer.alloc(Number(info.size));
    let offset = 0;
    while (offset < privateKey.length) {
      const { bytesRead } = await handle.read(privateKey, offset, privateKey.length - offset, offset);
      if (bytesRead === 0) throw new Error("identity changed during read");
      offset += bytesRead;
    }
    const extra = Buffer.alloc(1);
    try {
      if ((await handle.read(extra, 0, 1, offset)).bytesRead !== 0) throw new Error("identity changed during read");
    } finally {
      extra.fill(0);
    }
    return privateKey;
  } catch {
    privateKey?.fill(0);
    throw new Error("SSH identity file is missing, empty, unreadable, symlinked, or too large");
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

function buildConnectConfig(host: SshHost, privateKey: Buffer | undefined, explicitAgentPath: string | undefined, timeout: number): ConnectConfig {
  const common: ConnectConfig = {
    host: host.host,
    port: host.port,
    username: host.user,
    readyTimeout: timeout * 1000,
    keepaliveInterval: 10_000,
    keepaliveCountMax: 2,
    hostVerifier: (key: Buffer) => matchesPinnedHostKey(key, host.hostKey),
  };
  if (host.auth.kind === "agent") {
    const agent = explicitAgentPath ?? process.env.SSH_AUTH_SOCK;
    if (!agent) throw new Error("SSH agent authentication requested but no agent socket is available");
    return { ...common, agent };
  }
  if (host.auth.kind === "identity") {
    if (!privateKey) throw new Error("SSH identity could not be loaded");
    return {
      ...common,
      privateKey,
      ...(host.auth.passphrase === undefined ? {} : { passphrase: host.auth.passphrase }),
    };
  }
  return { ...common, password: host.auth.password };
}

function quoteBash(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

function quotePowerShell(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

function decodeUtf8(value: Buffer): string {
  return new TextDecoder("utf-8", { fatal: true }).decode(value);
}

function abortError(): Error {
  const error = new Error("SSH command aborted");
  error.name = "AbortError";
  return error;
}
