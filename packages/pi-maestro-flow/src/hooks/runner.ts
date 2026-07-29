import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import type {
  CodexCommandHook,
  CodexHookEvent,
  CodexHookHandler,
  CodexHooksFile,
} from "./schema.ts";
import { hookHandlerId, hookHandlerIdentity } from "./review.ts";

const MAX_OUTPUT_BYTES = 1024 * 1024;
const TERMINATION_GRACE_MS = 1_000;
const WINDOWS_COMMAND_WRAPPER = `
const fs = require("node:fs");
const { spawn } = require("node:child_process");
const child = spawn(process.argv[1], { shell: true, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
process.stdin.pipe(child.stdin);
let stdoutBytes = 0;
let stderrBytes = 0;
child.stdout.on("data", (chunk) => { stdoutBytes += chunk.length; process.stdout.write(chunk); });
child.stderr.on("data", (chunk) => { stderrBytes += chunk.length; process.stderr.write(chunk); });
let reported = false;
const report = (code) => {
  if (reported) return;
  reported = true;
  let pending = 2;
  const flushed = () => {
    pending -= 1;
    if (pending === 0) {
      fs.writeSync(3, JSON.stringify({ code: code ?? 1, stdoutBytes, stderrBytes }) + "\\n");
    }
  };
  process.stdout.write("", flushed);
  process.stderr.write("", flushed);
};
child.on("error", (error) => { console.error(error.message); report(1); });
child.on("close", report);
setInterval(() => {}, 2147483647);
`;

export interface HookCommandExecution {
  handler: CodexCommandHook;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  error?: string;
}

export interface ParsedHookOutput extends HookCommandExecution {
  json?: Record<string, unknown>;
  plainText?: string;
}

export function getMatchingCommandHooks(
  config: CodexHooksFile,
  eventName: CodexHookEvent,
  matchValues: string[],
  toggles: Readonly<Record<string, boolean>> = {},
): CodexCommandHook[] {
  const handlers: CodexCommandHook[] = [];
  const occurrences = new Map<string, number>();
  for (const group of config.hooks[eventName] ?? []) {
    const groupMatches = matches(group.matcher, matchValues);
    for (const handler of group.hooks) {
      const identity = hookHandlerIdentity(eventName, group.matcher, handler);
      const occurrence = occurrences.get(identity) ?? 0;
      occurrences.set(identity, occurrence + 1);
      if (
        groupMatches
        && handler.type === "command"
        && !handler.async
        && toggles[hookHandlerId(eventName, group.matcher, handler, occurrence)] !== false
      ) handlers.push(handler);
    }
  }
  return handlers;
}

export function countSkippedHandlers(config: CodexHooksFile): number {
  let count = 0;
  for (const groups of Object.values(config.hooks)) {
    for (const group of groups ?? []) {
      count += group.hooks.filter((handler: CodexHookHandler) =>
        handler.type !== "command" || (handler.type === "command" && handler.async === true),
      ).length;
    }
  }
  return count;
}

export async function runMatchingCommandHooks(
  config: CodexHooksFile,
  eventName: CodexHookEvent,
  matchValues: string[],
  input: Record<string, unknown>,
  cwd: string,
  signal?: AbortSignal,
  toggles: Readonly<Record<string, boolean>> = {},
): Promise<ParsedHookOutput[]> {
  const handlers = getMatchingCommandHooks(config, eventName, matchValues, toggles);
  return Promise.all(handlers.map(async (handler) => parseExecution(
    await runCommandHook(handler, input, cwd, signal),
  )));
}

export function runCommandHook(
  handler: CodexCommandHook,
  input: Record<string, unknown>,
  cwd: string,
  signal?: AbortSignal,
): Promise<HookCommandExecution> {
  if (signal?.aborted) {
    return Promise.resolve({
      handler,
      exitCode: null,
      stdout: "",
      stderr: "",
      timedOut: false,
      error: "hook aborted",
    });
  }

  return new Promise((resolve) => {
    const command = process.platform === "win32" && handler.commandWindows
      ? handler.commandWindows
      : handler.command;
    const child = process.platform === "win32"
      ? spawn(process.execPath, ["-e", WINDOWS_COMMAND_WRAPPER, command], {
          cwd,
          windowsHide: true,
          stdio: ["pipe", "pipe", "pipe", "pipe"],
        })
      : spawn(command, {
          cwd,
          detached: true,
          shell: true,
          windowsHide: true,
          stdio: ["pipe", "pipe", "pipe"],
        });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    const completionStream = process.platform === "win32" ? child.stdio[3] : null;
    let completionText = "";
    let completionExitCode: number | null | undefined;
    let expectedStdoutBytes: number | undefined;
    let expectedStderrBytes: number | undefined;
    let receivedStdoutBytes = 0;
    let receivedStderrBytes = 0;
    let outputBytes = 0;
    let timedOut = false;
    let settled = false;
    let terminationStarted = false;
    let treeTerminated = false;
    let childClosed = false;
    let failure: string | undefined;

    const cleanup = (): void => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      child.removeListener("error", onError);
      child.removeListener("close", onClose);
      child.stdout.removeListener("data", onStdout);
      child.stderr.removeListener("data", onStderr);
      completionStream?.removeListener("data", onCompletionData);
      child.stdin.removeListener("error", ignoreStdinError);
    };
    const finish = (exitCode: number | null, error?: string): void => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve({
        handler,
        exitCode,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
        timedOut,
        ...(error ? { error } : {}),
      });
    };
    const finishIfReady = (): void => {
      if (settled || !treeTerminated || !childClosed) return;
      if (failure !== undefined) {
        finish(null, failure);
        return;
      }
      if (completionExitCode !== undefined) finish(completionExitCode);
    };
    const startTermination = (): void => {
      if (terminationStarted || settled) return;
      terminationStarted = true;
      clearTimeout(timer);
      if (failure !== undefined) {
        child.stdout.removeListener("data", onStdout);
        child.stderr.removeListener("data", onStderr);
      }
      void terminateProcessTree(child).then(
        () => {
          treeTerminated = true;
          finishIfReady();
        },
        () => {
          treeTerminated = true;
          finishIfReady();
        },
      );
    };
    const stopWith = (message: string): void => {
      if (failure !== undefined || settled) return;
      failure = message;
      startTermination();
    };
    const maybeStartNormalTermination = (): void => {
      if (
        completionExitCode === undefined
        || expectedStdoutBytes === undefined
        || expectedStderrBytes === undefined
        || receivedStdoutBytes < expectedStdoutBytes
        || receivedStderrBytes < expectedStderrBytes
      ) return;
      startTermination();
    };
    const append = (target: "stdout" | "stderr", chunk: Buffer | string): void => {
      if (failure !== undefined || settled) return;
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, "utf8");
      if (target === "stdout") receivedStdoutBytes += buffer.byteLength;
      else receivedStderrBytes += buffer.byteLength;
      if (outputBytes + buffer.byteLength > MAX_OUTPUT_BYTES) {
        stopWith(`hook output exceeded ${MAX_OUTPUT_BYTES} bytes`);
        return;
      }
      outputBytes += buffer.byteLength;
      (target === "stdout" ? stdout : stderr).push(buffer);
      maybeStartNormalTermination();
    };
    const onStdout = (chunk: Buffer | string): void => append("stdout", chunk);
    const onStderr = (chunk: Buffer | string): void => append("stderr", chunk);
    const onError = (error: Error): void => {
      if (child.pid) stopWith(error.message);
      else finish(null, error.message);
    };
    const onClose = (code: number | null): void => {
      childClosed = true;
      if (failure === undefined && completionExitCode === undefined) {
        if (process.platform === "win32") {
          failure = "hook wrapper exited before reporting completion";
        } else {
          completionExitCode = code;
        }
      }
      startTermination();
      finishIfReady();
    };
    const onCompletionData = (chunk: Buffer | string): void => {
      if (failure !== undefined || completionExitCode !== undefined || settled) return;
      completionText += chunk.toString();
      const newline = completionText.indexOf("\n");
      if (newline < 0) return;
      try {
        const completion = JSON.parse(completionText.slice(0, newline)) as Record<string, unknown>;
        if (
          !Number.isInteger(completion.code)
          || !Number.isInteger(completion.stdoutBytes)
          || !Number.isInteger(completion.stderrBytes)
          || Number(completion.stdoutBytes) < 0
          || Number(completion.stderrBytes) < 0
        ) throw new Error("invalid completion payload");
        completionExitCode = Number(completion.code);
        expectedStdoutBytes = Number(completion.stdoutBytes);
        expectedStderrBytes = Number(completion.stderrBytes);
        maybeStartNormalTermination();
      } catch {
        stopWith("hook wrapper reported invalid completion metadata");
      }
    };
    const onAbort = (): void => stopWith("hook aborted");
    const ignoreStdinError = (): void => undefined;
    const timer = setTimeout(() => {
      timedOut = true;
      stopWith(`hook timed out after ${handler.timeout} seconds`);
    }, handler.timeout * 1000);
    timer.unref?.();

    child.stdout.on("data", onStdout);
    child.stderr.on("data", onStderr);
    completionStream?.on("data", onCompletionData);
    child.once("error", onError);
    child.once("close", onClose);
    child.stdin.on("error", ignoreStdinError);
    if (signal?.aborted) onAbort();
    else signal?.addEventListener("abort", onAbort, { once: true });
    if (failure === undefined) child.stdin.end(JSON.stringify(input));
  });
}

async function terminateProcessTree(child: ChildProcess): Promise<void> {
  if (process.platform === "win32" && child.pid) {
    const result = spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], {
      windowsHide: true,
      stdio: "ignore",
    });
    if (result.error || result.status !== 0) {
      try { child.kill("SIGKILL"); } catch {}
      await waitForExit(child, TERMINATION_GRACE_MS);
    }
    return;
  }

  signalProcessGroup(child, "SIGTERM");
  await waitForExit(child, TERMINATION_GRACE_MS);
  signalProcessGroup(child, "SIGKILL");
  await waitForExit(child, TERMINATION_GRACE_MS);
}

function signalProcessGroup(child: ChildProcess, signal: NodeJS.Signals): void {
  if (child.pid) {
    try {
      process.kill(-child.pid, signal);
      return;
    } catch {}
  }
  try { child.kill(signal); } catch {}
}

function waitForExit(child: ChildProcess, timeoutMs: number): Promise<boolean> {
  if (!isRunning(child)) return Promise.resolve(true);
  return new Promise((resolve) => {
    const cleanup = (): void => {
      clearTimeout(timer);
      child.removeListener("close", onExit);
      child.removeListener("error", onError);
    };
    const settle = (exited: boolean): void => {
      cleanup();
      resolve(exited);
    };
    const onExit = (): void => settle(true);
    const onError = (): void => settle(false);
    const timer = setTimeout(() => settle(false), timeoutMs);
    timer.unref?.();
    child.once("close", onExit);
    child.once("error", onError);
  });
}

function isRunning(child: ChildProcess): boolean {
  return child.exitCode === null && child.signalCode === null;
}

function parseExecution(execution: HookCommandExecution): ParsedHookOutput {
  const stdout = execution.stdout.trim();
  if (!stdout) return execution;
  try {
    const value: unknown = JSON.parse(stdout);
    if (typeof value === "object" && value !== null && !Array.isArray(value)) {
      return { ...execution, json: value as Record<string, unknown> };
    }
  } catch {
    // Plain text is valid only for selected events and is interpreted by the adapter.
  }
  return { ...execution, plainText: stdout };
}

function matches(pattern: string | undefined, values: string[]): boolean {
  if (pattern === undefined || pattern === "" || pattern === "*") return true;
  const regex = new RegExp(pattern);
  return values.some((value) => regex.test(value));
}
