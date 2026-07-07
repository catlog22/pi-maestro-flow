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
  tasks?: Array<{ agent: string; task: string; model?: string; cwd?: string }>;
  chain?: Array<{ agent: string; task?: string; model?: string }>;
  concurrency?: number;
}

export interface RunTeammateOptions {
  baseCwd: string;
  signal?: AbortSignal;
  onProgress?: (data: AgentProgress) => void;
  parentSessionFile?: string;
  onChildSpawned?: (stdin: import("node:stream").Writable) => void;
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
): string[] {
  // RPC mode: stdin stays open for bidirectional messaging (steer/follow_up/abort)
  const args: string[] = ["--mode", "rpc"];

  const model = modelOverride ?? params.model ?? agentConfig.model;
  if (model) {
    args.push("--model", model);
  }

  if (agentConfig.tools && agentConfig.tools.length > 0) {
    args.push("--tools", agentConfig.tools.join(","));
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

  // Resolve agent
  const agentConfig = resolveAgent(cwd, params.agent);
  if (!agentConfig) {
    return {
      agent: params.agent,
      task: params.task ?? "",
      exitCode: 1,
      messages: [{
        role: "system",
        content: `Agent "${params.agent}" not found. Available agents can be discovered from agents/ directories.`,
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

  // Should not reach here, but fallback
  const fallback = await runSingleAttempt(
    params, agentConfig, cwd, correlationId, replyTo, startTime, undefined, options,
  );
  fallback.attemptedModels = attemptedModels;
  return fallback;
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

  // AC5: Session directory
  let sessionDir: string | undefined;
  if (params.context === "fork") {
    const parentSession = options.parentSessionFile ?? process.env.PI_TEAMMATE_PARENT_SESSION ?? null;
    const sessionRoot = getTeammateSessionRoot(parentSession);
    if (sessionRoot) {
      sessionDir = path.join(sessionRoot, correlationId);
      fs.mkdirSync(sessionDir, { recursive: true });
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

  const piArgs = buildPiArgs(agentConfig, params, systemPromptFile, modelOverride, sessionDir);

  const usage = emptyUsage();
  const messages: Array<{ role: string; content: string }> = [];
  let resolvedModel = modelOverride ?? params.model ?? agentConfig.model ?? "unknown";
  let lastContent = "";

  // AC8: Rich progress tracking
  const progress = createProgress(params.agent, startTime);

  return new Promise<SingleResult>((resolve) => {
    let child: ChildProcess;

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

    try {
      const spawnSpec = getPiSpawnCommand(piArgs);
      const spawnOpts: Parameters<typeof spawn>[2] = {
        cwd,
        stdio: ["pipe", "pipe", "pipe"],
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
          const text = extractTextContent(event);
          if (text) {
            lastContent = text;
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
          // Extract text from streaming delta or full message snapshot
          const ame = event.assistantMessageEvent as Record<string, unknown> | undefined;
          const deltaType = ame?.type as string | undefined;
          if (deltaType === "text_delta") {
            const delta = ame?.delta as string | undefined;
            if (delta) {
              lastContent += delta;
              progress.lastMessage = lastContent;
              options.onProgress?.(progress);
            }
          } else {
            const text = extractTextContent(event);
            if (text) {
              lastContent = text;
              progress.lastMessage = text;
              options.onProgress?.(progress);
            }
          }
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
// AC1: Parallel execution (tasks[])
// ---------------------------------------------------------------------------

export async function runParallel(
  tasks: Array<{ agent: string; task: string; model?: string; cwd?: string }>,
  concurrency: number,
  options: RunTeammateOptions,
): Promise<SingleResult[]> {
  const results: SingleResult[] = new Array(tasks.length);
  let nextIndex = 0;

  async function runNext(): Promise<void> {
    while (nextIndex < tasks.length) {
      const idx = nextIndex++;
      const t = tasks[idx];
      results[idx] = await runTeammate(
        { agent: t.agent, task: t.task, model: t.model, cwd: t.cwd },
        options,
      );
    }
  }

  const workers = Array.from(
    { length: Math.min(concurrency, tasks.length) },
    () => runNext(),
  );
  await Promise.all(workers);

  return results;
}

// ---------------------------------------------------------------------------
// AC2: Chain execution (chain[])
// ---------------------------------------------------------------------------

export async function runChain(
  steps: Array<{ agent: string; task?: string; model?: string }>,
  initialTask: string,
  options: RunTeammateOptions,
): Promise<SingleResult[]> {
  const results: SingleResult[] = [];
  let previousOutput = "";

  for (let i = 0; i < steps.length; i++) {
    const step = steps[i];
    let task: string;

    if (i === 0) {
      task = step.task ?? initialTask;
    } else {
      const template = step.task ?? "{previous}";
      task = template.replace(/\{previous\}/g, previousOutput);
    }

    const result = await runTeammate(
      { agent: step.agent, task, model: step.model },
      options,
    );
    results.push(result);

    // Extract last message content for {previous}
    const lastMsg = result.messages[result.messages.length - 1];
    previousOutput = lastMsg?.content ?? "";

    // Stop chain on failure
    if (result.exitCode !== 0) break;
  }

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

