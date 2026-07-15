import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";
import { showSmartSearchConfigOverlay } from "../tui/smart-search-config.ts";

const require = createRequire(import.meta.url);
const DEFAULT_MAX_OUTPUT_BYTES = 1_000_000;

const SmartSearchMode = Type.Unsafe<"search" | "research" | "fetch" | "route">({
  type: "string",
  enum: ["search", "research", "fetch", "route"],
});
const Validation = Type.Unsafe<"fast" | "balanced" | "strict">({
  type: "string",
  enum: ["fast", "balanced", "strict"],
});
const Fallback = Type.Unsafe<"auto" | "off">({ type: "string", enum: ["auto", "off"] });
const Budget = Type.Unsafe<"quick" | "standard" | "deep">({
  type: "string",
  enum: ["quick", "standard", "deep"],
});
const RouterMode = Type.Unsafe<"hybrid" | "rules" | "off">({
  type: "string",
  enum: ["hybrid", "rules", "off"],
});

export const SmartSearchParams = Type.Object({
  mode: SmartSearchMode,
  query: Type.String({ minLength: 1, description: "Search/research/route query, or URL for fetch" }),
  platform: Type.Optional(Type.String({ minLength: 1, description: "Search platform hint" })),
  model: Type.Optional(Type.String({ minLength: 1, description: "Search model override" })),
  extra_sources: Type.Optional(Type.Integer({ minimum: 0, maximum: 20 })),
  validation: Type.Optional(Validation),
  fallback: Type.Optional(Fallback),
  providers: Type.Optional(Type.String({ minLength: 1, description: "Comma-separated search providers" })),
  timeout: Type.Optional(Type.Integer({ minimum: 1, maximum: 600, description: "SmartSearch provider timeout in seconds" })),
  budget: Type.Optional(Budget),
  evidence_dir: Type.Optional(Type.String({ minLength: 1 })),
  router_mode: Type.Optional(RouterMode),
  max_output_bytes: Type.Optional(Type.Integer({ minimum: 1_024, maximum: 10_000_000 })),
});

export interface SmartSearchRunOptions {
  cwd: string;
  signal?: AbortSignal;
  maxOutputBytes: number;
}

export interface SmartSearchRunResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export interface SmartSearchRunner {
  run(args: readonly string[], options: SmartSearchRunOptions): Promise<SmartSearchRunResult>;
}

export interface SmartSearchDetails {
  mode: "search" | "research" | "fetch" | "route";
  query: string;
  command_args: string[];
  result: unknown;
  stderr?: string;
}

export function createSmartSearchRunner(
  resolveWrapper: () => string = () => require.resolve("@konbakuyomu/smart-search/npm/bin/smart-search.js"),
): SmartSearchRunner {
  return {
    run(args, options) {
      if (options.signal?.aborted) return Promise.reject(abortError());
      const wrapperPath = resolveWrapper();
      return new Promise((resolve, reject) => {
        const child = spawn(process.execPath, [wrapperPath, ...args], {
          cwd: options.cwd,
          env: process.env,
          stdio: ["ignore", "pipe", "pipe"],
          windowsHide: true,
        });
        const stdout: Buffer[] = [];
        const stderr: Buffer[] = [];
        let outputBytes = 0;
        let settled = false;
        let failure: Error | undefined;

        const finish = (callback: () => void): void => {
          if (settled) return;
          settled = true;
          options.signal?.removeEventListener("abort", onAbort);
          callback();
        };
        const stopWith = (error: Error): void => {
          if (failure) return;
          failure = error;
          terminateProcessTree(child);
        };
        const collect = (target: Buffer[], chunk: Buffer | string): void => {
          const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          outputBytes += buffer.byteLength;
          if (outputBytes > options.maxOutputBytes) {
            stopWith(new Error(`SmartSearch output exceeded ${options.maxOutputBytes} bytes.`));
            return;
          }
          target.push(buffer);
        };
        const onAbort = (): void => stopWith(abortError());

        options.signal?.addEventListener("abort", onAbort, { once: true });
        child.stdout.on("data", (chunk: Buffer | string) => collect(stdout, chunk));
        child.stderr.on("data", (chunk: Buffer | string) => collect(stderr, chunk));
        child.on("error", (error) => finish(() => reject(error)));
        child.on("close", (code) => finish(() => {
          if (failure) {
            reject(failure);
            return;
          }
          resolve({
            stdout: Buffer.concat(stdout).toString("utf8"),
            stderr: Buffer.concat(stderr).toString("utf8"),
            exitCode: code ?? 5,
          });
        }));
      });
    },
  };
}

const defaultRunner = createSmartSearchRunner();

export function createSmartSearchTool(runner: SmartSearchRunner = defaultRunner): ToolDefinition<typeof SmartSearchParams, SmartSearchDetails> {
  return {
    name: "smart_search",
    label: "Smart Search",
    description: "Run the bundled SmartSearch CLI for live search, deep research, page fetching, or read-only route diagnostics. The package-local npm wrapper is used instead of a global PATH command.",
    promptSnippet: "Use smart_search for web search, evidence-first research, URL fetching, and provider route diagnostics.",
    parameters: SmartSearchParams,
    async execute(_id, params, signal, _onUpdate, ctx): Promise<AgentToolResult<SmartSearchDetails>> {
      if (signal?.aborted) throw abortError();
      const query = params.query.trim();
      if (!query) throw new Error("SmartSearch query is required and must not be empty.");
      const commandArgs = buildSmartSearchArgs({ ...params, query });
      try {
        const execution = await runner.run(commandArgs, {
          cwd: ctx.cwd,
          signal,
          maxOutputBytes: params.max_output_bytes ?? DEFAULT_MAX_OUTPUT_BYTES,
        });
        if (execution.exitCode !== 0) {
          const reason = execution.stderr.trim() || execution.stdout.trim() || `exit code ${execution.exitCode}`;
          throw new Error(`SmartSearch failed with exit code ${execution.exitCode}: ${reason}`);
        }
        const result = parseJsonOutput(execution.stdout);
        const details: SmartSearchDetails = {
          mode: params.mode,
          query,
          command_args: commandArgs,
          result,
          ...(execution.stderr.trim() ? { stderr: execution.stderr.trim() } : {}),
        };
        return {
          content: [{ type: "text", text: JSON.stringify(result) }],
          details,
        } as AgentToolResult<SmartSearchDetails>;
      } catch (error) {
        if (signal?.aborted || isAbortError(error)) throw abortError();
        throw error instanceof Error ? error : new Error(String(error));
      }
    },
  };
}

export function registerSmartSearchTool(pi: ExtensionAPI, runner?: SmartSearchRunner): void {
  pi.registerTool(createSmartSearchTool(runner) as never);
}

export interface RegisterSmartSearchOptions {
  runner?: SmartSearchRunner;
  showConfig?: typeof showSmartSearchConfigOverlay;
}

export function registerSmartSearch(
  pi: ExtensionAPI,
  options: RegisterSmartSearchOptions = {},
): void {
  registerSmartSearchTool(pi, options.runner);
  const showConfig = options.showConfig ?? showSmartSearchConfigOverlay;
  pi.registerCommand("smart-search", {
    description: "配置内置 Smart Search 搜索工具",
    async handler(args, ctx) {
      const action = args.trim().toLowerCase();
      if (action && action !== "config") {
        ctx.ui.notify("用法：/smart-search [config]", "warning");
        return;
      }
      try {
        await showConfig(ctx);
      } catch (error) {
        ctx.ui.notify(`Smart Search 配置打开失败：${errorMessage(error)}`, "error");
      }
    },
  });
}

type SmartSearchInput = Static<typeof SmartSearchParams>;

export function buildSmartSearchArgs(params: SmartSearchInput): string[] {
  const args = [params.mode, params.query, "--format", "json"];
  if (params.mode === "search") {
    appendOption(args, "--platform", params.platform);
    appendOption(args, "--model", params.model);
    appendOption(args, "--extra-sources", params.extra_sources);
    appendOption(args, "--validation", params.validation);
    appendOption(args, "--fallback", params.fallback);
    appendOption(args, "--providers", params.providers);
    appendOption(args, "--timeout", params.timeout);
  } else if (params.mode === "research") {
    appendOption(args, "--budget", params.budget);
    appendOption(args, "--evidence-dir", params.evidence_dir);
    appendOption(args, "--fallback", params.fallback);
  } else if (params.mode === "route") {
    appendOption(args, "--validation", params.validation);
    appendOption(args, "--router-mode", params.router_mode);
  }
  return args;
}

function appendOption(args: string[], flag: string, value: string | number | undefined): void {
  if (value !== undefined) args.push(flag, String(value));
}

function parseJsonOutput(stdout: string): unknown {
  const text = stdout.trim();
  if (!text) throw new Error("SmartSearch returned empty output.");
  try {
    return JSON.parse(text) as unknown;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`SmartSearch returned invalid JSON: ${reason}`);
  }
}

function abortError(): Error {
  const error = new Error("SmartSearch execution aborted.");
  error.name = "AbortError";
  return error;
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

function terminateProcessTree(child: { pid?: number; kill(): boolean }): void {
  if (process.platform === "win32" && child.pid) {
    const killer = spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], {
      windowsHide: true,
      stdio: "ignore",
    });
    killer.once("error", () => { child.kill(); });
    return;
  }
  child.kill();
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
