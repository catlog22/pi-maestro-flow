/**
 * Teammate Extension Entry Point
 *
 * Registers tools:
 *   - teammate: dispatch tasks to sub-agents (single/parallel/chain, await/detach)
 *   - teammate-send: send messages to named running agents
 *   - teammate-list: list active/named agents
 *
 * P1: inbox message queue + named agent registry + detach mode
 */

import { randomUUID } from "node:crypto";
import type {
  ExtensionAPI,
  ExtensionContext,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import { TeammateParams, TeammateSendParams, TeammateListParams } from "./schemas.ts";
import {
  runTeammate,
  runParallel,
  runChain,
  sendRpcMessage,
  type RunTeammateParams,
  type RpcMessageMode,
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
  if (process.env.PI_TEAMMATE_CHILD === "1") {
    return;
  }

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

Modes:
  - Single: { agent: "delegate", task: "..." }
  - Parallel: { tasks: [{ agent: "scout", task: "..." }, { agent: "reviewer", task: "..." }] }
  - Chain: { chain: [{ agent: "scout", task: "Find auth code" }, { agent: "delegate", task: "Fix: {previous}" }] }

Routing:
  - name: Optional addressable name for cross-agent routing (enables teammate-send)
  - reply_to: Result routing — "caller" (direct return) or "main" (broadcast to parent session)

Structured output:
  - outputSchema: JSON Schema to validate and parse child output as structured data`,

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

      const activeAgent: ActiveAgent = {
        agent: params.agent ?? "parallel",
        name: params.name,
        correlationId,
        startedAt: Date.now(),
        abortController,
        inbox: [],
        lastActivityAt: Date.now(),
        replyTo: params.reply_to,
      };
      state.activeRuns.set(correlationId, activeAgent);

      if (params.name) {
        state.namedAgents.set(params.name, correlationId);
      }

      pi.events.emit(TEAMMATE_STARTED_EVENT, {
        id,
        agent: params.agent ?? "parallel",
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

          return (data: AgentProgress) => {
          activeAgent.lastActivityAt = Date.now();

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
              mode: "single",
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
      });

      let detached = false;

      try {
        // --- PARALLEL MODE ---
        if (params.tasks && params.tasks.length > 0) {
          const concurrency = params.concurrency ?? 4;
          const results = await runParallel(
            params.tasks,
            concurrency,
            makeOptions(),
          );

          const hasError = results.some((r) => r.exitCode !== 0);
          const summaries = results
            .map((r) => `[${r.agent}] ${r.exitCode === 0 ? "OK" : "FAIL"}: ${r.messages[r.messages.length - 1]?.content ?? "(no output)"}`)
            .join("\n\n");

          emitComplete(pi, id, "parallel", correlationId, hasError ? 1 : 0,
            Math.max(...results.map((r) => r.durationMs)));

          return {
            content: [{ type: "text", text: summaries }],
            isError: hasError,
            details: { mode: "parallel", results },
          };
        }

        // --- CHAIN MODE ---
        if (params.chain && params.chain.length > 0) {
          const results = await runChain(
            params.chain,
            params.task ?? "",
            makeOptions(),
          );

          const lastResult = results[results.length - 1];
          const hasError = results.some((r) => r.exitCode !== 0);
          const lastMessage = lastResult?.messages[lastResult.messages.length - 1]?.content ?? "(no output)";

          emitComplete(pi, id, "chain", correlationId, hasError ? 1 : 0,
            results.reduce((sum, r) => sum + r.durationMs, 0));

          return {
            content: [{ type: "text", text: lastMessage }],
            isError: hasError,
            details: { mode: "chain", results },
          };
        }

        if (params.background === false) {
          // --- FOREGROUND: block until completion, Ctrl+D to detach ---
          let detachResolve: (() => void) | null = null;
          const detachPromise = new Promise<void>((r) => { detachResolve = r; });

          const removeListener = ctx.hasUI
            ? ctx.ui.onTerminalInput((data: string) => {
                if (data === "\x04") detachResolve?.();
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

          // Ctrl+D: detach to background
          detached = true;
          runPromise.then((result) => {
            emitComplete(pi, id, params.agent, correlationId, result.exitCode, result.durationMs);
            cleanupAgent(state, correlationId, params.name);
            const label = params.name ?? correlationId.slice(0, 8);
            const lastMsg = result.messages[result.messages.length - 1]?.content ?? "(no output)";
            const summary = lastMsg.length > 500 ? lastMsg.slice(0, 500) + "…" : lastMsg;
            pi.sendMessage(
              {
                customType: "teammate-complete",
                content: `[teammate] Agent "${params.agent}/${label}" ${result.exitCode === 0 ? "completed" : "failed"} (${Math.round(result.durationMs / 1000)}s)\n\n${summary}`,
                display: true,
                details: { agent: params.agent, name: params.name, correlationId, result },
              },
              { triggerTurn: true },
            );
          });
          return {
            content: [{ type: "text", text: `Agent "${params.agent}" detached to background (Ctrl+D). Will notify on completion.` }],
            isError: false,
            details: { mode: "single", results: [] },
          };
        }

        // --- BACKGROUND (default) ---
        const bgPromise = runTeammate(params, makeOptions());

        bgPromise.then((result) => {
          emitComplete(pi, id, params.agent, correlationId, result.exitCode, result.durationMs);
          cleanupAgent(state, correlationId, params.name);

          const label = params.name ?? correlationId.slice(0, 8);
          const lastMsg = result.messages[result.messages.length - 1]?.content ?? "(no output)";
          const status = result.exitCode === 0 ? "completed" : "failed";
          const summary = lastMsg.length > 500 ? lastMsg.slice(0, 500) + "…" : lastMsg;

          pi.sendMessage(
            {
              customType: "teammate-complete",
              content: `[teammate] Agent "${params.agent}/${label}" ${status} (${Math.round(result.durationMs / 1000)}s)\n\n${summary}`,
              display: true,
              details: { agent: params.agent, name: params.name, correlationId, result },
            },
            { triggerTurn: true },
          );
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
          cleanupAgent(state, correlationId, params.name);
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
      const correlationId = state.namedAgents.get(params.to);
      if (!correlationId) {
        const available = Array.from(state.namedAgents.keys());
        return {
          content: [{
            type: "text",
            text: `Agent "${params.to}" not found. ${available.length > 0 ? `Available named agents: ${available.join(", ")}` : "No named agents are currently running."}`,
          }],
          isError: true,
          details: { delivered: false },
        };
      }

      const agent = state.activeRuns.get(correlationId);
      if (!agent) {
        state.namedAgents.delete(params.to);
        return {
          content: [{ type: "text", text: `Agent "${params.to}" is no longer running.` }],
          isError: true,
          details: { delivered: false },
        };
      }

      const mode = params.mode ?? "follow_up";

      if (!agent.stdin || !agent.stdin.writable) {
        return {
          content: [{ type: "text", text: `Agent "${params.to}" stdin is not available.` }],
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

      agent.lastActivityAt = Date.now();
      pi.events.emit(TEAMMATE_MESSAGE_EVENT, {
        correlationId,
        from: "caller",
        to: params.to,
        mode,
        message: params.message,
      });

      const modeLabel = mode === "steer" ? "interrupted + injected" : mode === "abort" ? "aborted" : "queued after current turn";
      return {
        content: [{
          type: "text",
          text: `Message ${modeLabel} for "${params.to}" (mode: ${mode}).`,
        }],
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
      const agents: Array<{
        agent: string;
        name?: string;
        correlationId: string;
        startedAt: string;
        durationMs: number;
        idleMs: number;
        inboxSize: number;
        hasStdin: boolean;
      }> = [];

      for (const [cid, entry] of state.activeRuns) {
        if (view === "named" && !entry.name) continue;

        agents.push({
          agent: entry.agent,
          name: entry.name,
          correlationId: cid,
          startedAt: new Date(entry.startedAt).toISOString(),
          durationMs: Date.now() - entry.startedAt,
          idleMs: Date.now() - entry.lastActivityAt,
          inboxSize: entry.inbox.length,
          hasStdin: Boolean(entry.stdin?.writable),
        });
      }

      const lines = agents.length > 0
        ? agents.map((a) =>
          `[${a.agent}]${a.name ? ` name="${a.name}"` : ""} | up ${Math.round(a.durationMs / 1000)}s | idle ${Math.round(a.idleMs / 1000)}s | inbox: ${a.inboxSize}`
        ).join("\n")
        : "No active teammate agents.";

      return {
        content: [{ type: "text", text: lines }],
        isError: false,
        details: { agents },
      };
    },
  };

  // =========================================================================
  // Register tools (LLM-callable)
  // =========================================================================

  pi.registerTool(tool);
  pi.registerTool(sendTool);
  pi.registerTool(listTool);

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

        overlay.appendLog(agent.correlationId, `Agent: ${agent.agent} | ${agentLabel(agent)}`, "info");
        overlay.appendLog(agent.correlationId, `Started: ${new Date(agent.startedAt).toISOString()}`, "info");
        overlay.appendLog(agent.correlationId, "", "info");

        const msgHandler = (data: unknown) => {
          const evt = data as Record<string, unknown>;
          const cid = evt.correlationId as string;
          if (!cid) return;

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
      { overlay: true },
    );
  }

  async function showAgentSelector(ctx: ExtensionContext): Promise<void> {
    const entries = Array.from(state.activeRuns.entries());
    if (entries.length === 0) {
      ctx.ui.notify("No active agents.", "warning");
      return;
    }
    if (entries.length === 1) {
      await showAttachOverlay(entries[0][0], ctx);
      return;
    }
    const selected = await ctx.ui.select(
      "Attach to agent",
      entries.map(([cid, a]) => ({
        value: cid,
        label: `${a.agent}/${agentLabel(a)}`,
      })),
    );
    if (selected) {
      await showAttachOverlay(selected, ctx);
    }
  }

  pi.registerShortcut("alt+r", {
    description: "Attach to a running teammate agent",
    async handler(ctx) {
      await showAgentSelector(ctx);
    },
  });

  // =========================================================================
  // Widget: active agents list below editor (auto-updated)
  // =========================================================================

  let widgetCtx: ExtensionContext | null = null;

  function updateAgentWidget(): void {
    if (!widgetCtx) return;
    const agents = Array.from(state.activeRuns.values());
    if (agents.length === 0) {
      widgetCtx.ui.setWidget("teammate-agents", undefined);
      return;
    }

    const lines = agents.map((a) => {
      const label = agentLabel(a);
      const uptime = Math.round((Date.now() - a.startedAt) / 1000);
      const status = a.stdin?.writable ? "●" : "○";
      return `  ${status} ${a.agent}/${label}  ${uptime}s`;
    });

    lines.unshift("─ agents ─ Alt+R attach");
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
    }, 2000);
  }

  function stopWidgetTimer(): void {
    if (widgetTimer) {
      clearInterval(widgetTimer);
      widgetTimer = null;
    }
  }

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
    for (const run of state.activeRuns.values()) {
      releaseAgentMemory(run);
      run.abortController.abort();
    }
    state.activeRuns.clear();
    state.namedAgents.clear();
    state.currentSessionId = null;
  });
}

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

function cleanupAgent(
  state: TeammateState,
  correlationId: string,
  name?: string,
): void {
  const agent = state.activeRuns.get(correlationId);
  if (agent) releaseAgentMemory(agent);
  state.activeRuns.delete(correlationId);
  if (name) {
    state.namedAgents.delete(name);
  }
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
