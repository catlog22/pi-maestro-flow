import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import type { ExtensionAPI, ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { listAgentSummaries, type AgentSummary } from "pi-maestro-teammate/v1/agents";
import { createTeammateDirectChildRequestHandler } from "pi-maestro-teammate/v1/extension";

import { SwarmController } from "../swarm/controller.ts";
import {
  SWARM_PLAN_LIMITS,
  type SwarmExecutionPlan,
  type SwarmRunArtifact,
  type SwarmStreamEntry,
} from "../swarm/types.ts";
import { SwarmOverlay } from "../tui/swarm-overlay.ts";

const SwarmRolePlanParams = Type.Object({
  id: Type.String({ minLength: 1 }),
  stage: Type.Union([Type.Literal("judge"), Type.Literal("analyst")]),
  agent: Type.String({ minLength: 1 }),
  taskType: Type.Union([
    Type.Literal("explore"), Type.Literal("analysis"), Type.Literal("debug"),
    Type.Literal("planning"), Type.Literal("development"), Type.Literal("review"), Type.Literal("testing"),
  ]),
  mission: Type.String({ minLength: 1 }),
  prompt: Type.String({ minLength: 1 }),
}, { additionalProperties: false });

const SwarmExecutionPlanParams = Type.Object({
    rationale: Type.String({ minLength: 1 }),
    dimensions: Type.Array(Type.Object({
      id: Type.String({ minLength: 1 }),
      label: Type.String({ minLength: 1 }),
      description: Type.String({ minLength: 1 }),
    }, { additionalProperties: false }), {
      minItems: SWARM_PLAN_LIMITS.dimensions.min,
      maxItems: SWARM_PLAN_LIMITS.dimensions.max,
    }),
    roles: Type.Array(SwarmRolePlanParams, { minItems: 2, maxItems: 2 }),
    ant: Type.Object({
      taskType: Type.Union([
        Type.Literal("explore"), Type.Literal("analysis"), Type.Literal("debug"),
        Type.Literal("planning"), Type.Literal("development"), Type.Literal("review"), Type.Literal("testing"),
      ]),
      mission: Type.String({ minLength: 1 }),
      prompt: Type.String({ minLength: 1 }),
      evidenceRequirements: Type.Array(Type.String({ minLength: 1 }), { minItems: 1, maxItems: 12 }),
      constraints: Type.Array(Type.String({ minLength: 1 }), { maxItems: 12 }),
      outputExpectation: Type.String({ minLength: 1 }),
    }, { additionalProperties: false }),
    scoring: Type.Object({
      rubric: Type.Array(Type.Object({
        id: Type.String({ minLength: 1 }),
        label: Type.String({ minLength: 1 }),
        weight: Type.Number({ minimum: 0, maximum: 1 }),
        description: Type.String({ minLength: 1 }),
      }, { additionalProperties: false }), {
        minItems: SWARM_PLAN_LIMITS.rubric.min,
        maxItems: SWARM_PLAN_LIMITS.rubric.max,
      }),
      instructions: Type.Array(Type.String({ minLength: 1 }), { maxItems: 12 }),
    }, { additionalProperties: false }),
    synthesis: Type.Object({
      requirements: Type.Array(Type.String({ minLength: 1 }), { minItems: 1, maxItems: 12 }),
    }, { additionalProperties: false }),
}, { description: "Objective-specific task-space and evaluation contract", additionalProperties: false });

// Keep the function schema rooted at one object. OpenAI-compatible providers
// reject a root-level anyOf even when every union branch is an object.
// Execute-specific requirements are enforced by the runtime below.
export const SwarmRuntimeParams = Type.Object({
  action: Type.String({ enum: ["catalog", "execute", "resume", "continue"] }),
  objective: Type.Optional(
    Type.String({ minLength: 1, description: "Exact user objective; required when action is 'execute'. Do not expand or rewrite it." }),
  ),
  plan: Type.Optional(SwarmExecutionPlanParams),
  runId: Type.Optional(Type.String({ minLength: 1 })),
  additionalIterations: Type.Optional(Type.Integer({ minimum: 1, maximum: 10 })),
}, { additionalProperties: false });

interface SwarmCatalogDetails {
  action: "catalog";
  roles: AgentSummary[];
}

export interface SwarmExecutionDetails {
  action: "execute" | "resume" | "continue";
  runId: string;
  status: SwarmRunArtifact["status"];
  phase: string;
  artifactDir: string;
}

type SwarmRuntimeDetails = SwarmCatalogDetails | SwarmExecutionDetails;

let activeController: SwarmController | undefined;
let latestSnapshot: SwarmRunArtifact | undefined;
let activeOverlay: SwarmOverlay | undefined;
let activeStream: ReturnType<typeof createMainStreamEmitter> | undefined;
let activeToolProgress: ReturnType<typeof createSwarmToolProgressPublisher> | undefined;
const deferredProjectionTimers = new Set<ReturnType<typeof setTimeout>>();
export const SWARM_STATUS_KEY = "maestro-swarm";

export function registerSwarmCommand(pi: ExtensionAPI): void {
  const runtimeTool: ToolDefinition<typeof SwarmRuntimeParams, SwarmRuntimeDetails> = {
    name: "swarm_runtime",
    label: "Swarm Runtime",
    description: `Catalog and execution bridge for the bundled swarm Skill. The Ant is a private runtime builtin; read the live teammate catalog only for judge and analyst, then submit the objective-specific contract.`,
    promptSnippet: "swarm_runtime: use the private system Ant, bind judge/analyst from the live catalog, then execute the Skill-compiled contract",
    parameters: SwarmRuntimeParams,
    executionMode: "sequential",
    async execute(_id, params, signal, onUpdate, ctx): Promise<AgentToolResult<SwarmRuntimeDetails>> {
      if (params.action === "catalog") {
        const roles = listAgentSummaries(ctx.cwd);
        return {
          content: [{ type: "text", text: JSON.stringify({ roles }, null, 2) }],
          details: { action: "catalog", roles },
        };
      }
      if (!new Set(["execute", "resume", "continue"]).has(params.action)) {
        return {
          content: [{ type: "text", text: `Unknown swarm_runtime action: ${params.action}` }],
          isError: true,
        };
      }
      let controller: SwarmController;
      if (params.action === "execute") {
        if (typeof params.objective !== "string" || params.objective.trim().length === 0 || !params.plan) {
          return {
            content: [{ type: "text", text: "swarm_runtime execute requires a non-empty objective and compiled plan." }],
            isError: true,
          };
        }
        controller = ensureController(pi, ctx, params.objective.trim());
      } else {
        const restored = loadSwarmSnapshot(ctx.cwd, params.runId);
        const additional = params.action === "continue" ? (params.additionalIterations ?? 2) : 0;
        if (params.action === "resume" && restored.currentIteration >= restored.config.maxIterations) {
          throw new Error(`Swarm ${restored.runId} already reached maxIterations; use continue with additionalIterations.`);
        }
        if (additional > 0) restored.config.maxIterations = Math.min(10, restored.currentIteration + additional);
        controller = createController(pi, ctx, restored.objective, undefined, restored);
      }
      activeToolProgress?.dispose();
      const toolProgress = createSwarmToolProgressPublisher(onUpdate);
      activeToolProgress = toolProgress;
      // ToolExecutionComponent 只接收固定 4 行、限频的 compact 状态；完整实时详情进入 overlay。
      // 禁止把 agent tree 或主消息 stream 放进 partial result，否则旧组件移出 viewport 后
      // Pi 会 fullRender(true) 并用 ESC[3J 清空 scrollback。
      const abort = () => controller.cancel();
      signal?.addEventListener("abort", abort, { once: true });
      try {
        if (params.action === "execute") controller.configure(params.plan as SwarmExecutionPlan);
        const result = await controller.start();
        latestSnapshot = result;
        activeOverlay?.update(result);
        toolProgress.publish(result, true);
        const projection = activeStream?.finish();
        activeStream = undefined;
        deferSwarmMessages(pi, projection, result);
        return {
          content: [{ type: "text", text: renderRuntimeResult(result) }],
          isError: result.status === "failed",
          details: executionDetails(result, params.action as "execute" | "resume" | "continue"),
        };
      } finally {
        if (activeToolProgress === toolProgress) activeToolProgress = undefined;
        toolProgress.dispose();
        signal?.removeEventListener("abort", abort);
      }
    },
  };
  pi.registerTool(runtimeTool);

  pi.registerCommand("swarm", {
    description: "Run bundled swarm Skill with compact iteration/convergence monitoring",
    getArgumentCompletions(prefix: string) {
      const options = [
        { value: "status", label: "status", description: "Show compact iteration and convergence status" },
        { value: "inspect", label: "inspect", description: "Open the detailed diagnostic dashboard" },
        { value: "resume", label: "resume", description: "Resume the latest interrupted persisted swarm" },
        { value: "continue", label: "continue", description: "Run additional iterations from persisted pheromone state" },
        { value: "feedback", label: "feedback", description: "Apply user feedback from the next iteration" },
        { value: "export", label: "export", description: "Export result and best-solution report" },
        { value: "archive", label: "archive", description: "Detach the completed run while preserving artifacts" },
        { value: "stop", label: "stop", description: "Cancel the active swarm while preserving artifacts" },
      ];
      const normalized = prefix.trim().toLowerCase();
      const matches = options.filter((option) => option.value.startsWith(normalized));
      return matches.length > 0 ? matches : null;
    },
    async handler(args: string, ctx: ExtensionContext) {
      const input = args.trim();
      if (!input || input.toLowerCase() === "status") {
        if (!latestSnapshot) {
          ctx.ui.notify("Usage: /swarm <objective>", "info");
          return;
        }
        ctx.ui.notify(`${formatSwarmMonitorStatus(latestSnapshot)} · ${latestSnapshot.runId}`, "info");
        return;
      }
      if (input.toLowerCase() === "inspect") {
        if (!latestSnapshot) {
          ctx.ui.notify("No swarm run is available to inspect.", "info");
          return;
        }
        await openSwarmOverlay(ctx, latestSnapshot);
        return;
      }
      if (input.toLowerCase() === "stop") {
        if (!activeController || !isActive(activeController.status)) {
          ctx.ui.notify("No active swarm run.", "info");
          return;
        }
        activeController.cancel();
        ctx.ui.notify(`Cancelling swarm ${activeController.runId}; artifacts will be preserved.`, "warning");
        return;
      }
      if (/^feedback(?:\s|$)/i.test(input)) {
        const feedback = input.replace(/^feedback\s*/i, "").trim();
        if (!activeController) {
          ctx.ui.notify("No swarm run can accept feedback.", "info");
          return;
        }
        if (!feedback) {
          ctx.ui.notify("Usage: /swarm feedback <text>", "info");
          return;
        }
        activeController.addFeedback(feedback);
        ctx.ui.notify(`Feedback accepted for iteration ${activeController.getSnapshot().currentIteration + 1}.`, "info");
        return;
      }
      if (/^export(?:\s|$)/i.test(input)) {
        if (!latestSnapshot) {
          ctx.ui.notify("No swarm result is available to export.", "info");
          return;
        }
        const destinationText = input.replace(/^export\s*/i, "").trim();
        if (!destinationText) {
          ctx.ui.notify("Usage: /swarm export <directory>", "info");
          return;
        }
        const destination = resolve(ctx.cwd, destinationText);
        mkdirSync(destination, { recursive: true });
        for (const file of ["result.json", "swarm-report.json", "best-solution.md", "best.json"]) {
          const source = join(latestSnapshot.artifactDir, file);
          if (existsSync(source)) copyFileSync(source, join(destination, file));
        }
        ctx.ui.notify(`Swarm result exported to ${destination}.`, "info");
        return;
      }
      if (input.toLowerCase() === "archive") {
        if (!latestSnapshot) {
          ctx.ui.notify("No swarm run is available to archive.", "info");
          return;
        }
        activeController?.dispose();
        activeController = undefined;
        activeOverlay?.dispose();
        activeOverlay = undefined;
        ctx.ui.setStatus(SWARM_STATUS_KEY, undefined);
        ctx.ui.notify(`Swarm ${latestSnapshot.runId} detached; artifacts remain at ${latestSnapshot.artifactDir}.`, "info");
        return;
      }
      if (/^(?:resume|continue)(?:\s|$)/i.test(input)) {
        if (activeController && isActive(activeController.status)) {
          ctx.ui.notify(`Swarm ${activeController.runId} is still ${activeController.status}.`, "warning");
          return;
        }
        pi.sendUserMessage(`/skill:swarm ${input}`);
        return;
      }
      if (activeController && isActive(activeController.status)) {
        ctx.ui.notify(`Swarm ${activeController.runId} is still ${activeController.status}. Use /swarm status, /swarm inspect, or /swarm stop.`, "warning");
        return;
      }

      const launch = parseSwarmLaunch(input);
      if (!launch.objective) {
        ctx.ui.notify("Usage: /swarm [--ants N] [--iterations N] [--path-length N] <objective>", "info");
        return;
      }
      const controller = createController(pi, ctx, launch.objective, launch.config);
      controller.activateSkill();
      latestSnapshot = controller.getSnapshot();
      publishSwarmStatus(ctx, latestSnapshot);
      pi.sendUserMessage(`/skill:swarm ${launch.objective}`);
    },
  });

  pi.on("session_shutdown", (_event, ctx) => {
    activeController?.dispose();
    activeController = undefined;
    latestSnapshot = undefined;
    activeOverlay?.dispose();
    activeOverlay = undefined;
    activeStream?.discard();
    activeStream = undefined;
    activeToolProgress?.dispose();
    activeToolProgress = undefined;
    clearDeferredProjectionTimers();
    ctx.ui.setStatus(SWARM_STATUS_KEY, undefined);
  });
}

export function resetSwarmCommandStateForTest(): void {
  activeController?.dispose();
  activeController = undefined;
  latestSnapshot = undefined;
  activeOverlay?.dispose();
  activeOverlay = undefined;
  activeStream?.discard();
  activeStream = undefined;
  activeToolProgress?.dispose();
  activeToolProgress = undefined;
  clearDeferredProjectionTimers();
}

function ensureController(pi: ExtensionAPI, ctx: ExtensionContext, objective: string): SwarmController {
  if (activeController && isActive(activeController.status)) {
    const activeObjective = activeController.getSnapshot().objective;
    if (!areSwarmObjectivesCompatible(activeObjective, objective)) {
      throw new Error(`Active swarm ${activeController.runId} is bound to a different objective.`);
    }
    return activeController;
  }
  const controller = createController(pi, ctx, objective);
  controller.activateSkill();
  latestSnapshot = controller.getSnapshot();
  publishSwarmStatus(ctx, latestSnapshot);
  return controller;
}

export function areSwarmObjectivesCompatible(active: string, candidate: string): boolean {
  const left = normalizeSwarmObjective(active);
  const right = normalizeSwarmObjective(candidate);
  if (!left || !right) return false;
  return left === right || hasObjectiveBoundaryPrefix(left, right) || hasObjectiveBoundaryPrefix(right, left);
}

function normalizeSwarmObjective(value: string): string {
  return value.trim().replace(/\s+/g, " ").toLocaleLowerCase();
}

function hasObjectiveBoundaryPrefix(value: string, prefix: string): boolean {
  if (!value.startsWith(prefix)) return false;
  const next = value.slice(prefix.length, prefix.length + 1);
  return next.length === 0 || /[\s:：,，;；.!！?？\-—(（\[【]/.test(next);
}

function createController(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  objective: string,
  config?: Partial<SwarmRunArtifact["config"]>,
  resumeSnapshot?: SwarmRunArtifact,
): SwarmController {
  if (resumeSnapshot) activeController?.dispose();
  const controller = new SwarmController({
    baseCwd: ctx.cwd,
    objective,
    config,
    resumeSnapshot,
    parentSessionFile: ctx.sessionManager.getSessionFile(),
    onChildRequest: createTeammateDirectChildRequestHandler(pi, ctx),
    onUpdate(snapshot) {
      latestSnapshot = snapshot;
      publishSwarmStatus(ctx, snapshot);
      activeOverlay?.update(snapshot);
      activeToolProgress?.publish(snapshot);
    },
    onStream(entry) { activeStream?.push(entry); },
  });
  activeController = controller;
  activeStream?.discard();
  activeStream = createMainStreamEmitter(controller.runId);
  return controller;
}

function parseSwarmLaunch(input: string): { objective: string; config: Partial<SwarmRunArtifact["config"]> } {
  const tokens = [...input.matchAll(/"([^"]*)"|'([^']*)'|(\S+)/g)].map((match) => match[1] ?? match[2] ?? match[3]!);
  const config: Partial<SwarmRunArtifact["config"]> = {};
  const flags: Record<string, keyof SwarmRunArtifact["config"]> = {
    "--ants": "nAnts",
    "--iterations": "maxIterations",
    "--path-length": "maxPathLength",
    "--concurrency": "concurrency",
    "--alpha": "alpha",
    "--beta": "beta",
    "--evaporation": "evaporation",
    "--deposit": "deposit",
    "--elite-weight": "eliteWeight",
    "--tau-min": "tauMin",
    "--tau-max": "tauMax",
    "--target-score": "targetScore",
    "--entropy-floor": "entropyFloor",
    "--stagnation": "stagnationPatience",
    "--min-delta": "minDelta",
  };
  const objective: string[] = [];
  for (let index = 0; index < tokens.length; index++) {
    const key = flags[tokens[index]!.toLowerCase()];
    if (!key) {
      objective.push(tokens[index]!);
      continue;
    }
    const raw = tokens[index + 1];
    const value = raw == null ? Number.NaN : Number(raw);
    if (!Number.isFinite(value)) throw new Error(`${tokens[index]} requires a numeric value.`);
    config[key] = value;
    index++;
  }
  return { objective: objective.join(" ").trim(), config };
}

function loadSwarmSnapshot(baseCwd: string, requestedRunId?: string): SwarmRunArtifact {
  const root = resolve(baseCwd, ".workflow", "swarms");
  if (!existsSync(root)) throw new Error("No persisted swarm runs are available.");
  const candidates = requestedRunId
    ? [requestedRunId]
    : readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && entry.name.startsWith("SW-"))
      .map((entry) => entry.name)
      .sort((left, right) => {
        const leftPath = join(root, left, "run.json");
        const rightPath = join(root, right, "run.json");
        return (existsSync(rightPath) ? statSync(rightPath).mtimeMs : 0) - (existsSync(leftPath) ? statSync(leftPath).mtimeMs : 0);
      });
  for (const runId of candidates) {
    if (!/^SW-[\p{L}\p{N}._-]+$/u.test(runId)) continue;
    const runPath = resolve(root, runId, "run.json");
    if (!runPath.startsWith(`${root}${sep}`) || !existsSync(runPath)) continue;
    const parsed = JSON.parse(readFileSync(runPath, "utf8")) as SwarmRunArtifact;
    if (parsed?.runId === runId && parsed.plan) return parsed;
  }
  throw new Error(requestedRunId ? `Swarm ${requestedRunId} was not found or is not resumable.` : "No resumable swarm run was found.");
}

function publishSwarmStatus(ctx: ExtensionContext, snapshot: SwarmRunArtifact): void {
  ctx.ui.setStatus(SWARM_STATUS_KEY, formatSwarmMonitorStatus(snapshot));
}

export function formatSwarmMonitorStatus(snapshot: SwarmRunArtifact): string {
  const metric = snapshot.metrics[snapshot.metrics.length - 1];
  const iteration = `${snapshot.currentIteration}/${snapshot.config.maxIterations}`;
  const convergence = metric ? `${Math.round(metric.convergence * 100)}%` : "--";
  const terminal = snapshot.status === "converged" ? "CONVERGED"
    : snapshot.status === "synthesizing" ? "SYNTH"
    : snapshot.status === "completed" ? "DONE"
    : snapshot.status === "failed" ? "FAILED"
    : snapshot.status === "cancelled" ? "CANCELLED"
    : snapshot.status === "preparing" ? "PREP"
    : undefined;
  return [
    `SWARM ${iteration}`,
    `CONV ${convergence}`,
    terminal,
  ].filter(Boolean).join(" · ");
}

async function openSwarmOverlay(ctx: ExtensionContext, snapshot: SwarmRunArtifact): Promise<void> {
  await ctx.ui.custom<void>((tui, _theme, _keybindings, done) => {
    const disableMouseTracking = enableSwarmMouseTracking(tui);
    const overlay = new SwarmOverlay({
      snapshot,
      requestRender: () => tui.requestRender(),
      close: () => {
        if (activeOverlay === overlay) activeOverlay = undefined;
        done(undefined);
      },
      onDispose: disableMouseTracking,
    });
    activeOverlay = overlay;
    return overlay;
  }, {
    overlay: true,
    overlayOptions: { anchor: "center", width: "94%", maxHeight: "92%" },
  });
}

function enableSwarmMouseTracking(tui: { terminal: { write(data: string): void } }): () => void {
  let enabled = true;
  // Pi 默认不启用 mouse tracking；overlay 存活期间用 SGR 模式接管滚轮，关闭时必须恢复。
  tui.terminal.write("\x1b[?1000h\x1b[?1006h");
  return () => {
    if (!enabled) return;
    enabled = false;
    tui.terminal.write("\x1b[?1006l\x1b[?1000l");
  };
}

function isActive(status: SwarmRunArtifact["status"]): boolean {
  return status === "preparing" || status === "running" || status === "converged" || status === "synthesizing";
}

function executionDetails(snapshot: SwarmRunArtifact, action: SwarmExecutionDetails["action"] = "execute"): SwarmExecutionDetails {
  return {
    action,
    runId: snapshot.runId,
    status: snapshot.status,
    phase: snapshot.skill.phase,
    artifactDir: snapshot.artifactDir,
  };
}

function renderRuntimeResult(snapshot: SwarmRunArtifact): string {
  return [
    `Swarm Skill execution ${snapshot.status}.`,
    `Run: ${snapshot.runId}`,
    `Iterations: ${snapshot.currentIteration}`,
    `Convergence: ${snapshot.convergence.reason}`,
    `Result artifact: ${snapshot.artifactDir}/result.json`,
    snapshot.synthesis ? `Recommendation: ${snapshot.synthesis.recommendation}` : "No synthesis was produced.",
  ].join("\n");
}

function renderCompactToolProgress(snapshot: SwarmRunArtifact): string {
  const agents = [...snapshot.activeAgents, ...(snapshot.stageAgents ?? [])];
  const running = agents.filter((agent) => agent.status === "running").length;
  const completed = agents.filter((agent) => agent.status === "completed").length;
  const failed = agents.filter((agent) => agent.status === "failed").length;
  const metric = snapshot.metrics[snapshot.metrics.length - 1];
  const latest = snapshot.stream[snapshot.stream.length - 1]?.text ?? "Waiting for runtime event";
  return [
    `Swarm ${snapshot.runId} · ${snapshot.skill.phase} · ${snapshot.status}`,
    `Iteration ${snapshot.currentIteration}/${snapshot.config.maxIterations} · ${running} running · ${completed} done · ${failed} failed`,
    metric
      ? `Best ${Math.round(metric.bestScore * 100)}% · convergence ${Math.round(metric.convergence * 100)}%`
      : "Waiting for first convergence metric",
    `Latest · ${streamText(latest, 180)}`,
  ].join("\n");
}

export function createSwarmToolProgressPublisher(
  onUpdate: ((result: AgentToolResult<SwarmExecutionDetails>) => void) | undefined,
  intervalMs = 500,
): {
  publish(snapshot: SwarmRunArtifact, force?: boolean): void;
  dispose(): void;
} {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let pending: SwarmRunArtifact | undefined;
  let lastPublishedAt = 0;
  let disposed = false;

  const emit = (snapshot: SwarmRunArtifact) => {
    pending = undefined;
    lastPublishedAt = Date.now();
    onUpdate?.({
      content: [{ type: "text", text: renderCompactToolProgress(snapshot) }],
      details: executionDetails(snapshot),
    });
  };

  return {
    publish(snapshot, force = false) {
      if (disposed || !onUpdate) return;
      pending = snapshot;
      const elapsed = Date.now() - lastPublishedAt;
      if (force || lastPublishedAt === 0 || elapsed >= intervalMs) {
        if (timer) clearTimeout(timer);
        timer = undefined;
        emit(snapshot);
        return;
      }
      if (timer) return;
      timer = setTimeout(() => {
        timer = undefined;
        if (!disposed && pending) emit(pending);
      }, Math.max(0, intervalMs - elapsed));
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      if (timer) clearTimeout(timer);
      timer = undefined;
      pending = undefined;
    },
  };
}

export interface SwarmMainStreamProjection {
  content: string;
  details: Record<string, unknown>;
}

export function createMainStreamEmitter(runId: string): {
  push(entry: SwarmStreamEntry): void;
  finish(): SwarmMainStreamProjection | undefined;
  discard(): void;
} {
  const milestones: SwarmStreamEntry[] = [];
  const liveByAgent = new Map<string, SwarmStreamEntry>();
  let discarded = false;

  return {
    push(entry) {
      if (discarded) return;
      if (entry.kind === "assistant" || entry.kind === "tool" || (entry.kind === "status" && entry.agentId)) {
        liveByAgent.set(`${entry.kind}:${entry.agentId ?? entry.kind}`, entry);
        return;
      }
      if (entry.kind === "preparation" && !entry.complete) return;
      milestones.push(entry);
      if (milestones.length > 16) milestones.splice(0, milestones.length - 16);
    },
    finish() {
      if (discarded) return undefined;
      discarded = true;
      const entries = [...milestones, ...liveByAgent.values()]
        .sort((left, right) => left.sequence - right.sequence)
        .slice(-20);
      milestones.length = 0;
      liveByAgent.clear();
      if (entries.length === 0) return undefined;
      return {
        content: [
          `Swarm activity · ${runId}`,
          ...entries.map((entry) => `${entry.agentId ?? entry.kind}/${entry.kind}: ${streamText(entry.text, 280)}`),
        ].join("\n"),
        details: {
          runId,
          kind: "summary",
          count: entries.length,
          firstSequence: entries[0]?.sequence,
          sequence: entries[entries.length - 1]?.sequence,
        },
      };
    },
    discard() {
      discarded = true;
      milestones.length = 0;
      liveByAgent.clear();
    },
  };
}

function deferSwarmMessages(
  pi: ExtensionAPI,
  projection: SwarmMainStreamProjection | undefined,
  result: SwarmRunArtifact,
): void {
  // 延迟到 tool promise 返回后的 timers phase，确保 Pi 先完成 tool_execution_end，
  // 再把一次性事件摘要追加到主消息流，避免旧组件被后续 partial update 反复改写。
  const timer = setTimeout(() => {
    deferredProjectionTimers.delete(timer);
    if (projection) {
      void pi.sendMessage({
        customType: "swarm-stream",
        display: true,
        content: projection.content,
        details: projection.details,
      }, { triggerTurn: false });
    }
    void pi.sendMessage({
      customType: "swarm-result",
      display: true,
      content: result.synthesis
        ? [`Swarm ${result.runId} completed.`, "", result.synthesis.summary, "", result.synthesis.recommendation, "", `Artifacts: ${result.artifactDir}`].join("\n")
        : `Swarm ${result.runId} ended with status ${result.status}.\n\nArtifacts: ${result.artifactDir}`,
      details: {
        runId: result.runId,
        status: result.status,
        artifactDir: result.artifactDir,
        convergence: result.convergence,
      },
    }, { triggerTurn: false });
  }, 0);
  deferredProjectionTimers.add(timer);
}

function clearDeferredProjectionTimers(): void {
  for (const timer of deferredProjectionTimers) clearTimeout(timer);
  deferredProjectionTimers.clear();
}

function streamText(text: string, maxLength: number): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  return normalized.length > maxLength ? `…${normalized.slice(-(maxLength - 1))}` : normalized;
}
