import { spawn } from "node:child_process";
import type {
  CodexCommandHook,
  CodexHookEvent,
  CodexHookHandler,
  CodexHooksFile,
} from "./schema.ts";

const MAX_OUTPUT_BYTES = 1024 * 1024;

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
): CodexCommandHook[] {
  const handlers: CodexCommandHook[] = [];
  for (const group of config.hooks[eventName] ?? []) {
    if (!matches(group.matcher, matchValues)) continue;
    for (const handler of group.hooks) {
      if (handler.type === "command" && !handler.async) handlers.push(handler);
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
): Promise<ParsedHookOutput[]> {
  const handlers = getMatchingCommandHooks(config, eventName, matchValues);
  return Promise.all(handlers.map(async (handler) => parseExecution(
    await runCommandHook(handler, input, cwd),
  )));
}

export function runCommandHook(
  handler: CodexCommandHook,
  input: Record<string, unknown>,
  cwd: string,
): Promise<HookCommandExecution> {
  return new Promise((resolve) => {
    const command = process.platform === "win32" && handler.commandWindows
      ? handler.commandWindows
      : handler.command;
    const child = spawn(command, {
      cwd,
      shell: true,
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let settled = false;

    const finish = (exitCode: number | null, error?: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ handler, exitCode, stdout, stderr, timedOut, ...(error ? { error } : {}) });
    };
    const append = (target: "stdout" | "stderr", chunk: Buffer) => {
      if (target === "stdout") stdout += chunk.toString("utf8");
      else stderr += chunk.toString("utf8");
      if (Buffer.byteLength(stdout) + Buffer.byteLength(stderr) > MAX_OUTPUT_BYTES) {
        child.kill();
        finish(null, `hook output exceeded ${MAX_OUTPUT_BYTES} bytes`);
      }
    };
    child.stdout.on("data", (chunk: Buffer) => append("stdout", chunk));
    child.stderr.on("data", (chunk: Buffer) => append("stderr", chunk));
    child.on("error", (error) => finish(null, error.message));
    child.on("close", (code) => {
      if (timedOut && process.platform === "win32") return;
      finish(code, timedOut ? `hook timed out after ${handler.timeout} seconds` : undefined);
    });
    child.stdin.on("error", () => undefined);
    child.stdin.end(JSON.stringify(input));

    const timer = setTimeout(() => {
      timedOut = true;
      const message = `hook timed out after ${handler.timeout} seconds`;
      if (process.platform === "win32" && child.pid) {
        const killer = spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], {
          windowsHide: true,
          stdio: "ignore",
        });
        killer.on("error", () => {
          child.kill();
          finish(null, message);
        });
        killer.on("close", () => finish(null, message));
      } else {
        child.kill();
      }
    }, handler.timeout * 1000);
    timer.unref?.();
  });
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
