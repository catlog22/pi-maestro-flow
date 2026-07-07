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
  sendToChildStdin,
  type RunTeammateParams,
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

Three-axis control:
  - name: Optional addressable name for cross-agent routing (enables teammate-send)
  - reply_to: Result routing — "caller" (direct return) or "main" (broadcast to parent session)
Execution mode:
  - mode: "await" (default) blocks until result; "detach" returns immediately with a handle

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
          drainInbox(activeAgent);
        },
        onProgress: (data: AgentProgress) => {
          activeAgent.lastActivityAt = Date.now();
          if (!onUpdate) return;
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
                ...(data.status !== "running"
                  ? { completedAt: new Date().toISOString() }
                  : {}),
              }],
            },
          });
        },
      });

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

        // --- DETACH MODE ---
        if (params.mode === "detach") {
          const detachPromise = runTeammate(params, makeOptions());

          detachPromise.then((result) => {
            emitComplete(pi, id, params.agent, correlationId, result.exitCode, result.durationMs);
            cleanupAgent(state, correlationId, params.name);
          });

          return {
            content: [{
              type: "text",
              text: `[detached] Agent "${params.agent}" dispatched in background. correlationId=${correlationId}${params.name ? `, name="${params.name}"` : ""}. Use teammate-send to inject messages, teammate-list to check status.`,
            }],
            isError: false,
            details: { mode: "single", results: [] },
          };
        }

        // --- SINGLE AWAIT MODE ---
        const result = await runTeammate(params, makeOptions());

        const lastMessage =
          result.messages[result.messages.length - 1]?.content ?? "(no output)";

        const toolResult: AgentToolResult<Details> = {
          content: [{ type: "text", text: lastMessage }],
          isError: result.exitCode !== 0,
          details: { mode: "single", results: [result] },
        };

        if (result.structuredOutput !== undefined) {
          toolResult.details!.structuredOutput = result.structuredOutput;
        }

        emitComplete(pi, id, params.agent, correlationId, result.exitCode, result.durationMs);

        return toolResult;
      } finally {
        if (params.mode !== "detach") {
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

The target agent must have been dispatched with a "name" field and still be running.
Messages are injected into the agent's stdin as user messages.

Use "kind: notification" for context injection (fire-and-forget).
Use "kind: task" to assign additional work.`,

    parameters: TeammateSendParams,

    async execute(
      _id: string,
      params: { to: string; message: string; kind?: "notification" | "task" },
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

      const envelope: MessageEnvelope = {
        id: randomUUID(),
        from: "caller",
        to: params.to,
        kind: params.kind ?? "notification",
        payload: params.message,
        timestamp: Date.now(),
      };

      if (agent.stdin) {
        const sent = sendToChildStdin(agent.stdin, params.message);
        if (sent) {
          agent.lastActivityAt = Date.now();
          pi.events.emit(TEAMMATE_MESSAGE_EVENT, envelope);
          return {
            content: [{
              type: "text",
              text: `Message delivered to "${params.to}" (kind: ${envelope.kind}).`,
            }],
            isError: false,
            details: { delivered: true },
          };
        }
      }

      agent.inbox.push(envelope);
      return {
        content: [{
          type: "text",
          text: `Message queued for "${params.to}" (stdin not ready yet, will deliver when available).`,
        }],
        isError: false,
        details: { delivered: false },
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
          `[${a.agent}]${a.name ? ` name="${a.name}"` : ""} | up ${Math.round(a.durationMs / 1000)}s | idle ${Math.round(a.idleMs / 1000)}s | inbox: ${a.inboxSize} | stdin: ${a.hasStdin ? "ready" : "pending"}`
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
  // /teammate-attach command + Ctrl+T shortcut (user-facing TUI)
  // =========================================================================

  async function showAttachOverlay(agentName: string, ctx: ExtensionContext): Promise<void> {
    const correlationId = state.namedAgents.get(agentName);
    if (!correlationId) {
      ctx.ui.notify(`Agent "${agentName}" not found.`, "error");
      return;
    }
    const agent = state.activeRuns.get(correlationId);
    if (!agent) {
      state.namedAgents.delete(agentName);
      ctx.ui.notify(`Agent "${agentName}" is no longer active.`, "error");
      return;
    }

    await ctx.ui.custom(
      (_tui, _theme, _keybindings, done) => {
        const overlay = new AttachOverlay(agent, () => done(undefined));

        overlay.appendLog(`Agent: ${agent.agent} | correlationId: ${agent.correlationId}`);
        overlay.appendLog(`Started: ${new Date(agent.startedAt).toISOString()}`);
        overlay.appendLog(`Inbox: ${agent.inbox.length} messages`);
        overlay.appendLog("");

        const msgHandler = (data: unknown) => {
          const evt = data as Record<string, unknown>;
          if (evt.correlationId === agent.correlationId) {
            overlay.appendLog(`[${ts()}] ${JSON.stringify(evt)}`);
          }
        };
        const completeHandler = (data: unknown) => {
          const evt = data as Record<string, unknown>;
          if (evt.correlationId === agent.correlationId) {
            overlay.appendLog(`[${ts()}] COMPLETED exitCode=${evt.exitCode}`);
          }
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
    const names = Array.from(state.namedAgents.keys());
    if (names.length === 0) {
      ctx.ui.notify("No named agents running.", "warning");
      return;
    }
    if (names.length === 1) {
      await showAttachOverlay(names[0], ctx);
      return;
    }
    const selected = await ctx.ui.select(
      "Attach to agent",
      names.map((n) => {
        const cid = state.namedAgents.get(n)!;
        const a = state.activeRuns.get(cid);
        return { value: n, label: `${n} (${a?.agent ?? "?"})` };
      }),
    );
    if (selected) {
      await showAttachOverlay(selected, ctx);
    }
  }

  // Ctrl+T — shortcut to open agent selector/attach
  pi.registerShortcut("ctrl+b", {
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
      const name = a.name ? `${a.name}` : a.correlationId.slice(0, 8);
      const idle = Math.round((Date.now() - a.lastActivityAt) / 1000);
      const status = a.stdin?.writable ? "●" : "○";
      return `  ${status} ${a.agent}/${name}  idle ${idle}s`;
    });

    lines.unshift("─ agents ─ Ctrl+E attach");
    widgetCtx.ui.setWidget("teammate-agents", lines, { placement: "belowEditor" });
  }

  pi.events.on(TEAMMATE_STARTED_EVENT, () => updateAgentWidget());
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

function drainInbox(agent: ActiveAgent): void {
  if (!agent.stdin || !agent.inbox.length) return;
  for (const msg of agent.inbox) {
    sendToChildStdin(agent.stdin, msg.payload);
  }
  agent.inbox.length = 0;
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
