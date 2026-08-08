/**
 * Teammate Extension Entry Point
 *
 * Tools: teammate (dispatch), teammate-send (RPC message injection), teammate-list (status), observe
 * TUI: Alt+R composer panel, widget above editor, Alt+B foreground→background detach
 * Mode: RPC subprocess — stdin open for steer/follow_up/abort
 */

import { randomUUID } from "node:crypto";
import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
  ExtensionUIContext,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { createHash } from "node:crypto";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import { Check } from "typebox/value";
import { isGuiTeammateToolAllowed, registerGuiTool, unregisterGuiTool } from "../shared/gui-registry.ts";
import type { WorkspaceSessionScan } from "../transcript/session-transcript.ts";
import { Text, truncateToWidth } from "@earendil-works/pi-tui";
import { TeammateParams, TeammateSendParams, TeammateListParams, TeammateWatchParams, TeammateWaitParams, TeammateMonitorParams, ObserveParams } from "./schemas.ts";
import {
  formatObserveResult,
  observeTargets,
  registerObservationProvider,
  type ObserveParams as UnifiedObserveParams,
  type ObserveResult,
  type ObservationProvider,
  type ObservationSnapshot,
  type ObservationWaitStatus,
} from "../public/v1/observation.ts";
import {
  formatCompact,
  formatVerbose,
  formatHeader,
  formatBarrierCompact,
  validateMonitorParams,
  MONITOR_STATUS_KEY,
  MONITOR_DEFAULT_TIMEOUT_MS,
  MONITOR_DEFAULT_LINES,
  createEngineState,
  startEngine,
  stopEngine,
  addBinding,
  removeBinding,
  clearBindings,
  formatEngineStatusBar,
  buildAutoAnalysisPrompt,
  buildCustomAnalysisPrompt,
  parseAnalysisResult,
  ENGINE_TICK_MS,
  type MonitorTargetSnapshot,
  type MonitorParams,
  type MonitorEngineState,
  type MonitorSupervisionMode,
  type EngineAgentInfo,
  type AnalysisResult,
} from "./monitor.ts";
import {
  createWorkspacePeerCommandConsumer,
  createWorkspacePeerRuntime,
  discoverWorkspacePeers,
  resolveWorkspaceTarget,
  sendWorkspacePeerCommand,
  type WorkspaceAgentSnapshot,
  type WorkspaceBackgroundJobSnapshot,
  type WorkspaceOwnerSnapshot,
  type WorkspaceOwnerState,
  type WorkspacePeerCommandConsumer,
  type WorkspacePeerPublisher,
  type WorkspaceResolvedTarget,
  type WorkspaceSettledSnapshot,
} from "./workspace-peers.ts";
import {
  runSingleTeammate,
  runGraph,
  normalizeTeammateParams,
  inferGraphMode,
  taskDependencyNames,
  sendRpcMessage,
  truncateUtf8Tail,
  checkDepthGuard,
  getTeammateDepth,
  MAX_DEFAULT_DEPTH,
  resolveMaxActiveAgents,
  isStructuredOutputSettlementDiagnostic,
} from "../runs/execution.ts";
import {
  confirmChildReloaded,
  confirmParked,
  canChildWrite,
  buildFenceRecoveryMessages,
  cancelPark,
  createChildLease,
  fenceLease,
  leaseToken,
  handoffBarrierReached,
  isSessionPathContained,
  leaseSelection,
  requestHandback,
  requestPark,
  recoverChild,
  restoreMainOwnership,
  sameLeaseSelection,
  sameLeaseToken,
  transitionLeaseIfCurrent,
  transferToMain,
  unwrapLeasedMessage,
  type LeaseSelection,
  type LeaseToken,
} from "../runs/session-handoff.ts";
import type {
  RunTeammateParams,
  RunTeammateOptions,
  RpcMessageMode,
  NormalizedTask,
} from "../runs/execution.ts";
import {
  auxToolCallFallback,
  auxToolResultFallback,
  renderQuietTeammateAux,
  renderTeammateCall,
  renderTeammateListCall,
  renderTeammateListResult,
  renderTeammateResult,
} from "../tui/render.ts";
import { AttachOverlay } from "../tui/attach-overlay.ts";
import {
  BracketedPasteDecoder,
  removeLastGrapheme,
  sanitizeSingleLineInput,
  type DecodedInputToken,
} from "../tui/input-text.ts";
import { showModelMappingOverlay } from "../tui/model-mapping-overlay.ts";
import { showMonitorOverlay, type MonitorSessionRow } from "../tui/monitor-overlay.ts";
import type {
  Details,
  TeammateState,
  AgentProgress,
  AgentProgressSnapshot,
  AgentRunPhase,
  ChildAgentCallSnapshot,
  ActiveAgent,
  AgentStatus,
  AgentTerminalStatus,
  MessageEnvelope,
  SettledAgentRecord,
  SingleResult,
  StructuredResult,
  TeammateInteractionRecord,
  TeammateResultPublishedEvent,
} from "../shared/types.ts";
import { isAgentStalled, projectAgentActivity } from "../shared/agent-status.ts";
import {
  TEAMMATE_EXPECTED_SILENCE_TIMEOUT_MS,
  TEAMMATE_STALL_TIMEOUT_MS,
} from "../shared/limits.ts";

export { TEAMMATE_STALL_TIMEOUT_MS };

type TeammateToolResult<T> = AgentToolResult<T> & { isError?: boolean };

function isTeammateToolResult(value: unknown): value is TeammateToolResult<unknown> {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return Array.isArray(record.content)
    && Object.prototype.hasOwnProperty.call(record, "details")
    && (record.isError === undefined || typeof record.isError === "boolean");
}
import {
  TEAMMATE_COMPLETE_EVENT,
  TEAMMATE_STARTED_EVENT,
  TEAMMATE_MESSAGE_EVENT,
  TEAMMATE_RESULT_PUBLISHED_EVENT,
} from "../shared/types.ts";
import {
  appendAgentCatalog,
  discoverAgents,
  formatAgentCatalog,
  invalidateAgentCatalogCache,
  listAgentSummaries,
  type AgentSummary,
} from "../agents/agents.ts";
import {
  appendModelCatalog,
  createModelCatalogSnapshot,
  type ModelCatalogSnapshot,
  type TeammateModelCapability,
} from "../models/model-catalog.ts";
import {
  applyModelRouting,
  formatModelRoutingConfig,
  parseTeammateTaskType,
  type TeammateTaskType,
} from "../models/model-routing.ts";
import type { TeammateThinkingInput } from "../shared/thinking.ts";
import {
  getTeammateChildToolBroker,
  getTeammatePermissionBroker,
  registerTeammateChildProxyCaller,
} from "../runs/child-extensions.ts";
import { setQuietMode } from "../quiet-state.ts";
import { agentActiveMs, progressDurationMs } from "./teammate-helpers.ts";


export const TEAMMATE_PROMPT_SNIPPET =
  "Dispatch bounded work to discovered teammate roles for parallel, sequential, or specialist execution.";

export const TEAMMATE_PROMPT_GUIDELINES = [
  "Use teammate when work can be split into bounded independent tasks, or when a discovered specialist role materially improves correctness.",
  "Do not use teammate for trivial, tightly coupled, single-step work that is faster to complete directly.",
  "Use teammate tasks for parallel or DAG work; {name} and {name.field} references create dependencies between named tasks, and dependsOn declares ordering without injecting output.",
  "Give every multi-task teammate item a stable unique name so nested work remains traceable and addressable; a {ref} that matches no task name is passed through as literal text.",
  "Set teammate concurrency explicitly for provider-safe fan-out; background defaults to false, so the call waits for results until completion or its foreground timeoutMs window, then moves unfinished work to background without terminating it.",
  "maxNestingDepth may be set on the root dispatch or per task (task wins, omission inherits the top-level value and defaults to the global ceiling): 0 disables nested teammate calls for the spawned agents, and only 0 and 1 are effective (2 is capped to 1 by the global 2-level ceiling; above 2 is rejected). Nested dispatches cannot extend that depth — at most they may pass maxNestingDepth: 0 as an explicit no-further-nesting marker.",
  "After a nested (child-level) background dispatch, the completion is delivered automatically as a new turn in this agent's session — the root forwards the teammate-complete envelope over IPC while this agent is still live — so ending the turn to await the notification is correct; the root caller additionally sees the same notification. If this agent has ended, delivery is skipped and the result is only inspectable via observe.",
  'Use teammate with context: "fork" only when the child needs the current conversation history; fresh context is the default, and in multi-task mode prefer per-task fork over a top-level default.',
  "After teammate returns a background acknowledgement (explicit background, manual detach, or elapsed foreground window), normally end the current turn and wait for the automatic teammate-complete notification, which will trigger a new turn with the result.",
  "Do not poll observe or teammate-list after starting background work; use observe action=status only for a one-off inspection explicitly needed for debugging or requested by the user.",
  "If the current turn must wait for an already-backgrounded result, call observe exactly once with action=wait, a teammate target, and a bounded timeout.",
  "Use teammate-send for steering or follow-up while a teammate remains running or wakeable.",
  "Omit model to use teammate task-type model routing; an exact task-level provider/model overrides the top-level model, and the top-level model overrides automatic routing.",
  "Always wrap every teammate call in a non-empty tasks array: prompt, name, and dependsOn belong inside tasks[]; only shared defaults (agent/taskType/model/fallbackModels/thinking/context/cwd/outputSchema/timeoutMs/maxNestingDepth) may be set at the top level. A top-level prompt is rejected as an unexpected property.",
  "An explicit model that is not in the current model catalog fails fast with 'Unknown teammate model specifier' — pick an id from the injected available model catalog.",
];

export function terminalStatusForResult(
  result: SingleResult,
  callbackStatus?: AgentTerminalStatus,
): AgentTerminalStatus {
  return callbackStatus ?? result.terminalStatus ?? (result.exitCode === 0 ? "completed" : "failed");
}

export function resultIsError(result: SingleResult): boolean {
  return terminalStatusForResult(result) === "failed";
}

export function aggregateTerminalStatus(results: readonly SingleResult[]): AgentTerminalStatus {
  if (results.some((result) => terminalStatusForResult(result) === "failed")) return "failed";
  if (results.some((result) => terminalStatusForResult(result) === "terminated")) return "terminated";
  return "completed";
}

/**
 * Aggregates per-task lifecycle statuses recorded at terminal time. Graph
 * publications now carry publish-time results (the release boundary), so
 * container settlement and completion events derive their truth here instead
 * of from the publication.
 */
export function aggregateTerminalStatuses(
  statuses: Iterable<AgentTerminalStatus | undefined>,
): AgentTerminalStatus {
  let sawTerminated = false;
  for (const status of statuses) {
    if (status === "failed") return "failed";
    if (status === "terminated") sawTerminated = true;
  }
  return sawTerminated ? "terminated" : "completed";
}

const STRUCTURED_OUTPUT_CONFIRMATION = "Structured output saved.";

function formatStructuredOutputForDisplay(result: SingleResult): string | undefined {
  if (result.structuredOutput === undefined) return undefined;
  let text: string;
  try {
    text = JSON.stringify(result.structuredOutput, null, 2);
  } catch {
    return "[structured_output] (value is not JSON-serializable)";
  }
  // Deliver the full value: the parent agent consumes this text as the
  // authoritative result, so it must never be head-truncated.
  return `[structured_output] ${text}`;
}

function isStructuredOutputConfirmation(text: string): boolean {
  return text === STRUCTURED_OUTPUT_CONFIRMATION || text === "(no output)";
}

export function displayMessageForResult(result: SingleResult): string {
  const structured = formatStructuredOutputForDisplay(result);
  const lastMessage = result.messages.at(-1)?.content ?? structured ?? "(no output)";
  // A structured_output completion ends with the tool's generic confirmation,
  // not the answer. When the transcript tail is only that confirmation (or
  // nothing), surface the value itself; otherwise keep the prose answer and
  // append the value so callers see both.
  const effective = structured !== undefined && lastMessage !== structured
    ? isStructuredOutputConfirmation(lastMessage)
      ? structured
      : `${lastMessage}\n\n${structured}`
    : lastMessage;
  if (result.exitCode === 0) return effective;

  const schemaDiagnostic = result.messages
    .filter((message) => isStructuredOutputSettlementDiagnostic(message.content))
    .at(-1)?.content;
  const primaryDiagnostics = result.messages
    .filter((message) => message.role === "system" && !isStructuredOutputSettlementDiagnostic(message.content));
  const primaryDiagnostic = primaryDiagnostics
    .find((message) => !message.content.startsWith("Fork requested but parent session file not available"))
    ?.content
    ?? primaryDiagnostics.at(-1)?.content;

  if (primaryDiagnostic && schemaDiagnostic && primaryDiagnostic !== schemaDiagnostic) {
    return `${primaryDiagnostic}\n\nStructured output: ${schemaDiagnostic}`;
  }
  return primaryDiagnostic ?? schemaDiagnostic ?? effective;
}

export function summarizeGraphResults(results: readonly SingleResult[], tasks: readonly NormalizedTask[]): string {
  return results
    .map((result, index) => {
      const task = tasks[index];
      const label = task?.name ?? task?.description;
      return (
        `[${result.agent}${label ? `/${label}` : ""}] `
        + `${terminalStatusForResult(result) === "completed"
          ? "OK"
          : terminalStatusForResult(result) === "terminated" ? "TERMINATED" : "FAIL"}: ${displayMessageForResult(result)}`
      );
    })
    .join("\n\n");
}

export function aggregateGraphStructuredOutput(
  results: readonly SingleResult[],
  tasks: readonly NormalizedTask[],
): Record<string, unknown> | undefined {
  const structuredOutput: Record<string, unknown> = {};
  results.forEach((result, index) => {
    if (result.structuredOutput !== undefined) {
      structuredOutput[tasks[index]?.name ?? String(index)] = result.structuredOutput;
    }
  });
  return Object.keys(structuredOutput).length > 0 ? structuredOutput : undefined;
}

/**
 * Final assistant answer of a settled result: the last non-empty assistant
 * message, or the last non-empty message of any role (e.g. a failure
 * diagnostic) when no assistant text survived. Empty only when the transcript
 * is empty.
 */
export function finalResultText(result: SingleResult): string | undefined {
  const messages = result.messages ?? [];
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (!message || message.role !== "assistant") continue;
    const text = message.content?.trim();
    if (text) return text;
  }
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const text = messages[index]?.content?.trim();
    if (text) return text;
  }
  return undefined;
}

/**
 * Compact projection of settled results for completion events. Each entry
 * carries either the schema-valid `structuredOutput` or, when the task had no
 * outputSchema, the final assistant text as `output`. Undefined when no result
 * produced either, so emitters can spread it conditionally and keep the event
 * payload minimal.
 */
export function toStructuredResults(
  results: readonly SingleResult[],
  originCwd: string,
): StructuredResult[] | undefined {
  const entries: StructuredResult[] = [];
  for (const result of results) {
    const structured = result.structuredOutput;
    const text = structured !== undefined ? undefined : finalResultText(result);
    if (structured === undefined && text === undefined) continue;
    entries.push({
      correlationId: result.correlationId,
      ...(result.publicationId ? { publicationId: result.publicationId } : {}),
      originCwd: result.originCwd ?? originCwd,
      ...(result.name ? { name: result.name } : {}),
      agent: result.agent,
      ...(structured !== undefined ? { structuredOutput: structuredClone(structured) } : {}),
      ...(text !== undefined ? { output: text } : {}),
    });
  }
  return entries.length > 0 ? entries : undefined;
}

/** Publish one consumable result and await durable work claimed by listeners. */
export async function emitTeammateResultPublished(
  pi: ExtensionAPI,
  result: SingleResult,
  originCwd: string,
): Promise<void> {
  const projected = toStructuredResults([result], originCwd)?.[0];
  if (!projected) return;

  const pending: Promise<unknown>[] = [];
  const event: TeammateResultPublishedEvent = {
    result: projected,
    waitUntil(promise) {
      pending.push(Promise.resolve(promise));
    },
  };
  let emissionError: unknown;
  try {
    pi.events.emit(TEAMMATE_RESULT_PUBLISHED_EVENT, event);
  } catch (error) {
    emissionError = error;
  }

  const outcomes = await Promise.allSettled(pending);
  for (const outcome of outcomes) {
    if (outcome.status === "rejected") {
      console.warn(
        `[pi-maestro-teammate] result publication observer failed for ${result.correlationId}: `
        + `${outcome.reason instanceof Error ? outcome.reason.message : String(outcome.reason)}`,
      );
    }
  }
  if (emissionError !== undefined) throw emissionError;
}

/** Replace the retained turn value; undefined intentionally clears stale data. */
export function setAgentStructuredOutput(agent: ActiveAgent, output: unknown): void {
  agent.structuredOutput = output === undefined ? undefined : structuredClone(output);
}

export type TeammateRuntimeOptions = Pick<
  RunTeammateOptions,
  "spawnChildProcess" | "resultReadyGraceMs" | "foregroundMaxRunMs"
> & {
  /** @internal Observes the real runtime callbacks for public-path lifecycle tests. */
  onRunOptionsCreated?: (options: RunTeammateOptions) => void;
};

export function buildTeammateToolDescription(
  cwd: string,
  options?: { nested?: boolean },
): string {
  const nested = options?.nested === true;
  // Nested contexts (child agents) do not need the per-cwd routing table —
  // execution is proxied to the parent root process, which owns routing.
  const modelRoutingSection = nested
    ? "Model routing inherits the parent session's configuration; pass an explicit model id to override (an id outside the catalog fails fast at dispatch with \"Unknown teammate model specifier\")."
    : `When neither the top-level model nor a task-level model is set, teammates inherit the main session's current model by default. Configured task-type/role mappings take precedence when present; with no mapping and no session model, the agent's default model is used. An explicit model id that is not in the current catalog fails fast at dispatch with "Unknown teammate model specifier".

Configured task-type model routing for ${cwd}:
${formatModelRoutingConfig(cwd, discoverAgents(cwd))}`;
  return `Dispatch tasks to teammate agents. Teammates run as Pi subprocesses with their own tools and context.
${nested ? `Nested dispatch: this call is proxied to the parent root process — execution happens there, and the result (or teammate-complete notification) is delivered back to this agent's session.

` : ""}Minimal call:
  { tasks: [{ prompt: "Inspect auth" }] }

Every dispatch uses a non-empty tasks array; prompt is the only required per-task field and lives inside tasks[]. Optional per-task fields include agent, taskType, model, thinking, context, cwd, outputSchema, maxNestingDepth, name, dependsOn, description, and timeoutMs. Omit outputSchema for ordinary tasks; use it only when the caller explicitly requires machine-readable structured fields. Task-level values override the top-level defaults — except background, which is dispatch-level and belongs at the top level only. Tasks that omit agent inherit the top-level agent, then default to "general".
The top level accepts shared defaults for all tasks — agent, taskType, model, fallbackModels, thinking, context, cwd, timeoutMs, and maxNestingDepth — plus reply_to, concurrency, maxAgents, background, and the advanced optional outputSchema default. A task field (prompt/name/dependsOn) placed at the top level is rejected as an unexpected property. background is dispatch-level: the whole call shares one foreground/background window, so it belongs at the top level only — a per-task background value is ignored with a warning.
Use {name} or {name.field} in a dependent task's prompt, or dependsOn: ["name"] for ordering without output injection.

Nesting control: pass maxNestingDepth on the root dispatch — or per task, which overrides the top-level value — to limit how many levels of nested teammate dispatch the spawned agents may perform below themselves. Omitting it everywhere defaults to the global ceiling. The only effective values are 0 and 1 — 2 is capped to 1 by the global 2-level ceiling and anything above 2 is rejected. 0 forbids nested calls entirely — the assigned agents cannot dispatch teammates. Inside a spawned agent, maxNestingDepth can only tighten the parent's budget — pass 0 to forbid further nesting below that call; it can never extend depth beyond what the parent allowed.

Use an exact role name from the Available Teammate Agents section in the active system prompt. Unknown names are rejected.

Background: the foreground wait window is bounded — the smallest per-task timeoutMs, or a 600000 ms (10 minutes) default; when it elapses the call returns a background acknowledgement and the work continues, completing via one automatic teammate-complete notification that triggers a new turn. Do not poll observe or teammate-list; if the current turn must wait, call observe once with action="wait" and target { kind: "teammate", id: "<name-or-correlation-id>" }. Completion delivery details (root vs nested dispatch, skip-on-exit) are in the background parameter description.

## Structured output (optional)

Use outputSchema only when the caller needs machine-readable fields for validation or downstream {name.field} references. The task instruction remains in tasks[].prompt:
{ "tasks": [{ "name": "audit", "agent": "analyst", "prompt": "Inspect auth", "outputSchema": { "type": "object", "properties": { "result": { "type": "string" } }, "required": ["result"] } }] }

When a task (or the top-level call) sets outputSchema, the child must submit its final answer through a \`structured_output\` tool that validates the value against that JSON Schema. On completion the value is returned directly in the result content (prefixed \`[structured_output]\`) and is persisted for later reads via \`agent://<correlationId>\` (resource tool). Schema-invalid submissions are rejected by the child tool so the model can correct them within the current Pi turn; teammate does not replay validation failures. A run that ends without a valid value fails with a diagnostic naming the offending field. Without outputSchema, the teammate's final answer is returned as text.

## Todo binding (todo)

A task may carry an optional per-task \`todo\` field — a single Todo task id (\"12\" or \"#12\") or an ordered array of ids (\"[\"#1\", \"#2\"]\", first = highest priority). On agent start the host re-assigns each task's assignee to the agent (actor changes from root to the agent), auto-activates the first runnable one (pending, not blocked, and only when the agent has no other active task; blocked/done bindings are skipped), and injects the whole ordered list into the agent's system prompt as a managed fragment: the agent finishes the active task with \`todo update <id> status=completed summary=...\`, then activates the next with \`todo update <id> status=in_progress\`. The tasks must exist before dispatch; missing ids produce a warning and dispatch continues.

## Observation

Use observe for teammate and background Bash status, barrier waits, or transition watching:
- { action: "status", targets: [{ kind: "teammate", id: "reviewer" }] } — one-shot snapshot
- { action: "wait", targets: [{ kind: "teammate", id: "reviewer" }, { kind: "bash_bg", id: "bg-id" }], waitMode: "all" } — mixed barrier wait
- { action: "wait", until: "completed", targets: [{ kind: "teammate", id: "reviewer" }] } — block until the agent fully terminates (not just first result)
- { action: "watch", targets: [{ kind: "teammate", id: "reviewer" }], timeoutMs: 30000 } — follow status transitions until timeout

${modelRoutingSection}`;
}

export const TEAMMATE_SEND_DESCRIPTION = `Send a message to a running or sleeping teammate agent, addressed by name, @name, displayed name#id-prefix, correlation ID (or prefix), or a cross-session target from teammate-list such as owner:<ownerId> or owner:<ownerId>:<correlationId>.

Modes: "steer" | "follow_up" (default) | "abort" — per-mode semantics and the message requirement are in the mode and message parameter descriptions. Cross-session targets support only "steer" and "follow_up".`;
export const TEAMMATE_SEND_SNIPPET = "Steer, follow up with, or send a message to a cross-session teammate target.";
export const TEAMMATE_SEND_GUIDELINES = [
  "Use teammate-send only for a named running or sleeping agent; steer for urgent correction, abort only to terminate work.",
  "For another Pi window, call teammate-list with view=windows first, then send to the returned target (owner:<ownerId> for the window or owner:<ownerId>:<correlationId> for one of its agents). Cross-session abort is unsupported.",
];

export const TEAMMATE_LIST_DESCRIPTION = `List available roles, teammate agents, or cross-session windows. view defaults to "active".

- "active": live agents except completed entries
- "named": addressable agents
- "all": all tracked live entries
- "roles": builtin, project, and user-defined role definitions
- "windows": available peer Pi windows; use each returned target with teammate-send`;
export const TEAMMATE_LIST_SNIPPET = "List teammate roles, agent status, or available cross-session windows.";
export const TEAMMATE_LIST_GUIDELINES = [
  'Use teammate-list with view="roles" when an available builtin, project, or user-defined agent name is needed; use active/named/all for running work.',
  'Use teammate-list with view="windows" before sending across Pi sessions; the returned owner:<ownerId> target addresses the window main session.',
];

export const TEAMMATE_WATCH_DESCRIPTION =
  "Perform a one-shot inspection of a running or sleeping teammate agent's recent output, tool activity, inbox messages, and last result — including the structured_output value for schema tasks. This returns one snapshot, unlike observe action=\"watch\" which polls until its timeoutMs; it is not a completion-wait tool.";
export const TEAMMATE_WATCH_SNIPPET = "Inspect a specific teammate agent's recent activity and output.";
export const TEAMMATE_WATCH_GUIDELINES = [
  "Use teammate-watch only for a one-off live inspection after selecting an agent name, displayed selector, or correlation ID; never call it repeatedly to wait for completion.",
  "Use teammate-wait once when completion or a result is required, or wait for the automatic teammate-complete notification.",
];
export const TEAMMATE_WAIT_DESCRIPTION =
  "Wait once for a teammate result by name, or provide waitMs for a fixed delay. Named waits default to a bounded 600000 ms (10 minutes) timeout and settle on result-ready (not terminal lifecycle); they are the single-target convenience form of observe action=\"wait\" — use observe with until=\"completed\" to wait for full termination. Agent waits replace repeated teammate-watch calls.";
export const TEAMMATE_WAIT_SNIPPET = "Wait once for a teammate result or for a bounded delay.";
export const TEAMMATE_WAIT_GUIDELINES = [
  "Call teammate-wait exactly once with a returned name or correlation ID and a bounded timeout instead of repeatedly calling teammate-watch.",
  "Treat result-ready as a usable teammate result; do not continue waiting only for agent_end lifecycle confirmation.",
];

export const OBSERVE_DESCRIPTION = `Observe mixed teammate and background Bash targets through one status/wait/watch interface.

- "status": one-shot snapshot of every target
- "wait": block on an all/any/count barrier with one request-level timeout; set until="completed" to block until agents fully terminate instead of first result
- "watch": poll every target until the bounded timeoutMs you provide, returning the full status-transition timeline (richer than status, no barrier required); omitted timeoutMs defaults to 600000 (10 minutes)

Targets use { kind, id }, where kind is currently "teammate" or "bash_bg". Use detail=full (or tail) to include a settled teammate's captured result — including the structured_output value for schema tasks. Legacy teammate observation tools remain available internally but are hidden from the default LLM tool catalog.`;
export const OBSERVE_SNIPPET = "Observe, wait for, or watch mixed teammate and background Bash targets.";
export const OBSERVE_GUIDELINES = [
  "Use observe for mixed or multi-target status and waits; use one bounded wait instead of polling status.",
  "Use action=watch to follow status transitions over time; always pass a bounded timeoutMs — omitted defaults to 600000 (10 minutes). Use action=wait until=completed to block until agents fully terminate.",
  "Use detail=full only when recent output is required; summary is the compact default. detail=full includes a settled agent's captured result and structured_output value.",
];

export const TEAMMATE_MONITOR_DESCRIPTION = `Observe multiple teammate targets or block on a multi-agent barrier. Monitor mode is user-controlled via /monitor; this tool only queries and waits.

- "status": one-shot compact snapshot of targets — non-blocking
- "wait": block until the barrier condition (all/any/count targets reach a result; result-ready, not terminal)

Output is compact by default (one line per target). Set verbose=true for expanded output.

teammate-only: targets are plain agent-name strings (not observe's { kind, id } objects). This tool has no watch action, until threshold, or detail parameter; use observe for mixed bash_bg targets, transition watching, or until="completed" waits.`;
export const TEAMMATE_MONITOR_SNIPPET = "Query monitor snapshot or block on a multi-agent barrier.";
export const TEAMMATE_MONITOR_GUIDELINES = [
  "Use teammate-monitor for multi-agent observation and barrier waits; for a single agent, prefer teammate-wait.",
  "Monitor mode is user-controlled via /monitor; this tool only queries and waits.",
];

export function exposeLegacyObservationTools(): boolean {
  return process.env.PI_TEAMMATE_LEGACY_OBSERVATION_TOOLS === "1";
}

export const TEAMMATE_DEPTH_START_MARKER = "<teammate_nesting_context>";
export const TEAMMATE_DEPTH_END_MARKER = "</teammate_nesting_context>";

export function appendTeammateDepthContext(
  systemPrompt: string,
  depth: number,
  maxDispatchDepth?: number,
): string {
  const current = Math.max(0, Math.min(MAX_DEFAULT_DEPTH, depth));
  // Budget is the absolute max record-depth this agent may dispatch at; the
  // main agent's default is MAX-1 so remaining = MAX - depth as before.
  const budget = maxDispatchDepth ?? MAX_DEFAULT_DEPTH - 1;
  const remaining = Math.max(0, budget - current + 1);
  const role = current === 0 ? "main agent" : "teammate agent";
  const dispatchGuidance = remaining === 0
    ? maxDispatchDepth === 0
      ? "The parent dispatch disabled nested teammate calls (maxNestingDepth: 0). The teammate dispatch tool is intentionally unavailable; complete the assigned work directly and do not attempt further delegation."
      : "This is the terminal teammate level. The teammate dispatch tool is intentionally unavailable; complete the assigned work directly and do not attempt further delegation."
    : `You may delegate through the teammate tool for ${remaining} more level${remaining === 1 ? "" : "s"}.`;
  const depthContext = [
    TEAMMATE_DEPTH_START_MARKER,
    "# Teammate Nesting Context",
    `You are the ${role} at depth ${current}/${MAX_DEFAULT_DEPTH}. Remaining teammate depth: ${remaining}.`,
    dispatchGuidance,
    TEAMMATE_DEPTH_END_MARKER,
  ].join("\n");
  const start = systemPrompt.indexOf(TEAMMATE_DEPTH_START_MARKER);
  const end = systemPrompt.indexOf(TEAMMATE_DEPTH_END_MARKER);
  if (start >= 0 && end >= start) {
    return `${systemPrompt.slice(0, start)}${depthContext}${systemPrompt.slice(end + TEAMMATE_DEPTH_END_MARKER.length)}`;
  }
  return `${systemPrompt}\n\n${depthContext}`;
}

export function backgroundWaitGuidance(correlationId: string): string {
  return `correlationId=${correlationId}. The teammate-complete notification is delivered automatically when the work finishes: for a root dispatch it arrives as a new turn in this session; for a nested dispatch the work runs in the root process and the root forwards the completion over IPC, so it also arrives as a new turn in this agent's session while this agent is still live (the root caller additionally sees it). If this agent has already ended, delivery is skipped and the result is settled and inspectable via observe. Do not poll observe or teammate-list. If this turn must consume the result, call observe exactly once with { action: "wait", targets: [{ kind: "teammate", id: "${correlationId}" }], timeoutMs: 600000 (10 minutes) }; otherwise end the turn now.`;
}

/**
 * Appended to foreground detach acknowledgements so the Alt+B shortcut stays
 * discoverable across the root single, root graph, and nested foreground paths.
 */
export const FOREGROUND_DETACH_HINT = "Alt+B detaches a foreground call to background.";

/**
 * One session-scoped Alt+B listener dispatches to the oldest active foreground
 * owner. This makes nested calls detach layer by layer from the outermost call
 * instead of relying on TUI listener registration order.
 */
type ForegroundDetachOwner = {
  active: boolean;
  detach(): void;
};

let persistentUi: ExtensionUIContext | undefined;
let persistentUiUnsubscribe: (() => void) | undefined;
const foregroundDetachOwners: ForegroundDetachOwner[] = [];

function uninstallForegroundDetachListener(): void {
  const unsubscribe = persistentUiUnsubscribe;
  persistentUiUnsubscribe = undefined;
  unsubscribe?.();
}

function installForegroundDetachListener(): void {
  if (!persistentUi || persistentUiUnsubscribe || foregroundDetachOwners.length === 0) return;
  persistentUiUnsubscribe = persistentUi.onTerminalInput((data: string) => {
    if (data !== "\x1bb") return undefined;
    const owner = foregroundDetachOwners.shift();
    if (!owner) return undefined;
    owner.active = false;
    if (foregroundDetachOwners.length === 0) uninstallForegroundDetachListener();
    owner.detach();
    return { consume: true };
  });
}

export function setPersistentUi(
  ui: ExtensionUIContext | undefined,
  resetOwners = false,
): void {
  if (persistentUi !== ui || resetOwners) {
    uninstallForegroundDetachListener();
    persistentUi = ui;
  }
  if (!ui || resetOwners) {
    for (const owner of foregroundDetachOwners) owner.active = false;
    foregroundDetachOwners.length = 0;
    if (!ui) return;
  }
  installForegroundDetachListener();
}

/** Registers one foreground owner; unregister is idempotent on every race path. */
export function registerForegroundDetach(
  detach: () => void,
  ui?: ExtensionUIContext,
): () => void {
  if (ui) setPersistentUi(ui);
  const owner: ForegroundDetachOwner = { active: true, detach };
  foregroundDetachOwners.push(owner);
  try {
    installForegroundDetachListener();
  } catch (error) {
    owner.active = false;
    const index = foregroundDetachOwners.indexOf(owner);
    if (index >= 0) foregroundDetachOwners.splice(index, 1);
    if (foregroundDetachOwners.length === 0) uninstallForegroundDetachListener();
    throw error;
  }

  return () => {
    if (!owner.active) return;
    owner.active = false;
    const index = foregroundDetachOwners.indexOf(owner);
    if (index >= 0) foregroundDetachOwners.splice(index, 1);
    if (foregroundDetachOwners.length === 0) uninstallForegroundDetachListener();
  };
}

export function foregroundWaitWindowMs(
  tasks: ReadonlyArray<{ timeoutMs?: number }>,
  fallbackMs?: number,
): number {
  const configured = tasks
    .map((task) => task.timeoutMs)
    .filter((timeout): timeout is number => timeout !== undefined);
  // Never return undefined: an unbounded foreground deadline would make the
  // tool call hang forever instead of detaching to background (P0a).
  return configured.length > 0
    ? Math.min(...configured)
    : (fallbackMs ?? TEAMMATE_FOREGROUND_DEFAULT_TIMEOUT_MS);
}

export function createForegroundDeadline(timeoutMs: number): {
  promise: Promise<"timeout">;
  dispose(): void;
} {
  let timer: ReturnType<typeof setTimeout> | undefined;
  // timeoutMs is always resolved to a bounded number by foregroundWaitWindowMs
  // (P0a); an undefined value here would be a never-resolving promise that
  // hangs the foreground tool call instead of detaching to background.
  const promise = new Promise<"timeout">((resolve) => {
    timer = setTimeout(() => resolve("timeout"), timeoutMs);
  });
  return {
    promise,
    dispose() {
      if (timer) clearTimeout(timer);
      timer = undefined;
    },
  };
}

export const AGENT_BUFFER_LIMITS = Object.freeze({
  inboxItems: 64,
  sleepingInboxItems: 5,
  inboxBytes: 256 * 1024,
  logLines: 200,
  sleepingLogLines: 100,
  logLineBytes: 16 * 1024,
  logBytes: 512 * 1024,
  lastResultBytes: 256 * 1024,
  /** PERFSEC-004: Cap per-interaction payload retention (16 concurrent × 256KB = 4MB max). */
  interactionPayloadBytes: 256 * 1024,
});
/**
 * Idle confirmation window for caller-facing notifications during phases that
 * have a 30s canonical deadline. Expected-silence phases keep their longer
 * five-minute deadline and are never shortened by this override.
 */
export const TEAMMATE_STALL_NOTIFY_IDLE_MS = 60_000;

/**
 * Minimum spacing between caller-facing stall notifications for the same
 * agent. Without it, an agent that alternates activity and silence re-arms
 * the one-shot marker on every resume and notifies on every silent spell.
 */
export const TEAMMATE_STALL_NOTIFY_COOLDOWN_MS = 5 * 60_000;

/** Expected queue/model silence uses the shared five-minute ceiling. */
export const TEAMMATE_PENDING_STALL_TIMEOUT_MS = TEAMMATE_EXPECTED_SILENCE_TIMEOUT_MS;

/** Lower bound on teammate-wait re-poll spacing. */
export const TEAMMATE_WAIT_POLL_FLOOR_MS = 250;

/**
 * Backstop for `teammate-wait` calls that omit `timeoutMs`. The tool's own
 * description tells callers to pass a bounded timeout, but an unbounded wait
 * must still terminate on its own.
 */
export const TEAMMATE_WAIT_DEFAULT_TIMEOUT_MS = 10 * 60_000;

/**
 * Foreground wait window when neither the task nor runtime options provide a
 * timeout. Previously `undefined` here reached `createForegroundDeadline` as
 * a never-resolving promise, so a foreground call whose child stayed alive
 * without emitting a terminal event (or whose run promise never settled) hung
 * the tool call indefinitely instead of detaching to background. The window is
 * a detach bound, not a kill bound: on expiry the extension moves the run to
 * background and returns the standard acknowledgement + guidance.
 */
export const TEAMMATE_FOREGROUND_DEFAULT_TIMEOUT_MS = TEAMMATE_WAIT_DEFAULT_TIMEOUT_MS;

/**
 * Ceiling on how long one relayed permission/question may hold a child agent
 * before it is answered on the child's behalf. The terminal is a single shared
 * resource, so these requests are answered one at a time; without a ceiling one
 * unattended prompt stalls every other agent queued behind it, and any parent
 * waiting on those agents stalls with them.
 */
export const TEAMMATE_INTERACTION_TIMEOUT_MS = 5 * 60_000;

/**
 * Ceiling on queued relayed interactions. Past this the queue is answering
 * slower than agents are asking, so newcomers are declined immediately rather
 * than joining a line they would time out in anyway.
 */
export const TEAMMATE_INTERACTION_QUEUE_LIMIT = 16;

export const WAKEABLE_AGENT_BUDGET = Object.freeze({
  maxSleepingAgents: 12,
  anonymousTtlMs: 15 * 60_000,
  namedTtlMs: 60 * 60_000,
});

export const AGENT_WIDGET_IDLE_HIDE_MS = 60_000;
export { COCKPIT_UI_OWNERSHIP_EVENT } from "../shared/cockpit-events.ts";

/**
 * Appends one marker-prefixed activity line to an agent's log. Shared so the
 * single-task and graph proxy paths record the same shape; the single-task path
 * previously recorded nothing, leaving `teammate-watch` on a nested agent with
 * only "Waiting for model capacity or first activity…".
 */
export function appendAgentProgressLine(
  agent: ActiveAgent,
  data: AgentProgress,
  correlationId: string,
): void {
  const lastLine = data.lastMessage?.split("\n").pop()?.trim();
  if (!lastLine) return;
  const shortId = correlationId.slice(0, 8);
  const marker = data.name ? `@${data.name}#${shortId}` : `${data.agent}#${shortId}`;
  agent.outputLog.push(
    truncateUtf8Tail(`${marker} │ ${lastLine}`, AGENT_BUFFER_LIMITS.logLineBytes),
  );
  trimAgentBuffers(agent);
}

export function buildWorkspaceOwnerState(
  state: TeammateState,
  sessionName?: string,
  contextPressure?: number,
  backgroundJobs?: readonly WorkspaceBackgroundJobSnapshot[],
): WorkspaceOwnerState {
  const agents: WorkspaceAgentSnapshot[] = [];
  const settledById = new Map<string, WorkspaceSettledSnapshot>();
  for (const agent of state.activeRuns.values()) {
    const summary = agent.lastResult?.split("\n", 1)[0]
      ?? [...agent.outputLog].reverse().find((line) => typeof line === "string" && line.trim().length > 0);
    if (agent.status === "completed" || agent.status === "failed" || agent.status === "terminated") {
      settledById.set(agent.correlationId, {
        correlationId: agent.correlationId,
        ...(agent.name ? { name: agent.name } : {}),
        agent: agent.agent,
        status: agent.status,
        settledAt: agent.failedAt ?? agent.sleptAt ?? agent.lastActivityAt,
        ...(summary ? { summary: truncateUtf8Tail(summary, 8_192) } : {}),
      });
      continue;
    }
    agents.push({
      correlationId: agent.correlationId,
      ...(agent.name ? { name: agent.name } : {}),
      agent: agent.agent,
      status: projectAgentActivity(agent),
      ...(agent.phase ? { phase: agent.phase } : {}),
      ...(agent.lastOutcome ? { lastOutcome: { ...agent.lastOutcome } } : {}),
      startedAt: agent.startedAt,
      lastActivityAt: agent.lastActivityAt,
      ...(agent.resultReadyAt === undefined ? {} : { resultReadyAt: agent.resultReadyAt }),
      ...(summary ? { summary: truncateUtf8Tail(summary, 8_192) } : {}),
      ...(agent.inbox[0]?.payload ? { objective: truncateUtf8Tail(agent.inbox[0].payload, 8_192) } : {}),
      outputTail: agent.outputLog.slice(-20).map((line) => truncateUtf8Tail(line, 8_192)),
      pendingInteractions: agent.pendingInteractions?.size ?? 0,
      depth: agent.depth,
      ...(agent.spawnedBy ? { parentCorrelationId: agent.spawnedBy } : {}),
      wakeable: projectAgentActivity(agent) === "sleeping",
    });
  }
  for (const record of state.recentlySettled?.values() ?? []) {
    if (agents.some((agent) => agent.correlationId === record.correlationId)) continue;
    settledById.set(record.correlationId, {
      correlationId: record.correlationId,
      ...(record.name ? { name: record.name } : {}),
      agent: record.agent,
      status: record.status,
      settledAt: record.settledAt,
      ...(record.lastResult ? { summary: truncateUtf8Tail(record.lastResult.split("\n", 1)[0], 8_192) } : {}),
    });
  }
  return {
    agents,
    settled: [...settledById.values()],
    ...(backgroundJobs === undefined ? {} : { backgroundJobs: [...backgroundJobs] }),
    ...(state.currentSessionId ? { sessionId: state.currentSessionId } : {}),
    ...(sessionName ? { sessionName } : {}),
    ...(contextPressure !== undefined && Number.isFinite(contextPressure) ? { contextPressure: Math.max(0, Math.min(100, Math.round(contextPressure))) } : {}),
  };
}

/** Compatibility vocabulary for legacy internal status checks. */
export const LIVE_AGENT_STATUSES: ReadonlySet<AgentStatus> = new Set<AgentStatus>([
  "pending",
  "running",
  "retrying",
  "sleeping",
]);

/** Resource admission is independent of the externally projected activity. */
export function agentHoldsRuntimeSlot(agent: ActiveAgent): boolean {
  const ownsChildProcess = agent.ownsChildProcess ?? agent.progress === undefined;
  if (!ownsChildProcess) return false;
  if (agent.restartPending || agent.stdin?.writable) return true;
  return agent.status === "pending" || agent.status === "running" || agent.status === "retrying";
}

/**
 * Bounds the whole dispatch tree, not a single call. `maxAgents` caps one
 * dispatch's task count, so nesting multiplies rather than adds: without this
 * gate a depth-3 tree of 15-task graphs reaches 15^3 child processes.
 */
export function checkActiveAgentBudget(
  state: TeammateState,
  additional = 1,
): { allowed: boolean; active: number; max: number } {
  let active = 0;
  for (const agent of state.activeRuns.values()) {
    if (agentHoldsRuntimeSlot(agent)) active += 1;
  }
  const max = resolveMaxActiveAgents();
  return { allowed: active + additional <= max, active, max };
}

/**
 * Whether a log is provably within every limit, using a byte upper bound rather
 * than encoding. False means "trim to be sure", never "definitely over".
 */
export function logNeedsNoTrim(lines: readonly string[], lineLimit: number): boolean {
  if (lines.length > lineLimit) return false;
  let upperBound = 0;
  for (const line of lines) {
    if (typeof line !== "string") return false;
    const lineUpperBound = line.length * 3;
    if (lineUpperBound > AGENT_BUFFER_LIMITS.logLineBytes) return false;
    upperBound += lineUpperBound;
    if (upperBound > AGENT_BUFFER_LIMITS.logBytes) return false;
  }
  return true;
}

export function trimAgentBuffers(agent: ActiveAgent, sleeping = false): void {
  const inboxLimit = sleeping
    ? AGENT_BUFFER_LIMITS.sleepingInboxItems
    : AGENT_BUFFER_LIMITS.inboxItems;
  let inboxBytes = 0;
  const retainedInbox: MessageEnvelope[] = [];
  for (let index = agent.inbox.length - 1; index >= 0 && retainedInbox.length < inboxLimit; index -= 1) {
    const message = agent.inbox[index];
    const payload = truncateUtf8Tail(message.payload, AGENT_BUFFER_LIMITS.inboxBytes);
    const payloadBytes = Buffer.byteLength(payload, "utf8");
    if (retainedInbox.length > 0 && inboxBytes + payloadBytes > AGENT_BUFFER_LIMITS.inboxBytes) break;
    retainedInbox.push({ ...message, payload });
    inboxBytes += payloadBytes;
  }
  agent.inbox = retainedInbox.reverse();

  const lineLimit = sleeping
    ? AGENT_BUFFER_LIMITS.sleepingLogLines
    : AGENT_BUFFER_LIMITS.logLines;
  // This runs on every progress flush, and almost every call has nothing to
  // trim — yet it rebuilt the array and re-encoded every retained line to find
  // that out. A UTF-16 unit encodes to at most 3 UTF-8 bytes, so `length * 3`
  // is a sound upper bound that costs O(1) per line instead of a full scan.
  if (logNeedsNoTrim(agent.outputLog, lineLimit)) {
    if (agent.lastResult !== undefined) {
      agent.lastResult = truncateUtf8Tail(agent.lastResult, AGENT_BUFFER_LIMITS.lastResultBytes);
    }
    return;
  }
  let logBytes = 0;
  const retainedLog: string[] = [];
  for (let index = agent.outputLog.length - 1; index >= 0 && retainedLog.length < lineLimit; index -= 1) {
    const existingLine = agent.outputLog[index];
    if (typeof existingLine !== "string") continue;
    const line = truncateUtf8Tail(existingLine, AGENT_BUFFER_LIMITS.logLineBytes);
    const lineBytes = Buffer.byteLength(line, "utf8");
    if (retainedLog.length > 0 && logBytes + lineBytes > AGENT_BUFFER_LIMITS.logBytes) break;
    retainedLog.push(line);
    logBytes += lineBytes;
  }
  agent.outputLog = retainedLog.reverse();
  if (agent.lastResult !== undefined) {
    agent.lastResult = truncateUtf8Tail(agent.lastResult, AGENT_BUFFER_LIMITS.lastResultBytes);
  }
}

export function retainBoundedAgentHistory(agent: ActiveAgent, sleeping = false): void {
  trimAgentBuffers(agent, sleeping);
}

export interface ProgressFlushGate {
  mark(terminal?: boolean): void;
  flush(): void;
  dispose(): void;
}

export function createProgressFlushGate(
  onFlush: () => void,
  intervalMs = 300,
): ProgressFlushGate {
  let dirty = false;
  let lastFlushAt = Number.NEGATIVE_INFINITY;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const cancelTimer = () => {
    if (timer) clearTimeout(timer);
    timer = undefined;
  };
  const flush = () => {
    cancelTimer();
    if (!dirty) return;
    dirty = false;
    lastFlushAt = Date.now();
    onFlush();
  };
  const mark = (terminal = false) => {
    dirty = true;
    if (terminal || Date.now() - lastFlushAt >= intervalMs) {
      flush();
      return;
    }
    if (!timer) {
      timer = setTimeout(flush, Math.max(0, intervalMs - (Date.now() - lastFlushAt)));
      timer.unref?.();
    }
  };
  return { mark, flush, dispose: cancelTimer };
}

export function flushProgressBatch<T>(
  pending: Map<number, T>,
  latest: T | undefined,
  apply: (value: T) => void,
  publish: (latestValue: T) => void,
): void {
  if (!latest || pending.size === 0) return;
  const values = [...pending.values()];
  pending.clear();
  for (const value of values) apply(value);
  publish(latest);
}

export async function runWithProgressFlushCleanup<T>(
  run: () => Promise<T>,
  gate: ProgressFlushGate | undefined,
): Promise<T> {
  try {
    return await run();
  } finally {
    gate?.flush();
    gate?.dispose();
  }
}

export interface AgentWidgetTheme {
  fg(name: string, text: string): string;
  bold(text: string): string;
}

export async function switchConversationSession(
  ctx: Pick<ExtensionCommandContext, "switchSession">,
  sessionFile: string,
  onSwitched: (ctx: ExtensionCommandContext) => Promise<void> | void,
): Promise<void> {
  let switched = false;
  const result = await ctx.switchSession(sessionFile, {
    withSession: async (sessionCtx) => {
      switched = true;
      await onSwitched(sessionCtx as ExtensionCommandContext);
    },
  });
  if (result.cancelled || !switched) {
    throw new Error("Teammate session switch was cancelled before replacement completed.");
  }
}

export interface AgentWidgetRow {
  correlationId: string;
  parentCorrelationId?: string;
  label: string;
  agent: string;
  status: AgentProgressSnapshot["status"] | "sleeping";
  phase?: AgentRunPhase;
  action: string;
  direction: "↑" | "↓";
  toolCount: number;
  tokens: number;
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  startedAt: number;
  durationMs: number;
  lastActivityAt: number;
  resultReadyAt?: number;
  pendingInteractions: number;
  parentLabel?: string;
  resultLabels?: string[];
}

export interface AgentSelectorRow {
  correlationId: string;
  agent: string;
  name?: string;
  label: string;
  parentLabel?: string;
  status: ActiveAgent["status"];
  startedAt: number;
  depth: number;
  treePrefix: string;
  recentTools: Array<{ name: string; status: string }>;
  lastMessage?: string;
}

/** Walks `spawnedBy` to the top of an agent's dispatch tree. */
export function rootDispatchAncestor(state: TeammateState, correlationId: string): string {
  const seen = new Set<string>();
  let cursor = correlationId;
  while (!seen.has(cursor)) {
    seen.add(cursor);
    const parent = state.activeRuns.get(cursor)?.spawnedBy;
    if (!parent || parent === cursor) break;
    cursor = parent;
  }
  return cursor;
}

/**
 * Decides whether a proxied `teammate-send` may act on `targetCid`.
 *
 * A nested agent could name any agent in the process and act on it — including
 * `abort`, which terminates the target's whole subtree. Nothing checked that
 * the two were related, so a depth-2 worker could tear down an unrelated
 * dispatch tree it had no business knowing about.
 *
 * The split is by blast radius. Messaging stays open within the requester's own
 * dispatch tree, because peer coordination between siblings is the normal
 * pattern. Terminating is limited to the requester's own descendants: an agent
 * may dismantle what it built, not what built it or what runs beside it.
 */
export function canProxySendTo(
  state: TeammateState,
  requesterCid: string | undefined,
  targetCid: string,
  mode: RpcMessageMode,
): { allowed: boolean; reason?: string } {
  // No requester means the root tool itself, driven by the user's own model.
  if (!requesterCid) return { allowed: true };
  if (requesterCid === targetCid) return { allowed: true };

  if (mode === "abort") {
    if (isAgentDescendantOf(state, targetCid, requesterCid)) return { allowed: true };
    return {
      allowed: false,
      reason: "only agents you dispatched may be aborted; this one is not in your subtree",
    };
  }

  if (rootDispatchAncestor(state, requesterCid) === rootDispatchAncestor(state, targetCid)) {
    return { allowed: true };
  }
  return {
    allowed: false,
    reason: "that agent belongs to a different dispatch tree",
  };
}

/** Walks `spawnedBy` links up from `descendant`, looking for `ancestor`. */
export function isAgentDescendantOf(
  state: TeammateState,
  descendant: string,
  ancestor: string,
): boolean {
  const seen = new Set<string>();
  let cursor: string | undefined = descendant;
  while (cursor && !seen.has(cursor)) {
    if (cursor === ancestor) return true;
    seen.add(cursor);
    cursor = state.activeRuns.get(cursor)?.spawnedBy;
  }
  return false;
}

/**
 * Resolves which agent a proxied request belongs to.
 *
 * A child may legitimately name an id other than the one this process bound to
 * its transport: a graph runs several task children behind a single request
 * handler, so `event.correlationId` is how they tell each other apart. But the
 * id arrives over the wire from the child, and taking it on faith let a child
 * re-parent itself onto any agent it could name — including a shallower one,
 * which resets the depth its own dispatches are measured against and reopens
 * unbounded nesting. So a claim is honoured only when it resolves to an agent
 * inside the spawner's own subtree; otherwise the request is attributed to the
 * spawner this process actually launched.
 */
export function resolveProxyParentCorrelationId(
  event: Record<string, unknown>,
  spawnedBy?: string,
  state?: TeammateState,
): string | undefined {
  const claimed = typeof event.parentCid === "string" ? event.parentCid
    : typeof event.correlationId === "string" ? event.correlationId
      : undefined;
  if (!claimed) return spawnedBy;
  if (!spawnedBy) return claimed;
  if (claimed === spawnedBy) return spawnedBy;
  if (state && isAgentDescendantOf(state, claimed, spawnedBy)) return claimed;
  return spawnedBy;
}

export function selectorAgentLabel(agent: ActiveAgent): string {
  if (agent.name) return agent.name;
  const kind = agent.agent.startsWith("graph(") ? "graph" : "unnamed";
  return `${kind}#${agent.correlationId.slice(0, 8)}`;
}

export function emitTeammateStarted(
  pi: ExtensionAPI,
  agent: ActiveAgent,
  extra: Record<string, unknown> = {},
): void {
  pi.events.emit(TEAMMATE_STARTED_EVENT, {
    ...extra,
    correlationId: agent.correlationId,
    agent: agent.agent,
    name: agent.name,
    spawnedBy: agent.spawnedBy,
    startedAt: agent.startedAt,
    lastActivityAt: agent.lastActivityAt,
    // F-003: emit the full lifecycle status for backward compatibility and
    // the two-state activity projection as an additive field.
    status: agent.status,
    activity: projectAgentActivity(agent),
    ...(agent.phase ? { phase: agent.phase } : {}),
    ...(agent.lastOutcome ? { lastOutcome: { ...agent.lastOutcome } } : {}),
    ...(agent.todos && agent.todos.length > 0 ? { todos: [...agent.todos], todo: agent.todos[0] } : {}),
  });
}

// ---------------------------------------------------------------------------
// Cockpit agent commands (interrupt / steer)
// ---------------------------------------------------------------------------

/**
 * Canned notice injected when the user interrupts an agent from the cockpit
 * agent list: the current turn/tool is aborted and the agent is told to report
 * and continue, keeping the agent alive (unlike teammate-send's abort mode,
 * which terminates the whole tree).
 */
export const TEAMMATE_INTERRUPT_NOTICE =
  "[user interrupt] Stop the current operation immediately, briefly report what you were doing, and continue your task.";

export interface TeammateAgentCommandPayload {
  correlationId: string;
  action: "interrupt" | "steer";
  message?: string;
}

/** The only bus surface this function consumes — a test harness needs no full EventBus. */
export interface AgentCommandEventSink {
  events: {
    emit: (channel: string, data: unknown) => void;
  };
}

/**
 * Handle a cockpit agent-list command (TEAMMATE_AGENT_COMMAND_EVENT). Both
 * actions route through the steer RPC (Pi abort → prompt): `interrupt` injects
 * the canned notice, `steer` injects the user's message. A stalled agent stuck
 * in a tool is woken by the abort; sleeping agents are woken by the delivery.
 * Failures surface as an isSend message event so consumers never mistake the
 * send for agent progress.
 */
export async function applyTeammateAgentCommand(
  state: TeammateState,
  pi: AgentCommandEventSink,
  deliver: (correlationId: string, label: string, message: string) =>
    Promise<{ delivered: boolean; error?: string }> | { delivered: boolean; error?: string },
  payload: unknown,
): Promise<void> {
  if (!payload || typeof payload !== "object") return;
  const command = payload as Partial<TeammateAgentCommandPayload>;
  const correlationId = command.correlationId;
  if (typeof correlationId !== "string") return;
  // Reject unknown/typo'd actions with no side effects: a stray "abort" must
  // never degrade into a real abort→prompt on the agent.
  if (command.action !== "interrupt" && command.action !== "steer") return;
  const action = command.action;
  const message = typeof command.message === "string" ? command.message : "";
  const agent = state.activeRuns.get(correlationId);
  const label = agent?.name ?? correlationId.slice(0, 8);
  const emitFeedback = (text: string, isError: boolean): void => {
    pi.events.emit(TEAMMATE_MESSAGE_EVENT, {
      correlationId,
      from: "cockpit",
      to: label,
      mode: action,
      message: text,
      lastActivityAt: Date.now(),
      isSend: true,
      ...(isError ? { sendError: true } : {}),
    });
  };
  if (!agent || !LIVE_AGENT_STATUSES.has(agent.status)) {
    emitFeedback(`Agent "${label}" is not running and cannot receive commands.`, true);
    return;
  }
  if (action === "steer" && !message.trim()) {
    emitFeedback("Steering requires a message.", true);
    return;
  }
  const effective = action === "interrupt" ? TEAMMATE_INTERRUPT_NOTICE : message;
  const delivery = await deliver(correlationId, label, effective);
  if (!delivery.delivered) {
    emitFeedback(delivery.error ?? `Failed to ${action} agent "${label}".`, true);
  }
}

/** Reactivate a wakeable child and republish it to lifecycle-only consumers. */
export function wakeSleepingAgent(
  pi: ExtensionAPI,
  agent: ActiveAgent,
  now = Date.now(),
): boolean {
  if (agent.status !== "sleeping") return false;
  agent.status = "running";
  agent.phase = agent.stdin?.writable ? "prompting" : "restoring";
  if (agent.sleptAt) {
    agent.sleepMs += now - agent.sleptAt;
    agent.sleptAt = undefined;
  }
  agent.lastActivityAt = now;
  emitTeammateStarted(pi, agent);
  return true;
}

export function buildAgentSelectorRows(agents: ActiveAgent[]): AgentSelectorRow[] {
  const visible = agents.filter((agent) => agent.status !== "completed");
  const byId = new Map(visible.map((agent) => [agent.correlationId, agent]));
  const progressById = new Map<string, AgentProgressSnapshot>();
  for (const agent of visible) {
    for (const progress of agent.progress ?? []) {
      progressById.set(progress.correlationId, progress);
    }
  }

  const childrenByParent = new Map<string, ActiveAgent[]>();
  for (const agent of visible) {
    if (!agent.spawnedBy || !byId.has(agent.spawnedBy)) continue;
    const children = childrenByParent.get(agent.spawnedBy) ?? [];
    children.push(agent);
    childrenByParent.set(agent.spawnedBy, children);
  }

  const rows: AgentSelectorRow[] = [];
  const visited = new Set<string>();
  const append = (agent: ActiveAgent, depth: number, prefix: string, isLast: boolean): void => {
    if (visited.has(agent.correlationId)) return;
    visited.add(agent.correlationId);
    const progress = progressById.get(agent.correlationId)
      ?? agent.progress?.find((item) => item.correlationId === agent.correlationId);
    const parent = agent.spawnedBy ? byId.get(agent.spawnedBy) : undefined;
    const logTail = agent.outputLog.at(-1);
    const lastMessage = progress?.lastMessage ?? agent.lastResult ?? logTail;
    rows.push({
      correlationId: agent.correlationId,
      agent: agent.agent,
      ...(agent.name ? { name: agent.name } : {}),
      label: selectorAgentLabel(agent),
      ...(parent ? { parentLabel: selectorAgentLabel(parent) } : {}),
      status: agent.status,
      startedAt: agent.startedAt,
      depth,
      treePrefix: depth === 0 ? "" : `${prefix}${isLast ? "└─ " : "├─ "}`,
      recentTools: progress?.recentTools ?? [],
      ...(lastMessage ? { lastMessage } : {}),
    });

    const children = childrenByParent.get(agent.correlationId) ?? [];
    const childPrefix = depth === 0 ? "" : `${prefix}${isLast ? "   " : "│  "}`;
    children.forEach((child, index) => append(child, depth + 1, childPrefix, index === children.length - 1));
  };

  const roots = visible.filter((agent) => !agent.spawnedBy || !byId.has(agent.spawnedBy));
  roots.forEach((root, index) => append(root, 0, "", index === roots.length - 1));
  // Rescue pass: an agent can be unreachable from every root if its spawnedBy
  // links form a cycle. `visited` makes this a no-op for everything the tree
  // walk already emitted, so it only surfaces what would otherwise vanish.
  visible.forEach((agent, index) => append(agent, 0, "", index === visible.length - 1));
  return rows;
}

/**
 * Rows for completed teammate sessions recovered from disk after a restart.
 * The selector merges these below the live-agent rows; selecting one opens the
 * attach overlay in transcript mode (read-only).
 */
export function buildHistoryRows(
  scans: WorkspaceSessionScan[],
): AgentSelectorRow[] {
  return scans.map((scan) => ({
    correlationId: historyRowKey(scan),
    agent: "teammate",
    label: historyLabel(scan),
    status: "completed",
    startedAt: scan.startedAt ?? 0,
    depth: 0,
    treePrefix: "",
    recentTools: [],
    ...(scan.firstMessage ? { lastMessage: scan.firstMessage } : {}),
  }));
}

/**
 * Stable selector key for a history row, derived from the session file path —
 * position-based keys would drift when the scan order changes across rebuilds.
 */
export function historyRowKey(scan: WorkspaceSessionScan): string {
  const digest = createHash("sha256")
    .update(scan.sessionFile)
    .digest("hex")
    .slice(0, 8);
  return `hist-${digest}`;
}

export function historyLabel(scan: WorkspaceSessionScan): string {
  const id = scan.sessionId?.slice(0, 8) ?? "session";
  const count = scan.messageCount > 0 ? ` · ${scan.messageCount} msgs` : "";
  return `history ${id}${count}`;
}

export function renderAgentSelectorPanel(
  rows: AgentSelectorRow[],
  cursor: number,
  query: string,
  width: number,
): string[] {
  const dim = (value: string) => `\x1b[2m${value}\x1b[22m`;
  const bold = (value: string) => `\x1b[1m${value}\x1b[22m`;
  const green = (value: string) => `\x1b[32m${value}\x1b[39m`;
  const yellow = (value: string) => `\x1b[33m${value}\x1b[39m`;
  const red = (value: string) => `\x1b[31m${value}\x1b[39m`;
  const w = Math.max(1, Math.min(width, 60));
  const selectedIndex = Math.max(0, Math.min(cursor, Math.max(0, rows.length - 1)));
  const selected = rows[selectedIndex];
  const statusView = (row: AgentSelectorRow): { icon: string; text: string } => {
    if (row.status === "sleeping") return { icon: yellow("◉"), text: yellow("Sleeping") };
    if (row.status === "failed") return { icon: red("◉"), text: red("Sleeping · last run failed") };
    if (row.status === "pending") return { icon: dim("■"), text: dim("Running · starting") };
    if (row.status === "retrying") return { icon: yellow("■"), text: yellow("Running · retrying") };
    // History rows are completed sessions — never render as runnable.
    if (row.status === "completed" || row.status === "terminated") {
      return { icon: dim("✓"), text: dim("Done") };
    }
    return { icon: green("■"), text: green("Running") };
  };

  if (w < 20) {
    if (!selected) return [truncateToWidth(`${dim("□")} no matches`, w, "…")];
    const status = statusView(selected);
    return [truncateToWidth(
      `Esc · ${status.icon} ${selected.agent}/${selected.label} ${dim(selected.status)}`,
      w,
      "…",
    )];
  }

  const inner = w - 2;
  const out: string[] = [];
  const frameLine = (content: string) =>
    dim("│") + truncateToWidth(` ${content}`, inner, "…", true) + dim("│");
  const maxVisible = 8;
  const start = Math.max(0, Math.min(
    Math.max(0, rows.length - maxVisible),
    selectedIndex - Math.floor(maxVisible / 2),
  ));
  const visibleRows = rows.slice(start, start + maxVisible);
  const range = rows.length > maxVisible
    ? dim(` ${start + 1}-${start + visibleRows.length}/${rows.length}`)
    : "";
  const nestedCount = rows.filter((row) => row.depth > 0).length;
  const scope = w >= 46 && rows.length > 0
    ? dim(` · ${rows.length - nestedCount} root · ${nestedCount} nested`)
    : "";

  out.push(dim("╭" + "─".repeat(inner) + "╮"));
  out.push(frameLine(`${green("❯")} ${query}${dim("│")}${range}${scope}`));
  out.push(dim("├" + "─".repeat(inner) + "┤"));

  for (let index = 0; index < visibleRows.length; index++) {
    const absoluteIndex = start + index;
    const row = visibleRows[index];
    const status = statusView(row);
    const up = Math.round((Date.now() - row.startedAt) / 1000);
    const selection = absoluteIndex === selectedIndex ? green("▸") : " ";
    out.push(frameLine(
      `${selection} ${status.icon} ${bold(`${row.treePrefix}${row.agent}/${row.label}`)} ${status.text} ${dim(`${up}s`)}`,
    ));
  }
  if (rows.length === 0) out.push(frameLine(dim("□ no matches · Backspace clears the filter")));

  if (selected) {
    out.push(dim("├" + "─".repeat(inner) + "┤"));
    const lineage = selected.parentLabel ? `child of ${selected.parentLabel}` : "root run";
    out.push(frameLine(`${green("»")} ${bold(`${selected.agent}/${selected.label}`)} ${dim(lineage)}`));
    const recentTool = selected.recentTools.find((tool) => tool.status === "running")
      ?? selected.recentTools.at(-1);
    if (recentTool) {
      const toolIcon = recentTool.status === "running" ? yellow("■") : recentTool.status === "failed" ? red("✗") : dim("✓");
      out.push(frameLine(`${dim("Tool")} ${toolIcon} ${sanitizeSingleLineInput(recentTool.name)}`));
    } else {
      out.push(frameLine(`${dim("Tool")} ${dim("idle")}`));
    }
    const message = selected.lastMessage
      ? sanitizeSingleLineInput(selected.lastMessage.split(/\r?\n/).filter((line) => line.trim()).at(-1) ?? "")
      : "";
    out.push(frameLine(`${dim("│")} ${message || (selected.status === "pending" ? "Waiting for dependencies…" : "Waiting for output…")}`));
  }

  out.push(dim("╰" + "─".repeat(inner) + "╯"));
  const footer = w < 46
    ? " Esc cancel · Enter view · ↑↓ select"
    : " Esc cancel · Enter view · ↑↓ select · PgUp/PgDn page · type to filter";
  out.push(truncateToWidth(dim(footer), w, "…"));
  return out;
}

export function compactMetric(value: number): string {
  if (value < 1000) return String(value);
  if (value < 1_000_000) return `${(value / 1000).toFixed(value < 100_000 ? 1 : 0)}k`;
  return `${(value / 1_000_000).toFixed(1)}m`;
}

export function toolAction(name: string): string {
  const normalized = name.toLowerCase();
  if (normalized === "write" || normalized === "edit" || normalized.includes("patch")) return "writing file";
  if (normalized === "read" || normalized === "grep" || normalized === "ls") return "reading files";
  if (normalized === "bash" || normalized.includes("command")) return "running command";
  return `using ${name}`;
}

export function formatRetryDelay(delayMs: number): string {
  const seconds = Math.max(0, Math.ceil(delayMs / 1_000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  return remainder === 0 ? `${minutes}m` : `${minutes}m ${remainder}s`;
}

export function agentWidgetRows(agents: ActiveAgent[]): AgentWidgetRow[] {
  const rows = new Map<string, AgentWidgetRow>();
  const directAgents = new Map(agents.map((agent) => [agent.correlationId, agent]));
  const labelFor = (agent: ActiveAgent): string => agent.name ?? agent.agent;
  for (const active of agents) {
    const snapshots = active.progress ?? [];
    const effective = snapshots.length > 1 ? snapshots : [snapshots[0]];
    const snapshotByIndex = new Map(snapshots.map((snapshot) => [snapshot.taskIndex, snapshot]));
    for (const progress of effective) {
      const correlationId = progress?.correlationId ?? active.correlationId;
      const direct = directAgents.get(correlationId);
      const parent = direct?.spawnedBy ? directAgents.get(direct.spawnedBy) : undefined;
      const resultLabels = progress?.dependencies
        .map((dependency) => snapshotByIndex.get(dependency))
        .filter((dependency): dependency is AgentProgressSnapshot => dependency !== undefined)
        .map((dependency) => dependency.name ?? `task ${dependency.taskIndex + 1}`);
      const runningTool = progress?.recentTools?.find((tool) => tool.status === "running");
      const progressStatus = progress?.status;
      // Settled lifecycle state outranks the progress snapshot: dispatch paths
      // keep lifecycle-pending tasks "running" for the admission gate and never
      // rewrite the snapshot back once the lifecycle confirms. A settled direct
      // record (or a completed container after the child record was pruned) is
      // the authoritative terminal state; the snapshot only leads while live.
      const directStatus = direct?.status;
      const pendingInteractions = direct?.pendingInteractions?.size ?? 0;
      const status = directStatus === "sleeping" || (!direct && active.status === "sleeping")
        ? "sleeping"
        : directStatus === "completed" || directStatus === "failed" || directStatus === "terminated"
          ? directStatus
          : !direct && active.status === "completed"
            ? active.status
            : direct && LIVE_AGENT_STATUSES.has(direct.status) && progressStatus === "completed"
              ? direct.status
              : progressStatus ?? directStatus ?? active.status;
      const action = runningTool
        ? toolAction(runningTool.name)
        : pendingInteractions > 0
          ? `awaiting ${pendingInteractions} prompt${pendingInteractions === 1 ? "" : "s"}`
        : status === "running" && (progress?.resultReadyAt ?? direct?.resultReadyAt) !== undefined
          ? "result returned; lifecycle pending"
        : status === "sleeping"
          ? "sleeping"
          : status === "retrying"
            ? direct?.retry
              ? `retry ${direct.retry.attempt}/${direct.retry.maxRetries} in ${formatRetryDelay(
                direct.retry.nextRetryAt - Date.now(),
              )}`
              : "retrying"
          : status === "pending"
            ? "waiting for dependencies"
            : status === "failed"
              ? "failed"
              : status === "terminated"
                ? "terminated"
              : status === "completed"
                ? "completed"
                : progress?.lastMessage
                  ? "streaming"
                  : "waiting for model";
      const existing = rows.get(correlationId);
      if (!progress && existing) {
        rows.set(correlationId, {
          ...existing,
          label: direct?.name ?? existing.label,
          agent: direct?.agent ?? existing.agent,
          status,
          phase: direct?.phase ?? active.phase,
          pendingInteractions,
          action: status === "sleeping"
            ? "sleeping"
            : pendingInteractions > 0
              ? `awaiting ${pendingInteractions} prompt${pendingInteractions === 1 ? "" : "s"}`
              : existing.action,
          startedAt: direct?.startedAt ?? existing.startedAt,
          ...(direct?.spawnedBy ? { parentCorrelationId: direct.spawnedBy } : {}),
          ...(parent ? { parentLabel: labelFor(parent) } : {}),
        });
        continue;
      }
      rows.set(correlationId, {
        correlationId,
        ...(direct?.spawnedBy ? { parentCorrelationId: direct.spawnedBy } : {}),
        label: progress?.name ?? direct?.name ?? active.name ?? correlationId.slice(0, 8),
        agent: progress?.agent ?? direct?.agent ?? active.agent,
        status,
        phase: progress?.phase ?? direct?.phase ?? active.phase,
        action,
        direction: runningTool ? "↓" : "↑",
        toolCount: progress?.toolCount ?? 0,
        tokens: progress?.tokens ?? 0,
        inputTokens: progress?.inputTokens,
        outputTokens: progress?.outputTokens,
        cacheReadTokens: progress?.cacheReadTokens,
        cacheWriteTokens: progress?.cacheWriteTokens,
        startedAt: direct?.startedAt
          ?? (progress?.startedAt ? new Date(progress.startedAt).getTime() : active.startedAt),
        durationMs: direct
          ? agentActiveMs(direct)
          : progress?.completedAt
            ? progressDurationMs(progress, active)
            : status === "sleeping"
              ? agentActiveMs(active)
              : progress
                ? Math.max(progress.durationMs ?? 0, progressDurationMs(progress, active))
                : agentActiveMs(active),
        lastActivityAt: progress?.lastActivityAt ?? direct?.lastActivityAt ?? active.lastActivityAt,
        pendingInteractions,
        ...(status === "running" && (progress?.resultReadyAt ?? direct?.resultReadyAt)
          ? { resultReadyAt: progress?.resultReadyAt ?? direct?.resultReadyAt }
          : {}),
        ...(parent ? { parentLabel: labelFor(parent) } : {}),
        ...(resultLabels?.length ? { resultLabels } : {}),
      });
    }
  }
  return [...rows.values()];
}

export function renderAgentStatusWidget(
  agents: ActiveAgent[],
  width: number,
  theme: AgentWidgetTheme,
): string[] {
  const safeWidth = Math.max(1, width);
  const activityOrder = (a: AgentWidgetRow, b: AgentWidgetRow): number =>
    b.lastActivityAt - a.lastActivityAt || a.correlationId.localeCompare(b.correlationId);
  const unorderedRows = agentWidgetRows(agents);
  const byId = new Map(unorderedRows.map((row) => [row.correlationId, row]));
  const children = new Map<string, AgentWidgetRow[]>();
  const roots: AgentWidgetRow[] = [];
  for (const row of unorderedRows) {
    const parentId = row.parentCorrelationId;
    if (!parentId || parentId === row.correlationId || !byId.has(parentId)) {
      roots.push(row);
      continue;
    }
    const siblings = children.get(parentId) ?? [];
    siblings.push(row);
    children.set(parentId, siblings);
  }
  roots.sort(activityOrder);
  for (const siblings of children.values()) siblings.sort(activityOrder);
  const rows: AgentWidgetRow[] = [];
  const visited = new Set<string>();
  const append = (row: AgentWidgetRow): void => {
    if (visited.has(row.correlationId)) return;
    visited.add(row.correlationId);
    rows.push(row);
    for (const child of children.get(row.correlationId) ?? []) append(child);
  };
  for (const root of roots) append(root);
  for (const row of [...unorderedRows].sort(activityOrder)) append(row);
  if (rows.length === 0) return [];

  const maxVisible = safeWidth < 20 ? 3 : safeWidth < 40 ? 4 : 6;
  const selected = new Set<string>();
  const liveEdge = rows.find((row) => LIVE_AGENT_STATUSES.has(row.status));
  if (liveEdge) selected.add(liveEdge.correlationId);
  for (const row of rows) {
    if (row.status === "failed" && selected.size < maxVisible) selected.add(row.correlationId);
  }
  for (const row of rows) {
    if (selected.size >= maxVisible) break;
    selected.add(row.correlationId);
  }
  const visible = rows.filter((row) => selected.has(row.correlationId));
  const hidden = rows.length - visible.length;
  const icon = (row: AgentWidgetRow): string => {
    if (row.status === "running") return theme.fg("success", "■");
    if (row.status === "retrying") return theme.fg("warning", "↻");
    if (row.status === "sleeping") return theme.fg("warning", "◉");
    if (row.status === "failed") return theme.fg("error", "✗");
    if (row.status === "terminated") return theme.fg("warning", "×");
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

  const runningCount = rows.filter((row) => row.status === "running").length;
  const retryingCount = rows.filter((row) => row.status === "retrying").length;
  const sleeping = rows.filter((row) => row.status === "sleeping").length;
  const pending = rows.filter((row) => row.status === "pending").length;
  const failedCount = rows.filter((row) => row.status === "failed").length;
  const terminatedCount = rows.filter((row) => row.status === "terminated").length;
  const summary = [
    runningCount ? `${runningCount} running` : "",
    retryingCount ? `${retryingCount} retrying` : "",
    sleeping ? `${sleeping} sleeping` : "",
    pending ? `${pending} pending` : "",
    failedCount ? `${failedCount} failed` : "",
    terminatedCount ? `${terminatedCount} terminated` : "",
  ].filter(Boolean).join(" · ");
  const lines = [truncateToWidth(
    `${theme.bold("Agents")}  ${theme.fg("dim", `${summary} · Alt+R`)}`,
    safeWidth,
    "…",
  )];
  for (let index = 0; index < visible.length; index++) {
    const row = visible[index];
    const connector = index === visible.length - 1 && hidden === 0 ? "└─" : "├─";
    const now = Date.now();
    const duration = `${Math.max(0, Math.floor(row.durationMs / 1000))}s`;
    const idleMs = Math.max(0, now - row.lastActivityAt);
    const stalled = isAgentStalled({
      status: row.status,
      phase: row.phase,
      resultReadyAt: row.resultReadyAt,
      lastActivityAt: row.lastActivityAt,
      pendingInteractions: row.pendingInteractions,
    }, now);
    const state = row.resultReadyAt !== undefined && row.status === "running"
      ? "result returned; lifecycle pending"
      : stalled
      ? `stalled ${Math.floor(idleMs / 1000)}s`
      : row.status === "running"
        ? `running · ${row.action}`
        : row.status === "retrying"
          ? `retrying · ${row.action}`
        : row.action;
    const tokenMetrics = row.inputTokens !== undefined || row.outputTokens !== undefined
      ? [
          `in ${compactMetric(row.inputTokens ?? 0)}`,
          `out ${compactMetric(row.outputTokens ?? 0)}`,
          ...((row.cacheReadTokens ?? 0) > 0 || (row.cacheWriteTokens ?? 0) > 0
            ? [`cache ${compactMetric(row.cacheReadTokens ?? 0)}r/${compactMetric(row.cacheWriteTokens ?? 0)}w`]
            : []),
        ]
      : row.tokens
        ? [`${row.direction} ${compactMetric(row.tokens)} tokens`]
        : [];
    const metrics = [
      duration,
      ...tokenMetrics,
      row.toolCount ? `${row.toolCount} tools` : "",
    ].filter(Boolean).join(" · ");
    const relationship = [
      row.parentLabel ? `child of @${row.parentLabel}` : "",
      row.resultLabels?.length
        ? `result from ${row.resultLabels.map((label) => `@${label}`).join(", ")}`
        : "",
    ].filter(Boolean).join(" · ");
    const relationshipText = relationship ? ` · ${relationship}` : "";
    const agentText = safeWidth < 40 ? "" : ` ${theme.fg("muted", row.agent)}`;
    const rowContent = safeWidth < 40
      ? `${theme.fg("accent", `@${row.label}`)} · ${state} · ${theme.fg("dim", duration)}`
      : `${theme.fg("accent", `@${row.label}`)}${agentText} · ${theme.fg("dim", metrics)} · ${state}${theme.fg("dim", relationshipText)}`;
    lines.push(truncateToWidth(
      `${theme.fg("dim", connector)} ${icon(row)} ${rowContent}`,
      safeWidth,
      "…",
    ));
  }
  if (hidden > 0) {
    lines.push(truncateToWidth(theme.fg("dim", `└─ … ${hidden} more · Alt+R to inspect`), safeWidth, "…"));
  }
  return lines;
}

export function handleChildLifecycleEvent(
  state: TeammateState,
  event: Record<string, unknown>,
): void {
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
    agent.lastParkNonce = pendingHandoff.nonce;
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
  const lease = agent.lease;
  const pendingCancel = agent.pendingCancel;
  if (event.type === "teammate_handoff_cancelled"
    && lease?.state === "fenced"
    && pendingCancel
    && pendingCancel?.nonce === event.nonce
    && pendingCancel.fencedEpoch === lease.epoch
  ) {
    agent.lease = recoverChild(lease);
    agent.sendControl?.({ type: "teammate_lease_update", token: leaseToken(agent.lease) });
    agent.pendingCancel = undefined;
  }
}

export function restoreMainOwnershipIfHandbackPending(
  agent: ActiveAgent,
): LeaseToken | undefined {
  const lease = agent.lease;
  const pending = agent.pendingHandback;
  if (!lease
    || !pending
    || lease.owner !== "none"
    || lease.state !== "reloading"
    || lease.epoch !== pending.epoch
    || lease.nonce !== pending.nonce
  ) return undefined;

  agent.lease = restoreMainOwnership(lease);
  agent.pendingHandback = undefined;
  return leaseToken(agent.lease);
}

export const CHILD_PROXY_TIMEOUT_MS = 30 * 60 * 1_000;

export interface PendingChildProxyRequest {
  resolve: (result: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
  signal?: AbortSignal;
  abortHandler?: () => void;
  cancelRoot?: (reason: "timeout" | "aborted") => void;
}

export type ChildProxyPendingRequests = Map<string, PendingChildProxyRequest>;

export function takeChildProxyRequest(
  pendingRequests: ChildProxyPendingRequests,
  requestId: string,
): PendingChildProxyRequest | undefined {
  const pending = pendingRequests.get(requestId);
  if (!pending) return undefined;
  pendingRequests.delete(requestId);
  clearTimeout(pending.timer);
  if (pending.signal && pending.abortHandler) {
    pending.signal.removeEventListener("abort", pending.abortHandler);
  }
  return pending;
}

export function childProxyAbortError(): Error {
  const error = new Error("Teammate proxy request aborted.");
  error.name = "AbortError";
  return error;
}

/** @internal Exported for lifecycle regression tests. */
export function resolveChildProxyRequest(
  pendingRequests: ChildProxyPendingRequests,
  requestId: string,
  result: unknown,
): boolean {
  const pending = takeChildProxyRequest(pendingRequests, requestId);
  if (!pending) return false;
  pending.resolve(result);
  return true;
}

/** @internal Exported for lifecycle regression tests. */
export function rejectChildProxyRequest(
  pendingRequests: ChildProxyPendingRequests,
  requestId: string,
  error: Error,
): boolean {
  const pending = takeChildProxyRequest(pendingRequests, requestId);
  if (!pending) return false;
  pending.reject(error);
  return true;
}

/** @internal Exported for lifecycle regression tests. */
export function rejectAllChildProxyRequests(
  pendingRequests: ChildProxyPendingRequests,
  error: Error,
): void {
  const pending = [...pendingRequests.values()];
  pendingRequests.clear();
  for (const request of pending) {
    request.cancelRoot?.("aborted");
    clearTimeout(request.timer);
    if (request.signal && request.abortHandler) {
      request.signal.removeEventListener("abort", request.abortHandler);
    }
    request.reject(error);
  }
}

/** @internal Exported for lifecycle regression tests. */
export type IpcSender = (
  message: Record<string, unknown>,
  callback: (error: Error | null) => void,
) => boolean;

/**
 * Builds the IPC sender the teammate proxy uses to talk to its parent.
 *
 * Node's IPC `send` reads `this.connected` internally, so detaching it from its
 * owner (`const send = proc.send`) leaves `this` undefined in module scope and
 * throws "Cannot read properties of undefined (reading 'connected')" on the
 * first call — which broke every proxied teammate tool in a nested child.
 * Binding the owner keeps the proxied call working. Returns undefined when no
 * live IPC channel exists.
 */
export function createIpcSender(
  // Node's IPC process.send is a loosely-typed boundary (message: any); any[]
  // is the signature both process.send and test fakes satisfy without casts.
  proc: { connected?: boolean; send?: (...args: any[]) => boolean } = process,
): IpcSender | undefined {
  const rawSend = proc.send;
  if (typeof rawSend !== "function" || proc.connected === false) return undefined;
  const send = rawSend.bind(proc);
  return (message, callback) => send(message, callback);
}

export function createChildProxyRequest(
  pendingRequests: ChildProxyPendingRequests,
  requestId: string,
  message: Record<string, unknown>,
  send: (message: Record<string, unknown>, callback: (error: Error | null) => void) => boolean,
  timeoutMs = CHILD_PROXY_TIMEOUT_MS,
  signal?: AbortSignal,
): Promise<unknown> {
  if (signal?.aborted) return Promise.reject(childProxyAbortError());
  return new Promise((resolve, reject) => {
    // Giving up locally is not enough: the root already created an agent for
    // this request and is running it. Without telling the root, that agent has
    // no consumer and no one left to settle it — an orphan that outlives the
    // child that asked for it. Best-effort; an older root simply ignores it.
    const notifyRootGaveUp = (reason: "timeout" | "aborted") => {
      try {
        send({ type: "teammate_proxy_cancel", requestId, reason }, () => {});
      } catch {
        // The channel is already gone, which is itself the cancellation.
      }
    };
    const timer = setTimeout(() => {
      notifyRootGaveUp("timeout");
      rejectChildProxyRequest(
        pendingRequests,
        requestId,
        new Error(`Teammate proxy request timed out after ${timeoutMs}ms.`),
      );
    }, timeoutMs);
    const abortHandler = signal
      ? () => {
        notifyRootGaveUp("aborted");
        rejectChildProxyRequest(pendingRequests, requestId, childProxyAbortError());
      }
      : undefined;
    pendingRequests.set(requestId, {
      resolve,
      reject,
      timer,
      signal,
      abortHandler,
      cancelRoot: notifyRootGaveUp,
    });
    if (signal && abortHandler) signal.addEventListener("abort", abortHandler, { once: true });
    if (signal?.aborted) abortHandler?.();
    if (!pendingRequests.has(requestId)) return;

    try {
      send(message, (error) => {
        if (error) rejectChildProxyRequest(pendingRequests, requestId, error);
      });
    } catch (error) {
      rejectChildProxyRequest(
        pendingRequests,
        requestId,
        error instanceof Error ? error : new Error(String(error)),
      );
    }
  });
}

