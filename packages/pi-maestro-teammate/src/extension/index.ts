/**
 * Teammate Extension Entry Point
 *
 * Tools: teammate (dispatch), teammate-send (RPC message injection), teammate-list (status)
 * TUI: Alt+R composer panel, widget above editor, Alt+B foreground→background detach
 * Mode: RPC subprocess — stdin open for steer/follow_up/abort
 */

import { randomUUID } from "node:crypto";
import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import { truncateToWidth } from "@earendil-works/pi-tui";
import { TeammateParams, TeammateSendParams, TeammateListParams, TeammateWatchParams } from "./schemas.ts";
import {
  runTeammate,
  runGraph,
  normalizeChainToTasks,
  inferGraphMode,
  extractDependencies,
  sendRpcMessage,
} from "../runs/execution.ts";
import {
  confirmChildReloaded,
  confirmParked,
  canChildWrite,
  createChildLease,
  fenceLease,
  leaseToken,
  handoffBarrierReached,
  isSessionPathContained,
  requestHandback,
  requestPark,
  recoverChild,
  sameLeaseToken,
  transferToMain,
  unwrapLeasedMessage,
  type LeaseToken,
} from "../runs/session-handoff.ts";
import type {
  RunTeammateParams,
  RunTeammateOptions,
  RpcMessageMode,
  NormalizedTask,
} from "../runs/execution.ts";
import {
  renderTeammateCall,
  renderTeammateResult,
} from "../tui/render.ts";
import { AttachOverlay } from "../tui/attach-overlay.ts";
import type {
  Details,
  TeammateState,
  AgentProgress,
  AgentProgressSnapshot,
  ActiveAgent,
  MessageEnvelope,
  SingleResult,
} from "../shared/types.ts";
import {
  TEAMMATE_COMPLETE_EVENT,
  TEAMMATE_STARTED_EVENT,
  TEAMMATE_MESSAGE_EVENT,
} from "../shared/types.ts";

interface AgentWidgetTheme {
  fg(name: string, text: string): string;
  bold(text: string): string;
}

export async function switchConversationSession(
  ctx: Pick<ExtensionCommandContext, "switchSession">,
  sessionFile: string,
  onSwitched: () => Promise<void> | void,
): Promise<void> {
  await ctx.switchSession(sessionFile, { withSession: async () => { await onSwitched(); } });
}

interface AgentWidgetRow {
  label: string;
  agent: string;
  status: AgentProgressSnapshot["status"] | "sleeping";
  action: string;
  direction: "↑" | "↓";
  toolCount: number;
  tokens: number;
}

function compactMetric(value: number): string {
  if (value < 1000) return String(value);
  if (value < 1_000_000) return `${(value / 1000).toFixed(value < 100_000 ? 1 : 0)}k`;
  return `${(value / 1_000_000).toFixed(1)}m`;
}

function toolAction(name: string): string {
  const normalized = name.toLowerCase();
  if (normalized === "write" || normalized === "edit" || normalized.includes("patch")) return "writing file";
  if (normalized === "read" || normalized === "grep" || normalized === "ls") return "reading files";
  if (normalized === "bash" || normalized.includes("command")) return "running command";
  return `using ${name}`;
}

function agentWidgetRows(agents: ActiveAgent[]): AgentWidgetRow[] {
  const rows: AgentWidgetRow[] = [];
  for (const active of agents) {
    const snapshots = active.progress ?? [];
    const effective = snapshots.length > 1 ? snapshots : [snapshots[0]];
    for (const progress of effective) {
      const runningTool = progress?.recentTools?.find((tool) => tool.status === "running");
      const status = active.status === "sleeping" ? "sleeping" : progress?.status ?? "running";
      const action = runningTool
        ? toolAction(runningTool.name)
        : status === "sleeping"
          ? "sleeping"
          : status === "pending"
            ? "waiting for dependencies"
            : status === "failed"
              ? "failed"
              : status === "completed"
                ? "completed"
                : progress?.lastMessage
                  ? "streaming"
                  : "waiting for model";
      rows.push({
        label: progress?.name ?? active.name ?? active.correlationId.slice(0, 8),
        agent: progress?.agent ?? active.agent,
        status,
        action,
        direction: runningTool ? "↓" : "↑",
        toolCount: progress?.toolCount ?? 0,
        tokens: progress?.tokens ?? 0,
      });
    }
  }
  return rows;
}

export function renderAgentStatusWidget(
  agents: ActiveAgent[],
  width: number,
  theme: AgentWidgetTheme,
): string[] {
  const safeWidth = Math.max(1, width);
  const rows = agentWidgetRows(agents);
  if (rows.length === 0) return [];
  const statusRank = (status: AgentWidgetRow["status"]): number => {
    if (status === "running") return 0;
    if (status === "sleeping") return 1;
    if (status === "pending") return 2;
    if (status === "failed") return 3;
    return 4;
  };
  rows.sort((a, b) => statusRank(a.status) - statusRank(b.status));

  const maxVisible = safeWidth < 20 ? 3 : safeWidth < 40 ? 4 : 6;
  const visible = rows.slice(0, maxVisible);
  const hidden = rows.length - visible.length;
  const icon = (row: AgentWidgetRow): string => {
    if (row.status === "running") return theme.fg("success", "■");
    if (row.status === "sleeping") return theme.fg("warning", "◉");
    if (row.status === "failed") return theme.fg("error", "✗");
    if (row.status === "completed") return theme.fg("muted", "✓");
    return theme.fg("dim", "□");
  };

  if (safeWidth < 20) {
    const compact = visible.map((row) => truncateToWidth(
      `${icon(row)} @${row.label} ${row.action}`,
      safeWidth,
      "…",
    ));
    if (hidden > 0) compact.push(truncateToWidth(theme.fg("dim", `… ${hidden} more`), safeWidth, "…"));
    return compact;
  }

  const running = rows.filter((row) => row.status === "running").length;
  const sleeping = rows.filter((row) => row.status === "sleeping").length;
  const pending = rows.filter((row) => row.status === "pending").length;
  const failed = rows.filter((row) => row.status === "failed").length;
  const summary = [
    running ? `${running} running` : "",
    sleeping ? `${sleeping} sleeping` : "",
    pending ? `${pending} pending` : "",
    failed ? `${failed} failed` : "",
  ].filter(Boolean).join(" · ");
  const lines = [truncateToWidth(
    `${theme.bold("Agents")}  ${theme.fg("dim", `${summary} · Alt+R`)}`,
    safeWidth,
    "…",
  )];
  for (let index = 0; index < visible.length; index++) {
    const row = visible[index];
    const connector = index === visible.length - 1 && hidden === 0 ? "└─" : "├─";
    const metrics = [
      row.tokens ? `${row.direction} ${compactMetric(row.tokens)} tokens` : "",
      row.toolCount ? `${row.toolCount} tools` : "",
    ].filter(Boolean).join(" · ");
    const meta = metrics ? ` · ${metrics}` : "";
    lines.push(truncateToWidth(
      `${theme.fg("dim", connector)} ${icon(row)} ${theme.fg("accent", `@${row.label}`)} ${theme.fg("muted", row.agent)} · ${row.action}${theme.fg("dim", meta)}`,
      safeWidth,
      "…",
    ));
  }
  if (hidden > 0) {
    lines.push(truncateToWidth(theme.fg("dim", `└─ … ${hidden} more · Alt+R to inspect`), safeWidth, "…"));
  }
  return lines;
}

export default function registerTeammateExtension(pi: ExtensionAPI): void {
  pi.registerMessageRenderer<Details | { result?: SingleResult }>(
    "teammate-complete",
    (message, options, theme) => {
      const rawDetails = message.details;
      let details: Details | undefined;
      if (rawDetails && "results" in rawDetails && Array.isArray(rawDetails.results)) {
        details = rawDetails as Details;
      } else if (rawDetails && "result" in rawDetails && rawDetails.result) {
        details = { mode: "single", results: [rawDetails.result] };
      }
      if (!details) return undefined;

      const content = typeof message.content === "string"
        ? [{ type: "text" as const, text: message.content }]
        : message.content;
      return renderTeammateResult({
        content,
        details,
      }, options, theme as ExtensionContext["ui"]["theme"]);
    },
  );

  const isChild = process.env.PI_TEAMMATE_CHILD === "1";

  // =========================================================================
  // Child mode: register proxy tools that forward to root via stdout/IPC
  // =========================================================================

  if (isChild) {
    const bridgeKey = Symbol.for("pi-maestro-teammate.child-handoff");
    interface ChildHandoffBridge {
      ctx?: ExtensionContext;
      parked: boolean;
      parking: boolean;
      nonce?: string;
      listenerInstalled: boolean;
      pollTimer?: ReturnType<typeof setInterval>;
      pendingRequests: Map<string, (result: unknown) => void>;
      expectedLease?: LeaseToken;
      acceptedPromptSeq: number;
      requiredPromptSeq: number;
      completedPromptSeq: number;
      idleStableTicks: number;
    }
    const globals = globalThis as typeof globalThis & Record<symbol, unknown>;
    const bridge: ChildHandoffBridge = (globals[bridgeKey] as ChildHandoffBridge | undefined) ?? {
      parked: false,
      parking: false,
      listenerInstalled: false,
      pendingRequests: new Map(),
      acceptedPromptSeq: 0,
      requiredPromptSeq: 0,
      completedPromptSeq: 0,
      idleStableTicks: 0,
    };
    globals[bridgeKey] = bridge;
    const pendingRequests = bridge.pendingRequests;

    const sendChildEvent = (message: Record<string, unknown>): void => {
      if (typeof process.send === "function") process.send(message);
    };

    const publishSessionIdentity = (ctx: ExtensionContext): void => {
      bridge.ctx = ctx;
      sendChildEvent({
        type: "teammate_session_ready",
        correlationId: process.env.PI_TEAMMATE_CORRELATION_ID,
        sessionId: ctx.sessionManager.getSessionId(),
        sessionFile: ctx.sessionManager.getSessionFile(),
      });
    };

    pi.on("session_start", (_event, ctx) => publishSessionIdentity(ctx));
    pi.on("session_compact", (_event, ctx) => publishSessionIdentity(ctx));
    pi.on("message_end", (_event, ctx) => publishSessionIdentity(ctx));
    pi.on("agent_end", (_event, ctx) => {
      publishSessionIdentity(ctx);
      bridge.completedPromptSeq = bridge.acceptedPromptSeq;
      bridge.idleStableTicks = 0;
    });
    pi.on("input", (event) => {
      if (event.text.startsWith("/teammate-handoff-reload ")) {
        return bridge.expectedLease?.owner === "none" ? { action: "continue" } : { action: "handled" };
      }
      if (bridge.parked) return { action: "handled" };
      const unwrapped = unwrapLeasedMessage(event.text);
      if (unwrapped.malformed) return { action: "handled" };
      if (bridge.expectedLease && !sameLeaseToken(bridge.expectedLease, unwrapped.token)) {
        return { action: "handled" };
      }
      bridge.acceptedPromptSeq++;
      bridge.idleStableTicks = 0;
      if (unwrapped.token) return { action: "transform", text: unwrapped.message };
      return { action: "continue" };
    });

    pi.registerCommand("teammate-handoff-reload", {
      description: "Internal: reload a parked teammate session before ownership return",
      async handler(args, ctx) {
        const sessionFile = decodeURIComponent(args.trim());
        if (!sessionFile) return;
        await ctx.switchSession(sessionFile, {
          withSession: async (nextCtx) => {
            bridge.ctx = nextCtx;
            bridge.parked = false;
            bridge.parking = false;
            sendChildEvent({
              type: "teammate_handoff_returned",
              correlationId: process.env.PI_TEAMMATE_CORRELATION_ID,
              nonce: bridge.nonce,
              sessionId: nextCtx.sessionManager.getSessionId(),
              sessionFile: nextCtx.sessionManager.getSessionFile(),
            });
          },
        });
      },
    });

    // IPC listener: receive results from root
    if (typeof process.send === "function" && !bridge.listenerInstalled) {
      bridge.listenerInstalled = true;
      process.on("message", (msg: unknown) => {
        const m = msg as Record<string, unknown>;
        if (m?.type === "teammate_proxy_result") {
          const resolve = pendingRequests.get(m.requestId as string);
          if (resolve) {
            pendingRequests.delete(m.requestId as string);
            resolve(m.result);
          }
        } else if (m?.type === "teammate_handoff_request") {
          bridge.parking = true;
          bridge.nonce = m.nonce as string;
          bridge.requiredPromptSeq = Number(m.requiredPromptSeq ?? bridge.acceptedPromptSeq);
          bridge.idleStableTicks = 0;
          if (bridge.pollTimer) clearInterval(bridge.pollTimer);
          bridge.pollTimer = setInterval(() => {
            if (!bridge.parking || bridge.completedPromptSeq < bridge.requiredPromptSeq) return;
            bridge.idleStableTicks = bridge.ctx?.isIdle() ? bridge.idleStableTicks + 1 : 0;
            if (!handoffBarrierReached(bridge.requiredPromptSeq, bridge.completedPromptSeq, bridge.idleStableTicks)) return;
            if (bridge.pollTimer) clearInterval(bridge.pollTimer);
            bridge.pollTimer = undefined;
            bridge.parking = false;
            bridge.parked = true;
            sendChildEvent({
              type: "teammate_handoff_ready",
              correlationId: process.env.PI_TEAMMATE_CORRELATION_ID,
              nonce: bridge.nonce,
              sessionId: bridge.ctx.sessionManager.getSessionId(),
              sessionFile: bridge.ctx.sessionManager.getSessionFile(),
            });
          }, 50);
        } else if (m?.type === "teammate_lease_update") {
          bridge.expectedLease = m.token as LeaseToken | undefined;
          if (bridge.expectedLease?.owner === "none") bridge.nonce = bridge.expectedLease.nonce;
        } else if (m?.type === "teammate_handoff_cancel" && m.nonce === bridge.nonce) {
          bridge.parking = false;
          bridge.parked = false;
          if (bridge.pollTimer) clearInterval(bridge.pollTimer);
          bridge.pollTimer = undefined;
          sendChildEvent({
            type: "teammate_handoff_cancelled",
            correlationId: process.env.PI_TEAMMATE_CORRELATION_ID,
            nonce: bridge.nonce,
          });
        }
      });
    }

    async function proxyCall<T>(tool: string, params: unknown): Promise<AgentToolResult<T>> {
      if (typeof process.send !== "function") {
        return {
          content: [{ type: "text", text: "IPC not available. Teammate proxy requires IPC channel." }],
          isError: true,
        } as AgentToolResult<T>;
      }
      const requestId = randomUUID();
      const result = await new Promise<unknown>((resolve) => {
        pendingRequests.set(requestId, resolve);
        process.send?.({ type: "teammate_proxy_request", tool, requestId, params });
      });
      return result as AgentToolResult<T>;
    }

    pi.registerTool({
      name: "teammate",
      label: "Teammate",
      description: "Dispatch tasks to teammate agents (proxy to root orchestrator).",
      parameters: TeammateParams,
      async execute(_id: string, params: RunTeammateParams) {
        return proxyCall<Details>("teammate", params);
      },
    });

    pi.registerTool({
      name: "teammate-send",
      label: "Teammate Send",
      description: "Send a message to a named teammate agent (proxy to root).",
      parameters: TeammateSendParams,
      async execute(_id: string, params: { to: string; message: string; mode?: RpcMessageMode }) {
        return proxyCall<{ delivered: boolean }>("teammate-send", params);
      },
    });

    pi.registerTool({
      name: "teammate-list",
      label: "Teammate List",
      description: "List active teammate agents (proxy to root).",
      parameters: TeammateListParams,
      async execute(_id: string, params: { view?: "active" | "named" | "all" }) {
        return proxyCall<{ agents: unknown[] }>("teammate-list", params);
      },
    });

    pi.registerTool({
      name: "teammate-watch",
      label: "Teammate Watch",
      description: "View a running agent's output (proxy to root).",
      parameters: TeammateWatchParams,
      async execute(_id: string, params: { name: string; lines?: number }) {
        return proxyCall<{ output: string[] }>("teammate-watch", params);
      },
    });

    return; // Child mode done — skip root-mode registration
  }

  // =========================================================================
  // ROOT MODE — full tool implementations below
  // =========================================================================

  const registryKey = Symbol.for("pi-maestro-teammate.root-registry");
  const rootGlobals = globalThis as typeof globalThis & Record<symbol, unknown>;
  const state: TeammateState = (rootGlobals[registryKey] as TeammateState | undefined) ?? {
    baseCwd: "",
    currentSessionId: null,
    activeRuns: new Map(),
    namedAgents: new Map(),
  };
  rootGlobals[registryKey] = state;

  function handleChildLifecycleEvent(event: Record<string, unknown>): void {
    const correlationId = event.correlationId as string | undefined;
    if (!correlationId) return;
    const agent = state.activeRuns.get(correlationId);
    if (!agent) return;
    const eventSessionFile = event.sessionFile as string | undefined;
    if (eventSessionFile && !isSessionPathContained(agent.sessionDir, eventSessionFile)) return;

    if (event.type === "teammate_session_ready") {
      agent.sessionId = event.sessionId as string | undefined;
      agent.sessionFile = eventSessionFile;
      return;
    }
    const pendingHandoff = agent.pendingHandoff;
    if (event.type === "teammate_handoff_ready" && pendingHandoff && event.nonce === pendingHandoff.nonce) {
      agent.sessionId = event.sessionId as string | undefined;
      agent.sessionFile = eventSessionFile;
      if (agent.lease) agent.lease = confirmParked(agent.lease);
      clearTimeout(pendingHandoff.timer);
      pendingHandoff.resolve(true);
      agent.pendingHandoff = undefined;
      return;
    }
    if (event.type === "teammate_handoff_returned") {
      const pending = agent.pendingHandback;
      if (!pending
        || event.nonce !== pending.nonce
        || event.sessionId !== pending.sessionId
        || event.sessionFile !== pending.sessionFile
      ) return;
      if (agent.lease) agent.lease = confirmChildReloaded(agent.lease);
      if (agent.lease) agent.sendControl?.({ type: "teammate_lease_update", token: leaseToken(agent.lease) });
      agent.pendingHandback = undefined;
      agent.status = "running";
      return;
    }
    if (event.type === "teammate_handoff_cancelled"
      && agent.lease?.state === "fenced"
      && agent.pendingCancel?.nonce === event.nonce
      && agent.pendingCancel.fencedEpoch === agent.lease.epoch
    ) {
      agent.lease = recoverChild(agent.lease);
      agent.sendControl?.({ type: "teammate_lease_update", token: leaseToken(agent.lease) });
      agent.pendingCancel = undefined;
    }
  }

  // =========================================================================
  // Tool 1: teammate — dispatch
  // =========================================================================

  const tool: ToolDefinition<typeof TeammateParams, Details> = {
    name: "teammate",
    label: "Teammate",
    description: `Dispatch tasks to teammate agents. Teammates run as pi subprocesses with their own tools and context.

Single agent:
  { agent: "delegate", task: "..." }

Fork current session (child inherits full conversation history):
  { agent: "delegate", task: "...", context: "fork" }

Multiple tasks (no references = parallel):
  { tasks: [
      { agent: "scout", task: "Find API endpoints" },
      { agent: "scout", task: "Map database schema" }
    ] }

Multiple tasks ({name} references = DAG — dependencies auto-resolved):
  { tasks: [
      { agent: "scout", name: "api", task: "List all API routes",
        outputSchema: { type: "object", properties: { routes: { type: "array" } } } },
      { agent: "scout", name: "db", task: "Map the database schema" },
      { agent: "reviewer", task: "Routes: {api.routes}\\nDB: {db}\\n\\nCheck consistency" }
    ] }

Variable references:
  - {name} — full output of the named task (text or JSON if outputSchema set)
  - {name.field} — specific field from structured output

Context modes:
  - "fresh" (default): blank conversation, no prior context
  - "fork": inherits current session's full conversation history — the child sees everything before the fork and continues independently

Routing:
  - name: addressable name for variable referencing and teammate-send
  - reply_to: "caller" (direct return) or "main" (broadcast to parent)

Top-level defaults (model, cwd, outputSchema, timeoutMs) flow down to each task unless overridden per-task.`,

    promptSnippet: "Use teammate to dispatch background agents for parallel or sequential work.",
    promptGuidelines: [
      "Prefer background mode (default) for long-running tasks — foreground (background: false) only for short tasks where you need the result immediately",
      "Use the name field to make agents addressable via teammate-send and referenceable via {name} in other tasks",
      "Use {name} and {name.field} variable references in tasks array to create DAG dependencies — referenced tasks are awaited, unreferenced run in parallel",
      "Set outputSchema for structured output when downstream tasks need specific fields",
      "Use teammate-list to check running agents, teammate-send to send follow-up messages or steer/abort",
      'Use context: "fork" to spawn a child that inherits the current conversation history — useful when the child needs full context of what has been discussed',
    ],

    parameters: TeammateParams,

    async execute(
      id: string,
      params: RunTeammateParams,
      signal: AbortSignal,
      onUpdate:
        | ((result: AgentToolResult<Details>) => void)
        | undefined,
      ctx: ExtensionContext,
    ): Promise<AgentToolResult<Details>> {
      // --- Normalize to task list ---
      let normalizedTasks: NormalizedTask[];
      let isMultiTask = false;

      if (params.chain?.length) {
        normalizedTasks = normalizeChainToTasks(params.chain, params.task ?? "");
        isMultiTask = true;
      } else if (params.tasks?.length) {
        normalizedTasks = params.tasks.map((t: { agent: string; task?: string; name?: string; model?: string; cwd?: string; outputSchema?: Record<string, unknown>; timeoutMs?: number }) => ({
          agent: t.agent,
          task: t.task ?? "",
          name: t.name,
          model: t.model ?? params.model,
          cwd: t.cwd ?? params.cwd,
          outputSchema: (t.outputSchema ?? params.outputSchema) as Record<string, unknown> | undefined,
          timeoutMs: t.timeoutMs ?? params.timeoutMs,
        }));
        isMultiTask = true;
      } else if (params.agent) {
        normalizedTasks = [];
      } else {
        return {
          content: [{ type: "text", text: 'Requires "agent" field for single mode, or "tasks" for multi-task mode.' }],
          isError: true,
          details: { mode: "single", results: [] },
        };
      }

      // Apply top-level defaults to chain tasks
      if (params.chain?.length) {
        for (const t of normalizedTasks) {
          t.model ??= params.model;
          t.cwd ??= params.cwd;
          t.outputSchema ??= params.outputSchema as Record<string, unknown> | undefined;
          t.timeoutMs ??= params.timeoutMs;
        }
      }

      const isSingle = !isMultiTask;
      const graphMode = isMultiTask ? inferGraphMode(normalizedTasks) : null;

      const taskNames = new Set(normalizedTasks.filter((task) => task.name).map((task) => task.name!));
      const taskIndexByName = new Map<string, number>();
      normalizedTasks.forEach((task, index) => {
        if (task.name) taskIndexByName.set(task.name, index);
      });
      const taskCorrelationIds = isMultiTask
        ? normalizedTasks.map(() => randomUUID())
        : [];
      const progressState = new Map<number, AgentProgressSnapshot>();
      if (isMultiTask) {
        normalizedTasks.forEach((task, index) => {
          progressState.set(index, {
            agent: task.agent,
            ...(task.name ? { name: task.name } : {}),
            correlationId: taskCorrelationIds[index],
            taskIndex: index,
            dependencies: extractDependencies(task.task, taskNames)
              .map((name) => taskIndexByName.get(name))
              .filter((dependency): dependency is number => dependency !== undefined),
            status: "pending",
          });
        });
      }

      const progressSnapshot = (): AgentProgressSnapshot[] =>
        [...progressState.values()].sort((a, b) => a.taskIndex - b.taskIndex);

      const correlationId = randomUUID();

      const abortController = new AbortController();
      // P2-1: Deadlock detection — check if reply_to creates a cycle
      if (params.name && params.reply_to !== "main" && params.reply_to !== "caller") {
        const wouldCycle = detectReplyCycle(state, params.name, params.reply_to);
        if (wouldCycle) {
          return {
            content: [{
              type: "text",
              text: `[deadlock] reply_to="${params.reply_to}" would create a cycle with agent "${params.name}". Falling back to reply_to="caller".`,
            }],
            isError: false,
            details: { mode: "single", results: [] },
          };
        }
      }

      const agentLabel = isMultiTask ? `graph(${normalizedTasks.length})` : params.agent!;

      const activeAgent: ActiveAgent = {
        agent: agentLabel,
        name: params.name,
        correlationId,
        startedAt: Date.now(),
        abortController,
        inbox: [],
        outputLog: [],
        lastActivityAt: Date.now(),
        replyTo: params.reply_to,
        status: "running",
        sleepMs: 0,
        lease: createChildLease(),
        promptSeq: p.task ? 1 : 0,
        lease: createChildLease(),
        promptSeq: params.task ? 1 : 0,
        ...(isMultiTask ? { progress: progressSnapshot() } : {}),
      };
      state.activeRuns.set(correlationId, activeAgent);

      if (params.name) {
        state.namedAgents.set(params.name, correlationId);
      }

      pi.events.emit(TEAMMATE_STARTED_EVENT, {
        id,
        agent: agentLabel,
        name: params.name,
        correlationId,
      });

      const abortForward = () => abortController.abort();
      signal.addEventListener("abort", abortForward, { once: true });

      const parentSessionFile = ctx.sessionManager?.getSessionFile?.() ?? undefined;

      const makeOptions = () => ({
        baseCwd: state.baseCwd || ctx.cwd,
        ...(isSingle ? { correlationId } : {}),
        ...(isMultiTask ? { taskCorrelationIds } : {}),
        signal: abortController.signal,
        parentSessionFile,
        onChildSpawned: (
          stdin: import("node:stream").Writable,
          sendControl: (message: Record<string, unknown>) => boolean,
          sessionDir?: string,
        ) => {
          activeAgent.stdin = stdin;
          activeAgent.sendControl = sendControl;
          activeAgent.sessionDir = sessionDir;
          if (activeAgent.lease) sendControl({ type: "teammate_lease_update", token: leaseToken(activeAgent.lease) });
        },
        onChildEvent: (event: Record<string, unknown>) => handleChildLifecycleEvent({ ...event, correlationId }),
        onProgress: (() => {
          let lastUpdateTime = 0;
          const UPDATE_INTERVAL = 300; // ms — throttle TUI updates
          const logStates = new Map<string, {
            loggedToolCount: number;
            streamingLineIdx: number;
            loggedToolLines: Map<number, number>;
          }>();

          return (data: AgentProgress) => {
            activeAgent.lastActivityAt = Date.now();
            const progressKey = data.taskIndex ?? 0;
            const existing = progressState.get(progressKey);
            const progressName = data.name ?? existing?.name;
            const entry: AgentProgressSnapshot = {
              agent: data.agent,
              ...(progressName ? { name: progressName } : {}),
              correlationId: data.correlationId ?? existing?.correlationId ?? taskCorrelationIds[progressKey] ?? correlationId,
              taskIndex: progressKey,
              dependencies: data.dependencies ?? existing?.dependencies ?? [],
              status: data.status,
              startedAt: new Date(data.startedAt).toISOString(),
              recentTools: data.recentTools,
              toolCount: data.toolCount,
              tokens: data.tokens,
              ...(data.lastMessage ? { lastMessage: data.lastMessage } : {}),
              ...(data.status === "completed" || data.status === "failed"
                ? { completedAt: new Date().toISOString() }
                : {}),
            };
            progressState.set(progressKey, entry);
            const currentProgress = progressSnapshot();
            activeAgent.progress = currentProgress;

            const shortId = entry.correlationId.slice(0, 8);
            const logKey = entry.correlationId;
            const logState = logStates.get(logKey) ?? {
              loggedToolCount: 0,
              streamingLineIdx: -1,
              loggedToolLines: new Map<number, number>(),
            };
            logStates.set(logKey, logState);
            const logLabel = data.name
              ? `@${data.name}#${shortId}`
              : `${data.agent}#${shortId}`;

            // Record a bounded aggregate history while keeping per-agent cursors independent.
            const MAX_LOG = 200;
            if (data.recentTools?.length) {
              for (let ti = logState.loggedToolCount; ti < data.recentTools.length; ti++) {
                const tool = data.recentTools[ti];
                logState.loggedToolLines.set(ti, activeAgent.outputLog.length);
                activeAgent.outputLog.push(`[${new Date().toISOString().slice(11, 19)}] ${logLabel} ~ ${tool.name}`);
                logState.streamingLineIdx = -1;
              }
              for (let ti = 0; ti < data.recentTools.length; ti++) {
                const tool = data.recentTools[ti];
                if (tool.status !== "running") {
                  const lineIndex = logState.loggedToolLines.get(ti);
                  if (lineIndex !== undefined && activeAgent.outputLog[lineIndex]?.includes("~ ")) {
                    activeAgent.outputLog[lineIndex] = activeAgent.outputLog[lineIndex].replace("~ ", "✓ ");
                  }
                }
              }
              logState.loggedToolCount = data.recentTools.length;
            }
            if (data.lastMessage) {
              const lastLine = data.lastMessage.split("\n").pop()?.trim();
              if (lastLine) {
                const streamLine = `${logLabel} │ ${lastLine}`;
                if (logState.streamingLineIdx >= 0) {
                  activeAgent.outputLog[logState.streamingLineIdx] = streamLine;
                } else {
                  logState.streamingLineIdx = activeAgent.outputLog.length;
                  activeAgent.outputLog.push(streamLine);
                }
              }
            }
            if (activeAgent.outputLog.length > MAX_LOG) {
              activeAgent.outputLog.splice(0, activeAgent.outputLog.length - MAX_LOG);
              logStates.clear();
            }

            // Broadcast the complete graph snapshot so overlays can switch views reliably.
            pi.events.emit(TEAMMATE_MESSAGE_EVENT, {
              correlationId,
              agent: data.agent,
              name: data.name,
              taskCorrelationId: entry.correlationId,
              taskIndex: progressKey,
              dependencies: entry.dependencies,
              status: data.status,
              toolCount: data.toolCount,
              tokens: data.tokens,
              recentTools: data.recentTools,
              lastMessage: data.lastMessage,
              progress: currentProgress,
            });

            if (!onUpdate) return;
            // Throttle TUI updates — skip if too frequent (except completion).
            const now = Date.now();
            if (data.status === "running" && now - lastUpdateTime < UPDATE_INTERVAL) return;
            lastUpdateTime = now;

            onUpdate({
              content: [{
                type: "text",
                text: `[${data.name ?? data.agent}] ${data.status} · tools ${data.toolCount} · tokens ${data.tokens}`,
              }],
              details: {
                mode: (graphMode ?? "single") as Details["mode"],
                results: [],
                progress: currentProgress,
              },
            });
          };
        })(),
        onChildRequest: (event: Record<string, unknown>, reply: (msg: unknown) => void) => {
          handleProxyRequest(pi, state, event, reply, correlationId);
        },
      });

      let detached = false;

      try {
        // --- MULTI-TASK MODE (parallel / chain / graph) ---
        if (isMultiTask) {
          const executeGraph = async () => {
            const results = await runGraph(
              normalizedTasks,
              params.concurrency ?? 4,
              makeOptions(),
            );

            const hasError = results.some((r) => r.exitCode !== 0);
            const totalDur = graphMode === "chain"
              ? results.reduce((s, r) => s + r.durationMs, 0)
              : Math.max(...results.map((r) => r.durationMs), 0);

            const summaries = results
              .map((r, i) => `[${r.agent}${normalizedTasks[i]?.name ? "/" + normalizedTasks[i].name : ""}] ${r.exitCode === 0 ? "OK" : "FAIL"}: ${r.messages[r.messages.length - 1]?.content ?? "(no output)"}`)
              .join("\n\n");

            // Aggregate structured outputs by task name (fallback to index for unnamed)
            const structuredOutputs: Record<string, unknown> = {};
            for (let i = 0; i < results.length; i++) {
              const task = normalizedTasks[i];
              if (results[i].structuredOutput !== undefined) {
                const key = task.name ?? String(i);
                structuredOutputs[key] = results[i].structuredOutput;
              }
            }
            const structuredOutput = Object.keys(structuredOutputs).length > 0
              ? structuredOutputs
              : undefined;

            results.forEach((result, index) => {
              const current = progressState.get(index);
              progressState.set(index, {
                agent: result.agent,
                ...(normalizedTasks[index]?.name ? { name: normalizedTasks[index].name } : {}),
                correlationId: result.correlationId,
                taskIndex: index,
                dependencies: current?.dependencies ?? [],
                status: result.exitCode === 0 ? "completed" : "failed",
                ...(current?.startedAt ? { startedAt: current.startedAt } : {}),
                completedAt: new Date().toISOString(),
                recentTools: current?.recentTools ?? [],
                toolCount: current?.toolCount ?? 0,
                tokens: result.usage.inputTokens + result.usage.outputTokens,
                lastMessage: result.messages[result.messages.length - 1]?.content ?? "",
              });
            });
            const progress = progressSnapshot();
            activeAgent.progress = progress;

            return { results, hasError, totalDur, summaries, structuredOutput, progress };
          };

          if (params.background === false) {
            // Foreground: block until completion
            const { results, hasError, totalDur, summaries, structuredOutput, progress } = await executeGraph();

            emitComplete(pi, id, graphMode, correlationId, hasError ? 1 : 0, totalDur);

            return {
              content: [{ type: "text", text: summaries }],
              isError: hasError,
              details: {
                mode: graphMode as Details["mode"],
                results,
                progress,
                ...(structuredOutput !== undefined ? { structuredOutput } : {}),
              },
            };
          }

          // Background (default)
          const bgPromise = executeGraph();

          bgPromise.then(({ results, summaries, progress }) => {
            retireAgent(state, correlationId, summaries);

            pi.sendMessage(
              {
                customType: "teammate-complete",
                content: summaries,
                display: true,
                details: { mode: graphMode, results, progress },
              },
              { triggerTurn: true },
            );
          }).catch(() => {
            retireAgent(state, correlationId);
          });

          return {
            content: [{
              type: "text",
              text: `${normalizedTasks.length} tasks (${graphMode}) running in background. correlationId=${correlationId}. Use teammate-list to check status.`,
            }],
            isError: false,
            details: { mode: graphMode as Details["mode"], results: [], progress: progressSnapshot() },
          };
        }

        if (params.background === false) {
          // --- FOREGROUND: block until completion, Alt+B to detach ---
          let detachResolve: (() => void) | null = null;
          const detachPromise = new Promise<void>((r) => { detachResolve = r; });

          const removeListener = ctx.hasUI
            ? ctx.ui.onTerminalInput((data: string) => {
                if (data === "\x1bb") detachResolve?.(); // Alt+B
              })
            : null;

          const runPromise = runTeammate(params, makeOptions());
          const race = await Promise.race([
            runPromise.then((r) => ({ done: true as const, result: r })),
            detachPromise.then(() => ({ done: false as const, result: null })),
          ]);

          removeListener?.();

          if (race.done) {
            const result = race.result!;
            emitComplete(pi, id, params.agent, correlationId, result.exitCode, result.durationMs);
            const lastMessage = result.messages[result.messages.length - 1]?.content ?? "(no output)";
            const toolResult: AgentToolResult<Details> = {
              content: [{ type: "text", text: lastMessage }],
              isError: result.exitCode !== 0,
              details: { mode: "single", results: [result] },
            };
            if (result.structuredOutput !== undefined) {
              toolResult.details!.structuredOutput = result.structuredOutput;
            }
            return toolResult;
          }

          // Alt+B: detach to background
          detached = true;
          runPromise.then((result) => {
            emitComplete(pi, id, params.agent, correlationId, result.exitCode, result.durationMs);
            const lastMsg = result.messages[result.messages.length - 1]?.content ?? "(no output)";
            retireAgent(state, correlationId, lastMsg);
            pi.sendMessage(
              {
                customType: "teammate-complete",
                content: lastMsg,
                display: true,
                details: { mode: "single", results: [result] },
              },
              { triggerTurn: true },
            );
          }).catch(() => {
            retireAgent(state, correlationId);
          });
          return {
            content: [{ type: "text", text: `■ @${params.name ?? params.agent} detached · completion notification enabled` }],
            isError: false,
            details: { mode: "single", results: [] },
          };
        }

        // --- BACKGROUND (default) ---
        const bgPromise = runTeammate(params, makeOptions());

        bgPromise.then((result) => {
          emitComplete(pi, id, params.agent, correlationId, result.exitCode, result.durationMs);
          const lastMsg = result.messages[result.messages.length - 1]?.content ?? "(no output)";
          retireAgent(state, correlationId, lastMsg);

          pi.sendMessage(
            {
              customType: "teammate-complete",
              content: lastMsg,
              display: true,
              details: { mode: "single", results: [result] },
            },
            { triggerTurn: true },
          );
        }).catch(() => {
          retireAgent(state, correlationId);
        });

        return {
          content: [{
            type: "text",
            text: `■ @${params.name ?? params.agent} running in background · teammate-list status · teammate-send message`,
          }],
          isError: false,
          details: { mode: "single", results: [] },
        };
      } finally {
        if (params.background === false && !detached) {
          retireAgent(state, correlationId);
        }
        signal.removeEventListener("abort", abortForward);
      }
    },

    renderCall(args, theme, context) {
      return renderTeammateCall(args, theme, context);
    },

    renderResult(result, options, theme) {
      return renderTeammateResult(result, options, theme);
    },
  };

  // =========================================================================
  // Tool 2: teammate-send — send message to named agent
  // =========================================================================

  const sendTool: ToolDefinition<typeof TeammateSendParams, { delivered: boolean }> = {
    name: "teammate-send",
    label: "Teammate Send",
    description: `Send a message to a named, running teammate agent.

Modes:
  - "steer" — interrupt current turn, inject message immediately
  - "follow_up" (default) — queue after current turn completes
  - "abort" — cancel current execution (message field ignored)`,

    promptSnippet: "Use teammate-send to communicate with running teammate agents by name.",

    parameters: TeammateSendParams,

    async execute(
      _id: string,
      params: { to: string; message: string; mode?: RpcMessageMode },
    ): Promise<AgentToolResult<{ delivered: boolean }>> {
      const requestedMode = params.mode ?? "follow_up";

      const cid = state.namedAgents.get(params.to);
      if (!cid) {
        const available = Array.from(state.namedAgents.keys());
        return {
          content: [{ type: "text", text: `Agent "${params.to}" not found. ${available.length > 0 ? `Available: ${available.join(", ")}` : "No named agents running."}` }],
          isError: true,
          details: { delivered: false },
        };
      }

      const agent = state.activeRuns.get(cid);
      if (!agent?.stdin?.writable) {
        state.namedAgents.delete(params.to);
        return {
          content: [{ type: "text", text: `Agent "${params.to}" is no longer running.` }],
          isError: true,
          details: { delivered: false },
        };
      }

      if (!canChildWrite(agent.lease)) {
        return {
          content: [{ type: "text", text: `Agent "${params.to}" is currently owned by ${agent.lease.owner} (${agent.lease.state}).` }],
          isError: true,
          details: { delivered: false },
        };
      }

      const mode: RpcMessageMode = agent.status === "sleeping" && requestedMode !== "abort"
        ? "prompt"
        : requestedMode;
      const sent = sendRpcMessage(agent.stdin, params.message, mode, agent.lease ? leaseToken(agent.lease) : undefined);
      if (!sent) {
        return {
          content: [{ type: "text", text: `Failed to send message to "${params.to}".` }],
          isError: true,
          details: { delivered: false },
        };
      }

      if (mode === "prompt") agent.promptSeq = (agent.promptSeq ?? 0) + 1;
      const wasSleeping = agent.status === "sleeping";
      if (wasSleeping && mode !== "abort") {
        agent.status = "running";
        if (agent.sleptAt) {
          agent.sleepMs += Date.now() - agent.sleptAt;
          agent.sleptAt = undefined;
        }
      }

      const now = Date.now();
      agent.inbox.push({ id: randomUUID(), from: "caller", to: params.to, kind: mode === "abort" ? "notification" : "task", payload: params.message, timestamp: now });
      agent.outputLog.push(`[${new Date(now).toISOString().slice(11, 19)}] ◀ ${mode}: ${params.message.slice(0, 100)}`);
      agent.lastActivityAt = now;

      pi.events.emit(TEAMMATE_MESSAGE_EVENT, { correlationId: cid, from: "caller", to: params.to, mode, message: params.message, isSend: true });

      if (mode === "abort") {
        killAgent(state, cid, params.to);
        return {
          content: [{ type: "text", text: `Agent "${params.to}" aborted and terminated.` }],
          isError: false,
          details: { delivered: true },
        };
      }

      const modeLabel = wasSleeping ? "woken up + prompt" : mode === "steer" ? "interrupted + injected" : "queued after current turn";
      return {
        content: [{ type: "text", text: `Message ${modeLabel} for "${params.to}".${wasSleeping ? " Agent woken up." : ""}` }],
        isError: false,
        details: { delivered: true },
      };
    },
  };

  // =========================================================================
  // Tool 3: teammate-list — list active agents
  // =========================================================================

  const listTool: ToolDefinition<typeof TeammateListParams, { agents: unknown[] }> = {
    name: "teammate-list",
    label: "Teammate List",
    description: `List active teammate agents with status and timing.`,

    promptSnippet: "Use teammate-list to check on running background agents before dispatching new work.",

    parameters: TeammateListParams,

    async execute(
      _id: string,
      params: { view?: "active" | "named" | "all" },
    ): Promise<AgentToolResult<{ agents: unknown[] }>> {
      const view = params.view ?? "active";
      const { entries, text } = buildAgentList(state, view);

      return {
        content: [{ type: "text", text }],
        isError: false,
        details: { agents: entries },
      };
    },
  };

  // =========================================================================
  // Tool 4: teammate-watch — view agent output and activity
  // =========================================================================

  const watchTool: ToolDefinition<typeof TeammateWatchParams, { output: string[] }> = {
    name: "teammate-watch",
    label: "Teammate Watch",
    description: `View a running agent's recent output log — tool calls, streaming text, and inbox messages.`,

    promptSnippet: "Use teammate-watch to inspect a specific agent's live activity log.",

    parameters: TeammateWatchParams,

    async execute(
      _id: string,
      params: { name: string; lines?: number },
    ): Promise<AgentToolResult<{ output: string[] }>> {
      const lines = params.lines ?? 20;
      const resolved = resolveWatchTarget(state, params.name);
      if (!resolved.match) {
        const suffix = resolved.available.length > 0
          ? ` Available: ${resolved.available.join(", ")}`
          : " No agents are available.";
        return {
          content: [{ type: "text", text: resolved.error ?? `Agent "${params.name}" not found.${suffix}` }],
          isError: true,
          details: { output: [] },
        };
      }
      const output = buildWatchOutput(resolved.match, lines);

      return {
        content: [{ type: "text", text: output.join("\n") }],
        isError: false,
        details: { output },
      };
    },
  };

  // =========================================================================
  // Register tools (LLM-callable)
  // =========================================================================

  pi.registerTool(tool);
  pi.registerTool(sendTool);
  pi.registerTool(listTool);
  pi.registerTool(watchTool);

  // =========================================================================
  // Alt+R shortcut — attach overlay (user-facing TUI)
  // =========================================================================

  function agentLabel(a: ActiveAgent): string {
    return a.name ?? a.correlationId.slice(0, 8);
  }

  interface ComposerPanel {
    render(width: number): string[];
    handleInput(data: string): void;
    invalidate(): void;
    dispose?(): void;
  }

  let interactivePanelActive = false;

  async function showComposerPanel<T>(
    ctx: ExtensionContext,
    key: string,
    create: (requestRender: () => void, done: (value: T) => void) => ComposerPanel,
  ): Promise<T> {
    interactivePanelActive = true;
    updateAgentWidget();

    return new Promise<T>((resolve, reject) => {
      let panel: ComposerPanel | undefined;
      let unsubscribe = () => {};
      let settled = false;

      const cleanup = (): void => {
        unsubscribe();
        ctx.ui.setWidget(key, undefined);
        interactivePanelActive = false;
        updateAgentWidget();
      };
      const done = (value: T): void => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve(value);
      };

      try {
        ctx.ui.setWidget(key, (tui) => {
          panel = create(() => tui.requestRender(), done);
          return panel;
        }, { placement: "aboveEditor" });
        unsubscribe = ctx.ui.onTerminalInput((data) => {
          panel?.handleInput(data === "\x03" ? "\x1b" : data);
          return { consume: true };
        });
      } catch (error) {
        cleanup();
        reject(error);
      }
    });
  }

  async function showAttachOverlay(correlationId: string, ctx: ExtensionContext): Promise<void> {
    const agent = state.activeRuns.get(correlationId);
    if (!agent) {
      ctx.ui.notify("Agent is no longer active.", "error");
      return;
    }

    interactivePanelActive = true;
    updateAgentWidget();
    try {
      await ctx.ui.custom<void>(
        (tui, _theme, _keybindings, done) => {
        const overlay = new AttachOverlay(
          agent,
          () => done(undefined),
          () => state.activeRuns,
          async (cid, message) => {
            const target = state.activeRuns.get(cid);
            if (!target?.stdin?.writable) {
              return { ok: false, message: "Agent is no longer writable" };
            }
            if (!canChildWrite(target.lease)) {
              return { ok: false, message: `Session owned by ${target.lease.owner} (${target.lease.state})` };
            }
            const sendMode: RpcMessageMode = target.status === "sleeping" ? "prompt" : "follow_up";
            const sent = sendRpcMessage(target.stdin, message, sendMode, target.lease ? leaseToken(target.lease) : undefined);
            if (!sent) return { ok: false, message: "Send failed" };
            if (sendMode === "prompt") target.promptSeq = (target.promptSeq ?? 0) + 1;

            const now = Date.now();
            const label = target.name ?? target.correlationId.slice(0, 8);
            target.inbox.push({
              id: randomUUID(),
              from: "caller",
              to: label,
              kind: "task",
              payload: message,
              timestamp: now,
            });
            target.outputLog.push(`[${new Date(now).toISOString().slice(11, 19)}] ◀ follow_up: ${message.slice(0, 100)}`);
            target.lastActivityAt = now;
            if (target.status === "sleeping") {
              target.status = "running";
              if (target.sleptAt) {
                target.sleepMs += now - target.sleptAt;
                target.sleptAt = undefined;
              }
            }
            pi.events.emit(TEAMMATE_MESSAGE_EVENT, {
              correlationId: cid,
              from: "caller",
              to: label,
              mode: sendMode,
              message,
              isSend: true,
            });
            return { ok: true, message: `Queued for ${label}` };
          },
        );
        overlay.setRequestRender(() => tui.requestRender());

        // Load existing output log history
        for (const line of agent.outputLog) {
          const kind = line.includes("◀ ") ? "system" as const
            : line.match(/\[\d{2}:\d{2}:\d{2}\]/) ? "tool" as const
            : "output" as const;
          overlay.appendLog(agent.correlationId, line, kind);
        }
        if (agent.outputLog.length === 0) {
          overlay.appendLog(agent.correlationId, `Agent: ${agent.agent} | ${agentLabel(agent)}`, "info");
          overlay.appendLog(agent.correlationId, `Started: ${new Date(agent.startedAt).toISOString()}`, "info");
        }

        const completedToolLog = new Set<string>();

        const msgHandler = (data: unknown) => {
          const evt = data as Record<string, unknown>;
          const cid = evt.correlationId as string;
          if (!cid) return;

          if (evt.isSend) {
            const mode = evt.mode as string;
            const msg = (evt.message as string)?.slice(0, 60) ?? "";
            overlay.appendLog(cid, `[${ts()}] ◀ ${mode}: ${msg}`, "system");
            return;
          }

          const progress = evt.progress as AgentProgressSnapshot[] | undefined;
          if (progress) overlay.setProgress(cid, progress);

          const tools = evt.recentTools as Array<{ name: string; status: string }> | undefined;
          if (tools && tools.length > 0) {
            const toolEntries = tools.map((t) => ({
              name: t.name,
              status: t.status as "running" | "completed" | "failed",
              startedAt: Date.now(),
            }));
            overlay.setActiveTools(cid, toolEntries);

            for (const t of tools) {
              const key = `${evt.taskIndex ?? "single"}:${t.name}:${t.status}`;
              if (t.status !== "running" && !completedToolLog.has(key)) {
                completedToolLog.add(key);
                overlay.appendLog(cid, `[${ts()}] ✓ ${t.name}`, "tool");
              }
            }
          }

          const lastMsg = evt.lastMessage as string | undefined;
          if (lastMsg) {
            overlay.setStreamingText(cid, lastMsg);
          }
        };
        const completeHandler = (data: unknown) => {
          const evt = data as Record<string, unknown>;
          const cid = evt.correlationId as string;
          if (!cid) return;
          overlay.appendLog(cid, `COMPLETED exitCode=${evt.exitCode} ${evt.durationMs}ms`, "system");
        };
        const unsubscribeMessage = pi.events.on(TEAMMATE_MESSAGE_EVENT, msgHandler);
        const unsubscribeComplete = pi.events.on(TEAMMATE_COMPLETE_EVENT, completeHandler);

        const origDispose = overlay.dispose.bind(overlay);
        overlay.dispose = () => {
          unsubscribeMessage();
          unsubscribeComplete();
          origDispose();
        };

        return {
          get focused() { return overlay.focused; },
          set focused(value: boolean) { overlay.focused = value; },
          render: (width: number) => overlay.render(width),
          handleInput: (data: string) => overlay.handleInput(data),
          invalidate: () => overlay.invalidate(),
          dispose: () => overlay.dispose(),
        };
        },
        {
          overlay: true,
          overlayOptions: {
            width: "88%",
            maxHeight: "86%",
            anchor: "center",
          },
        },
      );
    } finally {
      interactivePanelActive = false;
      updateAgentWidget();
    }
  }

  async function showAgentSelector(ctx: ExtensionContext): Promise<void> {
    const entries = Array.from(state.activeRuns.entries()).filter(([, a]) => a.status !== "completed");
    if (entries.length === 0) {
      ctx.ui.notify("No active agents.", "warning");
      return;
    }
    if (entries.length === 1) {
      await showAttachOverlay(entries[0][0], ctx);
      return;
    }

    // Fuzzy search panel above the editor for agent selection.
    const { truncateToWidth: trunc } = await import("@earendil-works/pi-tui");
    type AgentEntry = [string, ActiveAgent];

    function matchScore(entry: AgentEntry, rawQuery: string): number | undefined {
      const [, agent] = entry;
      const text = `${agent.agent} ${agent.name ?? ""} ${agent.correlationId.slice(0, 8)}`.toLowerCase();
      const query = rawQuery.trim().toLowerCase();
      if (!query) return 0;
      const direct = text.indexOf(query);
      if (direct >= 0) return 1000 - direct;

      let position = -1;
      let score = 0;
      for (const char of query) {
        const next = text.indexOf(char, position + 1);
        if (next < 0) return undefined;
        score += next === position + 1 ? 10 : 1;
        position = next;
      }
      return score;
    }

    const selected = await showComposerPanel<string | null>(
      ctx,
      "teammate-agent-selector",
      (requestRender, done) => {
        let query = "";
        let cursor = 0;

        function filtered(): AgentEntry[] {
          if (!query) return entries;
          return entries
            .map((entry, index) => ({ entry, index, score: matchScore(entry, query) }))
            .filter((item): item is { entry: AgentEntry; index: number; score: number } => item.score !== undefined)
            .sort((a, b) => b.score - a.score || a.index - b.index)
            .map((item) => item.entry);
        }

        return {
          render(width: number) {
            const dim = (s: string) => `\x1b[2m${s}\x1b[22m`;
            const bold = (s: string) => `\x1b[1m${s}\x1b[22m`;
            const green = (s: string) => `\x1b[32m${s}\x1b[39m`;
            const yellow = (s: string) => `\x1b[33m${s}\x1b[39m`;
            const w = Math.max(1, Math.min(width, 60));
            const matches = filtered();
            if (w < 20) {
              const current = matches[cursor];
              const compact = current
                ? `${current[1].status === "sleeping" ? yellow("◉") : green("■")} ${current[1].agent}/${current[1].name ?? current[0].slice(0, 6)} ${dim(current[1].status)}`
                : `${dim("□")} no matches`;
              const queryPrefix = query ? `${query} ${dim("»")} ` : "";
              return [trunc(`${queryPrefix}${compact}`, w, "…")];
            }

            const inner = w - 2;
            const out: string[] = [];
            const frameLine = (content: string) =>
              dim("│") + trunc(` ${content}`, inner, "…", true) + dim("│");
            const maxVisible = 5;
            const start = Math.max(0, Math.min(
              Math.max(0, matches.length - maxVisible),
              cursor - Math.floor(maxVisible / 2),
            ));
            const visibleMatches = matches.slice(start, start + maxVisible);
            const range = matches.length > maxVisible
              ? dim(` ${start + 1}-${start + visibleMatches.length}/${matches.length}`)
              : "";

            out.push(dim("╭" + "─".repeat(inner) + "╮"));
            out.push(frameLine(`${green("❯")} ${query}${dim("│")}${range}`));
            out.push(dim("├" + "─".repeat(inner) + "┤"));

            for (let i = 0; i < visibleMatches.length; i++) {
              const absoluteIndex = start + i;
              const [cid, a] = visibleMatches[i];
              const icon = a.status === "sleeping" ? yellow("◉") : green("■");
              const name = a.name ?? cid.slice(0, 8);
              const up = Math.round((Date.now() - a.startedAt) / 1000);
              const status = a.status === "sleeping" ? yellow("sleeping") : green("running");
              const prefix = absoluteIndex === cursor ? green("▸") : " ";
              out.push(frameLine(`${prefix} ${icon} ${bold(`${a.agent}/${name}`)} ${status} ${dim(`${up}s`)}`));
            }
            if (matches.length === 0) {
              out.push(frameLine(dim("□ no matches")));
            }

            out.push(dim("╰" + "─".repeat(inner) + "╯"));
            out.push(trunc(dim(" type to filter · ↑↓ select · Enter attach · Esc cancel"), w, "…"));
            return out;
          },

          handleInput(data: string) {
            const matches = filtered();
            if (data === "\r" || data === "\n") {
              done(matches[cursor]?.[0] ?? null);
            } else if (data === "\x1b") {
              done(null);
            } else if (data === "\x1b[A" || (data === "k" && !query)) {
              cursor = Math.max(0, cursor - 1);
              requestRender();
            } else if (data === "\x1b[B" || (data === "j" && !query)) {
              cursor = Math.min(Math.max(0, matches.length - 1), cursor + 1);
              requestRender();
            } else if (data === "\x7f" || data === "\b") {
              if (query.length > 0) { query = query.slice(0, -1); cursor = 0; requestRender(); }
            } else if (data.length === 1 && data >= " ") {
              query += data;
              cursor = 0;
              requestRender();
            }
          },

          invalidate() {},
          dispose() {},
        };
      },
    );

    if (selected) {
      await showAttachOverlay(selected, ctx);
    }
  }

  async function prepareAgentHandoff(agent: ActiveAgent, timeoutMs = 15_000): Promise<boolean> {
    if (!agent.lease || !agent.sendControl) return false;
    agent.lease = requestPark(agent.lease);
    const nonce = agent.lease.nonce;
    const ready = new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => {
        if (agent.pendingHandoff?.nonce !== nonce) return;
        agent.pendingHandoff = undefined;
        agent.lease = agent.lease ? fenceLease(agent.lease) : undefined;
        if (agent.lease) agent.pendingCancel = { nonce, fencedEpoch: agent.lease.epoch };
        agent.sendControl?.({ type: "teammate_handoff_cancel", nonce });
        resolve(false);
      }, timeoutMs);
      agent.pendingHandoff = { nonce, resolve, timer };
    });
    if (!agent.sendControl({
      type: "teammate_handoff_request",
      nonce,
      requiredPromptSeq: agent.promptSeq ?? 0,
    })) {
      if (agent.pendingHandoff) clearTimeout(agent.pendingHandoff.timer);
      agent.pendingHandoff = undefined;
      agent.lease = fenceLease(agent.lease);
      return false;
    }
    return ready;
  }

  pi.registerCommand("teammate-session", {
    description: "Switch the main Pi conversation to a teammate session or return to main",
    async handler(_args, ctx) {
      const currentFile = ctx.sessionManager.getSessionFile();
      const attached = Array.from(state.activeRuns.values()).find((agent) =>
        agent.sessionFile === currentFile && agent.lease?.owner === "main"
      );
      if (attached) {
        if (!state.mainSessionFile) {
          ctx.ui.notify("Main session path is unavailable.", "error");
          return;
        }
        await ctx.waitForIdle();
        if (attached.lease) attached.lease = requestHandback(attached.lease);
        if (attached.lease) {
          const token = leaseToken(attached.lease);
          attached.pendingHandback = {
            nonce: token.nonce,
            epoch: token.epoch,
            sessionId: attached.sessionId,
            sessionFile: attached.sessionFile,
          };
          attached.sendControl?.({ type: "teammate_lease_update", token });
        }
        state.handoffSwitching = true;
        try {
          await switchConversationSession(ctx, state.mainSessionFile, async () => {
              state.handoffSwitching = false;
              if (!attached.stdin || !attached.sessionFile) return;
              sendRpcMessage(attached.stdin, `/teammate-handoff-reload ${encodeURIComponent(attached.sessionFile)}`, "prompt");
              setTimeout(() => {
                if (attached.lease?.state === "reloading") {
                  const cancelNonce = attached.pendingHandback?.nonce;
                  attached.lease = fenceLease(attached.lease);
                  attached.sendControl?.({ type: "teammate_lease_update", token: leaseToken(attached.lease) });
                  attached.pendingHandback = undefined;
                  if (cancelNonce) {
                    attached.pendingCancel = { nonce: cancelNonce, fencedEpoch: attached.lease.epoch };
                    attached.sendControl?.({ type: "teammate_handoff_cancel", nonce: cancelNonce });
                  }
                  attached.status = "sleeping";
                }
              }, 15_000);
          });
        } catch (error) {
          state.handoffSwitching = false;
          if (attached.lease) {
            attached.lease = fenceLease(attached.lease);
            attached.sendControl?.({ type: "teammate_lease_update", token: leaseToken(attached.lease) });
          }
          throw error;
        }
        return;
      }

      const candidates = Array.from(state.activeRuns.values()).filter((agent) =>
        Boolean(agent.sessionDir && agent.sessionFile && agent.sendControl && agent.lease?.owner === "child")
      );
      if (candidates.length === 0) {
        ctx.ui.notify("No attachable teammate sessions.", "warning");
        return;
      }
      const labels = candidates.map((agent) => `${agent.name ?? agent.correlationId.slice(0, 8)} · ${agent.agent} · ${agent.status}`);
      const selected = await ctx.ui.select("Switch to teammate session", labels);
      const index = selected ? labels.indexOf(selected) : -1;
      if (index < 0) return;
      const agent = candidates[index];
      ctx.ui.notify(`Waiting for ${agent.name ?? agent.agent} to finish its current loop…`, "info");
      if (!await prepareAgentHandoff(agent)) {
        ctx.ui.notify("Session handoff timed out and was fenced.", "error");
        return;
      }
      if (!agent.sessionFile || !agent.lease) return;
      agent.lease = transferToMain(agent.lease);
      agent.sendControl?.({ type: "teammate_lease_update", token: leaseToken(agent.lease) });
      state.handoffSwitching = true;
      try {
        await switchConversationSession(ctx, agent.sessionFile, async () => {
            state.handoffSwitching = false;
        });
      } catch (error) {
        state.handoffSwitching = false;
        agent.lease = fenceLease(agent.lease);
        agent.sendControl?.({ type: "teammate_lease_update", token: leaseToken(agent.lease) });
        throw error;
      }
    },
  });

  // =========================================================================
  // TUI — only in parent mode (child processes have no terminal)
  // =========================================================================

  pi.registerShortcut("alt+r", {
    description: "Switch the main conversation to a teammate session",
    handler() {
      pi.sendUserMessage("/teammate-session");
    },
  });

  let widgetCtx: ExtensionContext | null = null;

  function updateAgentWidget(): void {
    if (!widgetCtx) return;
    if (interactivePanelActive) {
      widgetCtx.ui.setWidget("teammate-agents", undefined);
      return;
    }
    const now = Date.now();
    const SLEEP_HIDE_MS = 60_000;
    const visible = Array.from(state.activeRuns.entries()).filter(([, a]) => {
      if (a.status === "completed") return false;
      if (a.status === "sleeping" && a.sleptAt && now - a.sleptAt > SLEEP_HIDE_MS) return false;
      return true;
    });
    if (visible.length === 0) {
      widgetCtx.ui.setWidget("teammate-agents", undefined);
      return;
    }

    // Sort: running first, sleeping last
    visible.sort(([, a], [, b]) => {
      if (a.status === "running" && b.status !== "running") return -1;
      if (a.status !== "running" && b.status === "running") return 1;
      return a.startedAt - b.startedAt;
    });

    const agents = visible.map(([, agent]) => agent);

    widgetCtx.ui.setWidget("teammate-agents", (_tui, theme) => ({
      render(width: number): string[] {
        return renderAgentStatusWidget(agents, width, theme);
      },
      invalidate() {},
    }), { placement: "belowEditor" });
  }

  let widgetTimer: ReturnType<typeof setInterval> | null = null;

  function startWidgetTimer(): void {
    if (widgetTimer) return;
    widgetTimer = setInterval(() => {
      if (state.activeRuns.size === 0) {
        stopWidgetTimer();
        updateAgentWidget();
        return;
      }
      updateAgentWidget();
    }, 1000);
  }

  function stopWidgetTimer(): void {
    if (widgetTimer) {
      clearInterval(widgetTimer);
      widgetTimer = null;
    }
  }

  if (!isChild) {
  pi.events.on(TEAMMATE_STARTED_EVENT, () => {
    updateAgentWidget();
    startWidgetTimer();
  });
  pi.events.on(TEAMMATE_COMPLETE_EVENT, () => {
    setTimeout(updateAgentWidget, 100);
  });

  // =========================================================================
  // Session lifecycle — agents live until session ends
  // =========================================================================

  pi.on("session_start", (_event, ctx) => {
    widgetCtx = ctx;
    state.baseCwd = ctx.cwd;
    state.currentSessionId = ctx.sessionManager?.getSessionId() ?? null;
    const sessionFile = ctx.sessionManager?.getSessionFile?.();
    const isAgentSession = Array.from(state.activeRuns.values()).some((agent) => agent.sessionFile === sessionFile);
    if (sessionFile && !isAgentSession) state.mainSessionFile = sessionFile;
  });

  pi.on("session_compact", (_event, ctx) => {
    widgetCtx = ctx;
    state.baseCwd = ctx.cwd;
    state.currentSessionId = ctx.sessionManager?.getSessionId() ?? null;
    updateAgentWidget();
  });

  pi.on("session_shutdown", () => {
    stopWidgetTimer();
    if (state.handoffSwitching) {
      widgetCtx = null;
      state.currentSessionId = null;
      return;
    }
    for (const [cid, run] of state.activeRuns) {
      killAgent(state, cid, run.name);
    }
    state.namedAgents.clear();
    state.currentSessionId = null;
  });
} // end if (!isChild)
} // end registerTeammateExtension

// ===========================================================================
// Helpers
// ===========================================================================

type AgentListView = "active" | "named" | "all";
type ListedAgentStatus = ActiveAgent["status"] | AgentProgressSnapshot["status"];

interface ListedAgent {
  agent: string;
  name?: string;
  correlationId: string;
  parentCorrelationId?: string;
  startedAt: string;
  durationMs: number;
  idleMs: number;
  inboxSize: number;
  hasStdin: boolean;
  spawnedBy?: string;
  depth: number;
  treePrefix: string;
  status: ListedAgentStatus;
  taskIndex?: number;
  dependencies?: number[];
  toolCount?: number;
  tokens?: number;
}

function progressDurationMs(progress: AgentProgressSnapshot, parent: ActiveAgent): number {
  const startedAt = progress.startedAt
    ? new Date(progress.startedAt).getTime()
    : parent.startedAt;
  const completedAt = progress.completedAt
    ? new Date(progress.completedAt).getTime()
    : Date.now();
  return Math.max(0, completedAt - startedAt);
}

export function buildAgentList(
  state: TeammateState,
  view: AgentListView,
): { entries: ListedAgent[]; text: string } {
  const entries: ListedAgent[] = [];
  const childrenOf = new Map<string, string[]>();
  const roots: string[] = [];

  const physicalVisible = (entry: ActiveAgent): boolean => {
    if (view === "active" && entry.status === "completed") return false;
    if (view === "named" && !entry.name && !entry.progress?.some((item) => item.name)) return false;
    return true;
  };

  for (const [cid, entry] of state.activeRuns) {
    if (!physicalVisible(entry)) continue;
    if (entry.spawnedBy && state.activeRuns.has(entry.spawnedBy)) {
      const siblings = childrenOf.get(entry.spawnedBy) ?? [];
      siblings.push(cid);
      childrenOf.set(entry.spawnedBy, siblings);
    } else {
      roots.push(cid);
    }
  }

  function visitPhysical(
    cid: string,
    treePrefix: string,
    descendantsPrefix: string,
    depth: number,
  ): void {
    const entry = state.activeRuns.get(cid);
    if (!entry || !physicalVisible(entry)) return;

    entries.push({
      agent: entry.agent,
      name: entry.name,
      correlationId: cid,
      startedAt: new Date(entry.startedAt).toISOString(),
      durationMs: agentActiveMs(entry),
      idleMs: Date.now() - entry.lastActivityAt,
      inboxSize: entry.inbox.length,
      hasStdin: Boolean(entry.stdin?.writable),
      spawnedBy: entry.spawnedBy,
      depth,
      treePrefix,
      status: entry.status,
    });

    const physicalChildren = (childrenOf.get(cid) ?? [])
      .filter((childCid) => {
        const child = state.activeRuns.get(childCid);
        return Boolean(child && physicalVisible(child));
      });
    const graphChildren = (entry.progress ?? [])
      .filter((progress) => view !== "named" || Boolean(progress.name))
      .sort((a, b) => a.taskIndex - b.taskIndex);
    const childCount = physicalChildren.length + graphChildren.length;
    let childIndex = 0;

    for (const childCid of physicalChildren) {
      const isLast = childIndex === childCount - 1;
      visitPhysical(
        childCid,
        `${descendantsPrefix}${isLast ? "└─ " : "├─ "}`,
        `${descendantsPrefix}${isLast ? "   " : "│  "}`,
        depth + 1,
      );
      childIndex++;
    }

    for (const progress of graphChildren) {
      const isLast = childIndex === childCount - 1;
      entries.push({
        agent: progress.agent,
        name: progress.name,
        correlationId: progress.correlationId,
        parentCorrelationId: cid,
        startedAt: progress.startedAt ?? new Date(entry.startedAt).toISOString(),
        durationMs: progressDurationMs(progress, entry),
        idleMs: Date.now() - entry.lastActivityAt,
        inboxSize: 0,
        hasStdin: false,
        spawnedBy: cid,
        depth: depth + 1,
        treePrefix: `${descendantsPrefix}${isLast ? "└─ " : "├─ "}`,
        status: progress.status,
        taskIndex: progress.taskIndex,
        dependencies: progress.dependencies,
        toolCount: progress.toolCount,
        tokens: progress.tokens,
      });
      childIndex++;
    }
  }

  roots.forEach((cid) => visitPhysical(cid, "", "", 0));

  const iconFor = (status: ListedAgentStatus): string => {
    if (status === "pending") return "○";
    if (status === "running") return "●";
    if (status === "sleeping") return "◉";
    if (status === "failed") return "✗";
    return "✓";
  };
  const text = entries.length > 0
    ? entries.map((entry) => {
        const identity = entry.name
          ? `[${entry.agent}] name="${entry.name}"`
          : `[${entry.agent}]`;
        const metadata = [
          `id=${entry.correlationId.slice(0, 8)}`,
          entry.taskIndex !== undefined ? `task=${entry.taskIndex + 1}` : "",
          entry.dependencies?.length
            ? `deps=${entry.dependencies.map((dependency) => dependency + 1).join(",")}`
            : "",
          `${Math.round(entry.durationMs / 1000)}s`,
          entry.toolCount ? `${entry.toolCount} tools` : "",
          entry.tokens ? `${entry.tokens} tok` : "",
          entry.inboxSize ? `inbox=${entry.inboxSize}` : "",
        ].filter(Boolean).join(" · ");
        return `${entry.treePrefix}${iconFor(entry.status)} ${identity} · ${metadata}`;
      }).join("\n")
    : "No active teammate agents.";

  return { entries, text };
}

type WatchTarget =
  | { kind: "agent"; agent: ActiveAgent }
  | { kind: "graph-task"; agent: ActiveAgent; progress: AgentProgressSnapshot };

export function resolveWatchTarget(
  state: TeammateState,
  target: string,
): { match?: WatchTarget; error?: string; available: string[] } {
  const available = new Set<string>();
  for (const [cid, agent] of state.activeRuns) {
    available.add(agent.name ?? cid.slice(0, 8));
    for (const progress of agent.progress ?? []) {
      available.add(progress.name ?? progress.correlationId.slice(0, 8));
    }
  }

  const namedCid = state.namedAgents.get(target);
  if (namedCid) {
    const agent = state.activeRuns.get(namedCid);
    if (agent) return { match: { kind: "agent", agent }, available: [...available] };
  }

  const exactAgent = state.activeRuns.get(target);
  if (exactAgent) return { match: { kind: "agent", agent: exactAgent }, available: [...available] };

  const exactTaskMatches: Array<{ agent: ActiveAgent; progress: AgentProgressSnapshot }> = [];
  for (const agent of state.activeRuns.values()) {
    for (const progress of agent.progress ?? []) {
      if (progress.correlationId === target || progress.name === target) {
        exactTaskMatches.push({ agent, progress });
      }
    }
  }
  if (exactTaskMatches.length === 1) {
    return { match: { kind: "graph-task", ...exactTaskMatches[0] }, available: [...available] };
  }
  if (exactTaskMatches.length > 1) {
    return { error: `Agent target "${target}" is ambiguous. Use its id from teammate-list.`, available: [...available] };
  }

  const prefixMatches: WatchTarget[] = [];
  for (const [cid, agent] of state.activeRuns) {
    if (cid.startsWith(target)) prefixMatches.push({ kind: "agent", agent });
    for (const progress of agent.progress ?? []) {
      if (progress.correlationId.startsWith(target)) {
        prefixMatches.push({ kind: "graph-task", agent, progress });
      }
    }
  }
  if (prefixMatches.length === 1) return { match: prefixMatches[0], available: [...available] };
  if (prefixMatches.length > 1) {
    return { error: `Agent id prefix "${target}" is ambiguous. Use a longer id from teammate-list.`, available: [...available] };
  }
  return { available: [...available] };
}

export function buildWatchOutput(target: WatchTarget, lineCount: number): string[] {
  if (target.kind === "agent") {
    const { agent } = target;
    const label = agent.name ?? agent.correlationId.slice(0, 8);
    const log = agent.outputLog.slice(-lineCount);
    const uptime = Math.round(agentActiveMs(agent) / 1000);
    const idle = Math.round((Date.now() - agent.lastActivityAt) / 1000);
    const output = [
      `[${agent.agent}/${label}] id=${agent.correlationId.slice(0, 8)} | ${agent.status} | up ${uptime}s | idle ${idle}s | log ${agent.outputLog.length} | inbox ${agent.inbox.length}`,
      "---",
      ...log,
    ];
    const lastResult = agent.lastResult?.trim();
    if (lastResult) {
      output.push("--- last result ---", ...lastResult.split("\n").slice(-lineCount));
    }
    if (agent.status === "sleeping") {
      output.push("", "[sleeping — messages remain visible; use teammate-send to wake]");
    }
    if (agent.inbox.length > 0) {
      output.push("--- inbox ---");
      for (const message of agent.inbox.slice(-5)) {
        const time = new Date(message.timestamp).toISOString().slice(11, 19);
        output.push(`[${time}] ◀ ${message.from}: ${message.payload.slice(0, 120)}`);
      }
    }
    return output;
  }

  const { agent, progress } = target;
  const shortId = progress.correlationId.slice(0, 8);
  const marker = progress.name ? `@${progress.name}#${shortId}` : `${progress.agent}#${shortId}`;
  const log = agent.outputLog.filter((line) => line.includes(marker)).slice(-lineCount);
  const label = progress.name ?? shortId;
  const output = [
    `[${progress.agent}/${label}] id=${shortId} | ${progress.status} | parent=${agent.correlationId.slice(0, 8)} (${agent.status}) | task=${progress.taskIndex + 1}`,
    "---",
    ...log,
  ];
  const lastMessage = progress.lastMessage?.trim();
  if (lastMessage) {
    output.push("--- last message ---", ...lastMessage.split("\n").slice(-lineCount));
  } else if (log.length === 0) {
    output.push(progress.status === "pending" ? "Waiting for dependencies…" : "No message captured yet.");
  }
  if (agent.status === "sleeping") {
    output.push("", "[graph is sleeping — this task's captured messages remain available]");
  }
  return output;
}

function emitComplete(
  pi: ExtensionAPI,
  id: string,
  agent: string,
  correlationId: string,
  exitCode: number,
  durationMs: number,
): void {
  pi.events.emit(TEAMMATE_COMPLETE_EVENT, {
    id, agent, correlationId, exitCode, durationMs,
  });
}

function retireAgent(
  state: TeammateState,
  correlationId: string,
  lastResult?: string,
): void {
  const agent = state.activeRuns.get(correlationId);
  if (!agent) return;
  agent.status = "sleeping";
  agent.lastResult = lastResult;
  agent.sleptAt = Date.now();
  agent.lastActivityAt = Date.now();
}

function killAgent(
  state: TeammateState,
  correlationId: string,
  name?: string,
): void {
  const agent = state.activeRuns.get(correlationId);
  if (!agent) return;
  releaseAgentMemory(agent);
  agent.status = "completed";
  agent.abortController.abort();
  state.activeRuns.delete(correlationId);
  if (name) state.namedAgents.delete(name);
}

function agentActiveMs(a: ActiveAgent): number {
  const total = Date.now() - a.startedAt;
  const sleeping = a.sleptAt ? Date.now() - a.sleptAt : 0;
  return total - a.sleepMs - sleeping;
}

// ===========================================================================
// P2-1: Reply-cycle deadlock detection
// ===========================================================================

function detectReplyCycle(
  state: TeammateState,
  fromName: string | undefined,
  replyToName: string | undefined,
): boolean {
  if (!fromName || !replyToName) return false;
  if (fromName === replyToName) return true;

  const visited = new Set<string>([fromName]);
  let current = replyToName;

  while (current) {
    if (visited.has(current)) return true;
    visited.add(current);

    const cid = state.namedAgents.get(current);
    if (!cid) break;
    const agent = state.activeRuns.get(cid);
    if (!agent?.replyTo) break;
    current = agent.replyTo;
  }

  return false;
}

function ts(): string {
  return new Date().toISOString().slice(11, 19);
}

function releaseAgentMemory(agent: ActiveAgent): void {
  if (agent.pendingHandoff) {
    clearTimeout(agent.pendingHandoff.timer);
    agent.pendingHandoff.resolve(false);
    agent.pendingHandoff = undefined;
  }
  agent.inbox.length = 0;
  if (agent.stdin) {
    try { agent.stdin.end(); } catch { /* already closed */ }
    agent.stdin = undefined;
  }
  agent.sendControl = undefined;
}

// ===========================================================================
// Flat model: handle proxy requests from child processes
// ===========================================================================

async function handleProxyRequest(
  pi: ExtensionAPI,
  state: TeammateState,
  event: Record<string, unknown>,
  reply: (msg: unknown) => void,
  spawnedBy?: string,
): Promise<void> {
  const tool = event.tool as string;
  const requestId = event.requestId as string;
  const params = event.params as Record<string, unknown>;
  const parentCid = event.parentCid as string | undefined;

  switch (tool) {
    case "teammate": {
      const p = params as RunTeammateParams;
      const cid = randomUUID();

      // Normalize
      let normalizedTasks: NormalizedTask[] | null = null;
      if (p.chain?.length) {
        normalizedTasks = normalizeChainToTasks(p.chain, p.task ?? "");
        for (const t of normalizedTasks) {
          t.model ??= p.model;
          t.cwd ??= p.cwd;
          t.outputSchema ??= p.outputSchema as Record<string, unknown> | undefined;
          t.timeoutMs ??= p.timeoutMs;
        }
      } else if (p.tasks?.length) {
        normalizedTasks = p.tasks.map((t) => ({
          agent: t.agent,
          task: t.task ?? "",
          name: t.name,
          model: t.model ?? p.model,
          cwd: t.cwd ?? p.cwd,
          outputSchema: (t.outputSchema ?? p.outputSchema) as Record<string, unknown> | undefined,
          timeoutMs: t.timeoutMs ?? p.timeoutMs,
        }));
      }

      if (!normalizedTasks && !p.agent) {
        reply({ type: "teammate_proxy_result", requestId, result: {
          content: [{ type: "text", text: 'Requires "agent" or "tasks".' }],
          isError: true, details: { mode: "single", results: [] },
        }});
        return;
      }

      const abortCtrl = new AbortController();
      const activeAgent: ActiveAgent = {
        agent: p.agent ?? `graph(${normalizedTasks?.length ?? 0})`,
        name: p.name,
        correlationId: cid,
        startedAt: Date.now(),
        abortController: abortCtrl,
        inbox: [],
        outputLog: [],
        lastActivityAt: Date.now(),
        spawnedBy: parentCid,
        status: "running",
        sleepMs: 0,
      };
      state.activeRuns.set(cid, activeAgent);
      if (p.name) state.namedAgents.set(p.name, cid);

      const spawnerAgent = spawnedBy ? state.activeRuns.get(spawnedBy) : undefined;
      const spawnerLabel = spawnerAgent?.name ?? spawnerAgent?.agent ?? "proxy";
      pi.sendMessage(
        {
          customType: "teammate-started",
          content: `● @${spawnerLabel} spawned @${p.name ?? p.agent}`,
          display: true,
        },
        { triggerTurn: true },
      );
      pi.events.emit(TEAMMATE_STARTED_EVENT, { correlationId: cid, agent: p.agent, name: p.name, spawnedBy });

      const runOpts: RunTeammateOptions = {
        baseCwd: state.baseCwd,
        signal: abortCtrl.signal,
        parentSessionFile: spawnerAgent?.sessionFile ?? state.mainSessionFile,
        onChildSpawned: (stdin, sendControl, sessionDir) => {
          activeAgent.stdin = stdin;
          activeAgent.sendControl = sendControl;
          activeAgent.sessionDir = sessionDir;
          if (activeAgent.lease) sendControl({ type: "teammate_lease_update", token: leaseToken(activeAgent.lease) });
        },
        onChildEvent: (event) => handleChildLifecycleEvent({ ...event, correlationId: cid }),
        onChildRequest: (evt, rep) => handleProxyRequest(pi, state, evt, rep, cid),
      };

      try {
        let resultPayload: unknown;
        if (normalizedTasks) {
          const mode = inferGraphMode(normalizedTasks);
          const results = await runGraph(normalizedTasks, p.concurrency ?? 4, runOpts);
          const hasError = results.some((r) => r.exitCode !== 0);
          const summaries = results
            .map((r, i) => `[${r.agent}${normalizedTasks![i]?.name ? "/" + normalizedTasks![i].name : ""}] ${r.exitCode === 0 ? "OK" : "FAIL"}: ${r.messages[r.messages.length - 1]?.content ?? "(no output)"}`)
            .join("\n\n");
          resultPayload = { content: [{ type: "text", text: summaries }], isError: hasError, details: { mode, results } };
        } else {
          const result = await runTeammate(p, runOpts);
          const lastMsg = result.messages[result.messages.length - 1]?.content ?? "(no output)";
          resultPayload = {
            content: [{ type: "text", text: lastMsg }],
            isError: result.exitCode !== 0,
            details: { mode: "single", results: [result] },
          };
        }
        reply({ type: "teammate_proxy_result", requestId, result: resultPayload });
      } finally {
        retireAgent(state, cid);
      }
      return;
    }

    case "teammate-send": {
      const to = params.to as string;
      const message = params.message as string;
      const requestedMode = (params.mode as RpcMessageMode) ?? "follow_up";

      const cid = state.namedAgents.get(to);
      if (!cid) {
        const available = Array.from(state.namedAgents.keys());
        reply({ type: "teammate_proxy_result", requestId, result: {
          content: [{ type: "text", text: `Agent "${to}" not found. ${available.length > 0 ? `Available: ${available.join(", ")}` : "No named agents."}` }],
          isError: true, details: { delivered: false },
        }});
        return;
      }

      const agent = state.activeRuns.get(cid);
      if (!agent?.stdin?.writable) {
        reply({ type: "teammate_proxy_result", requestId, result: {
          content: [{ type: "text", text: `Agent "${to}" is no longer running.` }],
          isError: true, details: { delivered: false },
        }});
        return;
      }
      if (!canChildWrite(agent.lease)) {
        reply({ type: "teammate_proxy_result", requestId, result: {
          content: [{ type: "text", text: `Agent "${to}" is currently owned by ${agent.lease.owner} (${agent.lease.state}).` }],
          isError: true, details: { delivered: false },
        }});
        return;
      }
      const mode: RpcMessageMode = agent.status === "sleeping" && requestedMode !== "abort"
        ? "prompt"
        : requestedMode;
      const sent = sendRpcMessage(agent.stdin, message, mode, agent.lease ? leaseToken(agent.lease) : undefined);
      if (!sent) {
        reply({ type: "teammate_proxy_result", requestId, result: {
          content: [{ type: "text", text: `Failed to send message to "${to}".` }],
          isError: true, details: { delivered: false },
        }});
        return;
      }
      if (mode === "prompt") agent.promptSeq = (agent.promptSeq ?? 0) + 1;
      if (agent.status === "sleeping" && mode === "prompt") {
        agent.status = "running";
        if (agent.sleptAt) {
          agent.sleepMs += Date.now() - agent.sleptAt;
          agent.sleptAt = undefined;
        }
      }
      const now = Date.now();
      agent.inbox.push({ id: randomUUID(), from: spawnedBy ?? "proxy", to, kind: mode === "abort" ? "notification" : "task", payload: message, timestamp: now });
      agent.outputLog.push(`[${new Date(now).toISOString().slice(11, 19)}] ◀ ${mode}: ${message.slice(0, 100)}`);
      agent.lastActivityAt = now;

      // Notify main session TUI
      const senderAgent = spawnedBy ? state.activeRuns.get(spawnedBy) : undefined;
      const senderLabel = senderAgent?.name ?? senderAgent?.agent ?? "agent";
      pi.sendMessage(
        {
          customType: "teammate-message",
          content: `● @${senderLabel} → @${to} (${mode}): ${message.slice(0, 120)}`,
          display: true,
        },
        { triggerTurn: true },
      );

      const modeLabel = mode === "steer" ? "interrupted + injected" : mode === "abort" ? "aborted" : "queued after current turn";
      reply({ type: "teammate_proxy_result", requestId, result: {
        content: [{ type: "text", text: `Message ${modeLabel} for "${to}".` }],
        isError: false, details: { delivered: true },
      }});
      return;
    }

    case "teammate-list": {
      const view = ((params.view as AgentListView | undefined) ?? "active");
      const { entries, text } = buildAgentList(state, view);
      reply({ type: "teammate_proxy_result", requestId, result: {
        content: [{ type: "text", text }], isError: false, details: { agents: entries },
      }});
      return;
    }

    case "teammate-watch": {
      const name = params.name as string;
      const lineCount = (params.lines as number) ?? 20;
      const resolved = resolveWatchTarget(state, name);
      if (!resolved.match) {
        reply({ type: "teammate_proxy_result", requestId, result: {
          content: [{ type: "text", text: resolved.error ?? `Agent "${name}" not found.` }], isError: true, details: { output: [] },
        }});
        return;
      }
      const output = buildWatchOutput(resolved.match, lineCount);
      reply({ type: "teammate_proxy_result", requestId, result: {
        content: [{ type: "text", text: output.join("\n") }], isError: false, details: { output },
      }});
      return;
    }
  }
}
