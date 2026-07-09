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
import { resolveAgent, type AgentConfig } from "../agents/agents.ts";
import { resolveReplyTo, type ReplyTarget } from "../shared/routing.ts";
import type { SingleResult, Usage, AgentProgress } from "../shared/types.ts";

// ---------------------------------------------------------------------------
// Public param / option interfaces
// ---------------------------------------------------------------------------

export interface RunTeammateParams {
  agent: string;
  task?: string;
  name?: string;
  reply_to?: "caller" | "main";
  protocol_version?: number;
  background?: boolean;
  context?: "fresh" | "fork";
  model?: string;
  cwd?: string;
  timeoutMs?: number;
  outputSchema?: Record<string, unknown>;
  tasks?: Array<{ agent: string; task?: string; name?: string; model?: string; cwd?: string; outputSchema?: Record<string, unknown>; timeoutMs?: number }>;
  chain?: Array<{ agent: string; task?: string; model?: string }>;
  concurrency?: number;
}

export interface RunTeammateOptions {
  baseCwd: string;
  signal?: AbortSignal;
  onProgress?: (data: AgentProgress) => void;
  onChildRequest?: (event: Record<string, unknown>, reply: (msg: unknown) => void) => void;
  parentSessionFile?: string;
  onChildSpawned?: (stdin: import("node:stream").Writable) => void;
  onTurnComplete?: (result: SingleResult) => void;
}

// ---------------------------------------------------------------------------
// Normalized task specification (unified across single/parallel/chain/graph)
// ---------------------------------------------------------------------------

export interface NormalizedTask {
  agent: string;
  task: string;
  name?: string;
  model?: string;
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

function resolveVariables(
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
    const deps = extractDependencies(tasks[i].task, taskNames);
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
  chain: Array<{ agent: string; task?: string; model?: string }>,
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
    return { agent: step.agent, task, name, model: step.model };
  });
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

function buildPiArgs(
  agentConfig: AgentConfig,
  params: RunTeammateParams,
  systemPromptFile: string,
  modelOverride?: string,
  sessionDir?: string,
  forkSessionFile?: string,
): string[] {
  // RPC mode: stdin stays open for bidirectional messaging (steer/follow_up/abort)
  const args: string[] = ["--mode", "rpc"];

  if (forkSessionFile) {
    args.push("--fork", forkSessionFile);
  }

  const model = modelOverride ?? params.model ?? agentConfig.model;
  if (model) {
    args.push("--model", model);
  }

  if (agentConfig.tools && agentConfig.tools.length > 0) {
    const proxyTools = ["teammate", "teammate-send", "teammate-list", "teammate-watch"];
    const toolSet = new Set([...agentConfig.tools, ...proxyTools]);
    args.push("--tools", [...toolSet].join(","));
  }

  args.push("--append-system-prompt", systemPromptFile);

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
  const correlationId = randomUUID();
  const cwd = params.cwd ?? options.baseCwd;

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

  // Resolve agent — fall back to generic config if no definition file exists
  const agentConfig: AgentConfig = resolveAgent(cwd, params.agent) ?? {
    name: params.agent,
    description: `Generic teammate agent "${params.agent}"`,
    tools: ["read", "grep", "find", "ls", "bash", "edit", "write"],
    systemPromptMode: "append" as const,
    inheritProjectContext: true,
    inheritSkills: false,
    systemPrompt: `You are a teammate agent named "${params.agent}". Execute the assigned task using the provided tools. Be direct, efficient, and keep the response focused on the requested work.`,
    source: "builtin" as const,
    filePath: "",
  };

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
  if (effectiveContext === "fork") {
    const parentSession = options.parentSessionFile ?? process.env.PI_TEAMMATE_PARENT_SESSION ?? null;
    if (parentSession && fs.existsSync(parentSession)) {
      const sessionRoot = getTeammateSessionRoot(parentSession);
      if (sessionRoot) {
        sessionDir = path.join(sessionRoot, correlationId);
        fs.mkdirSync(sessionDir, { recursive: true });
      }
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

  const piArgs = buildPiArgs(agentConfig, params, systemPromptFile, modelOverride, sessionDir, forkSessionFile);

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
      const rpcCmd = JSON.stringify({ type: "prompt", message: params.task });
      child.stdin.write(rpcCmd + "\n");
    }

    // Expose stdin for teammate-send message injection
    if (child.stdin) {
      options.onChildSpawned?.(child.stdin);
    }

    // IPC message listener — proxy requests from child extensions
    if (useIpc) {
      child.on("message", (msg: unknown) => {
        const m = msg as Record<string, unknown>;
        if (m?.type === "teammate_proxy_request" && options.onChildRequest) {
          const replyFn = (reply: unknown) => {
            try { child.send(reply); } catch { /* child disconnected */ }
          };
          options.onChildRequest(m, replyFn);
        }
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
          // Process stays alive — stdin open for follow_up/steer to wake agent
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

export async function runGraph(
  tasks: NormalizedTask[],
  concurrency: number,
  options: RunTeammateOptions,
): Promise<SingleResult[]> {
  const taskNames = new Set(tasks.filter((t) => t.name).map((t) => t.name!));
  const indexByName = new Map<string, number>();
  for (let i = 0; i < tasks.length; i++) {
    if (tasks[i].name) indexByName.set(tasks[i].name!, i);
  }

  // Build dependency adjacency list
  const deps: number[][] = tasks.map((t) => {
    return extractDependencies(t.task, taskNames).map((name) => {
      const idx = indexByName.get(name);
      if (idx === undefined) throw new Error(`Task references unknown name "${name}"`);
      return idx;
    });
  });

  if (hasCycle(deps)) {
    return tasks.map((t) => ({
      agent: t.agent,
      task: t.task,
      exitCode: 1,
      messages: [{ role: "system", content: "Circular dependency detected in task graph" }],
      usage: emptyUsage(),
      model: t.model ?? "unknown",
      correlationId: randomUUID(),
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
      return tasks.map((t) => ({
        agent: t.agent,
        task: t.task,
        exitCode: 1,
        messages: [{ role: "system", content: `Duplicate task name "${name}"` }],
        usage: emptyUsage(),
        model: t.model ?? "unknown",
        correlationId: randomUUID(),
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
    if (running < concurrency) {
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
        correlationId: randomUUID(),
        durationMs: 0,
      };
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
        correlationId: randomUUID(),
        durationMs: 0,
      };
      notifyComplete(idx);
      return;
    }

    await acquire();

    try {
      const result = await runTeammate(
        {
          agent: task.agent,
          task: resolvedTask,
          model: task.model,
          cwd: task.cwd,
          outputSchema: task.outputSchema,
          timeoutMs: task.timeoutMs,
        },
        options,
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
        correlationId: randomUUID(),
        durationMs: 0,
      };
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

export type RpcMessageMode = "steer" | "follow_up" | "abort";

export function sendRpcMessage(
  stdin: import("node:stream").Writable,
  message: string,
  mode: RpcMessageMode = "follow_up",
): boolean {
  if (!stdin.writable) return false;
  if (mode === "abort") {
    stdin.write(JSON.stringify({ type: "abort" }) + "\n");
    return true;
  }
  stdin.write(JSON.stringify({ type: mode, message }) + "\n");
  return true;
}

