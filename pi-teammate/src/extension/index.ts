/**
 * Teammate Extension Entry Point
 *
 * Tools: teammate (dispatch), teammate-send (RPC message injection), teammate-list (status)
 * TUI: Alt+R overlay, widget below editor, Alt+B foreground→background detach
 * Mode: RPC subprocess — stdin open for steer/follow_up/abort
 */

import { randomUUID } from "node:crypto";
import type {
  ExtensionAPI,
  ExtensionContext,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import { TeammateParams, TeammateSendParams, TeammateListParams, TeammateWatchParams } from "./schemas.ts";
import {
  runTeammate,
  runGraph,
  normalizeChainToTasks,
  inferGraphMode,
  sendRpcMessage,
} from "../runs/execution.ts";
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
  ActiveAgent,
  MessageEnvelope,
} from "../shared/types.ts";
import {
  TEAMMATE_COMPLETE_EVENT,
  TEAMMATE_STARTED_EVENT,
  TEAMMATE_MESSAGE_EVENT,
} from "../shared/types.ts";

export default function registerTeammateExtension(pi: ExtensionAPI): void {
  const isChild = process.env.PI_TEAMMATE_CHILD === "1";

  // =========================================================================
  // Child mode: register proxy tools that forward to root via stdout/IPC
  // =========================================================================

  if (isChild) {
    const pendingRequests = new Map<string, (result: unknown) => void>();

    // IPC listener: receive results from root
    if (typeof process.send === "function") {
      process.on("message", (msg: unknown) => {
        const m = msg as Record<string, unknown>;
        if (m?.type === "teammate_proxy_result") {
          const resolve = pendingRequests.get(m.requestId as string);
          if (resolve) {
            pendingRequests.delete(m.requestId as string);
            resolve(m.result);
          }
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
      process.send({ type: "teammate_proxy_request", tool, requestId, params });
      const result = await new Promise<unknown>((resolve) => {
        pendingRequests.set(requestId, resolve);
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

  const state: TeammateState = {
    baseCwd: "",
    currentSessionId: null,
    activeRuns: new Map(),
    namedAgents: new Map(),
  };

  // =========================================================================
  // Tool 1: teammate — dispatch
  // =========================================================================

  const tool: ToolDefinition<typeof TeammateParams, Details> = {
    name: "teammate",
    label: "Teammate",
    description: `Dispatch tasks to teammate agents. Teammates run as pi subprocesses with their own tools and context.

Single agent:
  { agent: "delegate", task: "..." }

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

Routing:
  - name: addressable name for variable referencing and teammate-send
  - reply_to: "caller" (direct return) or "main" (broadcast to parent)

Top-level defaults (model, cwd, outputSchema, timeoutMs) flow down to each task unless overridden per-task.`,

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
        signal: abortController.signal,
        parentSessionFile,
        onChildSpawned: (stdin: import("node:stream").Writable) => {
          activeAgent.stdin = stdin;
        },
        onProgress: (() => {
          let lastUpdateTime = 0;
          const UPDATE_INTERVAL = 300; // ms — throttle TUI updates
          let loggedToolCount = 0;
          let streamingLineIdx = -1;
          const loggedToolLines = new Map<number, number>();

          return (data: AgentProgress) => {
          activeAgent.lastActivityAt = Date.now();

          // Record to outputLog
          const MAX_LOG = 200;
          if (data.recentTools?.length) {
            for (let ti = loggedToolCount; ti < data.recentTools.length; ti++) {
              const t = data.recentTools[ti];
              loggedToolLines.set(ti, activeAgent.outputLog.length);
              activeAgent.outputLog.push(`[${new Date().toISOString().slice(11, 19)}] ~ ${t.name}`);
              streamingLineIdx = -1;
            }
            // Update completed tools in-place
            for (let ti = 0; ti < data.recentTools.length; ti++) {
              const t = data.recentTools[ti];
              if (t.status !== "running") {
                const idx = loggedToolLines.get(ti);
                if (idx !== undefined && activeAgent.outputLog[idx]?.includes("~ ")) {
                  activeAgent.outputLog[idx] = activeAgent.outputLog[idx].replace("~ ", "✓ ");
                }
              }
            }
            loggedToolCount = data.recentTools.length;
          }
          if (data.lastMessage) {
            const lastLine = data.lastMessage.split("\n").pop()?.trim();
            if (lastLine) {
              if (streamingLineIdx >= 0) {
                activeAgent.outputLog[streamingLineIdx] = lastLine;
              } else {
                streamingLineIdx = activeAgent.outputLog.length;
                activeAgent.outputLog.push(lastLine);
              }
            }
          }
          if (activeAgent.outputLog.length > MAX_LOG) {
            activeAgent.outputLog.splice(0, activeAgent.outputLog.length - MAX_LOG);
            streamingLineIdx = -1;
            loggedToolLines.clear();
            streamingLineIdx = -1;
          }

          // Broadcast to overlay listeners (always)
          pi.events.emit(TEAMMATE_MESSAGE_EVENT, {
            correlationId,
            agent: data.agent,
            status: data.status,
            toolCount: data.toolCount,
            tokens: data.tokens,
            recentTools: data.recentTools,
            lastMessage: data.lastMessage,
          });

          if (!onUpdate) return;
          // Throttle TUI updates — skip if too frequent (except completion)
          const now = Date.now();
          if (data.status === "running" && now - lastUpdateTime < UPDATE_INTERVAL) return;
          lastUpdateTime = now;

          onUpdate({
            content: [{
              type: "text",
              text: `[${data.agent}] ${data.status} | tools: ${data.toolCount} | tokens: ${data.tokens}`,
            }],
            details: {
              mode: (graphMode ?? "single") as Details["mode"],
              results: [],
              progress: [{
                agent: data.agent,
                status: data.status,
                startedAt: new Date(data.startedAt).toISOString(),
                recentTools: data.recentTools,
                toolCount: data.toolCount,
                tokens: data.tokens,
                lastMessage: data.lastMessage,
                ...(data.status !== "running"
                  ? { completedAt: new Date().toISOString() }
                  : {}),
              }],
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

            return { results, hasError, totalDur, summaries, structuredOutput };
          };

          if (params.background === false) {
            // Foreground: block until completion
            const { results, hasError, totalDur, summaries, structuredOutput } = await executeGraph();

            emitComplete(pi, id, graphMode, correlationId, hasError ? 1 : 0, totalDur);

            return {
              content: [{ type: "text", text: summaries }],
              isError: hasError,
              details: {
                mode: graphMode as Details["mode"],
                results,
                ...(structuredOutput !== undefined ? { structuredOutput } : {}),
              },
            };
          }

          // Background (default)
          const bgPromise = executeGraph();

          bgPromise.then(({ results, hasError, summaries }) => {
            const label = params.name ?? correlationId.slice(0, 8);
            const status = hasError ? "failed" : "completed";
            const summary = summaries.length > 500
              ? summaries.slice(0, 500) + "…"
              : summaries;
            retireAgent(state, correlationId, summary);

            pi.sendMessage(
              {
                customType: "teammate-complete",
                content: `[teammate] ${graphMode} "${label}" ${status} → sleeping\n\n${summary}`,
                display: true,
                details: { mode: graphMode, results },
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
            details: { mode: graphMode as Details["mode"], results: [] },
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
            const label = params.name ?? correlationId.slice(0, 8);
            const lastMsg = result.messages[result.messages.length - 1]?.content ?? "(no output)";
            const summary = lastMsg.length > 500 ? lastMsg.slice(0, 500) + "…" : lastMsg;
            retireAgent(state, correlationId, summary);
            pi.sendMessage(
              {
                customType: "teammate-complete",
                content: `[teammate] Agent "${params.agent}/${label}" → sleeping (${Math.round(result.durationMs / 1000)}s)\n\n${summary}`,
                display: true,
                details: { agent: params.agent, name: params.name, correlationId, result },
              },
              { triggerTurn: true },
            );
          }).catch(() => {
            retireAgent(state, correlationId);
          });
          return {
            content: [{ type: "text", text: `Agent "${params.agent}" detached to background (Alt+B). Will notify on completion.` }],
            isError: false,
            details: { mode: "single", results: [] },
          };
        }

        // --- BACKGROUND (default) ---
        const bgPromise = runTeammate(params, makeOptions());

        bgPromise.then((result) => {
          emitComplete(pi, id, params.agent, correlationId, result.exitCode, result.durationMs);
          const label = params.name ?? correlationId.slice(0, 8);
          const lastMsg = result.messages[result.messages.length - 1]?.content ?? "(no output)";
          const summary = lastMsg.length > 500 ? lastMsg.slice(0, 500) + "…" : lastMsg;
          retireAgent(state, correlationId, summary);

          pi.sendMessage(
            {
              customType: "teammate-complete",
              content: `[teammate] Agent "${params.agent}/${label}" → sleeping (${Math.round(result.durationMs / 1000)}s)\n\n${summary}`,
              display: true,
              details: { agent: params.agent, name: params.name, correlationId, result },
            },
            { triggerTurn: true },
          );
        }).catch(() => {
          retireAgent(state, correlationId);
        });

        return {
          content: [{
            type: "text",
            text: `Agent "${params.agent}" running in background. correlationId=${correlationId}${params.name ? `, name="${params.name}"` : ""}. Use teammate-list to check status, teammate-send to message.`,
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

    renderCall(args, theme) {
      return renderTeammateCall(args, theme);
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
  - "steer" — interrupt current turn, inject message immediately (打断当前执行)
  - "follow_up" (default) — queue after current turn completes (等当前完成后执行)
  - "abort" — cancel current execution (取消执行, message field ignored)`,

    parameters: TeammateSendParams,

    async execute(
      _id: string,
      params: { to: string; message: string; mode?: RpcMessageMode },
    ): Promise<AgentToolResult<{ delivered: boolean }>> {
      const mode = params.mode ?? "follow_up";

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

      const sent = sendRpcMessage(agent.stdin, params.message, mode);
      if (!sent) {
        return {
          content: [{ type: "text", text: `Failed to send message to "${params.to}".` }],
          isError: true,
          details: { delivered: false },
        };
      }

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

      const modeLabel = wasSleeping ? `woken up + ${mode}` : mode === "steer" ? "interrupted + injected" : "queued after current turn";
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
    description: `List active teammate agents.

Views:
  - "active": All running agents (default)
  - "named": Only named/addressable agents
  - "all": All agents including completed metadata`,

    parameters: TeammateListParams,

    async execute(
      _id: string,
      params: { view?: "active" | "named" | "all" },
    ): Promise<AgentToolResult<{ agents: unknown[] }>> {
      const view = params.view ?? "active";
      const entries: Array<{
        agent: string;
        name?: string;
        correlationId: string;
        startedAt: string;
        durationMs: number;
        idleMs: number;
        inboxSize: number;
        hasStdin: boolean;
        spawnedBy?: string;
        depth: number;
        status: "running" | "completed" | "failed";
      }> = [];

      // Build parent→children index for tree rendering
      const childrenOf = new Map<string, string[]>();
      const roots: string[] = [];
      for (const [cid, entry] of state.activeRuns) {
        if (view === "active" && entry.status === "completed") continue;
        if (view === "named" && !entry.name) continue;
        if (entry.spawnedBy && state.activeRuns.has(entry.spawnedBy)) {
          const siblings = childrenOf.get(entry.spawnedBy) ?? [];
          siblings.push(cid);
          childrenOf.set(entry.spawnedBy, siblings);
        } else {
          roots.push(cid);
        }
      }

      function collectTree(cid: string, depth: number): void {
        const entry = state.activeRuns.get(cid);
        if (!entry) return;
        if (view === "active" && entry.status === "completed") return;
        if (view === "named" && !entry.name) return;
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
          status: entry.status,
        });
        for (const childCid of childrenOf.get(cid) ?? []) {
          collectTree(childCid, depth + 1);
        }
      }
      for (const rootCid of roots) {
        collectTree(rootCid, 0);
      }

      const lines = entries.length > 0
        ? entries.map((a) => {
          const indent = a.depth > 0 ? "  ".repeat(a.depth) + "└─ " : "";
          const statusIcon = a.status === "running" ? "●" : a.status === "sleeping" ? "◉" : "✓";
          return `${indent}${statusIcon} [${a.agent}]${a.name ? ` name="${a.name}"` : ""} | ${Math.round(a.durationMs / 1000)}s | inbox: ${a.inboxSize}`;
        }).join("\n")
        : "No active teammate agents.";

      return {
        content: [{ type: "text", text: lines }],
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
    description: `View a running agent's recent output and activity log. Returns the last N lines of tool calls, streaming text, and inbox messages.`,

    parameters: TeammateWatchParams,

    async execute(
      _id: string,
      params: { name: string; lines?: number },
    ): Promise<AgentToolResult<{ output: string[] }>> {
      const lines = params.lines ?? 20;

      // Check direct agents first
      const cid = state.namedAgents.get(params.name);
      if (!cid) {
        const available = Array.from(state.namedAgents.keys());
        return {
          content: [{ type: "text", text: `Agent "${params.name}" not found. ${available.length > 0 ? `Available: ${available.join(", ")}` : "No named agents running."}` }],
          isError: true,
          details: { output: [] },
        };
      }

      const agent = state.activeRuns.get(cid);
      if (!agent) {
        state.namedAgents.delete(params.name);
        return {
          content: [{ type: "text", text: `Agent "${params.name}" is no longer running.` }],
          isError: true,
          details: { output: [] },
        };
      }

      const log = agent.outputLog.slice(-lines);
      const uptime = Math.round(agentActiveMs(agent) / 1000);
      const idle = Math.round((Date.now() - agent.lastActivityAt) / 1000);
      const statusLabel = agent.status === "sleeping" ? " | SLEEPING" : "";
      const header = `[${agent.agent}/${params.name}] up ${uptime}s | idle ${idle}s | log ${agent.outputLog.length} lines | inbox ${agent.inbox.length}${statusLabel}`;
      const output = [header, "---", ...log];
      if (agent.status === "sleeping") {
        output.push("", "[sleeping — use teammate-send to wake]");
      }

      if (agent.inbox.length > 0) {
        output.push("--- inbox ---");
        for (const msg of agent.inbox.slice(-5)) {
          const time = new Date(msg.timestamp).toISOString().slice(11, 19);
          output.push(`[${time}] ◀ ${msg.from}: ${msg.payload.slice(0, 120)}`);
        }
      }

      return {
        content: [{ type: "text", text: output.join("\n") }],
        isError: false,
        details: { output: log },
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

  async function showAttachOverlay(correlationId: string, ctx: ExtensionContext): Promise<void> {
    const agent = state.activeRuns.get(correlationId);
    if (!agent) {
      ctx.ui.notify("Agent is no longer active.", "error");
      return;
    }

    await ctx.ui.custom(
      (tui, _theme, _keybindings, done) => {
        const overlay = new AttachOverlay(
          agent,
          () => done(undefined),
          () => state.activeRuns,
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

        const msgHandler = (data: unknown) => {
          const evt = data as Record<string, unknown>;
          const cid = evt.correlationId as string;
          if (!cid) return;

          // teammate-send message
          if (evt.isSend) {
            const mode = evt.mode as string;
            const msg = (evt.message as string)?.slice(0, 60) ?? "";
            overlay.appendLog(cid, `[${ts()}] ◀ ${mode}: ${msg}`, "system");
            return;
          }

          const lastMsg = evt.lastMessage as string | undefined;
          if (lastMsg) {
            overlay.setOutput(cid, lastMsg);
            return;
          }

          const tools = evt.recentTools as Array<{ name: string; status: string }> | undefined;
          if (tools && tools.length > 0) {
            const last = tools[tools.length - 1];
            const icon = last.status === "running" ? "~" : "✓";
            overlay.appendLog(cid, `[${ts()}] ${icon} ${last.name}`, "tool");
          }
        };
        const completeHandler = (data: unknown) => {
          const evt = data as Record<string, unknown>;
          const cid = evt.correlationId as string;
          if (!cid) return;
          overlay.appendLog(cid, `COMPLETED exitCode=${evt.exitCode} ${evt.durationMs}ms`, "system");
        };
        pi.events.on(TEAMMATE_MESSAGE_EVENT, msgHandler);
        pi.events.on(TEAMMATE_COMPLETE_EVENT, completeHandler);

        const origDispose = overlay.dispose.bind(overlay);
        overlay.dispose = () => {
          pi.events.off(TEAMMATE_MESSAGE_EVENT, msgHandler);
          pi.events.off(TEAMMATE_COMPLETE_EVENT, completeHandler);
          origDispose();
        };

        return overlay;
      },
      {
        overlay: true,
        overlayOptions: {
          width: "100%",
          maxHeight: "100%",
          anchor: "top-left" as const,
          margin: 0,
        },
      },
    );
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
    const labels = entries.map(([, a]) => {
      const icon = a.status === "sleeping" ? "◉" : "●";
      return `${icon} ${a.agent}/${agentLabel(a)}`;
    });
    const selected = await ctx.ui.select("Attach to agent", labels);
    if (selected) {
      const idx = labels.indexOf(selected);
      if (idx >= 0) {
        await showAttachOverlay(entries[idx][0], ctx);
      }
    }
  }

  // =========================================================================
  // TUI — only in parent mode (child processes have no terminal)
  // =========================================================================

  pi.registerShortcut("alt+r", {
    description: "Attach to a running teammate agent",
    async handler(ctx) {
      await showAgentSelector(ctx);
    },
  });

  let widgetCtx: ExtensionContext | null = null;

  function updateAgentWidget(): void {
    if (!widgetCtx) return;
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

    const runCount = visible.filter(([, a]) => a.status === "running").length;
    const sleepCount = visible.length - runCount;
    const totalCount = state.activeRuns.size;
    const hiddenCount = totalCount - visible.length;
    const summary = [
      runCount > 0 ? `${runCount} running` : "",
      sleepCount > 0 ? `${sleepCount} sleeping` : "",
      hiddenCount > 0 ? `${hiddenCount} hidden` : "",
    ].filter(Boolean).join(" · ");
    const lines: string[] = [`─ agents (${summary}) ─ Alt+R attach`];
    for (const [, a] of visible) {
      const label = agentLabel(a);
      const uptime = Math.round(agentActiveMs(a) / 1000);
      const lastLog = a.outputLog[a.outputLog.length - 1];
      const brief = lastLog ? `  ${lastLog.slice(0, 40)}` : "";
      if (a.status === "running") {
        lines.push(`  ● ${a.agent}/${label}  ${uptime}s${brief}`);
      } else {
        lines.push(`  \x1b[90m◉ ${a.agent}/${label}  sleep${brief}\x1b[0m`);
      }
    }

    widgetCtx.ui.setWidget("teammate-agents", lines, { placement: "belowEditor" });
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
  });

  pi.on("session_shutdown", () => {
    stopWidgetTimer();
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
  agent.inbox.length = 0;
  if (agent.stdin) {
    try { agent.stdin.end(); } catch { /* already closed */ }
    agent.stdin = undefined;
  }
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
          content: `[teammate] ${spawnerLabel} spawned ${p.agent}${p.name ? `/"${p.name}"` : ""}`,
          display: true,
        },
        { triggerTurn: true },
      );
      pi.events.emit(TEAMMATE_STARTED_EVENT, { correlationId: cid, agent: p.agent, name: p.name, spawnedBy });

      const runOpts: RunTeammateOptions = {
        baseCwd: state.baseCwd,
        signal: abortCtrl.signal,
        onChildSpawned: (stdin) => { activeAgent.stdin = stdin; },
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
      const mode = (params.mode as RpcMessageMode) ?? "follow_up";

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

      sendRpcMessage(agent.stdin, message, mode);
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
          content: `[teammate-send] ${senderLabel} → ${to} (${mode}): ${message.slice(0, 120)}`,
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
      const view = (params.view as string) ?? "active";
      const agents: unknown[] = [];
      for (const [c, entry] of state.activeRuns) {
        if (view === "named" && !entry.name) continue;
        agents.push({
          agent: entry.agent, name: entry.name, correlationId: c,
          startedAt: new Date(entry.startedAt).toISOString(),
          durationMs: agentActiveMs(entry),
          idleMs: Date.now() - entry.lastActivityAt,
          inboxSize: entry.inbox.length,
        });
      }
      const lines = agents.length > 0
        ? (agents as Array<Record<string, unknown>>).map((a) =>
          `[${a.agent}]${a.name ? ` name="${a.name}"` : ""} | up ${Math.round((a.durationMs as number) / 1000)}s`
        ).join("\n")
        : "No active agents.";
      reply({ type: "teammate_proxy_result", requestId, result: {
        content: [{ type: "text", text: lines }], isError: false, details: { agents },
      }});
      return;
    }

    case "teammate-watch": {
      const name = params.name as string;
      const lineCount = (params.lines as number) ?? 20;
      const cid = state.namedAgents.get(name);
      if (!cid) {
        reply({ type: "teammate_proxy_result", requestId, result: {
          content: [{ type: "text", text: `Agent "${name}" not found.` }], isError: true, details: { output: [] },
        }});
        return;
      }
      const agent = state.activeRuns.get(cid);
      if (!agent) {
        reply({ type: "teammate_proxy_result", requestId, result: {
          content: [{ type: "text", text: `Agent "${name}" is no longer running.` }], isError: true, details: { output: [] },
        }});
        return;
      }
      const log = agent.outputLog.slice(-lineCount);
      const header = `[${agent.agent}/${name}] up ${Math.round((Date.now() - agent.startedAt) / 1000)}s | log ${agent.outputLog.length} lines`;
      reply({ type: "teammate_proxy_result", requestId, result: {
        content: [{ type: "text", text: [header, "---", ...log].join("\n") }], isError: false, details: { output: log },
      }});
      return;
    }
  }
}
