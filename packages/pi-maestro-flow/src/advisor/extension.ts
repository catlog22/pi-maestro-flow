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
  normalizeAdvisorVerdict,
  parseAdvisorVerdictText,
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
}

interface RunTeammateParamsLike {
  tasks: Array<{
    agent?: string;
    prompt: string;
    taskType?: string;
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

// ---------------------------------------------------------------------------
// Config persistence
// ---------------------------------------------------------------------------

function mergeConfig(raw: Partial<AdvisorConfig> | undefined): AdvisorConfig {
  return {
    enabled: typeof raw?.enabled === "boolean" ? raw.enabled : DEFAULT_ADVISOR_CONFIG.enabled,
    guide: typeof raw?.guide === "string" ? raw.guide : DEFAULT_ADVISOR_CONFIG.guide,
    cooldownMs: typeof raw?.cooldownMs === "number" && raw.cooldownMs >= 0
      ? raw.cooldownMs
      : DEFAULT_ADVISOR_CONFIG.cooldownMs,
    maxTailMessages: typeof raw?.maxTailMessages === "number" && raw.maxTailMessages > 0
      ? raw.maxTailMessages
      : DEFAULT_ADVISOR_CONFIG.maxTailMessages,
    maxTailChars: typeof raw?.maxTailChars === "number" && raw.maxTailChars > 0
      ? raw.maxTailChars
      : DEFAULT_ADVISOR_CONFIG.maxTailChars,
  };
}

async function loadConfig(): Promise<AdvisorConfig> {
  try {
    const raw = JSON.parse(await readFile(advisorConfigPath(), "utf8")) as Partial<AdvisorConfig> | undefined;
    return mergeConfig(raw);
  } catch {
    return { ...DEFAULT_ADVISOR_CONFIG };
  }
}

async function saveConfig(config: AdvisorConfig): Promise<void> {
  const path = advisorConfigPath();
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

  void loadConfig().then((loaded) => {
    config = loaded;
    if (config.enabled) pi.events?.emit?.("advisor:enabled", { enabled: true });
  });

  function notifyUnavailable(ctx: ExtensionContext, reason: string): void {
    if (unavailableNotified) return;
    unavailableNotified = true;
    ctx.ui.notify(`Advisor unavailable: ${reason}`, "warning");
  }

  /** Evaluate the current turn tail and deliver an advisory when warranted. */
  async function runAdvisorTurn(event: { messages: AgentMessage[] }, ctx: ExtensionContext): Promise<void> {
    if (!config.enabled || evaluationInFlight) return;
    evaluationInFlight = true;
    gate?.beginWindow();
    try {
      const loaded = await loadTeammate();
      if (!loaded) {
        notifyUnavailable(ctx, "pi-maestro-teammate is not installed");
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

      const tail = serializeTranscriptTail(event.messages, config.maxTailMessages, config.maxTailChars);
      const prompt = buildAdvisorPrompt(config, tail);
      const options = await createDirectTeammateRunOptions(pi, ctx, { baseCwd: ctx.cwd });

      const evaluation = await supervision.runSupervisedEvaluation<AdvisorVerdict>(
        async (dispatchContext) => {
          const results = await runTeammate(
            {
              tasks: [{
                agent: "analyst",
                prompt: dispatchContext.task,
                thinking: "low",
                timeoutMs: dispatchContext.timeoutMs ?? EVALUATION_TIMEOUT_MS,
                outputSchema: dispatchContext.outputSchema,
              }],
            },
            { ...options, signal: dispatchContext.signal },
          );
          const single = Array.isArray(results) ? results[0] : results;
          if (!single) throw new Error("Advisor evaluation returned no teammate result");
          return single;
        },        {
          task: prompt,
          timeoutMs: EVALUATION_TIMEOUT_MS,
          deadlineMs: EVALUATION_DEADLINE_MS,
          outputSchema: ADVISOR_OUTPUT_SCHEMA,
          fallbackTextParser: parseAdvisorVerdictText,
          maxFailures: 1,
          signal: ctx.signal,
        },
      );

      const verdict = evaluation.ok ? normalizeAdvisorVerdict(evaluation.verdict) : undefined;
      state.lastEvaluatedAt = Date.now();
      if (!verdict || verdict.status === "on-track") {
        state.uneventful++;
        state.lastStatus = verdict?.status;
        return;
      }
      state.lastStatus = verdict.status;

      const requested = verdictDeliveryMode(verdict);
      if (!requested || !gate) return;
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
          details: { source: "advisor", severity, status: verdict.status },
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
            meta: { status: verdict.status, delivery: mode },
          }),
        );
      } catch { /* best effort — supervision telemetry must never break the turn */ }
    } catch (error) {
      if (!unavailableNotified) {
        unavailableNotified = true;
        ctx.ui.notify(
          `Advisor evaluation failed: ${error instanceof Error ? error.message : String(error)}`,
          "warning",
        );
      }
    } finally {
      evaluationInFlight = false;
    }
  }

  pi.on("agent_end", (event, ctx) => {
    void runAdvisorTurn(event as { messages: AgentMessage[] }, ctx);
  });

  pi.registerCommand("advisor", {
    description: "Advisor: /advisor [status|on|off] — turn-level quality supervision",
    async handler(args: string, ctx) {
      const trimmed = args.trim().toLowerCase();
      if (trimmed === "on") {
        config = { ...config, enabled: true };
        await saveConfig(config);
        ctx.ui.notify("Advisor enabled. It will review each turn end and raise concerns.", "info");
        return;
      }
      if (trimmed === "off") {
        config = { ...config, enabled: false };
        await saveConfig(config);
        ctx.ui.notify("Advisor disabled.", "info");
        return;
      }
      // status (default)
      const lines = [
        `ADVISOR ${config.enabled ? "on" : "off"}`,
        `  cooldown: ${config.cooldownMs}ms · tail: ${config.maxTailMessages} msgs / ${config.maxTailChars} chars`,
        config.guide ? `  guide: ${config.guide.slice(0, 120)}${config.guide.length > 120 ? "…" : ""}` : "  guide: (none)",
        `  last: ${state.lastStatus ?? "never"}${state.lastEvaluatedAt ? ` · ${new Date(state.lastEvaluatedAt).toLocaleTimeString()}` : ""}`,
        `  deliveries: ${state.deliveries} · suppressed: ${state.suppressed} · uneventful: ${state.uneventful}`,
      ];
      ctx.ui.notify(lines.join("\n"), "info");
    },
  });
}

// Re-export runtime surface for tests and future consumers.
export { ADVISOR_OUTPUT_SCHEMA, DEFAULT_ADVISOR_CONFIG } from "./runtime.ts";
