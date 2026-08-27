import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import { Text } from "@earendil-works/pi-tui";
import { toolCallLine, toolResultLine, resultSummary } from "../quiet-render.ts";
import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";
import { showSmartSearchConfigOverlay } from "../tui/smart-search-config.ts";
import { getTuiLocale } from "../tui/locale.ts";
import type { SupportedSettingsLocale } from "pi-maestro-settings-core/v1";
import { nativeSearch } from "./web-access/search-router.ts";
import { nativeFetch } from "./web-access/fetch-router.ts";
import { reclaimOwnedProcessTree } from "../process/owned-process-tree.ts";

const require = createRequire(import.meta.url);
const DEFAULT_MAX_OUTPUT_BYTES = 1_000_000;
const DEFAULT_HOST_TIMEOUT_MS = 90_000;

const SMART_SEARCH_UI = {
  en: {
    description: "Configure the built-in Smart Search tool",
    usage: "Usage: /smart-search [config]",
    openFailed: "Failed to open Smart Search configuration: {message}",
  },
  "zh-CN": {
    description: "配置内置 Smart Search 搜索工具",
    usage: "用法：/smart-search [config]",
    openFailed: "Smart Search 配置打开失败：{message}",
  },
} as const;

function smartSearchUiText(
  key: keyof (typeof SMART_SEARCH_UI)["en"],
  vars?: Readonly<Record<string, string | number>>,
  explicitLocale?: SupportedSettingsLocale,
): string {
  const locale = getTuiLocale(explicitLocale);
  const template = SMART_SEARCH_UI[locale]?.[key] ?? SMART_SEARCH_UI.en[key];
  if (!vars) return template;
  return template.replace(/\{(\w+)\}/g, (_match, name: string) =>
    vars[name] !== undefined ? String(vars[name]) : `{${name}}`);
}

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
  timeout: Type.Optional(Type.Integer({ minimum: 1, maximum: 600, description: "Host wall-clock deadline in seconds (also forwarded to search providers)" })),
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
  /** Optional for injected-runner compatibility; the built-in runner defaults to 90 seconds. */
  timeoutMs?: number;
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
      const timeoutMs = positiveInteger(options.timeoutMs ?? DEFAULT_HOST_TIMEOUT_MS, "timeoutMs");
      const wrapperPath = resolveWrapper();
      return new Promise((resolve, reject) => {
        const child = spawn(process.execPath, [wrapperPath, ...args], {
          cwd: options.cwd,
          // POSIX group isolation only: the child remains referenced and every
          // terminal path reclaims the group before this runner settles.
          detached: process.platform !== "win32",
          env: process.env,
          stdio: ["ignore", "pipe", "pipe"],
          windowsHide: true,
        });
        const stdout: Buffer[] = [];
        const stderr: Buffer[] = [];
        let outputBytes = 0;
        let settled = false;
        let failure: Error | undefined;
        let reclamationStarted = false;
        let closeSeen = false;
        let normalExitCode: number | null = null;
        let normalReclamationComplete = false;

        const cleanup = (): void => {
          clearTimeout(timer);
          options.signal?.removeEventListener("abort", onAbort);
          child.removeListener("error", onError);
          child.removeListener("exit", onExit);
          child.removeListener("close", onClose);
          child.stdout.removeListener("data", onStdout);
          child.stdout.removeListener("error", onStdoutError);
          child.stderr.removeListener("data", onStderr);
          child.stderr.removeListener("error", onStderrError);
        };
        const finish = (callback: () => void): void => {
          if (settled) return;
          settled = true;
          cleanup();
          callback();
        };
        const stopWith = (error: Error): void => {
          if (failure || settled || reclamationStarted) return;
          failure = error;
          reclamationStarted = true;
          clearTimeout(timer);
          options.signal?.removeEventListener("abort", onAbort);
          child.stdout.removeListener("data", onStdout);
          child.stderr.removeListener("data", onStderr);
          void reclaimOwnedProcessTree(child, { label: "SmartSearch CLI" }).then(
            () => finish(() => reject(error)),
            (cleanupError) => {
              error.message = `${error.message} Process-tree cleanup failed: ${errorMessage(cleanupError)}`;
              finish(() => reject(error));
            },
          );
        };
        const collect = (target: Buffer[], chunk: Buffer | string): void => {
          if (failure || settled) return;
          const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          if (outputBytes + buffer.byteLength > options.maxOutputBytes) {
            stopWith(new Error(`SmartSearch output exceeded ${options.maxOutputBytes} bytes.`));
            return;
          }
          outputBytes += buffer.byteLength;
          target.push(buffer);
        };
        const finishNormalClose = (): void => {
          if (!closeSeen || !normalReclamationComplete || failure || settled) return;
          finish(() => resolve({
            stdout: Buffer.concat(stdout).toString("utf8"),
            stderr: Buffer.concat(stderr).toString("utf8"),
            exitCode: normalExitCode ?? 5,
          }));
        };
        const startNormalReclamation = (code: number | null): void => {
          if (failure || settled || reclamationStarted) return;
          reclamationStarted = true;
          normalExitCode = code;
          clearTimeout(timer);
          options.signal?.removeEventListener("abort", onAbort);
          void reclaimOwnedProcessTree(child, { label: "SmartSearch CLI" }).then(
            () => {
              normalReclamationComplete = true;
              finishNormalClose();
            },
            (cleanupError) => finish(() => reject(new Error(
              `SmartSearch CLI exited but process-tree cleanup was unconfirmed: ${errorMessage(cleanupError)}`,
            ))),
          );
        };
        const onStdout = (chunk: Buffer | string): void => collect(stdout, chunk);
        const onStderr = (chunk: Buffer | string): void => collect(stderr, chunk);
        const onStdoutError = (error: Error): void => stopWith(new Error(`SmartSearch stdout failed: ${errorMessage(error)}`));
        const onStderrError = (error: Error): void => stopWith(new Error(`SmartSearch stderr failed: ${errorMessage(error)}`));
        const onAbort = (): void => stopWith(signalError(options.signal));
        const onError = (error: Error): void => {
          if (child.pid) stopWith(error);
          else finish(() => reject(error));
        };
        const onExit = (code: number | null): void => startNormalReclamation(code);
        const onClose = (code: number | null): void => {
          closeSeen = true;
          startNormalReclamation(code);
          finishNormalClose();
        };
        const timer = setTimeout(
          () => stopWith(new Error(`SmartSearch timed out after ${timeoutMs}ms.`)),
          timeoutMs,
        );
        timer.unref?.();

        child.stdout.on("data", onStdout);
        child.stdout.on("error", onStdoutError);
        child.stderr.on("data", onStderr);
        child.stderr.on("error", onStderrError);
        child.once("error", onError);
        child.once("exit", onExit);
        child.once("close", onClose);
        if (options.signal?.aborted) onAbort();
        else options.signal?.addEventListener("abort", onAbort, { once: true });
      });
    },
  };
}

const defaultRunner = createSmartSearchRunner();

export interface SmartSearchExecutors {
  nativeSearch?: typeof nativeSearch;
  nativeFetch?: typeof nativeFetch;
}

export function createSmartSearchTool(
  runner: SmartSearchRunner = defaultRunner,
  executors: SmartSearchExecutors = {},
): ToolDefinition<typeof SmartSearchParams, SmartSearchDetails> {
  const executeSearch = executors.nativeSearch ?? nativeSearch;
  const executeFetch = executors.nativeFetch ?? nativeFetch;
  return {
    name: "smart_search",
    label: "Smart Search",
    description: "Run the bundled SmartSearch CLI for live search, deep research, page fetching, or read-only route diagnostics. The package-local npm wrapper is used instead of a global PATH command. " +
      "Example: { mode: \"search\", query: \"TypeBox schema validation\" } or { mode: \"fetch\", query: \"https://example.com/api\" }.",
    promptSnippet: "Use smart_search for web search, evidence-first research, URL fetching, and provider route diagnostics.",
    parameters: SmartSearchParams,
    async execute(_id, params, callerSignal, _onUpdate, ctx): Promise<AgentToolResult<SmartSearchDetails>> {
      const query = params.query.trim();
      if (!query) throw new Error("SmartSearch query is required and must not be empty.");
      const mode = parseSmartSearchMode(params.mode);
      const timeoutMs = (params.timeout ?? DEFAULT_HOST_TIMEOUT_MS / 1_000) * 1_000;
      const operation = composeCallerAndDeadlineSignal(callerSignal, timeoutMs);

      try {
        if (operation.signal.aborted) throw signalError(operation.signal);
        if (params.native && mode === "search") {
          return await executeNativeSearch(query, params, operation.signal, executeSearch);
        }

        if (params.native && mode === "fetch") {
          return await executeNativeFetch(query, operation.signal, executeFetch);
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
            signal: operation.signal,
            maxOutputBytes: params.max_output_bytes ?? DEFAULT_MAX_OUTPUT_BYTES,
            timeoutMs,
          });
          if (execution.exitCode !== 0) {
            const reason = execution.stderr.trim() || execution.stdout.trim() || `exit code ${execution.exitCode}`;
            if (isConfigError(reason) && (mode === "search" || mode === "fetch")) {
              return mode === "search"
                ? await executeNativeSearch(query, params, operation.signal, executeSearch)
                : await executeNativeFetch(query, operation.signal, executeFetch);
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
          if (operation.signal.aborted || isAbortError(error)) throw signalError(operation.signal, error);
          if (isOptionalPackageMissing(error)) {
            if (mode === "search") return await executeNativeSearch(query, params, operation.signal, executeSearch);
            if (mode === "fetch") return await executeNativeFetch(query, operation.signal, executeFetch);
            throw new Error(
              `SmartSearch mode "${mode}" requires the optional Python CLI package @konbakuyomu/smart-search, which is not installed. ` +
              "Install it with: npm install @konbakuyomu/smart-search (requires Python 3.10+). " +
              'Alternatively, use { native: true } for search/fetch modes.',
            );
          }
          throw error instanceof Error ? error : new Error(String(error));
        }
      } finally {
        operation.dispose();
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
  /** Explicit UI language; otherwise follows the shared runtime TUI locale. */
  locale?: SupportedSettingsLocale;
}

export function registerSmartSearch(
  pi: ExtensionAPI,
  options: RegisterSmartSearchOptions = {},
): void {
  registerSmartSearchTool(pi, options.runner);
  const showConfig = options.showConfig ?? showSmartSearchConfigOverlay;
  pi.registerCommand("smart-search", {
    description: smartSearchUiText("description", undefined, options.locale),
    async handler(args, ctx) {
      const action = args.trim().toLowerCase();
      if (action && action !== "config") {
        ctx.ui.notify(smartSearchUiText("usage", undefined, options.locale), "warning");
        return;
      }
      try {
        await showConfig(ctx, undefined, undefined, options.locale);
      } catch (error) {
        ctx.ui.notify(smartSearchUiText("openFailed", { message: errorMessage(error) }, options.locale), "error");
      }
    },
  });
}

async function executeNativeFetch(
  url: string,
  signal: AbortSignal,
  fetchExecutor: typeof nativeFetch,
): Promise<AgentToolResult<SmartSearchDetails>> {
  try {
    if (signal.aborted) throw signalError(signal);
    const result = await fetchExecutor({ urls: [url], signal });
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
    if (signal.aborted || isAbortError(error)) throw signalError(signal, error);
    throw error instanceof Error ? error : new Error(String(error));
  }
}

async function executeNativeSearch(
  query: string,
  params: { providers?: string; extra_sources?: number },
  signal: AbortSignal,
  searchExecutor: typeof nativeSearch,
): Promise<AgentToolResult<SmartSearchDetails>> {
  try {
    if (signal.aborted) throw signalError(signal);
    const result = await searchExecutor({
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
    if (signal.aborted || isAbortError(error)) throw signalError(signal, error);
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

function timeoutError(timeoutMs: number): Error {
  const error = new Error(`SmartSearch timed out after ${timeoutMs}ms.`);
  error.name = "TimeoutError";
  return error;
}

function signalError(signal?: AbortSignal, fallback?: unknown): Error {
  if (signal?.aborted && signal.reason instanceof Error) return signal.reason;
  if (fallback instanceof Error && isAbortError(fallback)) return fallback;
  return abortError();
}

function composeCallerAndDeadlineSignal(
  callerSignal: AbortSignal | undefined,
  timeoutMs: number,
): { signal: AbortSignal; dispose(): void } {
  const controller = new AbortController();
  const onCallerAbort = (): void => controller.abort(abortError());
  if (callerSignal?.aborted) onCallerAbort();
  else callerSignal?.addEventListener("abort", onCallerAbort, { once: true });
  const timer = controller.signal.aborted
    ? undefined
    : setTimeout(() => controller.abort(timeoutError(timeoutMs)), timeoutMs);
  return {
    signal: controller.signal,
    dispose() {
      if (timer) clearTimeout(timer);
      callerSignal?.removeEventListener("abort", onCallerAbort);
    },
  };
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

function isOptionalPackageMissing(error: unknown): boolean {
  return error instanceof Error
    && "code" in error
    && (error as NodeJS.ErrnoException).code === "MODULE_NOT_FOUND"
    && error.message.includes("@konbakuyomu/smart-search");
}

function positiveInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) throw new RangeError(`${label} must be a positive integer`);
  return value;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
