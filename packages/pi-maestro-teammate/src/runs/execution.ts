/**
 * Core teammate execution engine.
 *
 * Spawns a pi subprocess for agent execution, parses JSON lines from
 * stdout, tracks usage and progress, handles abort signals, and returns
 * a SingleResult.
 *
 * Supports single, parallel (tasks[]), and chain (chain[]) execution modes.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { listAgentSummaries, resolveAgent, type AgentConfig } from "../agents/agents.ts";
import { resolvePromptTask } from "../prompts/prompts.ts";
import { resolveReplyTo, type ReplyTarget } from "../shared/routing.ts";
import type { SingleResult, Usage, AgentProgress } from "../shared/types.ts";
import { wrapLeasedMessage, type LeaseToken } from "./session-handoff.ts";
import type { TeammateTaskType } from "../models/model-routing.ts";
import type { TeammateModelCapability } from "../models/model-catalog.ts";
import { getTeammateChildExtensions } from "./child-extensions.ts";
import {
  parseTeammateThinkingLevel,
  type TeammateThinkingInput,
  type TeammateThinkingLevel,
} from "../shared/thinking.ts";

// ---------------------------------------------------------------------------
// Public param / option interfaces
// ---------------------------------------------------------------------------

export interface RunTeammateParams {
  agent: string;
  task?: string;
  prompt?: string;
  promptArgs?: string[];
  taskType?: TeammateTaskType;
  name?: string;
  reply_to?: "caller" | "main";
  protocol_version?: number;
  background?: boolean;
  context?: "fresh" | "fork";
  model?: string;
  thinking?: TeammateThinkingInput;
  cwd?: string;
  timeoutMs?: number;
  outputSchema?: Record<string, unknown>;
  tasks?: Array<{ agent: string; task?: string; prompt?: string; promptArgs?: string[]; taskType?: TeammateTaskType; name?: string; dependsOn?: string[]; context?: "fresh" | "fork"; model?: string; thinking?: TeammateThinkingInput; cwd?: string; outputSchema?: Record<string, unknown>; timeoutMs?: number }>;
  chain?: Array<{ agent: string; task?: string; prompt?: string; promptArgs?: string[]; taskType?: TeammateTaskType; model?: string; thinking?: TeammateThinkingInput }>;
  concurrency?: number;
}

export interface RunTeammateOptions {
  baseCwd: string;
  modelCapabilities?: readonly TeammateModelCapability[];
  correlationId?: string;
  taskCorrelationIds?: string[];
  signal?: AbortSignal;
  onProgress?: (data: AgentProgress) => void;
  onChildRequest?: (event: Record<string, unknown>, reply: (msg: unknown) => void) => void;
  onChildEvent?: (event: Record<string, unknown>) => void;
  parentSessionFile?: string;
  initialLeaseToken?: LeaseToken | ((correlationId: string) => LeaseToken | undefined);
  onChildSpawned?: (
    stdin: import("node:stream").Writable,
    sendControl: (message: Record<string, unknown>) => boolean,
    sessionDir?: string,
    correlationId?: string,
  ) => void;
  onTurnComplete?: (result: SingleResult) => void;
}

// ---------------------------------------------------------------------------
// Normalized task specification (unified across single/parallel/chain/graph)
// ---------------------------------------------------------------------------

export interface NormalizedTask {
  agent: string;
  task: string;
  prompt?: string;
  promptArgs?: string[];
  taskType?: TeammateTaskType;
  name?: string;
  dependsOn?: string[];
  context?: "fresh" | "fork";
  model?: string;
  thinking?: TeammateThinkingLevel;
  cwd?: string;
  outputSchema?: Record<string, unknown>;
  timeoutMs?: number;
}

// ---------------------------------------------------------------------------
// Internal types
// ---------------------------------------------------------------------------

interface JsonLineEvent {
  type: string;
  content?: string;
  usage?: Partial<Usage>;
  model?: string;
  error?: string;
  name?: string;
  [key: string]: unknown;
}

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

function extractTextContent(event: JsonLineEvent): string | undefined {
  if (typeof event.content === "string") return event.content;
  // AgentMessage format: { message: { content: [{type:"text", text:"..."}] } }
  const msg = event.message as Record<string, unknown> | undefined;
  if (msg?.content) {
    if (typeof msg.content === "string") return msg.content;
    if (Array.isArray(msg.content)) {
      return (msg.content as Array<{ type: string; text?: string }>)
        .filter((c) => c.type === "text" && c.text)
        .map((c) => c.text!)
        .join("\n") || undefined;
    }
  }
  return undefined;
}

function emptyUsage(): Usage {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    cost: 0,
    turns: 0,
  };
}

function accumulateUsage(total: Usage, partial: Partial<Usage>): void {
  if (partial.inputTokens) total.inputTokens += partial.inputTokens;
  if (partial.outputTokens) total.outputTokens += partial.outputTokens;
  if (partial.cacheReadTokens)
    total.cacheReadTokens += partial.cacheReadTokens;
  if (partial.cacheWriteTokens)
    total.cacheWriteTokens += partial.cacheWriteTokens;
  if (partial.cost) total.cost += partial.cost;
}

// ---------------------------------------------------------------------------
// Variable reference resolution
// ---------------------------------------------------------------------------

const VAR_PATTERN_SOURCE = "\\{([a-zA-Z_][a-zA-Z0-9_-]*)((?:\\.[a-zA-Z_][a-zA-Z0-9_-]*|\\[\\d+\\])*)\\}";

interface TaskOutput {
  text: string;
  structured?: unknown;
}

export function extractDependencies(
  template: string | undefined,
  taskNames: Set<string>,
): string[] {
  if (!template) return [];
  const deps: string[] = [];
  const pattern = new RegExp(VAR_PATTERN_SOURCE, "g");
  let m;
  while ((m = pattern.exec(template)) !== null) {
    const name = m[1];
    if (taskNames.has(name) && !deps.includes(name)) {
      deps.push(name);
    }
  }
  return deps;
}

/**
 * Collect `{name}` references in a template that do NOT match any task name.
 * These are passed through as literal text at resolution time — surfacing
 * them lets callers distinguish intentional literals from misspelled refs.
 */
export function collectUnknownRefs(
  template: string | undefined,
  taskNames: Set<string>,
): string[] {
  if (!template) return [];
  const unknown: string[] = [];
  const pattern = new RegExp(VAR_PATTERN_SOURCE, "g");
  let m;
  while ((m = pattern.exec(template)) !== null) {
    const name = m[1];
    if (!taskNames.has(name) && !unknown.includes(name)) {
      unknown.push(name);
    }
  }
  return unknown;
}

function editDistance(a: string, b: string): number {
  const rows = a.length + 1;
  const cols = b.length + 1;
  const dist: number[] = new Array(cols).fill(0).map((_, j) => j);
  for (let i = 1; i < rows; i++) {
    let prevDiag = dist[0];
    dist[0] = i;
    for (let j = 1; j < cols; j++) {
      const tmp = dist[j];
      dist[j] = Math.min(
        dist[j] + 1,
        dist[j - 1] + 1,
        prevDiag + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
      prevDiag = tmp;
    }
  }
  return dist[cols - 1];
}

/**
 * Union of a task's implicit `{name}` references and explicit dependsOn names.
 * Single source of truth for graph edges — used by inferGraphMode, runGraph,
 * and progress snapshots so all three agree on the dependency set.
 */
export function taskDependencyNames(
  task: Pick<NormalizedTask, "task" | "dependsOn">,
  taskNames: Set<string>,
): string[] {
  const deps = extractDependencies(task.task, taskNames);
  for (const name of task.dependsOn ?? []) {
    if (taskNames.has(name) && !deps.includes(name)) deps.push(name);
  }
  return deps;
}

/**
 * Validate task references before dispatch.
 *
 * - dependsOn entries must match an existing task name — strict error
 *   (no literal-text ambiguity exists for an explicit dependency list).
 * - Unknown `{name}` refs close to an existing task name (edit distance)
 *   are treated as misspellings — error, because silently running the task
 *   without the intended dependency is worse than rejecting.
 * - Other unknown `{name}` refs are legitimate literals — warning only.
 *   Skipped entirely when no task has a name (reference intent impossible).
 */
export function validateTaskReferences(
  tasks: NormalizedTask[],
): { errors: string[]; warnings: string[] } {
  const errors: string[] = [];
  const warnings: string[] = [];
  const taskNames = new Set(tasks.filter((t) => t.name).map((t) => t.name!));

  tasks.forEach((t, i) => {
    const label = t.name ? `tasks[${i}] "${t.name}"` : `tasks[${i}]`;
    for (const name of t.dependsOn ?? []) {
      if (!taskNames.has(name)) {
        errors.push(`${label}: dependsOn references unknown task name "${name}"`);
      }
    }
    if (taskNames.size === 0) return;
    for (const name of collectUnknownRefs(t.task, taskNames)) {
      const threshold = name.length <= 3 ? 1 : 2;
      const close = [...taskNames].find(
        (candidate) => candidate !== t.name && editDistance(name, candidate) <= threshold,
      );
      if (close) {
        errors.push(
          `${label}: "{${name}}" looks like a misspelled reference to task "${close}" — fix the reference or rename the task`,
        );
      } else {
        warnings.push(
          `${label}: "{${name}}" does not match any task name and will be passed through as literal text`,
        );
      }
    }
  });

  return { errors, warnings };
}

function resolvePath(obj: unknown, pathStr: string): unknown {
  const parts = pathStr.split(/\.|\[|\]/).filter(Boolean);
  let current = obj;
  for (const part of parts) {
    if (current === null || current === undefined) return undefined;
    if (typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

export function resolveVariables(
  template: string,
  outputs: Map<string, TaskOutput>,
  taskNames: Set<string>,
): string {
  return template.replace(
    new RegExp(VAR_PATTERN_SOURCE, "g"),
    (match, name: string, pathSuffix: string) => {
      if (!taskNames.has(name)) return match;
      const output = outputs.get(name);
      if (!output) return match;

      if (!pathSuffix) {
        if (output.structured !== undefined) {
          return typeof output.structured === "string"
            ? output.structured
            : JSON.stringify(output.structured);
        }
        return output.text;
      }

      if (output.structured === undefined) {
        throw new Error(
          `Task "${name}" has no structured output for field access "${pathSuffix}"`,
        );
      }
      const value = resolvePath(output.structured, pathSuffix.slice(1));
      if (value === undefined) {
        throw new Error(
          `Field "${pathSuffix}" not found in task "${name}" structured output`,
        );
      }
      return typeof value === "string" ? value : JSON.stringify(value);
    },
  );
}

// ---------------------------------------------------------------------------
// Dependency graph utilities
// ---------------------------------------------------------------------------

function hasCycle(adjList: number[][]): boolean {
  const n = adjList.length;
  const state = new Array<number>(n).fill(0);

  function dfs(node: number): boolean {
    if (state[node] === 1) return true;
    if (state[node] === 2) return false;
    state[node] = 1;
    for (const dep of adjList[node]) {
      if (dfs(dep)) return true;
    }
    state[node] = 2;
    return false;
  }

  for (let i = 0; i < n; i++) {
    if (dfs(i)) return true;
  }
  return false;
}

export function inferGraphMode(
  tasks: NormalizedTask[],
): "parallel" | "chain" | "graph" {
  const taskNames = new Set(tasks.filter((t) => t.name).map((t) => t.name!));
  if (taskNames.size === 0) return "parallel";

  let hasDeps = false;
  let allLinear = true;

  for (let i = 0; i < tasks.length; i++) {
    const deps = taskDependencyNames(tasks[i], taskNames);
    if (deps.length > 0) hasDeps = true;
    if (deps.length > 1) allLinear = false;
    if (deps.length === 1 && i > 0 && deps[0] !== tasks[i - 1].name) {
      allLinear = false;
    }
  }

  if (!hasDeps) return "parallel";
  if (allLinear) return "chain";
  return "graph";
}

// ---------------------------------------------------------------------------
// Chain → tasks normalization (backward compat)
// ---------------------------------------------------------------------------

export function normalizeChainToTasks(
  chain: Array<{ agent: string; task?: string; prompt?: string; promptArgs?: string[]; taskType?: TeammateTaskType; model?: string; thinking?: TeammateThinkingInput }>,
  initialTask: string,
): NormalizedTask[] {
  return chain.map((step, i) => {
    const name = `_step${i}`;
    let task: string;
    if (i === 0) {
      task = step.task ?? initialTask;
    } else {
      const prevName = `_step${i - 1}`;
      const template = step.task ?? `{${prevName}}`;
      task = template.replace(/\{previous\}/g, `{${prevName}}`);
    }
    return {
      agent: step.agent,
      task,
      name,
      model: step.model,
      thinking: parseTeammateThinkingLevel(step.thinking),
      taskType: step.taskType,
      prompt: step.prompt,
      promptArgs: step.promptArgs,
    };
  });
}

// ---------------------------------------------------------------------------
// Unified param normalization (shared by tool execute and child proxy paths)
// ---------------------------------------------------------------------------

export interface NormalizeTeammateResult {
  /** Normalized task list; null when running in single-agent mode. */
  tasks: NormalizedTask[] | null;
  isMultiTask: boolean;
  /** Non-fatal issues surfaced to the caller alongside the result. */
  warnings: string[];
  /** Fatal validation error — nothing was dispatched. */
  error?: string;
}

/**
 * Normalize teammate tool params into a task list.
 *
 * Precedence: tasks > chain (deprecated) > single-agent sugar.
 * Top-level prompt/promptArgs/taskType/context/model/thinking/cwd/
 * outputSchema/timeoutMs act as defaults; per-task values win.
 */
export function normalizeTeammateParams(
  params: RunTeammateParams,
): NormalizeTeammateResult {
  const warnings: string[] = [];
  const hasTasks = !!params.tasks?.length;
  const hasChain = !!params.chain?.length;

  let normalized: NormalizedTask[];

  if (hasTasks) {
    if (hasChain) {
      warnings.push(
        '"chain" is deprecated and was ignored because "tasks" is also provided — migrate chain steps to tasks with {name} references',
      );
    }
    if (params.agent || params.task) {
      warnings.push(
        'top-level "agent"/"task" are ignored in multi-task mode — set them per task',
      );
    }
    normalized = params.tasks!.map((t) => ({
      agent: t.agent,
      task: t.task ?? "",
      prompt: t.prompt ?? params.prompt,
      promptArgs: t.promptArgs ?? params.promptArgs,
      taskType: t.taskType ?? params.taskType,
      name: t.name,
      dependsOn: t.dependsOn,
      context: t.context ?? params.context,
      model: t.model ?? params.model,
      thinking: parseTeammateThinkingLevel(t.thinking ?? params.thinking),
      cwd: t.cwd ?? params.cwd,
      outputSchema: (t.outputSchema ?? params.outputSchema) as Record<string, unknown> | undefined,
      timeoutMs: t.timeoutMs ?? params.timeoutMs,
    }));
  } else if (hasChain) {
    warnings.push(
      '"chain" is deprecated — use "tasks" with {name} references instead',
    );
    if (params.agent) {
      warnings.push('top-level "agent" is ignored in chain mode — set it per step');
    }
    normalized = normalizeChainToTasks(params.chain!, params.task ?? "").map((t) => ({
      ...t,
      prompt: t.prompt ?? params.prompt,
      promptArgs: t.promptArgs ?? params.promptArgs,
      taskType: t.taskType ?? params.taskType,
      context: params.context,
      model: t.model ?? params.model,
      thinking: t.thinking ?? parseTeammateThinkingLevel(params.thinking),
      cwd: t.cwd ?? params.cwd,
      outputSchema: (t.outputSchema ?? params.outputSchema) as Record<string, unknown> | undefined,
      timeoutMs: t.timeoutMs ?? params.timeoutMs,
    }));
  } else if (params.agent) {
    if (!params.task && !params.prompt) {
      return {
        tasks: null,
        isMultiTask: false,
        warnings,
        error: 'Single mode requires "task" or "prompt" — refusing to dispatch an empty task.',
      };
    }
    if (params.promptArgs?.length && !params.prompt) {
      warnings.push('"promptArgs" has no effect without "prompt"');
    }
    return { tasks: null, isMultiTask: false, warnings };
  } else {
    return {
      tasks: null,
      isMultiTask: false,
      warnings,
      error: 'Requires "agent" (with "task" or "prompt") for single mode, or "tasks" for multi-task mode.',
    };
  }

  for (const [i, t] of normalized.entries()) {
    if (!t.task && !t.prompt) {
      return {
        tasks: normalized,
        isMultiTask: true,
        warnings,
        error: `tasks[${i}]${t.name ? ` "${t.name}"` : ""} requires "task" or "prompt" — refusing to dispatch an empty task.`,
      };
    }
    if (t.promptArgs?.length && !t.prompt) {
      warnings.push(`tasks[${i}]: "promptArgs" has no effect without "prompt"`);
    }
  }

  const refCheck = validateTaskReferences(normalized);
  warnings.push(...refCheck.warnings);
  if (refCheck.errors.length > 0) {
    return {
      tasks: normalized,
      isMultiTask: true,
      warnings,
      error: refCheck.errors.join("\n"),
    };
  }

  return { tasks: normalized, isMultiTask: true, warnings };
}

// ---------------------------------------------------------------------------
// AC3: Windows-safe pi binary resolution
// ---------------------------------------------------------------------------

let resolvedPiEntryPoint: string | null | undefined;

function resolvePiEntryPoint(): string | null {
  if (resolvedPiEntryPoint !== undefined) return resolvedPiEntryPoint;

  // Try current process argv (if pi is the host)
  const argv1 = process.argv[1];
  if (argv1 && (argv1.endsWith(".mjs") || argv1.endsWith(".js"))) {
    resolvedPiEntryPoint = argv1;
    return resolvedPiEntryPoint;
  }

  if (process.platform === "win32") {
    // Parse pi.cmd to find the real .js entry point
    const npmDir = process.env.APPDATA
      ? path.join(process.env.APPDATA, "npm")
      : null;
    if (npmDir) {
      const cmdFile = path.join(npmDir, "pi.cmd");
      try {
        const content = fs.readFileSync(cmdFile, "utf-8");
        // pi.cmd contains: "%_prog%" "%dp0%\node_modules\...\cli.js" %*
        const match = content.match(/"?%dp0%\\([^"*%\r\n]+\.(?:js|mjs))"?/);
        if (match) {
          const entryPoint = path.join(npmDir, match[1]);
          if (fs.existsSync(entryPoint)) {
            resolvedPiEntryPoint = entryPoint;
            return resolvedPiEntryPoint;
          }
        }
      } catch { /* fallback */ }
    }
  }

  resolvedPiEntryPoint = null;
  return null;
}

function getPiSpawnCommand(args: string[]): { command: string; args: string[]; shell: boolean } {
  const envBinary = process.env.PI_TEAMMATE_PI_BINARY;
  if (envBinary) {
    return { command: envBinary, args, shell: false };
  }

  const entryPoint = resolvePiEntryPoint();
  if (entryPoint) {
    return { command: process.execPath, args: [entryPoint, ...args], shell: false };
  }

  if (process.platform === "win32") {
    return { command: "pi.cmd", args, shell: true };
  }
  return { command: "pi", args, shell: false };
}

// ---------------------------------------------------------------------------
// AC4: Nesting depth guard
// ---------------------------------------------------------------------------

const MAX_DEFAULT_DEPTH = 3;

function getTeammateDepth(): number {
  return parseInt(process.env.PI_TEAMMATE_DEPTH ?? "0", 10);
}

function checkDepthGuard(maxDepth?: number): { allowed: boolean; current: number; max: number } {
  const current = getTeammateDepth();
  const max = maxDepth ?? MAX_DEFAULT_DEPTH;
  return { allowed: current < max, current, max };
}

// ---------------------------------------------------------------------------
// AC5: Session directory management
// ---------------------------------------------------------------------------

function getTeammateSessionRoot(parentSessionFile: string | null): string | undefined {
  if (!parentSessionFile) return undefined;
  const baseName = path.basename(parentSessionFile, ".jsonl");
  const sessionsDir = path.dirname(parentSessionFile);
  return path.join(sessionsDir, baseName);
}

// ---------------------------------------------------------------------------
// AC7: Model fallback chain
// ---------------------------------------------------------------------------

function buildModelCandidates(primary?: string, fallbacks?: string[]): string[] {
  const candidates: string[] = [];
  if (primary) candidates.push(primary);
  if (fallbacks) candidates.push(...fallbacks);
  return candidates;
}

function isRetryableModelError(messages: Array<{ role: string; content: string }>): boolean {
  const errorPatterns = ["model", "rate", "unavailable", "capacity", "overloaded", "429", "503"];
  for (const msg of messages) {
    if (msg.role !== "system") continue;
    const lower = msg.content.toLowerCase();
    if (errorPatterns.some((p) => lower.includes(p))) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Build pi CLI arguments
// ---------------------------------------------------------------------------

const ORDERED_THINKING_LEVELS: readonly TeammateThinkingLevel[] = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
];

export function clampThinkingForModel(
  thinking: TeammateThinkingLevel,
  model: string | undefined,
  modelCapabilities: readonly TeammateModelCapability[] = [],
): TeammateThinkingLevel {
  const supported = modelCapabilities.find((candidate) => candidate.id === model)?.thinkingLevels;
  if (!supported?.length || supported.includes(thinking)) return thinking;

  const requestedIndex = ORDERED_THINKING_LEVELS.indexOf(thinking);
  for (let index = requestedIndex; index < ORDERED_THINKING_LEVELS.length; index += 1) {
    const candidate = ORDERED_THINKING_LEVELS[index];
    if (supported.includes(candidate)) return candidate;
  }
  for (let index = requestedIndex - 1; index >= 0; index -= 1) {
    const candidate = ORDERED_THINKING_LEVELS[index];
    if (supported.includes(candidate)) return candidate;
  }
  return thinking;
}

export function buildPiArgs(
  agentConfig: AgentConfig,
  params: RunTeammateParams,
  systemPromptFile: string,
  modelOverride?: string,
  sessionDir?: string,
  forkSessionFile?: string,
  schemaFile?: string,
  modelCapabilities: readonly TeammateModelCapability[] = [],
): string[] {
  // RPC mode: stdin stays open for bidirectional messaging (steer/follow_up/abort)
  const args: string[] = ["--mode", "rpc"];

  // Child mode owns session identity publication, lease fencing, and proxy tools.
  // Load it explicitly because the child cwd may not discover this package.
  const teammateExtension = fileURLToPath(
    new URL("../extension/index.ts", import.meta.url),
  );
  args.push("--extension", teammateExtension);

  const inheritedExtensions = getTeammateChildExtensions();
  const loadedExtensionPaths = new Set([
    process.platform === "win32" ? teammateExtension.toLowerCase() : teammateExtension,
  ]);
  for (const registration of inheritedExtensions) {
    const key = process.platform === "win32"
      ? registration.path.toLowerCase()
      : registration.path;
    if (loadedExtensionPaths.has(key)) continue;
    loadedExtensionPaths.add(key);
    args.push("--extension", registration.path);
  }

  if (forkSessionFile) {
    args.push("--fork", forkSessionFile);
  }

  const model = modelOverride ?? params.model ?? agentConfig.model;
  if (model) {
    args.push("--model", model);
  }

  const requestedThinking = parseTeammateThinkingLevel(params.thinking) ?? agentConfig.thinking;
  if (requestedThinking) {
    args.push("--thinking", clampThinkingForModel(requestedThinking, model, modelCapabilities));
  }

  if (agentConfig.tools && agentConfig.tools.length > 0) {
    const proxyTools = ["teammate", "teammate-send", "teammate-list", "teammate-watch"];
    const inheritedTools = inheritedExtensions.flatMap((registration) => registration.tools);
    const toolSet = new Set([...agentConfig.tools, ...proxyTools, ...inheritedTools]);
    if (schemaFile) toolSet.add("structured_output");
    args.push("--tools", [...toolSet].join(","));
  }

  if (schemaFile) {
    const structuredOutputExtension = fileURLToPath(
      new URL("../extension/structured-output.ts", import.meta.url),
    );
    args.push("--extension", structuredOutputExtension);
  }

  args.push(
    agentConfig.systemPromptMode === "replace"
      ? "--system-prompt"
      : "--append-system-prompt",
    systemPromptFile,
  );

  if (!agentConfig.inheritProjectContext) {
    args.push("--no-context-files");
  }

  if (!agentConfig.inheritSkills) {
    args.push("--no-skills");
  }

  if (sessionDir) {
    args.push("--session-dir", sessionDir);
  }

  return args;
}

// ---------------------------------------------------------------------------
// Write temporary files
// ---------------------------------------------------------------------------

function writeSystemPromptFile(
  agentConfig: AgentConfig,
  correlationId: string,
): string {
  const tmpDir = path.join(os.tmpdir(), "pi-teammate");
  fs.mkdirSync(tmpDir, { recursive: true });
  const promptFile = path.join(tmpDir, `prompt-${correlationId}.md`);
  fs.writeFileSync(promptFile, agentConfig.systemPrompt, "utf-8");
  return promptFile;
}

function writeSchemaFile(schema: Record<string, unknown>, correlationId: string): { schemaFile: string; outputFile: string } {
  const tmpDir = path.join(os.tmpdir(), "pi-teammate");
  fs.mkdirSync(tmpDir, { recursive: true });
  const schemaFile = path.join(tmpDir, `schema-${correlationId}.json`);
  const outputFile = path.join(tmpDir, `output-${correlationId}.json`);
  fs.writeFileSync(schemaFile, JSON.stringify(schema), "utf-8");
  return { schemaFile, outputFile };
}

function cleanupFile(filePath: string): void {
  try { fs.unlinkSync(filePath); } catch { /* best effort */ }
}

// ---------------------------------------------------------------------------
// AC8: Progress helper
// ---------------------------------------------------------------------------

function createProgress(agent: string, startTime: number): AgentProgress {
  return {
    agent,
    status: "running",
    recentTools: [],
    toolCount: 0,
    tokens: 0,
    durationMs: 0,
    lastActivityAt: startTime,
    startedAt: startTime,
  };
}

// ---------------------------------------------------------------------------
// Core: run a single teammate agent
// ---------------------------------------------------------------------------

export async function runTeammate(
  params: RunTeammateParams,
  options: RunTeammateOptions,
): Promise<SingleResult> {
  const startTime = Date.now();
  const correlationId = options.correlationId ?? randomUUID();
  const cwd = params.cwd ?? options.baseCwd;

  const promptResolution = resolvePromptTask(cwd, params.prompt, params.task, params.promptArgs);
  if (promptResolution.error) {
    return {
      agent: params.agent,
      task: params.task ?? "",
      exitCode: 1,
      messages: [{ role: "system", content: promptResolution.error }],
      usage: emptyUsage(),
      model: params.model ?? "unknown",
      correlationId,
      durationMs: Date.now() - startTime,
    };
  }
  if (params.prompt) params = { ...params, task: promptResolution.task };

  // AC4: Depth guard
  const depthCheck = checkDepthGuard();
  if (!depthCheck.allowed) {
    return {
      agent: params.agent,
      task: params.task ?? "",
      exitCode: 1,
      messages: [{
        role: "system",
        content: `Teammate nesting depth exceeded: current=${depthCheck.current}, max=${depthCheck.max}. Prevent recursive fork-bomb.`,
      }],
      usage: emptyUsage(),
      model: params.model ?? "unknown",
      correlationId,
      durationMs: Date.now() - startTime,
    };
  }

  // Resolve an exact discovered role. Silent generic fallback made misspelled
  // or out-of-project role names look successful while ignoring their prompt.
  const agentConfig: AgentConfig | undefined = resolveAgent(cwd, params.agent);
  if (!agentConfig) {
    const available = listAgentSummaries(cwd).map((agent) => agent.name).join(", ");
    return {
      agent: params.agent,
      task: params.task ?? "",
      exitCode: 1,
      messages: [{
        role: "system",
        content: `Unknown teammate agent "${params.agent}". Available agents: ${available || "(none)"}.`,
      }],
      usage: emptyUsage(),
      model: params.model ?? "unknown",
      correlationId,
      durationMs: Date.now() - startTime,
    };
  }

  // Resolve routing
  const replyTo: ReplyTarget = resolveReplyTo({
    reply_to: params.reply_to,
    protocol_version: params.protocol_version,
    name: params.name,
  });

  // AC7: Model fallback — try each candidate
  const candidates = buildModelCandidates(
    params.model ?? agentConfig.model,
    agentConfig.fallbackModels,
  );
  const attemptedModels: string[] = [];

  for (let mi = 0; mi <= candidates.length; mi++) {
    const modelToUse = mi < candidates.length ? candidates[mi] : undefined;
    if (modelToUse) attemptedModels.push(modelToUse);

    const result = await runSingleAttempt(
      params, agentConfig, cwd, correlationId, replyTo, startTime, modelToUse, options,
    );

    if (result.exitCode === 0 || mi >= candidates.length - 1 || !isRetryableModelError(result.messages)) {
      result.attemptedModels = attemptedModels.length > 1 ? attemptedModels : undefined;
      return result;
    }
    // Model error and more candidates — try next
  }

}

async function runSingleAttempt(
  params: RunTeammateParams,
  agentConfig: AgentConfig,
  cwd: string,
  correlationId: string,
  replyTo: ReplyTarget,
  startTime: number,
  modelOverride: string | undefined,
  options: RunTeammateOptions,
): Promise<SingleResult> {
  const systemPromptFile = writeSystemPromptFile(agentConfig, correlationId);

  // AC5: Session directory + fork context
  const effectiveContext = params.context ?? agentConfig.defaultContext;
  let sessionDir: string | undefined;
  let forkSessionFile: string | undefined;
  let forkWarning: string | undefined;
  const parentSession = options.parentSessionFile ?? process.env.PI_TEAMMATE_PARENT_SESSION ?? null;
  if (parentSession && fs.existsSync(parentSession)) {
    const sessionRoot = getTeammateSessionRoot(parentSession);
    if (sessionRoot) {
      sessionDir = path.join(sessionRoot, correlationId);
      fs.mkdirSync(sessionDir, { recursive: true });
    }
  }
  if (effectiveContext === "fork") {
    if (parentSession && fs.existsSync(parentSession)) {
      forkSessionFile = parentSession;
    } else if (params.context === "fork") {
      forkWarning = "Fork requested but parent session file not available. Starting with fresh context.";
    }
  }

  // AC6: Structured output
  let schemaFile: string | undefined;
  let outputFile: string | undefined;
  if (params.outputSchema) {
    const files = writeSchemaFile(params.outputSchema, correlationId);
    schemaFile = files.schemaFile;
    outputFile = files.outputFile;
  }

  const piArgs = buildPiArgs(
    agentConfig,
    params,
    systemPromptFile,
    modelOverride,
    sessionDir,
    forkSessionFile,
    schemaFile,
    options.modelCapabilities,
  );

  const usage = emptyUsage();
  const messages: Array<{ role: string; content: string }> = [];
  if (forkWarning) {
    messages.push({ role: "system", content: forkWarning });
  }
  let resolvedModel = modelOverride ?? params.model ?? agentConfig.model ?? "unknown";
  let lastContent = "";
  let streamingText = "";

  // AC8: Rich progress tracking
  const progress = createProgress(params.agent, startTime);

  return new Promise<SingleResult>((resolve) => {
    let child: ChildProcess;
    let resolved = false;

    const spawnEnv: Record<string, string | undefined> = {
      ...process.env,
      PI_TEAMMATE_CHILD: "1",
      PI_TEAMMATE_DEPTH: String(getTeammateDepth() + 1),
      PI_TEAMMATE_CORRELATION_ID: correlationId,
      PI_TEAMMATE_REPLY_TO: replyTo,
    };

    if (outputFile) {
      spawnEnv.PI_TEAMMATE_STRUCTURED_OUTPUT_PATH = outputFile;
      spawnEnv.PI_TEAMMATE_STRUCTURED_SCHEMA_PATH = schemaFile;
    }

    if (options.parentSessionFile) {
      spawnEnv.PI_TEAMMATE_PARENT_SESSION = options.parentSessionFile;
    }

    let useIpc = false;
    try {
      const spawnSpec = getPiSpawnCommand(piArgs);
      useIpc = !spawnSpec.shell;
      const spawnOpts: Parameters<typeof spawn>[2] = {
        cwd,
        stdio: useIpc ? ["pipe", "pipe", "pipe", "ipc"] : ["pipe", "pipe", "pipe"],
        env: spawnEnv,
        shell: spawnSpec.shell,
      };
      child = spawn(spawnSpec.command, spawnSpec.args, spawnOpts);
    } catch (error) {
      cleanupFile(systemPromptFile);
      if (schemaFile) cleanupFile(schemaFile);
      if (outputFile) cleanupFile(outputFile);

      resolve({
        agent: params.agent,
        task: params.task ?? "",
        exitCode: 1,
        messages: [{
          role: "system",
          content: `Failed to spawn pi subprocess: ${error instanceof Error ? error.message : String(error)}`,
        }],
        usage: emptyUsage(),
        model: resolvedModel,
        correlationId,
        durationMs: Date.now() - startTime,
      });
      return;
    }

    // RPC mode: stdin stays open for bidirectional messaging.
    // Send initial prompt via RPC command.
    if (child.stdin && params.task) {
      const initialLeaseToken = typeof options.initialLeaseToken === "function"
        ? options.initialLeaseToken(correlationId)
        : options.initialLeaseToken;
      sendRpcMessage(child.stdin, params.task, "prompt", initialLeaseToken);
    }

    // Expose stdin for teammate-send message injection
    if (child.stdin) {
      options.onChildSpawned?.(child.stdin, (message) => {
        if (!child.connected) return false;
        try {
          child.send(message as never);
          return true;
        } catch {
          return false;
        }
      }, sessionDir, correlationId);
    }

    // IPC message listener — proxy requests from child extensions
    if (useIpc) {
      child.on("message", (msg: unknown) => {
        const m = msg as Record<string, unknown>;
        dispatchChildIpcMessage(
          m,
          options.onChildRequest,
          options.onChildEvent
            ? (event) => options.onChildEvent?.({
                ...event,
                correlationId: event.correlationId ?? correlationId,
              })
            : undefined,
          (reply) => {
            try { child.send(reply as never); } catch { /* child disconnected */ }
          },
        );
      });
    }

    // Report initial progress
    options.onProgress?.(progress);

    // Handle abort signal
    const abortHandler = () => {
      child.kill("SIGTERM");
      setTimeout(() => {
        if (!child.killed) child.kill("SIGKILL");
      }, 5000);
    };
    if (options.signal) {
      options.signal.addEventListener("abort", abortHandler, { once: true });
    }

    // Timeout handling
    let timeoutTimer: ReturnType<typeof setTimeout> | undefined;
    if (params.timeoutMs) {
      timeoutTimer = setTimeout(() => {
        child.kill("SIGTERM");
        setTimeout(() => {
          if (!child.killed) child.kill("SIGKILL");
        }, 5000);
      }, params.timeoutMs);
    }

    // Parse JSON lines from stdout
    let stdoutBuffer = "";
    child.stdout?.on("data", (chunk: Buffer) => {
      const text = chunk.toString();
      stdoutBuffer += text;
      const lines = stdoutBuffer.split("\n");
      stdoutBuffer = lines.pop() ?? "";

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          const event = JSON.parse(trimmed) as JsonLineEvent;
          processEvent(event);
        } catch {
          lastContent += trimmed + "\n";
        }
      }
    });

    function processEvent(event: JsonLineEvent): void {
      // AC8: Update lastActivityAt on every event
      progress.lastActivityAt = Date.now();
      progress.durationMs = Date.now() - startTime;

      switch (event.type) {
        case "extension_ui_request": {
          const request = {
            ...event,
            type: "teammate_rpc_ui_request",
            correlationId,
          };
          const respond = (response: unknown) => {
            if (!child.stdin?.writable) return;
            child.stdin.write(`${JSON.stringify(response)}\n`);
          };
          if (options.onChildRequest) options.onChildRequest(request, respond);
          else if (typeof event.id === "string") {
            respond({ type: "extension_ui_response", id: event.id, cancelled: true });
          }
          break;
        }
        case "message_end":
        case "assistant": {
          const text = extractTextContent(event) || streamingText || undefined;
          if (text) {
            lastContent = text;
            streamingText = "";
            messages.push({ role: "assistant", content: text });
            progress.lastMessage = text;
            options.onProgress?.(progress);
          }
          if (event.usage) {
            accumulateUsage(usage, event.usage);
            usage.turns += 1;
            progress.tokens = usage.inputTokens + usage.outputTokens;
          }
          if (event.model) {
            resolvedModel = event.model;
          }
          break;
        }
        case "message_update": {
          const ame = event.assistantMessageEvent as Record<string, unknown> | undefined;
          const deltaType = ame?.type as string | undefined;

          if (deltaType === "text_delta") {
            const delta = ame?.delta as string | undefined;
            if (delta) {
              streamingText += delta;
              progress.lastMessage = streamingText;
              options.onProgress?.(progress);
            }
          } else if (deltaType === "text_start") {
            streamingText = "";
          }
          // Ignore thinking_delta, thinking_start, etc.

          // Extract usage from message snapshot
          const msg = event.message as Record<string, unknown> | undefined;
          const msgUsage = msg?.usage as Partial<Usage> | undefined;
          if (msgUsage) {
            accumulateUsage(usage, msgUsage);
            progress.tokens = usage.inputTokens + usage.outputTokens;
          }
          break;
        }
        case "response": {
          // RPC acknowledgement — ignore
          break;
        }
        case "tool_execution_start": {
          const toolName = (event.toolName as string) ?? (event.name as string) ?? "unknown";
          progress.recentTools.push({ name: toolName, status: "running" });
          if (progress.recentTools.length > 10) progress.recentTools.shift();
          options.onProgress?.(progress);
          break;
        }
        case "tool_execution_end":
        case "tool_result_end":
        case "tool_result": {
          if (event.content) {
            messages.push({ role: "tool", content: event.content });
          }
          progress.toolCount += 1;
          const lastTool = progress.recentTools[progress.recentTools.length - 1];
          if (lastTool && lastTool.status === "running") {
            lastTool.status = "completed";
          }
          options.onProgress?.(progress);
          break;
        }
        case "usage": {
          if (event.usage) {
            accumulateUsage(usage, event.usage);
            progress.tokens = usage.inputTokens + usage.outputTokens;
          }
          break;
        }
        case "turn_end": {
          const msg = event.message as Record<string, unknown> | undefined;
          if (msg) {
            const text = extractTextContent({ message: msg } as JsonLineEvent);
            if (text && !messages.some((m) => m.content === text)) {
              lastContent = text;
              messages.push({ role: "assistant", content: text });
              progress.lastMessage = text;
            }
          }
          break;
        }
        case "agent_end": {
          progress.status = "completed";
          progress.durationMs = Date.now() - startTime;
          if (messages.length === 0 && lastContent) {
            messages.push({ role: "assistant", content: lastContent });
          }
          options.onProgress?.(progress);

          if (timeoutTimer) clearTimeout(timeoutTimer);
          cleanupFile(systemPromptFile);
          if (schemaFile) cleanupFile(schemaFile);

          let structuredOutput: unknown;
          if (outputFile) {
            try {
              if (fs.existsSync(outputFile)) {
                structuredOutput = JSON.parse(fs.readFileSync(outputFile, "utf-8"));
              }
            } catch { /* ignore */ }
            cleanupFile(outputFile);
          }

          const turnResult: SingleResult = {
            agent: params.agent,
            task: params.task ?? "",
            exitCode: 0,
            messages: [...messages],
            usage: { ...usage },
            model: resolvedModel,
            correlationId,
            durationMs: Date.now() - startTime,
            structuredOutput,
            attemptedModels: undefined,
          };

          if (!resolved) {
            resolved = true;
            resolve(turnResult);
          }
          options.onTurnComplete?.(turnResult);
          // Process stays alive. Idle agents must be resumed with an RPC prompt;
          // steer/follow_up only queue while an agent loop is already running.
          break;
        }
        case "error": {
          messages.push({
            role: "system",
            content: event.error ?? "Unknown error",
          });
          break;
        }
      }
    }

    let stderrBuffer = "";
    child.stderr?.on("data", (chunk: Buffer) => {
      stderrBuffer += chunk.toString();
    });

    child.on("close", (code) => {
      if (timeoutTimer) clearTimeout(timeoutTimer);
      if (options.signal) {
        options.signal.removeEventListener("abort", abortHandler);
      }

      cleanupFile(systemPromptFile);

      // Process remaining buffer
      if (stdoutBuffer.trim()) {
        try {
          const event = JSON.parse(stdoutBuffer.trim()) as JsonLineEvent;
          processEvent(event);
        } catch {
          lastContent += stdoutBuffer.trim();
        }
      }

      if (messages.length === 0) {
        const content =
          lastContent.trim() || stderrBuffer.trim() || "(no output)";
        messages.push({ role: "assistant", content });
      }

      const status = code === 0 ? "completed" : "failed";
      progress.status = status;
      progress.durationMs = Date.now() - startTime;
      const lastMsg = messages[messages.length - 1]?.content;
      if (lastMsg) progress.lastMessage = lastMsg;
      options.onProgress?.(progress);

      // AC6: Read structured output if available
      let structuredOutput: unknown;
      if (outputFile) {
        try {
          if (fs.existsSync(outputFile)) {
            structuredOutput = JSON.parse(fs.readFileSync(outputFile, "utf-8"));
          }
        } catch {
          // Schema validation failed or file not written
        }
        cleanupFile(outputFile);
      }
      if (schemaFile) cleanupFile(schemaFile);

      if (!resolved) {
        resolved = true;
        resolve({
          agent: params.agent,
          task: params.task ?? "",
          exitCode: code ?? 1,
          messages,
          usage,
          model: resolvedModel,
          correlationId,
          durationMs: Date.now() - startTime,
          structuredOutput,
        });
      }
    });

    child.on("error", (error) => {
      if (timeoutTimer) clearTimeout(timeoutTimer);
      if (options.signal) {
        options.signal.removeEventListener("abort", abortHandler);
      }

      cleanupFile(systemPromptFile);
      if (schemaFile) cleanupFile(schemaFile);
      if (outputFile) cleanupFile(outputFile);

      progress.status = "failed";
      progress.durationMs = Date.now() - startTime;
      options.onProgress?.(progress);

      resolve({
        agent: params.agent,
        task: params.task ?? "",
        exitCode: 1,
        messages: [{
          role: "system",
          content: `Process error: ${error.message}`,
        }],
        usage: emptyUsage(),
        model: resolvedModel,
        correlationId,
        durationMs: Date.now() - startTime,
      });
    });
  });
}

// ---------------------------------------------------------------------------
// Graph execution (unified: parallel, chain, and DAG)
// ---------------------------------------------------------------------------

export function normalizeGraphConcurrency(concurrency: number, taskCount: number): number {
  return Math.max(
    1,
    Math.min(taskCount || 1, Number.isFinite(concurrency) ? Math.floor(concurrency) : 1),
  );
}

export async function runGraph(
  tasks: NormalizedTask[],
  concurrency: number,
  options: RunTeammateOptions,
): Promise<SingleResult[]> {
  const maxConcurrency = normalizeGraphConcurrency(concurrency, tasks.length);
  const taskCorrelationIds = tasks.map(
    (_, index) => options.taskCorrelationIds?.[index] ?? randomUUID(),
  );
  const taskNames = new Set(tasks.filter((t) => t.name).map((t) => t.name!));
  const indexByName = new Map<string, number>();
  for (let i = 0; i < tasks.length; i++) {
    if (tasks[i].name) indexByName.set(tasks[i].name!, i);
  }

  // Defensive validation for direct runGraph callers — the teammate tool
  // path already rejects these in normalizeTeammateParams.
  const refCheck = validateTaskReferences(tasks);
  if (refCheck.errors.length > 0) {
    return tasks.map((t, index) => ({
      agent: t.agent,
      task: t.task,
      exitCode: 1,
      messages: [{ role: "system", content: refCheck.errors.join("\n") }],
      usage: emptyUsage(),
      model: t.model ?? "unknown",
      correlationId: taskCorrelationIds[index],
      durationMs: 0,
    }));
  }

  // Build dependency adjacency list — implicit {name} refs ∪ explicit dependsOn.
  // Names are pre-filtered against taskNames, so lookups cannot miss.
  const deps: number[][] = tasks.map((t) =>
    taskDependencyNames(t, taskNames).map((name) => indexByName.get(name)!),
  );

  if (hasCycle(deps)) {
    return tasks.map((t, index) => ({
      agent: t.agent,
      task: t.task,
      exitCode: 1,
      messages: [{ role: "system", content: "Circular dependency detected in task graph" }],
      usage: emptyUsage(),
      model: t.model ?? "unknown",
      correlationId: taskCorrelationIds[index],
      durationMs: 0,
    }));
  }

  // Validate unique names
  const nameCount = new Map<string, number>();
  for (const t of tasks) {
    if (t.name) nameCount.set(t.name, (nameCount.get(t.name) ?? 0) + 1);
  }
  for (const [name, count] of nameCount) {
    if (count > 1) {
      return tasks.map((t, index) => ({
        agent: t.agent,
        task: t.task,
        exitCode: 1,
        messages: [{ role: "system", content: `Duplicate task name "${name}"` }],
        usage: emptyUsage(),
        model: t.model ?? "unknown",
        correlationId: taskCorrelationIds[index],
        durationMs: 0,
      }));
    }
  }

  const results: SingleResult[] = new Array(tasks.length);
  const outputs = new Map<string, TaskOutput>();
  const completed = new Set<number>();
  const failed = new Set<number>();

  // Concurrency semaphore
  let running = 0;
  const waiters: Array<() => void> = [];

  function acquire(): Promise<void> {
    if (running < maxConcurrency) {
      running++;
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      waiters.push(() => {
        running++;
        resolve();
      });
    });
  }

  function release(): void {
    running--;
    const next = waiters.shift();
    if (next) next();
  }

  // Dependency completion tracking
  const completionListeners = new Map<number, Array<() => void>>();

  function waitForDeps(taskIdx: number): Promise<boolean> {
    const taskDeps = deps[taskIdx];
    if (taskDeps.length === 0) return Promise.resolve(true);

    if (taskDeps.every((d) => completed.has(d) || failed.has(d))) {
      return Promise.resolve(!taskDeps.some((d) => failed.has(d)));
    }

    return new Promise((resolve) => {
      let remaining = taskDeps.filter(
        (d) => !completed.has(d) && !failed.has(d),
      ).length;
      if (remaining === 0) {
        resolve(!taskDeps.some((d) => failed.has(d)));
        return;
      }

      for (const dep of taskDeps) {
        if (completed.has(dep) || failed.has(dep)) continue;
        const cbs = completionListeners.get(dep) ?? [];
        cbs.push(() => {
          remaining--;
          if (remaining === 0) {
            resolve(!taskDeps.some((d) => failed.has(d)));
          }
        });
        completionListeners.set(dep, cbs);
      }
    });
  }

  function notifyComplete(taskIdx: number): void {
    const cbs = completionListeners.get(taskIdx);
    if (cbs) {
      for (const cb of cbs) cb();
      completionListeners.delete(taskIdx);
    }
  }

  function reportTaskFailure(task: NormalizedTask, taskIndex: number, message: string): void {
    const now = Date.now();
    options.onProgress?.({
      agent: task.agent,
      name: task.name,
      correlationId: taskCorrelationIds[taskIndex],
      taskIndex,
      dependencies: deps[taskIndex],
      status: "failed",
      recentTools: [],
      toolCount: 0,
      tokens: 0,
      durationMs: 0,
      lastActivityAt: now,
      startedAt: now,
      lastMessage: message,
    });
  }

  const promises = tasks.map(async (task, idx) => {
    const depsOk = await waitForDeps(idx);

    if (!depsOk) {
      failed.add(idx);
      results[idx] = {
        agent: task.agent,
        task: task.task,
        exitCode: 1,
        messages: [{ role: "system", content: "Skipped: upstream dependency failed" }],
        usage: emptyUsage(),
        model: task.model ?? "unknown",
        correlationId: taskCorrelationIds[idx],
        durationMs: 0,
      };
      reportTaskFailure(task, idx, "Skipped: upstream dependency failed");
      notifyComplete(idx);
      return;
    }

    let resolvedTask = task.task;
    try {
      resolvedTask = resolveVariables(task.task, outputs, taskNames);
    } catch (err) {
      failed.add(idx);
      results[idx] = {
        agent: task.agent,
        task: task.task,
        exitCode: 1,
        messages: [{
          role: "system",
          content: `Variable resolution failed: ${err instanceof Error ? err.message : String(err)}`,
        }],
        usage: emptyUsage(),
        model: task.model ?? "unknown",
        correlationId: taskCorrelationIds[idx],
        durationMs: 0,
      };
      reportTaskFailure(task, idx, results[idx].messages[0].content);
      notifyComplete(idx);
      return;
    }

    await acquire();

    try {
      const result = await runTeammate(
        {
          agent: task.agent,
          task: resolvedTask,
          prompt: task.prompt,
          promptArgs: task.promptArgs,
          context: task.context,
          model: task.model,
          thinking: task.thinking,
          cwd: task.cwd,
          outputSchema: task.outputSchema,
          timeoutMs: task.timeoutMs,
        },
        {
          ...options,
          correlationId: taskCorrelationIds[idx],
          onProgress: options.onProgress
            ? (data) => options.onProgress?.({
                ...data,
                name: task.name,
                correlationId: taskCorrelationIds[idx],
                taskIndex: idx,
                dependencies: deps[idx],
              })
            : undefined,
        },
      );
      results[idx] = result;

      if (result.exitCode === 0) {
        completed.add(idx);
        if (task.name) {
          const lastMsg =
            result.messages[result.messages.length - 1]?.content ?? "";
          outputs.set(task.name, {
            text: lastMsg,
            structured: result.structuredOutput,
          });
        }
      } else {
        failed.add(idx);
      }
    } catch (err) {
      failed.add(idx);
      results[idx] = {
        agent: task.agent,
        task: resolvedTask,
        exitCode: 1,
        messages: [{
          role: "system",
          content: `Execution error: ${err instanceof Error ? err.message : String(err)}`,
        }],
        usage: emptyUsage(),
        model: task.model ?? "unknown",
        correlationId: taskCorrelationIds[idx],
        durationMs: 0,
      };
      reportTaskFailure(task, idx, results[idx].messages[0].content);
    } finally {
      release();
      notifyComplete(idx);
    }
  });

  await Promise.all(promises);
  return results;
}

// ---------------------------------------------------------------------------
// RPC: Send message to running agent via stdin
// ---------------------------------------------------------------------------

export type RpcMessageMode = "prompt" | "steer" | "follow_up" | "abort";

export function sendRpcMessage(
  stdin: import("node:stream").Writable,
  message: string,
  mode: RpcMessageMode = "follow_up",
  token?: LeaseToken,
): boolean {
  if (!stdin.writable) return false;
  if (mode === "abort") {
    stdin.write(JSON.stringify({ type: "abort" }) + "\n");
    return true;
  }
  const leasedMessage = wrapLeasedMessage(message, token);
  if (mode === "prompt") {
    stdin.write(JSON.stringify({ type: "prompt", message: leasedMessage }) + "\n");
    return true;
  }
  stdin.write(JSON.stringify({ type: mode, message: leasedMessage }) + "\n");
  return true;
}

export function dispatchChildIpcMessage(
  message: Record<string, unknown>,
  onRequest: RunTeammateOptions["onChildRequest"],
  onEvent: RunTeammateOptions["onChildEvent"],
  reply: (message: unknown) => void,
): "request" | "event" {
  if (
    (message.type === "teammate_proxy_request" || message.type === "teammate_interaction_request")
    && onRequest
  ) {
    onRequest(message, reply);
    return "request";
  }
  onEvent?.(message);
  return "event";
}

