import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import { Text } from "@earendil-works/pi-tui";
import { toolCallLine, toolResultLine, resultSummary } from "../quiet-render.ts";
import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";
import { showSmartSearchConfigOverlay } from "../tui/smart-search-config.ts";
import { nativeSearch } from "./web-access/search-router.ts";
import { nativeFetch } from "./web-access/fetch-router.ts";

const require = createRequire(import.meta.url);
const DEFAULT_MAX_OUTPUT_BYTES = 1_000_000;

type SmartSearchModeValue = "search" | "research" | "fetch" | "route";
type ValidationValue = "fast" | "balanced" | "strict";
type FallbackValue = "auto" | "off";
type BudgetValue = "quick" | "standard" | "deep";
type RouterModeValue = "hybrid" | "rules" | "off";

const SmartSearchMode = Type.Unsafe<SmartSearchModeValue>({
  type: "string",
  enum: ["search", "research", "fetch", "route"],
  description: "search: quick web results; research: multi-source deep analysis; fetch: retrieve a URL; route: provider diagnostics",
});
const Validation = Type.Unsafe<ValidationValue>({
  type: "string",
  enum: ["fast", "balanced", "strict"],
  description: "Source validation depth: fast (minimal), balanced (default), strict (cross-check for security/compliance claims)",
});
const Fallback = Type.Unsafe<FallbackValue>({
  type: "string",
  enum: ["auto", "off"],
  description: "Provider fallback on failure: auto (try alternatives) or off",
});
const Budget = Type.Unsafe<BudgetValue>({
  type: "string",
  enum: ["quick", "standard", "deep"],
  description: "Research effort budget: quick (few sources), standard (default), deep (exhaustive)",
});
const RouterMode = Type.Unsafe<RouterModeValue>({
  type: "string",
  enum: ["hybrid", "rules", "off"],
  description: "Provider routing strategy: hybrid (LLM + rules), rules (deterministic), off (single provider)",
});

export const SmartSearchParams = Type.Object({
  mode: SmartSearchMode,
  query: Type.String({ minLength: 1, description: "Search/research/route query, or URL for fetch" }),
  platform: Type.Optional(Type.String({ minLength: 1, description: "Search platform hint" })),
  model: Type.Optional(Type.String({ minLength: 1, description: "Search model override" })),
  extra_sources: Type.Optional(Type.Integer({ minimum: 0, maximum: 20, description: "Additional sources beyond the default count" })),
  validation: Type.Optional(Validation),
  fallback: Type.Optional(Fallback),
  providers: Type.Optional(Type.String({ minLength: 1, description: "Comma-separated search providers" })),
  timeout: Type.Optional(Type.Integer({ minimum: 1, maximum: 600, description: "SmartSearch provider timeout in seconds" })),
  budget: Type.Optional(Budget),
  evidence_dir: Type.Optional(Type.String({ minLength: 1, description: "Directory to write research evidence artifacts" })),
  router_mode: Type.Optional(RouterMode),
  max_output_bytes: Type.Optional(Type.Integer({ minimum: 1_024, maximum: 10_000_000, description: "Output size cap in bytes (default: 1 MB)" })),
  native: Type.Optional(Type.Boolean({ description: "Use native TS search providers instead of Python CLI" })),
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
    description: "Run the bundled SmartSearch CLI for live search, deep research, page fetching, or read-only route diagnostics. The package-local npm wrapper is used instead of a global PATH command. " +
      "Example: { mode: \"search\", query: \"TypeBox schema validation\" } or { mode: \"fetch\", query: \"https://example.com/api\" }.",
    promptSnippet: "Use smart_search for web search, evidence-first research, URL fetching, and provider route diagnostics.",
    parameters: SmartSearchParams,
    async execute(_id, params, signal, _onUpdate, ctx): Promise<AgentToolResult<SmartSearchDetails>> {
      if (signal?.aborted) throw abortError();
      const query = params.query.trim();
      if (!query) throw new Error("SmartSearch query is required and must not be empty.");
      const mode = parseSmartSearchMode(params.mode);

      if (params.native && mode === "search") {
        return executeNativeSearch(query, params, signal);
      }

      if (params.native && mode === "fetch") {
        return executeNativeFetch(query, signal);
      }

      const { validation: rawValidation, fallback: rawFallback, budget: rawBudget, router_mode: rawRouterMode, native: _native, ...restParams } = params;
      const commandArgs = buildSmartSearchArgs({
        ...restParams,
        mode,
        query,
        validation: parseValidation(rawValidation),
        fallback: parseFallback(rawFallback),
        budget: parseBudget(rawBudget),
        router_mode: parseRouterMode(rawRouterMode),
      } as SmartSearchInput);
      try {
        const execution = await runner.run(commandArgs, {
          cwd: ctx.cwd,
          signal,
          maxOutputBytes: params.max_output_bytes ?? DEFAULT_MAX_OUTPUT_BYTES,
        });
        if (execution.exitCode !== 0) {
          const reason = execution.stderr.trim() || execution.stdout.trim() || `exit code ${execution.exitCode}`;
          if (isConfigError(reason) && (mode === "search" || mode === "fetch")) {
            return mode === "search"
              ? executeNativeSearch(query, params, signal)
              : executeNativeFetch(query, signal);
          }
          throw new Error(`SmartSearch failed with exit code ${execution.exitCode}: ${reason}`);
        }
        const result = parseJsonOutput(execution.stdout);
        const details: SmartSearchDetails = {
          mode,
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
    renderShell: "self",
    renderCall(args, theme, ctx) {
      if (ctx?.isPartial === false) return new Text("", 0, 0);
      const mode = String(args.mode ?? "search");
      const query = String(args.query ?? "").slice(0, 60);
      return toolCallLine(theme, "smart_search", `${mode} "${query}"`);
    },
    renderResult(result, opts, theme, ctx) {
      if (opts.isPartial) return new Text("", 0, 0);
      const isError = (result as { isError?: boolean }).isError === true;
      const text = result.content[0] && "text" in result.content[0] ? result.content[0].text : "";
      const mode = String(ctx.args.mode ?? "search");
      const query = String(ctx.args.query ?? "").slice(0, 60);
      return toolResultLine(theme, {
        name: "smart_search",
        ok: !isError,
        arg: `${mode} "${query}"`,
        summary: resultSummary(result),
        expanded: opts.expanded,
        detail: text,
      });
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

async function executeNativeFetch(
  url: string,
  signal?: AbortSignal,
): Promise<AgentToolResult<SmartSearchDetails>> {
  try {
    const result = await nativeFetch({ urls: [url], signal });
    const details: SmartSearchDetails = {
      mode: "fetch",
      query: url,
      command_args: ["native-fetch", url],
      result,
    };
    return {
      content: [{ type: "text", text: JSON.stringify(result) }],
      details,
    } as AgentToolResult<SmartSearchDetails>;
  } catch (error) {
    if (signal?.aborted || isAbortError(error)) throw abortError();
    throw error instanceof Error ? error : new Error(String(error));
  }
}

async function executeNativeSearch(
  query: string,
  params: { providers?: string; extra_sources?: number },
  signal?: AbortSignal,
): Promise<AgentToolResult<SmartSearchDetails>> {
  try {
    const result = await nativeSearch({
      query,
      provider: params.providers?.split(",")[0]?.trim(),
      numResults: params.extra_sources ? params.extra_sources + 5 : undefined,
      includeContent: true,
      signal,
    });
    const details: SmartSearchDetails = {
      mode: "search",
      query,
      command_args: ["native", query],
      result,
    };
    return {
      content: [{ type: "text", text: JSON.stringify(result) }],
      details,
    } as AgentToolResult<SmartSearchDetails>;
  } catch (error) {
    if (signal?.aborted || isAbortError(error)) throw abortError();
    throw error instanceof Error ? error : new Error(String(error));
  }
}

interface SmartSearchInput extends Omit<Static<typeof SmartSearchParams>, "mode" | "validation" | "fallback" | "budget" | "router_mode" | "native"> {
  mode: SmartSearchModeValue;
  validation?: ValidationValue;
  fallback?: FallbackValue;
  budget?: BudgetValue;
  router_mode?: RouterModeValue;
}

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

function parseSmartSearchMode(value: unknown): SmartSearchModeValue {
  if (value === "search" || value === "research" || value === "fetch" || value === "route") return value;
  throw new Error("SmartSearch mode is invalid.");
}

function parseValidation(value: unknown): ValidationValue | undefined {
  if (value === undefined) return undefined;
  if (value === "fast" || value === "balanced" || value === "strict") return value;
  throw new Error("SmartSearch validation mode is invalid.");
}

function parseFallback(value: unknown): FallbackValue | undefined {
  if (value === undefined) return undefined;
  if (value === "auto" || value === "off") return value;
  throw new Error("SmartSearch fallback mode is invalid.");
}

function parseBudget(value: unknown): BudgetValue | undefined {
  if (value === undefined) return undefined;
  if (value === "quick" || value === "standard" || value === "deep") return value;
  throw new Error("SmartSearch budget is invalid.");
}

function parseRouterMode(value: unknown): RouterModeValue | undefined {
  if (value === undefined) return undefined;
  if (value === "hybrid" || value === "rules" || value === "off") return value;
  throw new Error("SmartSearch router mode is invalid.");
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

function isConfigError(reason: string): boolean {
  try {
    const parsed = JSON.parse(reason) as { error_type?: string };
    return parsed.error_type === "config_error";
  } catch {
    return reason.includes("config_error");
  }
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
