import { randomUUID } from "node:crypto";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import * as fs from "node:fs";
import type { FileHandle } from "node:fs/promises";
import * as path from "node:path";
import {
  RequestError,
  type CreateTerminalRequest,
  type CreateTerminalResponse,
  type KillTerminalRequest,
  type PermissionOption,
  type ReadTextFileRequest,
  type ReadTextFileResponse,
  type ReleaseTerminalRequest,
  type RequestPermissionRequest,
  type RequestPermissionResponse,
  type TerminalOutputRequest,
  type TerminalOutputResponse,
  type WaitForTerminalExitRequest,
  type WaitForTerminalExitResponse,
  type WriteTextFileRequest,
} from "@agentclientprotocol/sdk";
import {
  captureProcessTree,
  redactRemoteError,
  sanitizedChildEnvironment,
  signalProcessTree,
  type ProcessTreeIdentity,
} from "./child-security.ts";
import type { RemoteAcpPolicy, RemoteAcpTerminalCommand } from "./types.ts";

const DEFAULT_FILE_LIMIT = 64 * 1024;
const DEFAULT_TERMINAL_OUTPUT_LIMIT = 64 * 1024;
const DEFAULT_TERMINAL_TIMEOUT_MS = 30_000;
const DEFAULT_TERMINAL_PROCESSES = 1;
const TERMINAL_ARG_COUNT_LIMIT = 256;
const TERMINAL_ARG_BYTES_LIMIT = 64 * 1024;
const TERMINAL_KILL_GRACE_MS = 250;
const CODE_EVAL_EXECUTABLES = new Set(["node", "nodejs", "deno", "bun", "python", "python3", "python2", "perl", "ruby", "php", "sh", "bash", "zsh", "dash", "fish"]);
const CODE_EVAL_FLAGS = new Set(["-e", "--eval", "-p", "--print", "-c", "--command", "--exec", "-pe", "-i"]);
const GIT_EXECUTION_SUBCOMMANDS = new Set(["alias", "config", "filter-branch", "submodule", "archive", "upload-pack", "receive-pack", "clone", "fetch", "pull"]);
const GIT_EXECUTION_FLAGS = new Set(["-c", "--config-env", "--exec-path", "--git-dir", "--work-tree"]);
const PATH_LIKE_VARS = new Set(["PATH", "LD_PRELOAD", "LD_LIBRARY_PATH", "DYLD_LIBRARY_PATH", "DYLD_INSERT_LIBRARIES", "PYTHONPATH", "NODE_PATH", "PERL5LIB"]);


interface TerminalExit {
  exitCode: number | null;
  signal: string | null;
}

interface ManagedTerminal {
  child: ChildProcessWithoutNullStreams;
  tree: ProcessTreeIdentity | undefined;
  output: string;
  outputLimit: number;
  truncated: boolean;
  exit?: TerminalExit;
  exitPromise: Promise<TerminalExit>;
  resolveExit: (exit: TerminalExit) => void;
  timeout: NodeJS.Timeout;
  killStarted: boolean;
}

interface CanonicalTerminalProfile {
  executable: string;
  args: readonly string[];
  environment: ReadonlySet<string>;
}

function abortError(): RequestError {
  return RequestError.requestCancelled(undefined, "ACP client operation was cancelled");
}

function assertNotAborted(signal: AbortSignal): void {
  if (signal.aborted) throw abortError();
}

function invalid(message: string): never {
  throw RequestError.invalidParams(undefined, message);
}

function within(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

function executableBase(executable: string): string {
  return path.basename(executable).toLowerCase().replace(/\.(?:exe|cmd|bat|com)$/i, "");
}

function assertSafeTerminalExecutable(executable: string): void {
  if (path.isAbsolute(executable)) {
    if (executable.split(/[\\/]/).includes("..") || /[\u0000-\u001f\u007f";`]/.test(executable)) {
      invalid("ACP terminal executable is not a canonical absolute path");
    }
    return;
  }
  if (!/^[A-Za-z0-9._+-]+$/.test(executable)) invalid("Invalid ACP terminal executable");
  const base = executableBase(executable);
  if (CODE_EVAL_EXECUTABLES.has(base) || base === "git") {
    invalid("ACP terminal executable must be a canonical absolute path with an argv policy");
  }
}

function isCodeEvalArgv(base: string, args: readonly string[]): boolean {
  if (!CODE_EVAL_EXECUTABLES.has(base) || args.length === 0) return false;
  const first = args[0];
  return CODE_EVAL_FLAGS.has(first)
    || first.startsWith("--eval")
    || first.startsWith("--print")
    || (first === "--" && args.length === 1);
}

function isGitExecutionArgv(base: string, args: readonly string[]): boolean {
  if (base !== "git" || args.length === 0) return false;
  if (GIT_EXECUTION_FLAGS.has(args[0])) return true;
  if (args.some((arg) => arg.startsWith("-c") || arg.startsWith("--config-env"))) return true;
  const subcommand = args.find((arg) => !arg.startsWith("-")) ?? "";
  return GIT_EXECUTION_SUBCOMMANDS.has(subcommand);
}

function assertSafeTerminalArgv(executable: string, args: readonly string[]): void {
  const base = executableBase(executable);
  if (isCodeEvalArgv(base, args)) invalid("ACP terminal argv is denied for code evaluation");
  if (isGitExecutionArgv(base, args)) invalid("ACP terminal argv is denied for git alias/config execution");
  for (const arg of args) {
    if (arg.includes("\0") || /[\u0000-\u001f\u007f]/.test(arg)) invalid("ACP terminal argv contains control characters");
  }
}

function deniedPathLikeEnv(entry: { name: string; value: string }): boolean {
  return PATH_LIKE_VARS.has(entry.name.toUpperCase());
}

function resolveCanonicalExecutable(executable: string): string | undefined {
  if (path.isAbsolute(executable)) {
    try {
      const real = fs.realpathSync(executable);
      return fs.statSync(real).isFile() ? real : undefined;
    } catch {
      return undefined;
    }
  }
  const pathValue = process.env.PATH ?? "";
  for (const directory of pathValue.split(path.delimiter)) {
    if (!directory) continue;
    const candidate = path.join(directory, executable);
    try {
      const real = fs.realpathSync(candidate);
      if (fs.statSync(real).isFile()) return real;
    } catch {
      continue;
    }
  }
  return undefined;
}

function appendUtf8Tail(current: string, addition: string, maxBytes: number): { value: string; truncated: boolean } {
  const combined = current + addition;
  const bytes = Buffer.byteLength(combined, "utf8");
  if (bytes <= maxBytes) return { value: combined, truncated: false };
  const buffer = Buffer.from(combined, "utf8");
  return {
    value: buffer.subarray(buffer.length - maxBytes).toString("utf8").replace(/^\uFFFD/, ""),
    truncated: true,
  };
}

function boundedPositive(value: number | null | undefined, fallback: number, maximum: number): number {
  if (value === undefined || value === null) return fallback;
  if (!Number.isInteger(value) || value < 1) invalid("ACP byte limit must be a positive integer");
  return Math.min(value, maximum);
}

export interface AcpClientOperationsOptions {
  targetRoot: string;
  policy?: RemoteAcpPolicy;
  signal: AbortSignal;
  isCancelling: () => boolean;
  sessionId: () => string | undefined;
  /** Deterministic test hook invoked after the parent handle is captured. */
  beforeFileOpen?: (operation: "read" | "write") => Promise<void>;
}

/** Implements only explicitly configured ACP client operations on the bridge host. */
export class AcpClientOperations {
  readonly #root: string;
  readonly #policy: RemoteAcpPolicy;
  readonly #signal: AbortSignal;
  readonly #isCancelling: () => boolean;
  readonly #sessionId: () => string | undefined;
  readonly #beforeFileOpen: ((operation: "read" | "write") => Promise<void>) | undefined;
  readonly #terminals = new Map<string, ManagedTerminal>();
  readonly #terminalProfiles: CanonicalTerminalProfile[] = [];
  readonly #permissionTools = new Set<string>();
  #rootDescriptor: number | undefined;

  constructor(options: AcpClientOperationsOptions) {
    this.#root = fs.realpathSync(options.targetRoot);
    if (!fs.statSync(this.#root).isDirectory()) throw new Error("ACP target root is not a directory");
    this.#policy = options.policy ?? {};
    this.#signal = options.signal;
    this.#isCancelling = options.isCancelling;
    this.#sessionId = options.sessionId;
    this.#beforeFileOpen = options.beforeFileOpen;
    this.#signal.addEventListener("abort", () => this.close(), { once: true });
    this.#permissionTools = new Set(
      (this.#policy.permissionTools ?? []).map((tool) => tool.trim().toLowerCase()).filter(Boolean),
    );
    for (const profile of this.#policy.terminal?.commands ?? []) {
      this.#terminalProfiles.push(this.#canonicalTerminalProfile(profile));
    }
    if (process.platform === "linux" && fs.existsSync("/proc/self/fd")) {
      const flags = fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW;
      this.#rootDescriptor = fs.openSync(this.#root, flags);
    }
  }

  get capabilities(): { fs?: { readTextFile?: boolean; writeTextFile?: boolean }; terminal?: boolean } {
    const fsPolicy = this.#policy.fs;
    const descriptorFilesystemAvailable = this.#rootDescriptor !== undefined;
    return {
      ...(descriptorFilesystemAvailable && (fsPolicy?.read || fsPolicy?.write) ? {
        fs: {
          ...(fsPolicy.read ? { readTextFile: true } : {}),
          ...(fsPolicy.write ? { writeTextFile: true } : {}),
        },
      } : {}),
      ...(this.#policy.terminal ? { terminal: true } : {}),
    };
  }

  requestPermission(request: RequestPermissionRequest, signal: AbortSignal): RequestPermissionResponse {
    this.#assertSession(request.sessionId);
    if (signal.aborted || this.#signal.aborted || this.#isCancelling()) return { outcome: { outcome: "cancelled" } };
    const option = this.#selectPermission(request.toolCall?.name, request.options);
    return option
      ? { outcome: { outcome: "selected", optionId: option.optionId } }
      : { outcome: { outcome: "cancelled" } };
  }

  async readTextFile(request: ReadTextFileRequest, signal: AbortSignal): Promise<ReadTextFileResponse> {
    this.#assertSession(request.sessionId);
    if (!this.#policy.fs?.read) invalid("ACP filesystem reads are not enabled for this target");
    assertNotAborted(this.#combinedSignal(signal));
    const maxBytes = this.#policy.fs.maxReadBytes ?? DEFAULT_FILE_LIMIT;
    const { parent, name } = await this.#openContainedParent(request.path);
    try {
      await this.#beforeFileOpen?.("read");
      await this.#assertContainedHandle(parent);
      const handle = await fs.promises.open(
        this.#descriptorChildPath(parent.fd, name),
        fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW,
      );
      try {
        await this.#assertContainedHandle(handle);
        const stat = await handle.stat();
        if (!stat.isFile() || stat.size > maxBytes) invalid("ACP filesystem read exceeds the configured byte limit");
        const content = await handle.readFile("utf8");
        assertNotAborted(this.#combinedSignal(signal));
        const lines = content.split(/\r?\n/);
        const start = request.line === undefined || request.line === null ? 1 : request.line;
        const limit = request.limit === undefined || request.limit === null ? lines.length : request.limit;
        if (!Number.isInteger(start) || start < 1 || !Number.isInteger(limit) || limit < 0) invalid("Invalid ACP filesystem line range");
        const selected = lines.slice(start - 1, start - 1 + limit).join("\n");
        if (Buffer.byteLength(selected, "utf8") > maxBytes) invalid("ACP filesystem read exceeds the configured byte limit");
        return { content: selected };
      } finally {
        await handle.close();
      }
    } finally {
      await parent.close();
    }
  }

  async writeTextFile(request: WriteTextFileRequest, signal: AbortSignal): Promise<Record<string, never>> {
    this.#assertSession(request.sessionId);
    if (!this.#policy.fs?.write) invalid("ACP filesystem writes are not enabled for this target");
    const operationSignal = this.#combinedSignal(signal);
    assertNotAborted(operationSignal);
    const maxBytes = this.#policy.fs.maxWriteBytes ?? DEFAULT_FILE_LIMIT;
    if (Buffer.byteLength(request.content, "utf8") > maxBytes) invalid("ACP filesystem write exceeds the configured byte limit");
    const { parent, name } = await this.#openContainedParent(request.path);
    try {
      await this.#beforeFileOpen?.("write");
      await this.#assertContainedHandle(parent);
      const handle = await fs.promises.open(
        this.#descriptorChildPath(parent.fd, name),
        fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_NOFOLLOW,
        0o600,
      );
      try {
        await this.#assertContainedHandle(handle);
        const stat = await handle.stat();
        if (!stat.isFile()) invalid("ACP filesystem write target must be a regular file");
        assertNotAborted(operationSignal);
        await handle.truncate(0);
        await handle.writeFile(request.content, "utf8");
        await handle.sync();
        assertNotAborted(operationSignal);
      } finally {
        await handle.close();
      }
    } finally {
      await parent.close();
    }
    return {};
  }

  async createTerminal(request: CreateTerminalRequest, signal: AbortSignal): Promise<CreateTerminalResponse> {
    this.#assertSession(request.sessionId);
    const policy = this.#policy.terminal;
    if (!policy) invalid("ACP terminal operations are not enabled for this target");
    assertNotAborted(this.#combinedSignal(signal));
    const args = request.args ?? [];
    if (args.length > TERMINAL_ARG_COUNT_LIMIT
      || Buffer.byteLength(JSON.stringify(args), "utf8") > TERMINAL_ARG_BYTES_LIMIT
      || args.some((argument) => !argument || argument.includes("\0"))) {
      invalid("Invalid ACP terminal arguments");
    }
    assertSafeTerminalArgv(request.command, args);
    const profile = this.#matchTerminalProfile(request.command, args);
    if (this.#terminals.size >= (policy.maxProcesses ?? DEFAULT_TERMINAL_PROCESSES)) {
      invalid("ACP terminal process limit reached");
    }
    const cwd = request.cwd === undefined || request.cwd === null
      ? this.#root
      : await this.#containedExistingPath(request.cwd, true);
    const additions: Record<string, string> = {};
    const environmentNames = new Set<string>();
    for (const entry of request.env ?? []) {
      const normalizedName = entry.name.toUpperCase();
      if (environmentNames.has(normalizedName)
        || deniedPathLikeEnv(entry)
        || !profile.environment.has(entry.name)
        || entry.value.includes("\0")
        || Buffer.byteLength(entry.value, "utf8") > 8192) {
        invalid("ACP terminal environment variable is not allowed");
      }
      environmentNames.add(normalizedName);
      additions[entry.name] = entry.value;
    }
    let environment: NodeJS.ProcessEnv;
    try {
      environment = sanitizedChildEnvironment({ additions });
    } catch {
      invalid("ACP terminal environment variable violates the child environment policy");
    }
    const outputLimit = boundedPositive(
      request.outputByteLimit,
      policy.maxOutputBytes ?? DEFAULT_TERMINAL_OUTPUT_LIMIT,
      policy.maxOutputBytes ?? DEFAULT_TERMINAL_OUTPUT_LIMIT,
    );
    const child = spawn(profile.executable, args, {
      cwd,
      detached: true,
      env: environment,
      windowsHide: true,
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
    });
    child.stdin.end();
    let resolveExit!: (exit: TerminalExit) => void;
    const exitPromise = new Promise<TerminalExit>((resolve) => { resolveExit = resolve; });
    const terminal: ManagedTerminal = {
      child,
      tree: captureProcessTree(child.pid),
      output: "",
      outputLimit,
      truncated: false,
      exitPromise,
      resolveExit,
      timeout: setTimeout(() => this.#killTerminal(terminal), policy.timeoutMs ?? DEFAULT_TERMINAL_TIMEOUT_MS),
      killStarted: false,
    };
    terminal.timeout.unref?.();
    const append = (chunk: Buffer) => {
      const next = appendUtf8Tail(terminal.output, chunk.toString("utf8"), terminal.outputLimit);
      terminal.output = next.value;
      terminal.truncated ||= next.truncated;
    };
    child.stdout.on("data", append);
    child.stderr.on("data", append);
    child.once("error", (error) => {
      append(Buffer.from(`Terminal process error: ${error.message}`));
      this.#settleTerminal(terminal, { exitCode: null, signal: null });
    });
    child.once("close", (code, exitSignal) => {
      this.#settleTerminal(terminal, { exitCode: code, signal: exitSignal });
    });
    const terminalId = randomUUID();
    this.#terminals.set(terminalId, terminal);
    if (signal.aborted || this.#signal.aborted) this.#killTerminal(terminal);
    return { terminalId };
  }

  terminalOutput(request: TerminalOutputRequest): TerminalOutputResponse {
    this.#assertSession(request.sessionId);
    const terminal = this.#getTerminal(request.terminalId);
    return {
      output: terminal.output,
      truncated: terminal.truncated,
      ...(terminal.exit ? { exitStatus: terminal.exit } : {}),
    };
  }

  async waitForTerminalExit(request: WaitForTerminalExitRequest, signal: AbortSignal): Promise<WaitForTerminalExitResponse> {
    this.#assertSession(request.sessionId);
    const terminal = this.#getTerminal(request.terminalId);
    const exit = terminal.exit ?? await this.#waitWithAbort(terminal.exitPromise, signal);
    return { exitCode: exit.exitCode, signal: exit.signal };
  }

  killTerminal(request: KillTerminalRequest): Record<string, never> {
    this.#assertSession(request.sessionId);
    this.#killTerminal(this.#getTerminal(request.terminalId));
    return {};
  }

  releaseTerminal(request: ReleaseTerminalRequest): Record<string, never> {
    this.#assertSession(request.sessionId);
    const terminal = this.#getTerminal(request.terminalId);
    clearTimeout(terminal.timeout);
    this.#killTerminal(terminal);
    this.#terminals.delete(request.terminalId);
    return {};
  }

  close(): void {
    for (const terminal of this.#terminals.values()) {
      clearTimeout(terminal.timeout);
      this.#killTerminal(terminal);
    }
    this.#terminals.clear();
    if (this.#rootDescriptor !== undefined) {
      fs.closeSync(this.#rootDescriptor);
      this.#rootDescriptor = undefined;
    }
  }

  #selectPermission(tool: string | null | undefined, options: PermissionOption[]): PermissionOption | undefined {
    if (this.#policy.permissionMode === "allow-once") {
      const toolName = (tool ?? "").trim().toLowerCase();
      if (toolName && this.#permissionTools.has(toolName)) {
        const allow = options.find((option) => option.kind === "allow_once");
        if (allow) return allow;
      }
    }
    return options.find((option) => option.kind === "reject_once")
      ?? options.find((option) => option.kind === "reject_always");
  }

  #assertSession(sessionId: string): void {
    const expected = this.#sessionId();
    if (!expected || sessionId !== expected) invalid("ACP client operation has an unknown session id");
  }

  #combinedSignal(requestSignal: AbortSignal): AbortSignal {
    return AbortSignal.any([requestSignal, this.#signal]);
  }

  async #containedExistingPath(requested: string, directory: boolean): Promise<string> {
    if (!path.isAbsolute(requested)) invalid("ACP filesystem paths must be absolute");
    const lexical = path.resolve(requested);
    if (!within(this.#root, lexical)) invalid("ACP filesystem path escapes the configured target root");
    let real: string;
    try { real = await fs.promises.realpath(lexical); } catch { invalid("ACP filesystem path does not exist"); }
    if (!within(this.#root, real!)) invalid("ACP filesystem path escapes the configured target root");
    const stat = await fs.promises.stat(real!);
    if (directory ? !stat.isDirectory() : !stat.isFile()) invalid("ACP filesystem path has the wrong type");
    return real!;
  }

  #canonicalTerminalProfile(profile: RemoteAcpTerminalCommand): CanonicalTerminalProfile {
    assertSafeTerminalExecutable(profile.executable);
    assertSafeTerminalArgv(profile.executable, profile.args);
    if (!path.isAbsolute(profile.executable) || path.normalize(profile.executable) !== profile.executable) {
      invalid("ACP terminal profile executable is not a canonical absolute path");
    }
    const canonical = resolveCanonicalExecutable(profile.executable);
    if (!canonical || !this.#samePath(canonical, profile.executable)) {
      invalid("ACP terminal profile executable is not canonical or does not exist");
    }
    if (profile.environment.some((name) => PATH_LIKE_VARS.has(name.toUpperCase()))) {
      invalid("ACP terminal profile cannot replace launch policy environment");
    }
    return { executable: canonical, args: [...profile.args], environment: new Set(profile.environment) };
  }

  #matchTerminalProfile(command: string, args: readonly string[]): CanonicalTerminalProfile {
    assertSafeTerminalExecutable(command);
    if (!path.isAbsolute(command) || path.normalize(command) !== command) {
      invalid("ACP terminal executable must be a canonical absolute path");
    }
    const canonical = resolveCanonicalExecutable(command);
    if (!canonical || !this.#samePath(canonical, command)) {
      invalid("ACP terminal executable must resolve to its canonical absolute path");
    }
    const profile = this.#terminalProfiles.find((candidate) => this.#samePath(candidate.executable, canonical)
      && candidate.args.length === args.length
      && candidate.args.every((argument, index) => argument === args[index]));
    if (!profile) invalid("ACP terminal command and argv do not match a configured profile");
    return profile;
  }

  #samePath(left: string, right: string): boolean {
    return process.platform === "win32" ? left.toLowerCase() === right.toLowerCase() : left === right;
  }

  async #openContainedParent(requested: string): Promise<{ parent: FileHandle; name: string }> {
    if (!path.isAbsolute(requested)) invalid("ACP filesystem paths must be absolute");
    const lexical = path.resolve(requested);
    if (!within(this.#root, lexical)) invalid("ACP filesystem path escapes the configured target root");
    if (this.#rootDescriptor === undefined) {
      invalid("ACP filesystem operations require descriptor-based containment on this platform");
    }
    const relative = path.relative(this.#root, lexical);
    const components = relative.split(path.sep).filter(Boolean);
    const name = components.pop();
    if (!name || name === "." || name === "..") invalid("ACP filesystem path must name a file");
    let current = await fs.promises.open(
      this.#descriptorPath(this.#rootDescriptor),
      fs.constants.O_RDONLY | fs.constants.O_DIRECTORY,
    );
    try {
      for (const component of components) {
        if (component === "." || component === "..") invalid("ACP filesystem path escapes the configured target root");
        const next = await fs.promises.open(
          this.#descriptorChildPath(current.fd, component),
          fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW,
        );
        await current.close();
        current = next;
      }
      await this.#assertContainedHandle(current);
      return { parent: current, name };
    } catch (error) {
      await current.close();
      throw error;
    }
  }

  #descriptorPath(descriptor: number): string {
    return `/proc/self/fd/${descriptor}`;
  }

  #descriptorChildPath(descriptor: number, child: string): string {
    return path.posix.join(this.#descriptorPath(descriptor), child);
  }

  async #assertContainedHandle(handle: FileHandle): Promise<void> {
    const rootDescriptor = this.#rootDescriptor;
    if (rootDescriptor === undefined) invalid("ACP filesystem descriptor root is closed");
    const [rootReal, handleReal] = await Promise.all([
      fs.promises.realpath(this.#descriptorPath(rootDescriptor)),
      fs.promises.realpath(this.#descriptorPath(handle.fd)),
    ]);
    if (!within(rootReal, handleReal)) invalid("ACP filesystem handle escapes the configured target root");
  }

  #getTerminal(terminalId: string): ManagedTerminal {
    const terminal = this.#terminals.get(terminalId);
    if (!terminal) invalid("Unknown ACP terminal id");
    return terminal!;
  }

  #settleTerminal(terminal: ManagedTerminal, exit: TerminalExit): void {
    if (terminal.exit) return;
    terminal.exit = exit;
    clearTimeout(terminal.timeout);
    terminal.resolveExit(exit);
    this.#killTerminal(terminal);
  }

  #killTerminal(terminal: ManagedTerminal): void {
    if (terminal.killStarted) return;
    terminal.killStarted = true;
    this.#signalTerminalTree(terminal, "SIGTERM");
    const timer = setTimeout(() => {
      this.#signalTerminalTree(terminal, "SIGKILL");
    }, TERMINAL_KILL_GRACE_MS);
    timer.unref?.();
  }

  #signalTerminalTree(terminal: ManagedTerminal, signal: NodeJS.Signals): void {
    try {
      signalProcessTree(terminal.tree, signal);
    } catch (error) {
      const warning = appendUtf8Tail(
        terminal.output,
        `\nTerminal process-tree cleanup warning: ${redactRemoteError(error, { maximumBytes: 512 })}`,
        terminal.outputLimit,
      );
      terminal.output = warning.value;
      terminal.truncated ||= warning.truncated;
    }
  }

  async #waitWithAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
    assertNotAborted(this.#combinedSignal(signal));
    return Promise.race([
      promise,
      new Promise<T>((_resolve, reject) => {
        const abort = () => reject(abortError());
        signal.addEventListener("abort", abort, { once: true });
        this.#signal.addEventListener("abort", abort, { once: true });
      }),
    ]);
  }
}
