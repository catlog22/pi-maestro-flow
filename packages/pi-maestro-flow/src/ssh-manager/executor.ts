import { createHash, timingSafeEqual } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import type { Duplex } from "node:stream";
import { Client, type ClientChannel, type ConnectConfig } from "ssh2";
import { validateSshHost, type SshHost, type SshKey } from "./model.ts";

export const MAX_SSH_TIMEOUT_SECONDS = 300;
export const DEFAULT_SSH_TIMEOUT_SECONDS = 30;
export const MAX_SSH_COMMAND_BYTES = 64 * 1024;
export const MAX_SSH_CWD_BYTES = 4 * 1024;
export const DEFAULT_SSH_OUTPUT_BYTES = 1024 * 1024;
export const MAX_SSH_OUTPUT_BYTES = 1024 * 1024;
const MAX_IDENTITY_BYTES = 1024 * 1024;
const MAX_JUMP_HOSTS = 5;
const POWERSHELL_MAX_INVOCATION_CHARS = 8_000;

export interface SshExecuteRequest { command: string; cwd?: string; timeout?: number; }
export interface SshExecuteOptions { signal?: AbortSignal; outputLimitBytes?: number; agentPath?: string; }
export interface SshExecutionResult {
  stdout: string; stderr: string; exitCode: number | null; signal: string | null; durationMs: number;
  effectiveDigest?: string;
}
export interface SshConnectionTestResult { fingerprint: string; effectiveDigest?: string; }
export interface SshConnectionSource {
  getHosts(): SshHost[];
  checkoutKey(id: string): SshKey;
  getEffectiveHostDigest(id: string): string;
}
export type SshClientFactory = () => Client;
export interface SshCommandChannel { readonly channel: ClientChannel; readonly effectiveDigest?: string; close(): void; }

type ResolvedHop = { host: SshHost; privateKey?: Buffer; passphrase?: string };
type ResolvedConnection = { hops: ResolvedHop[]; target: SshHost; effectiveDigest?: string };

class ConnectedChain {
  private closed = false;
  private failureHandler: ((error: Error) => void) | undefined;
  constructor(
    readonly clients: Client[],
    private readonly sockets: Duplex[],
    readonly target: SshHost,
    readonly effectiveDigest?: string,
  ) {}
  get client(): Client { return this.clients[this.clients.length - 1]!; }
  fail(error: Error): void { this.failureHandler?.(error); }
  onFailure(handler: (error: Error) => void): void { this.failureHandler = handler; }
  cleanup(): void {
    if (this.closed) return;
    this.closed = true;
    this.failureHandler = undefined;
    for (let index = this.clients.length - 1; index >= 0; index--) {
      try { this.clients[index]!.end(); } catch { /* best effort */ }
      if (index > 0) try { this.sockets[index - 1]!.destroy(); } catch { /* best effort */ }
    }
  }
}

export class SshExecutor {
  constructor(
    private readonly clientFactory: SshClientFactory = () => new Client(),
    private readonly connectionSource?: SshConnectionSource,
  ) {}

  async testConnection(hostValue: unknown, options: SshExecuteOptions = {}): Promise<SshConnectionTestResult> {
    if (options.signal?.aborted) throw abortError();
    const resolved = await this.resolveConnection(hostValue, true, options.agentPath);
    let chain: ConnectedChain | undefined;
    try {
      const fingerprints = new Set<string>();
      chain = await this.connect(resolved, DEFAULT_SSH_TIMEOUT_SECONDS, options, (fingerprint) => fingerprints.add(fingerprint));
      if (fingerprints.size !== 1) throw new Error("SSH connection test did not observe one unique final host key");
      return { fingerprint: [...fingerprints][0]!, ...(resolved.effectiveDigest ? { effectiveDigest: resolved.effectiveDigest } : {}) };
    } finally {
      chain?.cleanup();
      zeroResolvedKeys(resolved);
    }
  }

  async openChannel(hostValue: unknown, request: SshExecuteRequest, options: SshExecuteOptions = {}): Promise<SshCommandChannel> {
    const normalized = validateRequest(request, options.outputLimitBytes);
    if (options.signal?.aborted) throw abortError();
    const resolved = await this.resolveConnection(hostValue, false, options.agentPath);
    let chain: ConnectedChain | undefined;
    try {
      chain = await this.connect(resolved, normalized.timeout, options);
      const active = chain;
      return await new Promise<SshCommandChannel>((resolve, reject) => {
        let settled = false;
        const timer = setTimeout(() => fail(new Error("SSH command timed out")), normalized.timeout * 1000);
        const cleanupStartup = (): void => { clearTimeout(timer); options.signal?.removeEventListener("abort", onAbort); };
        const fail = (error: Error): void => {
          if (settled) return;
          settled = true; cleanupStartup(); active.cleanup(); reject(error);
        };
        const onAbort = (): void => fail(abortError());
        options.signal?.addEventListener("abort", onAbort, { once: true });
        if (options.signal?.aborted) { onAbort(); return; }
        active.onFailure(() => fail(new Error("SSH connection or authentication failed")));
        let remoteCommand: string;
        try { remoteCommand = buildRemoteCommand(active.target.shell, normalized.command, normalized.cwd); }
        catch (error) { fail(asError(error)); return; }
        active.client.exec(remoteCommand, (error, channel) => {
          if (error) { fail(new Error("SSH command could not be started")); return; }
          if (settled) { channel.destroy(); return; }
          settled = true; cleanupStartup();
          let closed = false;
          const close = (): void => { if (closed) return; closed = true; channel.destroy(); active.cleanup(); };
          active.onFailure(() => { if (!closed) close(); });
          channel.once("close", () => { if (closed) return; closed = true; active.cleanup(); });
          resolve({ channel, ...(active.effectiveDigest ? { effectiveDigest: active.effectiveDigest } : {}), close });
        });
      });
    } catch (error) {
      chain?.cleanup();
      throw error;
    } finally {
      zeroResolvedKeys(resolved);
    }
  }

  async execute(hostValue: unknown, request: SshExecuteRequest, options: SshExecuteOptions = {}): Promise<SshExecutionResult> {
    const normalized = validateRequest(request, options.outputLimitBytes);
    if (options.signal?.aborted) throw abortError();
    const resolved = await this.resolveConnection(hostValue, false, options.agentPath);
    const startedAt = Date.now();
    let chain: ConnectedChain | undefined;
    try {
      chain = await this.connect(resolved, normalized.timeout, options);
      const active = chain;
      return await new Promise<SshExecutionResult>((resolve, reject) => {
        let settled = false;
        let stream: ClientChannel | undefined;
        let stdout: Buffer[] = [], stderr: Buffer[] = [];
        let outputBytes = 0, exitCode: number | null = null, exitSignal: string | null = null;
        const timer = setTimeout(() => finishReject(new Error("SSH command timed out")), normalized.timeout * 1000);
        const cleanup = (): void => { clearTimeout(timer); options.signal?.removeEventListener("abort", onAbort); };
        const finishReject = (error: Error): void => {
          if (settled) return;
          settled = true; cleanup(); stdout = []; stderr = []; stream?.destroy(); active.cleanup(); reject(error);
        };
        const finishResolve = (): void => {
          if (settled) return;
          let decodedStdout: string, decodedStderr: string;
          try { decodedStdout = decodeUtf8(Buffer.concat(stdout)); decodedStderr = decodeUtf8(Buffer.concat(stderr)); }
          catch { finishReject(new Error("SSH output was not valid UTF-8")); return; }
          if (Buffer.byteLength(decodedStdout) + Buffer.byteLength(decodedStderr) > normalized.outputLimitBytes) {
            finishReject(new Error("SSH output exceeded the configured limit")); return;
          }
          settled = true; cleanup(); active.cleanup();
          resolve({ stdout: decodedStdout, stderr: decodedStderr, exitCode, signal: exitSignal, durationMs: Date.now() - startedAt,
            ...(active.effectiveDigest ? { effectiveDigest: active.effectiveDigest } : {}) });
        };
        const onAbort = (): void => finishReject(abortError());
        options.signal?.addEventListener("abort", onAbort, { once: true });
        if (options.signal?.aborted) { onAbort(); return; }
        active.onFailure(() => finishReject(new Error(stream ? "SSH connection closed before command completed" : "SSH connection or authentication failed")));
        active.client.exec(buildRemoteCommand(active.target.shell, normalized.command, normalized.cwd), (error, channel) => {
          if (error) { finishReject(new Error("SSH command could not be started")); return; }
          if (settled) { channel.destroy(); return; }
          stream = channel;
          const capture = (destination: Buffer[]) => (chunk: Buffer | string): void => {
            if (settled) return;
            const bytes = Buffer.isBuffer(chunk) ? Buffer.from(chunk) : Buffer.from(chunk, "utf8");
            outputBytes += bytes.length;
            if (outputBytes > normalized.outputLimitBytes) { bytes.fill(0); finishReject(new Error("SSH output exceeded the configured limit")); return; }
            destination.push(bytes);
          };
          channel.on("data", capture(stdout)); channel.stderr.on("data", capture(stderr));
          channel.on("exit", (code: number | null, signal?: string) => { exitCode = code; exitSignal = signal ?? null; });
          channel.once("error", () => finishReject(new Error("SSH command stream failed")));
          channel.once("close", finishResolve);
        });
      });
    } catch (error) {
      chain?.cleanup();
      throw error;
    } finally {
      zeroResolvedKeys(resolved);
    }
  }

  private async resolveConnection(hostValue: unknown, allowFinalTofu: boolean, agentPath?: string): Promise<ResolvedConnection> {
    let target: SshHost;
    let effectiveDigest: string | undefined;
    let hosts: SshHost[];
    if (typeof hostValue === "string") {
      if (!this.connectionSource) throw new Error("SSH connection source is required for host ids");
      hosts = this.connectionSource.getHosts().map(validateSshHost);
      const found = hosts.find((host) => host.id === hostValue);
      if (!found) throw new Error("SSH host was not found");
      target = found;
      effectiveDigest = this.connectionSource.getEffectiveHostDigest(target.id);
    } else {
      target = validateSshHost(hostValue);
      if (target.jumpHostId || target.auth.kind === "key") {
        if (!this.connectionSource) throw new Error("SSH connection source is required for managed keys or jump hosts");
        hosts = this.connectionSource.getHosts().map(validateSshHost);
        const found = hosts.find((host) => host.id === target.id);
        if (!found) throw new Error("SSH host was not found");
        target = found; effectiveDigest = this.connectionSource.getEffectiveHostDigest(target.id);
      } else hosts = [target];
    }
    const byId = new Map(hosts.map((host) => [host.id, host]));
    const leafFirst: SshHost[] = [];
    const seen = new Set<string>();
    let current: SshHost | undefined = target;
    while (current) {
      if (seen.has(current.id)) throw new Error("SSH jump host graph contains a cycle");
      seen.add(current.id); leafFirst.push(current);
      if (leafFirst.length - 1 > MAX_JUMP_HOSTS) throw new Error("SSH jump host ancestor depth exceeds 5");
      if (!current.jumpHostId) break;
      current = byId.get(current.jumpHostId);
      if (!current) throw new Error("SSH host references a missing jump host");
    }
    const ordered = leafFirst.reverse();
    for (let index = 0; index < ordered.length; index++) {
      if (ordered[index]!.hostKey === null && !(allowFinalTofu && index === ordered.length - 1)) {
        throw new Error("SSH host requires a pinned SHA256 host key");
      }
    }
    const hops: ResolvedHop[] = [];
    try {
      for (const host of ordered) {
        if (host.auth.kind === "key") {
          if (!this.connectionSource) throw new Error("SSH connection source is required for managed keys");
          const key = this.connectionSource.checkoutKey(host.auth.keyId);
          try {
            hops.push({ host, privateKey: Buffer.from(key.privateKey, "utf8"), ...(key.passphrase ? { passphrase: key.passphrase } : {}) });
          } finally {
            key.privateKey = "";
            key.passphrase = undefined;
          }
        } else {
          const privateKey = await readAuthentication(host, agentPath);
          hops.push({ host, ...(privateKey ? { privateKey } : {}) });
        }
      }
      return { hops, target, ...(effectiveDigest ? { effectiveDigest } : {}) };
    } catch (error) {
      for (const hop of hops) hop.privateKey?.fill(0);
      throw error;
    }
  }

  private async connect(
    resolved: ResolvedConnection,
    timeout: number,
    options: SshExecuteOptions,
    tofuCapture?: (fingerprint: string) => void,
  ): Promise<ConnectedChain> {
    const clients: Client[] = [], sockets: Duplex[] = [];
    const chain = new ConnectedChain(clients, sockets, resolved.target, resolved.effectiveDigest);
    try {
      for (let index = 0; index < resolved.hops.length; index++) {
        if (options.signal?.aborted) throw abortError();
        const hop = resolved.hops[index]!;
        let socket: Duplex | undefined;
        if (index > 0) {
          const previous = clients[index - 1]!;
          socket = await forward(previous, hop.host.host, hop.host.port, timeout, options.signal);
          sockets.push(socket);
        }
        const client = this.clientFactory(); clients.push(client);
        await connectClient(client, buildConnectConfig(hop, options.agentPath, timeout, socket, tofuCapture && index === resolved.hops.length - 1 ? tofuCapture : undefined), timeout, options.signal, chain);
        hop.privateKey?.fill(0);
      }
      return chain;
    } catch (error) {
      chain.cleanup();
      throw error;
    } finally {
      zeroResolvedKeys(resolved);
    }
  }
}

function connectClient(client: Client, config: ConnectConfig, timeout: number, signal: AbortSignal | undefined, chain: ConnectedChain): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const sink = (): void => chain.fail(new Error("SSH transport failed"));
    const cleanup = (): void => { clearTimeout(timer); signal?.removeEventListener("abort", onAbort); client.off("ready", onReady); client.off("error", onError); client.off("close", onCloseBeforeReady); };
    const fail = (error: Error): void => { if (settled) return; settled = true; cleanup(); reject(error); };
    const onAbort = (): void => fail(abortError());
    const onReady = (): void => { if (settled) return; settled = true; cleanup(); resolve(); };
    const onError = (): void => fail(new Error("SSH connection or authentication failed"));
    const onCloseBeforeReady = (): void => fail(new Error("SSH connection closed before command execution"));
    const timer = setTimeout(() => fail(new Error("SSH command timed out")), timeout * 1000);
    client.on("error", sink);
    client.once("close", () => { client.off("error", sink); if (settled) chain.fail(new Error("SSH transport closed")); });
    client.once("ready", onReady); client.once("error", onError); client.once("close", onCloseBeforeReady);
    signal?.addEventListener("abort", onAbort, { once: true });
    try { client.connect(config); } catch { fail(new Error("SSH connection could not be started")); }
  });
}

function forward(client: Client, host: string, port: number, timeout: number, signal?: AbortSignal): Promise<Duplex> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error?: Error, socket?: Duplex): void => {
      if (settled) { socket?.destroy(); return; }
      settled = true; clearTimeout(timer); signal?.removeEventListener("abort", onAbort);
      if (error || !socket) { socket?.destroy(); reject(error ?? new Error("SSH jump forwarding failed")); } else resolve(socket);
    };
    const onAbort = (): void => finish(abortError());
    const timer = setTimeout(() => finish(new Error("SSH command timed out")), timeout * 1000);
    signal?.addEventListener("abort", onAbort, { once: true });
    try { client.forwardOut("127.0.0.1", 0, host, port, (error, socket) => finish(error ? new Error("SSH jump forwarding failed") : undefined, socket)); }
    catch { finish(new Error("SSH jump forwarding could not be started")); }
  });
}

export function buildRemoteCommand(shell: SshHost["shell"], command: string, cwd?: string): string {
  validateCommandText(command, cwd);
  if (shell === "bash") { const script = cwd ? `cd -- ${quoteBash(cwd)} && ${command}` : command; return `exec bash -lc ${quoteBash(script)}`; }
  const script = ["$ErrorActionPreference = 'Stop'", ...(cwd ? [`Set-Location -LiteralPath ${quotePowerShell(cwd)} -ErrorAction Stop`] : []), command].join("; ");
  const invocation = `powershell.exe -NoLogo -NoProfile -NonInteractive -EncodedCommand ${Buffer.from(script, "utf16le").toString("base64")}`;
  if (invocation.length > POWERSHELL_MAX_INVOCATION_CHARS) throw new Error("PowerShell command is too large for bounded Windows EncodedCommand execution");
  return invocation;
}
export function sha256HostKeyFingerprint(key: Buffer): string { return `SHA256:${createHash("sha256").update(key).digest("base64").replace(/=+$/u, "")}`; }
export function matchesPinnedHostKey(key: Buffer, pinned: string): boolean {
  const actual = Buffer.from(sha256HostKeyFingerprint(key), "utf8"), expected = Buffer.from(pinned, "utf8");
  try { return actual.length === expected.length && timingSafeEqual(actual, expected); } finally { actual.fill(0); expected.fill(0); }
}
function validateRequest(request: SshExecuteRequest, outputLimit = DEFAULT_SSH_OUTPUT_BYTES) {
  if (!request || typeof request !== "object") throw new Error("SSH request must be an object");
  if (Object.keys(request).some((key) => !["command", "cwd", "timeout"].includes(key))) throw new Error("SSH request contains unsupported parameters");
  const timeout = request.timeout ?? DEFAULT_SSH_TIMEOUT_SECONDS;
  if (!Number.isInteger(timeout) || timeout < 1 || timeout > MAX_SSH_TIMEOUT_SECONDS) throw new Error("SSH timeout must be an integer between 1 and 300 seconds");
  if (!Number.isInteger(outputLimit) || outputLimit < 1 || outputLimit > MAX_SSH_OUTPUT_BYTES) throw new Error("SSH output limit must be between 1 byte and 1 MiB");
  validateCommandText(request.command, request.cwd);
  return { command: request.command, ...(request.cwd === undefined ? {} : { cwd: request.cwd }), timeout, outputLimitBytes: outputLimit };
}
function validateCommandText(command: unknown, cwd: unknown): asserts command is string {
  if (typeof command !== "string" || command.length === 0 || Buffer.byteLength(command) > MAX_SSH_COMMAND_BYTES || command.includes("\0")) throw new Error("SSH command must contain 1-65536 UTF-8 bytes and no NUL characters");
  if (cwd !== undefined && (typeof cwd !== "string" || cwd.length === 0 || Buffer.byteLength(cwd) > MAX_SSH_CWD_BYTES || cwd.includes("\0"))) throw new Error("SSH cwd must contain 1-4096 UTF-8 bytes and no NUL characters");
}
async function readAuthentication(host: SshHost, _agentPath?: string): Promise<Buffer | undefined> {
  if (host.auth.kind !== "identity") return undefined;
  let privateKey: Buffer | undefined, handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    const before = await lstat(host.auth.path); if (before.isSymbolicLink() || !before.isFile()) throw new Error("invalid identity");
    handle = await open(host.auth.path, constants.O_RDONLY | (process.platform === "win32" ? 0 : constants.O_NOFOLLOW));
    const info = await handle.stat(); if (!info.isFile() || info.size <= 0 || info.size > MAX_IDENTITY_BYTES) throw new Error("invalid identity");
    privateKey = Buffer.alloc(Number(info.size)); let offset = 0;
    while (offset < privateKey.length) { const { bytesRead } = await handle.read(privateKey, offset, privateKey.length - offset, offset); if (!bytesRead) throw new Error("identity changed during read"); offset += bytesRead; }
    const extra = Buffer.alloc(1); try { if ((await handle.read(extra, 0, 1, offset)).bytesRead) throw new Error("identity changed during read"); } finally { extra.fill(0); }
    return privateKey;
  } catch { privateKey?.fill(0); throw new Error("SSH identity file is missing, empty, unreadable, symlinked, or too large"); }
  finally { await handle?.close().catch(() => undefined); }
}
function buildConnectConfig(hop: ResolvedHop, agentPath: string | undefined, timeout: number, sock?: Duplex, tofuCapture?: (fingerprint: string) => void): ConnectConfig {
  const { host } = hop;
  const common: ConnectConfig = { host: host.host, port: host.port, ...(sock ? { sock } : {}), username: host.user, readyTimeout: timeout * 1000, keepaliveInterval: 10_000, keepaliveCountMax: 2,
    hostVerifier: (key: Buffer) => {
      const fingerprint = sha256HostKeyFingerprint(key);
      tofuCapture?.(fingerprint);
      return host.hostKey !== null ? matchesPinnedHostKey(key, host.hostKey) : tofuCapture !== undefined;
    } };
  if (host.auth.kind === "agent") { const agent = agentPath ?? process.env.SSH_AUTH_SOCK; if (!agent) throw new Error("SSH agent authentication requested but no agent socket is available"); return { ...common, agent }; }
  if (host.auth.kind === "identity") { if (!hop.privateKey) throw new Error("SSH identity could not be loaded"); return { ...common, privateKey: hop.privateKey, ...(host.auth.passphrase ? { passphrase: host.auth.passphrase } : {}) }; }
  if (host.auth.kind === "key") { if (!hop.privateKey) throw new Error("SSH managed key could not be loaded"); return { ...common, privateKey: hop.privateKey, ...(hop.passphrase ? { passphrase: hop.passphrase } : {}) }; }
  return { ...common, password: host.auth.password };
}
function zeroResolvedKeys(resolved: ResolvedConnection): void { for (const hop of resolved.hops) hop.privateKey?.fill(0); }
function quoteBash(value: string): string { return `'${value.replaceAll("'", `'\\''`)}'`; }
function quotePowerShell(value: string): string { return `'${value.replaceAll("'", "''")}'`; }
function decodeUtf8(value: Buffer): string { return new TextDecoder("utf-8", { fatal: true }).decode(value); }
function abortError(): Error { const error = new Error("SSH command aborted"); error.name = "AbortError"; return error; }
function asError(error: unknown): Error { return error instanceof Error ? error : new Error(String(error)); }
