/**
 * Advisor extension entry — turn-level quality supervision for the main session.
 *
 * Registered as a separate pi extension entry (`package.json` `pi.extensions`),
 * so it never touches the main maestro extension's registration surface.
 *
 * Flow per `agent_end`:
 *   1. (skip when disabled or an evaluation is already in flight)
 *   2. serialize the transcript tail and dispatch a low-frequency second-model
 *      evaluation through the shared supervision evaluator (teammate routing)
 *   3. on concern/blocker, gate the delivery (cooldown / normalized dedupe /
 *      interrupt downgrade) and inject an `<advisory>` into the primary session
 *   4. publish a `SupervisionEvent` (source "advisor") for cockpit-style surfaces
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createDirectTeammateRunOptions } from "../tools/direct-teammate.ts";
import {
  advisorConfigPath,
  buildAdvisorPrompt,
  createAdvisorRuntimeState,
  DEFAULT_ADVISOR_CONFIG,
  deliverySeverityFor,
  formatAdvisory,
  normalizeAdvisorConfig,
  normalizeAdvisorVerdict,
  parseAdvisorVerdictText,
  resolveAdvisorModel,
  serializeToolCheckpoint,
  serializeTranscriptTail,
  ADVISOR_OUTPUT_SCHEMA,
  verdictDeliveryMode,
  type AdvisorConfig,
  type AdvisorRuntimeState,
  type AdvisorVerdict,
} from "./runtime.ts";

const ADVISOR_TARGET = "main-session";
const ADVISOR_CUSTOM_TYPE = "advisor";
const EVALUATION_DEADLINE_MS = 120_000;
const EVALUATION_TIMEOUT_MS = 60_000;
const GATE_DOWNGRADE_WINDOWS = 3;

// ---------------------------------------------------------------------------
// Lazy teammate loading (module-not-found degrades to "advisor unavailable")
// ---------------------------------------------------------------------------

interface SingleResultLike {
  agent: string;
  exitCode: number;
  messages: Array<{ role: string; content: string }>;
  model?: string;
  correlationId?: string;
  structuredOutput?: unknown;
  attemptedModels?: string[];
  terminalStatus?: string;
  lifecyclePending?: boolean;
}

interface RunTeammateParamsLike {
  tasks: Array<{
    agent?: string;
    prompt: string;
    taskType?: string;
    model?: string;
    fallbackModels?: string[];
    thinking?: "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
    timeoutMs?: number;
    outputSchema?: Record<string, unknown>;
  }>;
}
interface RunTeammateOptionsLike {
  baseCwd: string;
  signal?: AbortSignal;
  onChildRequest?: (event: Record<string, unknown>, reply: (message: unknown) => void) => void;
}
type RunTeammateFn = (params: RunTeammateParamsLike, options: RunTeammateOptionsLike) => Promise<SingleResultLike[] | SingleResultLike>;

interface DeliveryGateOptionsLike {
  cooldownMs?: number;
  dedup?: false | { capacity?: number; scope?: "global" | "target"; normalize?: (m: string) => string };
  phraseFilter?: readonly string[] | false;
  perWindowLimit?: number;
  downgradeAfter?: number;
}

interface DeliveryGateLike {
  gate(target: string, message: string, requested: "interrupt" | "batch" | "notify"): "interrupt" | "batch" | "notify" | undefined;
  beginWindow(): void;
  reset(): void;
}

interface SupervisionApi {
  runSupervisedEvaluation: <T>(
    dispatch: (ctx: { task: string; signal?: AbortSignal; timeoutMs?: number; outputSchema?: Record<string, unknown> }) => Promise<SingleResultLike>,
    params: {
      task: string;
      timeoutMs?: number;
      deadlineMs?: number;
      outputSchema?: Record<string, unknown>;
      fallbackTextParser?: (text: string) => unknown;
      beforeVerdict?: (result: SingleResultLike) => string | undefined;
      maxFailures?: number;
      signal?: AbortSignal;
    },
  ) => Promise<{ ok: boolean; verdict?: T; raw?: SingleResultLike; reason?: string }>;
  DeliveryGate: new (options?: DeliveryGateOptionsLike) => DeliveryGateLike;
  SUPERVISION_EVENT: string;
  createSupervisionEvent: (
    source: string,
    kind: string,
    severity: string,
    overrides: Record<string, unknown>,
  ) => Record<string, unknown>;
}

let _supervisionApi: SupervisionApi | undefined;
let _runTeammateFn: RunTeammateFn | undefined;
let _teammateResolved = false;

/** @internal Test seam for the Advisor's direct teammate runtime. */
export function setAdvisorTeammateRuntimeForTest(
  runtime: { supervision: SupervisionApi; runTeammate: RunTeammateFn } | undefined,
): void {
  _supervisionApi = runtime?.supervision;
  _runTeammateFn = runtime?.runTeammate;
  _teammateResolved = runtime !== undefined;
}

async function loadTeammate(): Promise<{ supervision: SupervisionApi; runTeammate: RunTeammateFn } | undefined> {
  if (_teammateResolved) {
    return _supervisionApi && _runTeammateFn ? { supervision: _supervisionApi, runTeammate: _runTeammateFn } : undefined;
  }
  try {
    const supervision = await import("pi-maestro-teammate/v1/supervision") as unknown as SupervisionApi;
    const execution = await import("pi-maestro-teammate/v1/execution") as unknown as { runTeammate: RunTeammateFn };
    _supervisionApi = supervision;
    _runTeammateFn = execution.runTeammate;
    _teammateResolved = true;
    return { supervision: supervision as SupervisionApi, runTeammate: execution.runTeammate };
  } catch (error) {
    if (!isModuleNotFound(error)) {
      // Real load failure — clear so a later turn can retry.
      _teammateResolved = false;
    } else {
      _teammateResolved = true;
    }
    return undefined;
  }
}

function isModuleNotFound(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const code = (error as NodeJS.ErrnoException).code;
  return code === "MODULE_NOT_FOUND" || code === "ERR_MODULE_NOT_FOUND"
    || /Cannot find module|Cannot find package/i.test(error.message);
}

function waitForDispatchOrAbort<T>(dispatch: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return dispatch;
  if (signal.aborted) {
    return Promise.reject(signal.reason instanceof Error ? signal.reason : new Error("Advisor evaluation aborted"));
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      reject(signal.reason instanceof Error ? signal.reason : new Error("Advisor evaluation aborted"));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    dispatch.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
  });
}

// ---------------------------------------------------------------------------
// Config persistence
// ---------------------------------------------------------------------------

async function loadConfig(cwd: string): Promise<AdvisorConfig> {
  try {
    const raw = JSON.parse(await readFile(advisorConfigPath(cwd), "utf8")) as Partial<AdvisorConfig> | undefined;
    return normalizeAdvisorConfig(raw);
  } catch {
    return { ...DEFAULT_ADVISOR_CONFIG };
  }
}

async function saveConfig(config: AdvisorConfig, cwd: string): Promise<void> {
  const path = advisorConfigPath(cwd);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(config, null, 2)}\n`, "utf8");
}

// ---------------------------------------------------------------------------
// Extension entry
// ---------------------------------------------------------------------------

export default function registerAdvisor(pi: ExtensionAPI): void {
  let config: AdvisorConfig = { ...DEFAULT_ADVISOR_CONFIG };
  const state: AdvisorRuntimeState = createAdvisorRuntimeState();
  let gate: DeliveryGateLike | undefined;
  let evaluationInFlight = false;
  let unavailableNotified = false;
  let lifecycleController = new AbortController();
  let configCwd: string | undefined;
  let configGeneration = 0;
  let configLoadPromise: Promise<void> | undefined;
  let toolResultsSinceEvaluation = 0;
  let toolCheckpoints: string[] = [];
  type EvaluationSource = "tool_result" | "agent_end";
  let pendingEvaluation: { tail: string; ctx: ExtensionContext; source: EvaluationSource } | undefined;

  function notifyUnavailable(ctx: ExtensionContext, reason: string): void {
    if (unavailableNotified) return;
    unavailableNotified = true;
    ctx.ui.notify(`Advisor unavailable: ${reason}`, "warning");
  }

  function resetAdvisorLifecycle(): void {
    lifecycleController.abort();
    lifecycleController = new AbortController();
    pendingEvaluation = undefined;
    toolResultsSinceEvaluation = 0;
    toolCheckpoints = [];
    gate?.reset();
    gate = undefined;
  }

  function loadWorkspaceConfig(ctx: ExtensionContext): void {
    resetAdvisorLifecycle();
    const generation = ++configGeneration;
    let cwd: string;
    try {
      // ctx.cwd asserts the extension context is still active; after a session
      // replacement (e.g. --no-session startup) the captured ctx is stale and
      // the getter throws. Skip this load — the next session_start re-runs it.
      cwd = ctx.cwd;
    } catch {
      return;
    }
    configCwd = cwd;
    config = { ...DEFAULT_ADVISOR_CONFIG };
    const load = loadConfig(cwd).then((loaded) => {
      if (generation !== configGeneration || configCwd !== cwd) return;
      config = loaded;
      if (config.enabled) pi.events?.emit?.("advisor:enabled", { enabled: true });
    }).finally(() => {
      if (configLoadPromise === load) configLoadPromise = undefined;
    });
    configLoadPromise = load;
  }

  async function ensureWorkspaceConfig(ctx: ExtensionContext): Promise<void> {
    if (configCwd !== ctx.cwd) loadWorkspaceConfig(ctx);
    await configLoadPromise;
  }

  function recordEvaluationFailure(reason: string): void {
    state.failures++;
    state.lastStatus = "failed";
    state.lastError = reason;
  }

  /** Evaluate one queued snapshot and inject only after a valid background result arrives. */
  async function runAdvisorEvaluation(
    item: { tail: string; ctx: ExtensionContext; source: EvaluationSource },
    signal: AbortSignal,
  ): Promise<void> {
    if (!config.enabled || signal.aborted) return;
    state.evaluations++;
    gate?.beginWindow();
    try {
      const loaded = await loadTeammate();
      if (!loaded) {
        state.lastEvaluatedAt = Date.now();
        recordEvaluationFailure("pi-maestro-teammate is not installed");
        notifyUnavailable(item.ctx, "pi-maestro-teammate is not installed");
        return;
      }
      const { supervision, runTeammate } = loaded;
      if (!gate) {
        gate = new supervision.DeliveryGate({
          cooldownMs: config.cooldownMs,
          dedup: { scope: "global" },
          perWindowLimit: 1,
          downgradeAfter: GATE_DOWNGRADE_WINDOWS,
        });
      }

      const prompt = buildAdvisorPrompt(config, item.tail);
      const selectedModel = resolveAdvisorModel(config, item.ctx.model);
      const options = await createDirectTeammateRunOptions(pi, item.ctx, { baseCwd: item.ctx.cwd });
      const availableModels = item.ctx.modelRegistry.getAvailable()
        .map((model) => `${model.provider}/${model.id}`);
      if (!selectedModel || !availableModels.includes(selectedModel)) {
        state.lastEvaluatedAt = Date.now();
        recordEvaluationFailure(`Advisor model is unavailable: ${selectedModel ?? "main-session model"}`);
        return;
      }

      const evaluation = await supervision.runSupervisedEvaluation<AdvisorVerdict>(
        async (dispatchContext) => {
          const results = await waitForDispatchOrAbort(runTeammate(
            {
              tasks: [{
                agent: "analyst",
                prompt: dispatchContext.task,
                taskType: "analysis",
                model: selectedModel,
                fallbackModels: [],
                thinking: "low",
                timeoutMs: dispatchContext.timeoutMs ?? EVALUATION_TIMEOUT_MS,
                outputSchema: dispatchContext.outputSchema,
              }],
            },
            { ...options, signal: dispatchContext.signal },
          ), dispatchContext.signal);
          const single = Array.isArray(results) ? results[0] : results;
          if (!single) throw new Error("Advisor evaluation returned no teammate result");
          return single;
        }, {
          task: prompt,
          timeoutMs: EVALUATION_TIMEOUT_MS,
          deadlineMs: EVALUATION_DEADLINE_MS,
          outputSchema: ADVISOR_OUTPUT_SCHEMA,
          fallbackTextParser: parseAdvisorVerdictText,
          beforeVerdict: (result) => {
            if (result.exitCode !== 0) return `Advisor model exited with code ${result.exitCode}.`;
            if (result.terminalStatus === "failed" || result.terminalStatus === "terminated") {
              return `Advisor model ended with status ${result.terminalStatus}.`;
            }
            if (result.lifecyclePending === true) return "Advisor model lifecycle is still pending.";
            return undefined;
          },
          maxFailures: 1,
          signal,
        },
      );

      if (signal.aborted || !config.enabled) return;
      state.lastEvaluatedAt = Date.now();
      state.lastModel = evaluation.raw?.model ?? selectedModel;
      if (!evaluation.ok) {
        recordEvaluationFailure(evaluation.reason ?? "evaluation returned no usable verdict");
        return;
      }
      const verdict = normalizeAdvisorVerdict(evaluation.verdict);
      if (!verdict) {
        recordEvaluationFailure("evaluation returned an invalid advisor verdict");
        return;
      }
      state.lastError = undefined;
      state.lastStatus = verdict.status;
      if (verdict.status === "on-track") {
        state.uneventful++;
        return;
      }

      const requested = verdictDeliveryMode(verdict);
      if (!requested || !gate || signal.aborted || !config.enabled) return;
      const message = verdict.message?.trim() || verdict.reason?.trim();
      if (!message) return;

      const mode = gate.gate(ADVISOR_TARGET, message, requested);
      if (mode === undefined) {
        state.suppressed++;
        return;
      }
      const severity = deliverySeverityFor(verdict);
      const advisory = formatAdvisory(message, severity);
      const interrupting = mode === "interrupt";
      const blocker = verdict.status === "blocker";

      pi.sendMessage(
        {
          customType: ADVISOR_CUSTOM_TYPE,
          content: advisory,
          display: true,
          details: { source: "advisor", checkpoint: item.source, severity, status: verdict.status },
        },
        {
          triggerTurn: interrupting && blocker,
          deliverAs: interrupting ? "steer" : "nextTurn",
        },
      );
      state.deliveries++;

      try {
        pi.events?.emit?.(
          supervision.SUPERVISION_EVENT,
          supervision.createSupervisionEvent("advisor", "intervention", severity, {
            target: ADVISOR_TARGET,
            message,
            meta: { status: verdict.status, delivery: mode, checkpoint: item.source },
          }),
        );
      } catch { /* best effort — supervision telemetry must never break the turn */ }
    } catch (error) {
      if (signal.aborted || !config.enabled) return;
      state.lastEvaluatedAt = Date.now();
      const reason = error instanceof Error ? error.message : String(error);
      recordEvaluationFailure(reason);
      if (!unavailableNotified && !signal.aborted) {
        unavailableNotified = true;
        item.ctx.ui.notify(`Advisor evaluation failed: ${reason}`, "warning");
      }
    }
  }

  async function drainEvaluationQueue(): Promise<void> {
    if (evaluationInFlight) return;
    evaluationInFlight = true;
    const signal = lifecycleController.signal;
    try {
      while (config.enabled && !signal.aborted && pendingEvaluation) {
        const item = pendingEvaluation;
        pendingEvaluation = undefined;
        await runAdvisorEvaluation(item, signal);
      }
    } finally {
      evaluationInFlight = false;
      if (config.enabled && !lifecycleController.signal.aborted && pendingEvaluation) {
        void drainEvaluationQueue();
      }
    }
  }

  function enqueueEvaluation(tail: string, ctx: ExtensionContext, source: EvaluationSource): void {
    if (!config.enabled || configCwd !== ctx.cwd || !tail.trim()) return;
    pendingEvaluation = { tail, ctx, source };
    void drainEvaluationQueue();
  }

  pi.on("tool_result", (event, ctx) => {
    if (!config.enabled) return;
    toolResultsSinceEvaluation++;
    toolCheckpoints.push(serializeToolCheckpoint({
      toolName: event.toolName,
      input: event.input,
      content: event.content,
      isError: event.isError,
    }, config.maxTailChars));
    const thresholdReached = toolResultsSinceEvaluation >= config.reviewEveryToolResults;
    if (!event.isError && !thresholdReached) return;
    const tail = toolCheckpoints.join("\n\n").slice(-config.maxTailChars);
    toolResultsSinceEvaluation = 0;
    toolCheckpoints = [];
    enqueueEvaluation(tail, ctx, "tool_result");
  });

  pi.on("agent_end", (event, ctx) => {
    toolResultsSinceEvaluation = 0;
    toolCheckpoints = [];
    const tail = serializeTranscriptTail(
      (event as { messages: AgentMessage[] }).messages,
      config.maxTailMessages,
      config.maxTailChars,
    );
    enqueueEvaluation(tail, ctx, "agent_end");
  });

  pi.on("session_start", (_event, ctx) => loadWorkspaceConfig(ctx));
  pi.on("session_compact", () => resetAdvisorLifecycle());
  pi.on("session_shutdown", () => {
    lifecycleController.abort();
    pendingEvaluation = undefined;
  });

  pi.registerCommand("advisor", {
    description: "Advisor: /advisor [status|on|off|model <provider/model|inherit>]",
    async handler(args: string, ctx) {
      await ensureWorkspaceConfig(ctx);
      const rawArgs = args.trim();
      const trimmed = rawArgs.toLowerCase();
      if (trimmed === "on") {
        config = { ...config, enabled: true };
        resetAdvisorLifecycle();
        await saveConfig(config, ctx.cwd);
        ctx.ui.notify("Advisor enabled. Evaluations run in the background and inject results when ready.", "info");
        return;
      }
      if (trimmed === "off") {
        config = { ...config, enabled: false };
        resetAdvisorLifecycle();
        await saveConfig(config, ctx.cwd);
        ctx.ui.notify("Advisor disabled.", "info");
        return;
      }
      if (trimmed === "model") {
        ctx.ui.notify("Usage: /advisor model <provider/model|inherit>", "info");
        return;
      }
      if (trimmed.startsWith("model ")) {
        const requested = rawArgs.slice(rawArgs.indexOf(" ") + 1).trim();
        if (["inherit", "main", "default", "auto"].includes(requested.toLowerCase())) {
          const { model: _ignored, ...rest } = config;
          config = rest;
          resetAdvisorLifecycle();
          await saveConfig(config, ctx.cwd);
          ctx.ui.notify("Advisor model now inherits the active main-session model.", "info");
          return;
        }
        await ctx.modelRegistry.refresh();
        const available = ctx.modelRegistry.getAvailable()
          .map((model) => `${model.provider}/${model.id}`);
        if (!available.includes(requested)) {
          ctx.ui.notify(`Advisor model is unavailable: ${requested}`, "warning");
          return;
        }
        config = { ...config, model: requested };
        resetAdvisorLifecycle();
        await saveConfig(config, ctx.cwd);
        ctx.ui.notify(`Advisor dedicated model: ${requested}`, "info");
        return;
      }
      // status (default)
      const activeModel = resolveAdvisorModel(config, ctx.model);
      const lines = [
        `ADVISOR ${config.enabled ? "on" : "off"}`,
        `  model: ${activeModel ?? "unavailable"}${config.model ? " (dedicated)" : " (main session)"}`,
        `  cadence: every ${config.reviewEveryToolResults} tool results + agent end`,
        `  background: ${evaluationInFlight ? "running" : "idle"}${pendingEvaluation ? " · pending latest checkpoint" : ""}`,
        `  cooldown: ${config.cooldownMs}ms · tail: ${config.maxTailMessages} msgs / ${config.maxTailChars} chars`,
        config.guide ? `  guide: ${config.guide.slice(0, 120)}${config.guide.length > 120 ? "…" : ""}` : "  guide: (none)",
        `  last: ${state.lastStatus ?? "never"}${state.lastEvaluatedAt ? ` · ${new Date(state.lastEvaluatedAt).toLocaleTimeString()}` : ""}`,
        `  evaluations: ${state.evaluations} · failures: ${state.failures} · uneventful: ${state.uneventful}`,
        `  deliveries: ${state.deliveries} · suppressed: ${state.suppressed}`,
        state.lastModel ? `  resolved model: ${state.lastModel}` : "  resolved model: (none yet)",
        state.lastError ? `  last error: ${state.lastError.slice(0, 200)}` : "  last error: (none)",
      ];
      ctx.ui.notify(lines.join("\n"), "info");
    },
  });
}

// Re-export runtime surface for tests and future consumers.
export { ADVISOR_OUTPUT_SCHEMA, DEFAULT_ADVISOR_CONFIG } from "./runtime.ts";
