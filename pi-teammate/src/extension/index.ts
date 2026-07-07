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
  - lifecycle: "ephemeral" (default, one-shot) or "resident" (persistent, stays alive for messages)

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
        lifecycle: params.lifecycle ?? "ephemeral",
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
        lifecycle: string;
        startedAt: string;
        durationMs: number;
        inboxSize: number;
        hasStdin: boolean;
      }> = [];

      for (const [cid, entry] of state.activeRuns) {
        if (view === "named" && !entry.name) continue;

        agents.push({
          agent: entry.agent,
          name: entry.name,
          correlationId: cid,
          lifecycle: entry.lifecycle,
          startedAt: new Date(entry.startedAt).toISOString(),
          durationMs: Date.now() - entry.startedAt,
          inboxSize: entry.inbox.length,
          hasStdin: Boolean(entry.stdin?.writable),
        });
      }

      const lines = agents.length > 0
        ? agents.map((a) =>
          `[${a.agent}]${a.name ? ` name="${a.name}"` : ""} ${a.lifecycle} | ${Math.round(a.durationMs / 1000)}s | inbox: ${a.inboxSize} | stdin: ${a.hasStdin ? "ready" : "pending"}`
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
  // Register all tools
  // =========================================================================

  pi.registerTool(tool);
  pi.registerTool(sendTool);
  pi.registerTool(listTool);

  // =========================================================================
  // Session lifecycle + P2-2 reaper
  // =========================================================================

  let reaperTimer: ReturnType<typeof setInterval> | null = null;

  pi.on("session_start", (_event, ctx) => {
    state.baseCwd = ctx.cwd;
    state.currentSessionId = ctx.sessionManager?.getSessionId() ?? null;
    reaperTimer = startReaper(state, pi);
  });

  pi.on("session_shutdown", () => {
    if (reaperTimer) {
      clearInterval(reaperTimer);
      reaperTimer = null;
    }
    for (const run of state.activeRuns.values()) {
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

// ===========================================================================
// P2-2: Resident agent idle timeout + reaper
// ===========================================================================

const IDLE_WARN_MS = 5 * 60 * 1000;     // 5 min: send nudge
const IDLE_TIMEOUT_MS = 10 * 60 * 1000; // 10 min: force terminate
const REAPER_INTERVAL_MS = 60 * 1000;

function startReaper(state: TeammateState, pi: ExtensionAPI): ReturnType<typeof setInterval> {
  const nudged = new Set<string>();

  return setInterval(() => {
    const now = Date.now();

    for (const [cid, agent] of state.activeRuns) {
      if (agent.lifecycle !== "resident") continue;
      const idle = now - agent.lastActivityAt;

      if (idle > IDLE_TIMEOUT_MS) {
        agent.abortController.abort();
        pi.events.emit(TEAMMATE_COMPLETE_EVENT, {
          id: cid,
          agent: agent.agent,
          correlationId: agent.correlationId,
          exitCode: 0,
          durationMs: now - agent.startedAt,
          reason: "idle_timeout",
        });
        nudged.delete(cid);
        cleanupAgent(state, cid, agent.name);
      } else if (idle > IDLE_WARN_MS && !nudged.has(cid)) {
        if (agent.stdin) {
          sendToChildStdin(agent.stdin,
            `[system] Idle for ${Math.round(idle / 60000)} minutes. Continue your current task or wrap up. You will be terminated after ${Math.round(IDLE_TIMEOUT_MS / 60000)} minutes of inactivity.`);
          agent.lastActivityAt = now;
        }
        nudged.add(cid);
      }
    }
  }, REAPER_INTERVAL_MS);
}
