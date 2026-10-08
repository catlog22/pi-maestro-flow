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

import { randomUUID } from "node:crypto";
import { lstatSync, renameSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { getSupportedThinkingLevels } from "@earendil-works/pi-ai";
import { buildSessionContext, convertToLlm, type AgentToolUpdateCallback, type ExtensionAPI, type ExtensionCommandContext, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
  createSupervisionEvent,
  SUPERVISION_EVENT,
  ensureAdvisorCommandRegistered,
  getAdvisorRuntimeOwner,
  registerAdvisorRuntime,
  type AdvisorRuntimeLease,
} from "pi-maestro-teammate/v1/supervision";
import { createDirectTeammateRunOptions } from "../tools/direct-teammate.ts";
import { classify } from "pi-maestro-teammate/v1/classify";
import { todoProgressDomain } from "../classifier/domains.ts";
import { TodoReviewHost } from "./todo-review-host.ts";
import { todoReflection, type TodoReviewTicket } from "./todo-review.ts";
import {
  advisorConfigPath,
  applyAdvisorEnvOverrides,
  automaticAdvisorEnabled,
  buildAdvisorPrompt,
  buildAdvisorToolInventory,
  buildManualAdvisorPrompt,
  createAdvisorRuntimeState,
  DEFAULT_ADVISOR_CONFIG,
  deliverySeverityFor,
  ensureAdvisorUserTail,
  formatAdvisory,
  isAdvisorExecutorBlocked,
  isAdvisorMode,
  isAdvisorThinkingLevel,
  manualAdvisorEnabled,
  normalizeAdvisorConfig,
  normalizeLegacyAdvisorConfig,
  normalizeAdvisorVerdict,
  parseAdvisorVerdictText,
  resolveAdvisorModel,
  serializeAdvisorConversation,
  serializeToolCheckpoint,
  serializeTranscriptTail,
  stripInflightAdvisorCall,
  ADVISOR_OUTPUT_SCHEMA,
  verdictDeliveryMode,
  type AdvisorConfig,
  type AdvisorConfigSource,
  type AdvisorConversationMessage,
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
  messages: Array<{ role: string; content: unknown }>;
  model?: string;
  correlationId?: string;
  structuredOutput?: unknown;
  attemptedModels?: string[];
  terminalStatus?: string;
  lifecyclePending?: boolean;
  usage?: unknown;
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

function teammateResultText(result: SingleResultLike): string {
  for (let index = result.messages.length - 1; index >= 0; index--) {
    const content = result.messages[index]?.content;
    if (typeof content === "string" && content.trim()) return content.trim();
    if (!Array.isArray(content)) continue;
    const text = content
      .map((block) => typeof block === "object" && block !== null && typeof (block as { text?: unknown }).text === "string"
        ? (block as { text: string }).text
        : "")
      .join("\n")
      .trim();
    if (text) return text;
  }
  return "";
}

// ---------------------------------------------------------------------------
// Config persistence
// ---------------------------------------------------------------------------

export interface AdvisorWorkspaceConfigLoad {
  config: AdvisorConfig;
  baseConfig: AdvisorConfig;
  source: AdvisorConfigSource;
  envOverridden: boolean;
  warning?: string;
}

function isMissingFile(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | undefined)?.code === "ENOENT";
}

function advisorEnvOverridesPresent(env: NodeJS.ProcessEnv): boolean {
  return env.PI_ADVISOR !== undefined
    || env.PI_ADVISOR_COOLDOWN_MS !== undefined
    || env.PI_ADVISOR_MAX_REVIEWS !== undefined;
}

function withAdvisorEnv(
  baseConfig: AdvisorConfig,
  source: AdvisorConfigSource,
  env: NodeJS.ProcessEnv,
  warning?: string,
): AdvisorWorkspaceConfigLoad {
  return {
    baseConfig,
    config: applyAdvisorEnvOverrides(baseConfig, env),
    source,
    envOverridden: advisorEnvOverridesPresent(env),
    ...(warning ? { warning } : {}),
  };
}

export async function loadAdvisorWorkspaceConfig(
  cwd: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<AdvisorWorkspaceConfigLoad> {
  let canonicalText: string | undefined;
  try {
    canonicalText = await readFile(advisorConfigPath(cwd), "utf8");
  } catch (error) {
    if (!isMissingFile(error)) {
      const baseConfig = { ...DEFAULT_ADVISOR_CONFIG, enabled: false };
      return {
        baseConfig,
        config: baseConfig,
        source: "canonical-invalid",
        envOverridden: false,
        warning: `Advisor configuration is unreadable and was disabled: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }

  if (canonicalText !== undefined) {
    try {
      const raw = JSON.parse(canonicalText) as unknown;
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("expected a JSON object");
      return withAdvisorEnv(normalizeAdvisorConfig(raw as Partial<AdvisorConfig>), "canonical", env);
    } catch (error) {
      const baseConfig = { ...DEFAULT_ADVISOR_CONFIG, enabled: false };
      return {
        baseConfig,
        config: baseConfig,
        source: "canonical-invalid",
        envOverridden: false,
        warning: `Advisor configuration is malformed and was disabled: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }

  const settingsPath = resolve(cwd, ".pi", "settings.json");
  let settingsText: string;
  try {
    settingsText = await readFile(settingsPath, "utf8");
  } catch (error) {
    if (isMissingFile(error)) {
      return withAdvisorEnv({ ...DEFAULT_ADVISOR_CONFIG }, "defaults", env);
    }
    return withAdvisorEnv(
      { ...DEFAULT_ADVISOR_CONFIG },
      "defaults",
      env,
      `Legacy Advisor settings are unreadable: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  try {
    const parsed = JSON.parse(settingsText) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("expected a JSON object");
    const settings = parsed as Record<string, unknown>;
    const monitor = settings.monitor && typeof settings.monitor === "object" && !Array.isArray(settings.monitor)
      ? settings.monitor as Record<string, unknown>
      : undefined;
    const legacy = monitor?.advisor ?? settings.advisor;
    return legacy === undefined
      ? withAdvisorEnv({ ...DEFAULT_ADVISOR_CONFIG }, "defaults", env)
      : withAdvisorEnv(normalizeLegacyAdvisorConfig(legacy), "legacy", env);
  } catch (error) {
    return withAdvisorEnv(
      { ...DEFAULT_ADVISOR_CONFIG },
      "defaults",
      env,
      `Legacy Advisor settings are malformed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

const configWrites = new Map<string, Promise<void>>();
let configWriteBarrier: (() => Promise<void>) | undefined;
/** @internal Deterministic lifecycle interleavings at the durable replacement boundary. */
export function setAdvisorConfigWriteBarrierForTest(barrier: (() => Promise<void>) | undefined): void {
  configWriteBarrier = barrier;
}

async function saveConfig(config: AdvisorConfig, cwd: string, assertFresh: () => void): Promise<void> {
  const path = advisorConfigPath(cwd);
  const write = async (): Promise<void> => {
    assertFresh();
    await mkdir(dirname(path), { recursive: true });
    assertFresh();
    const temporary = `${path}.${randomUUID()}.tmp`;
    let committed = false;
    try {
      await writeFile(temporary, `${JSON.stringify(config, null, 2)}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
      if (configWriteBarrier) await configWriteBarrier();
      assertFresh();
      try {
        if (!lstatSync(path).isFile()) throw new Error("Advisor config target must be a regular file, not a link or directory.");
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      // No await between the authority fence and the atomic durable replacement.
      renameSync(temporary, path);
      committed = true;
    } finally { if (!committed) await rm(temporary, { force: true }); }
  };
  const operation = (configWrites.get(path) ?? Promise.resolve()).then(write, write);
  configWrites.set(path, operation);
  try { await operation; }
  finally { if (configWrites.get(path) === operation) configWrites.delete(path); }
}

// ---------------------------------------------------------------------------
// Extension entry
// ---------------------------------------------------------------------------

export default function registerAdvisor(pi: ExtensionAPI): void {
  let storedConfig: AdvisorConfig = { ...DEFAULT_ADVISOR_CONFIG };
  let config: AdvisorConfig = { ...DEFAULT_ADVISOR_CONFIG };
  let configSource: AdvisorConfigSource = "defaults";
  let configEnvOverridden = false;
  let state: AdvisorRuntimeState = createAdvisorRuntimeState();
  let gate: DeliveryGateLike | undefined;
  let evaluationInFlight = false;
  let unavailableNotified = false;
  let lifecycleController = new AbortController();
  let configCwd: string | undefined;
  let configGeneration = 0;
  let configLoadPromise: Promise<void> | undefined;
  let toolResultsSinceEvaluation = 0;
  let toolCheckpoints: string[] = [];
  let automaticReviews = 0;
  let lastAutomaticReviewStartedAt = 0;
  let consultations = 0;
  let consultationFailures = 0;
  let lastConsultedAt: number | undefined;
  let activeContext: ExtensionContext | undefined;
  let ownershipGeneration = 0;
  let advisorRuntimeLease: AdvisorRuntimeLease | undefined;
  type EvaluationSource = "tool_result" | "agent_end" | "todo_progress";
  interface EvaluationItem {
    tail: string;
    ctx: ExtensionContext;
    source: EvaluationSource;
    ownershipGeneration: number;
    ticket?: TodoReviewTicket;
    steer?: (message: string) => boolean;
  }
  const pendingEvaluations: EvaluationItem[] = [];
  let todoHost: TodoReviewHost;
  function currentItem(item: EvaluationItem, signal: AbortSignal): boolean {
    if (signal.aborted || !ownsAdvisorRuntime(item.ownershipGeneration) || !automaticAdvisorEnabled(config)) return false;
    if (item.ticket) { todoHost.sync(); return config.todoReview.enabled && todoHost.monitor.fresh(item.ticket); }
    return !todoHost.monitored();
  }

  function notifyUnavailable(ctx: ExtensionContext, reason: string): void {
    if (unavailableNotified) return;
    unavailableNotified = true;
    ctx.ui.notify(`Advisor unavailable: ${reason}`, "warning");
  }

  function resetAdvisorLifecycle(): void {
    lifecycleController.abort();
    lifecycleController = new AbortController();
    pendingEvaluations.length = 0;
    todoHost.reset(config.todoReview, true);
    toolResultsSinceEvaluation = 0;
    toolCheckpoints = [];
    gate?.reset();
    gate = undefined;
  }

  function resetAdvisorSessionState(): void {
    state = createAdvisorRuntimeState();
    automaticReviews = 0;
    lastAutomaticReviewStartedAt = 0;
    consultations = 0;
    consultationFailures = 0;
    lastConsultedAt = undefined;
    unavailableNotified = false;
  }

  function ownsAdvisorRuntime(generation = ownershipGeneration): boolean {
    return generation === ownershipGeneration && advisorRuntimeLease?.isOwner() === true;
  }

  function removeManualTool(): void {
    try {
      const active = pi.getActiveTools();
      if (active.includes("advisor")) pi.setActiveTools(active.filter((name) => name !== "advisor"));
    } catch {
      // Action APIs may be unavailable during extension loading or after shutdown.
    }
  }

  function handleAdvisorOwnershipChanged(owned: boolean): void {
    ownershipGeneration++;
    resetAdvisorLifecycle();
    resetAdvisorSessionState();
    if (!owned) {
      configGeneration++;
      configLoadPromise = undefined;
      removeManualTool();
      return;
    }
    if (activeContext) loadWorkspaceConfig(activeContext, true);
  }

  function loadWorkspaceConfig(ctx: ExtensionContext, resetSession = false): void {
    activeContext = ctx;
    resetAdvisorLifecycle();
    if (resetSession) { resetAdvisorSessionState(); todoHost.monitor.reset(config.todoReview); }
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
    storedConfig = { ...DEFAULT_ADVISOR_CONFIG };
    config = { ...DEFAULT_ADVISOR_CONFIG };
    configSource = "defaults";
    configEnvOverridden = false;
    const load = loadAdvisorWorkspaceConfig(cwd).then((loaded) => {
      if (generation !== configGeneration || configCwd !== cwd || !ownsAdvisorRuntime()) return;
      storedConfig = loaded.baseConfig;
      config = loaded.config;
      configSource = loaded.source;
      configEnvOverridden = loaded.envOverridden;
      if (loaded.warning) ctx.ui.notify(loaded.warning, "warning");
      syncManualTool(ctx);
      todoHost.reset(config.todoReview, true);
      if (config.enabled) pi.events?.emit?.("advisor:enabled", { enabled: true });
    }).finally(() => {
      if (configLoadPromise === load) configLoadPromise = undefined;
    });
    configLoadPromise = load;
  }

  async function ensureWorkspaceConfig(ctx: ExtensionContext): Promise<void> {
    activeContext = ctx;
    if (configCwd !== ctx.cwd) loadWorkspaceConfig(ctx);
    await configLoadPromise;
  }

  function syncManualTool(
    ctx: ExtensionContext,
    model = ctx.model,
    thinkingLevel = pi.getThinkingLevel(),
  ): boolean {
    const enabled = advisorRuntimeLease?.isOwner() === true
      && manualAdvisorEnabled(config)
      && !isAdvisorExecutorBlocked(config, model, thinkingLevel);
    const active = pi.getActiveTools();
    const present = active.includes("advisor");
    if (enabled && !present) pi.setActiveTools([...active, "advisor"]);
    if (!enabled && present) pi.setActiveTools(active.filter((name) => name !== "advisor"));
    return enabled;
  }

  async function commitConfig(
    next: AdvisorConfig,
    ctx: ExtensionContext,
    successMessage: string,
  ): Promise<boolean> {
    const generation = ownershipGeneration;
    if (!ownsAdvisorRuntime(generation)) return false;
    const epoch = configGeneration;
    const signal = lifecycleController.signal;
    const normalized = normalizeAdvisorConfig(next);
    const cwd = ctx.cwd;
    const sessionId = ctx.sessionManager?.getSessionId?.();
    const assertFresh = (): void => {
      if (!ownsAdvisorRuntime(generation) || epoch !== configGeneration || signal.aborted
        || configCwd !== cwd || ctx.sessionManager?.getSessionId?.() !== sessionId) {
        throw new Error("Advisor configuration save is stale; reopen settings.");
      }
    };
    try {
      await saveConfig(normalized, cwd, assertFresh);
      assertFresh();
    } catch (error) {
      if (!signal.aborted && epoch === configGeneration && ownsAdvisorRuntime(generation)) {
        ctx.ui.notify(`Failed to save Advisor configuration: ${error instanceof Error ? error.message : String(error)}`, "error");
      }
      return false;
    }
    if (!ownsAdvisorRuntime(generation) || epoch !== configGeneration || signal.aborted) return false;
    configGeneration++;
    storedConfig = normalized;
    config = applyAdvisorEnvOverrides(storedConfig);
    configSource = "canonical";
    configEnvOverridden = advisorEnvOverridesPresent(process.env);
    resetAdvisorLifecycle();
    syncManualTool(ctx);
    ctx.ui.notify(successMessage, "info");
    return true;
  }

  async function runManualConsultation(
    toolCallId: string,
    ctx: ExtensionContext,
    signal: AbortSignal | undefined,
    onUpdate: AgentToolUpdateCallback<Record<string, unknown>> | undefined,
  ) {
    const generation = ownershipGeneration;
    const staleResult = () => ({
      content: [{ type: "text" as const, text: "Advisor consultation is unavailable because this runtime is not the active owner." }],
      details: { status: "stale", thinking: config.consultThinking },
    });
    if (!ownsAdvisorRuntime(generation)) return staleResult();
    await ensureWorkspaceConfig(ctx);
    if (!ownsAdvisorRuntime(generation)) return staleResult();
    const consultationSignal = signal
      ? AbortSignal.any([signal, lifecycleController.signal])
      : lifecycleController.signal;
    if (!manualAdvisorEnabled(config)) {
      return {
        content: [{ type: "text" as const, text: "Manual Advisor consultation is disabled. Use /advisor mode manual or /advisor mode hybrid, then /advisor on." }],
        details: { status: "disabled", thinking: config.consultThinking },
      };
    }
    if (isAdvisorExecutorBlocked(config, ctx.model, pi.getThinkingLevel())) {
      return {
        content: [{ type: "text" as const, text: "Advisor is disabled for the current executor model and thinking level." }],
        details: { status: "blocked", thinking: config.consultThinking },
      };
    }

    const selectedModel = resolveAdvisorModel(config, ctx.model);
    const availableModels = ctx.modelRegistry.getAvailable().map((model) => `${model.provider}/${model.id}`);
    if (!selectedModel || !availableModels.includes(selectedModel)) {
      consultationFailures++;
      return {
        content: [{ type: "text" as const, text: `Advisor model is unavailable: ${selectedModel ?? "main-session model"}.` }],
        details: { status: "unavailable", advisorModel: selectedModel, thinking: config.consultThinking },
      };
    }

    const loaded = await loadTeammate();
    if (!ownsAdvisorRuntime(generation) || consultationSignal.aborted) return staleResult();
    if (!loaded) {
      consultationFailures++;
      return {
        content: [{ type: "text" as const, text: "Advisor is unavailable because pi-maestro-teammate is not installed." }],
        details: { status: "unavailable", advisorModel: selectedModel, thinking: config.consultThinking },
      };
    }

    const resolvedMessages = convertToLlm(buildSessionContext(
      ctx.sessionManager.getEntries(),
      ctx.sessionManager.getLeafId(),
    ).messages) as unknown as AdvisorConversationMessage[];
    const preparedMessages = ensureAdvisorUserTail(stripInflightAdvisorCall(resolvedMessages, toolCallId));
    const activeNames = new Set(pi.getActiveTools());
    const inventory = buildAdvisorToolInventory(pi.getAllTools().filter((tool) => activeNames.has(tool.name)));
    const prompt = buildManualAdvisorPrompt(config, serializeAdvisorConversation(preparedMessages), inventory);
    const options = await createDirectTeammateRunOptions(pi, ctx, { baseCwd: ctx.cwd });
    if (!ownsAdvisorRuntime(generation) || consultationSignal.aborted) return staleResult();

    onUpdate?.({
      content: [{ type: "text", text: `Consulting Advisor (${selectedModel}, ${config.consultThinking})…` }],
      details: { status: "running", advisorModel: selectedModel, thinking: config.consultThinking },
    });

    try {
      const results = await waitForDispatchOrAbort(loaded.runTeammate({
        tasks: [{
          agent: "analyst",
          prompt,
          taskType: "analysis",
          model: selectedModel,
          fallbackModels: [],
          thinking: config.consultThinking,
          timeoutMs: EVALUATION_TIMEOUT_MS,
        }],
      }, { ...options, signal: consultationSignal }), consultationSignal);
      if (!ownsAdvisorRuntime(generation) || consultationSignal.aborted) return staleResult();
      const result = Array.isArray(results) ? results[0] : results;
      if (!result) throw new Error("Advisor consultation returned no teammate result");
      if (result.exitCode !== 0 || result.terminalStatus === "failed" || result.terminalStatus === "terminated") {
        throw new Error(`Advisor model ended with ${result.terminalStatus ?? `exit code ${result.exitCode}`}`);
      }
      if (result.lifecyclePending === true) throw new Error("Advisor model lifecycle is still pending");
      const text = teammateResultText(result);
      if (!text) throw new Error("Advisor returned no guidance");
      consultations++;
      lastConsultedAt = Date.now();
      return {
        content: [{ type: "text" as const, text }],
        details: {
          status: "completed",
          advisorModel: result.model ?? selectedModel,
          thinking: config.consultThinking,
          correlationId: result.correlationId,
          usage: result.usage,
        },
      };
    } catch (error) {
      if (!ownsAdvisorRuntime(generation) || consultationSignal.aborted) return staleResult();
      consultationFailures++;
      const reason = error instanceof Error ? error.message : String(error);
      return {
        content: [{ type: "text" as const, text: `Advisor consultation failed: ${reason}` }],
        details: { status: "failed", advisorModel: selectedModel, thinking: config.consultThinking, error: reason },
      };
    }
  }

  function automaticReviewAvailable(now = Date.now()): boolean {
    return (config.maxAutomaticReviewsPerSession === 0
      || automaticReviews < config.maxAutomaticReviewsPerSession)
      && (config.automaticReviewCooldownMs === 0
        || now - lastAutomaticReviewStartedAt >= config.automaticReviewCooldownMs);
  }

  function recordEvaluationFailure(reason: string): void {
    state.failures++;
    state.lastStatus = "failed";
    state.lastError = reason;
  }

  /** Evaluate one queued snapshot and inject only after a valid background result arrives. */
  async function runAdvisorEvaluation(
    item: EvaluationItem,
    signal: AbortSignal,
  ): Promise<void> {
    if (!currentItem(item, signal) || (!item.ticket && !automaticReviewAvailable())) return;
    let taskAction: "reflect" | "escalate" | undefined;
    if (item.ticket) {
      const progress = await waitForDispatchOrAbort(classify(todoProgressDomain, item.ticket.input), signal);
      if (!currentItem(item, signal)) return;
      const shadow = config.todoReview.mode === "shadow";
      state.lastTodoReview = { taskId: item.ticket.taskId, actor: item.ticket.actor,
        status: progress.label, confidence: progress.confidence, layer: progress.layer,
        shadow, at: Date.now(), ...(progress.degradedReason ? { degradedReason: progress.degradedReason } : {}) };
      if (shadow) {
        state.todoShadowReviews = (state.todoShadowReviews ?? 0) + 1;
        try {
          pi.events?.emit?.(SUPERVISION_EVENT, createSupervisionEvent("advisor", "verdict", "info", {
            target: item.ticket.actor, verdict: { status: progress.label },
            meta: { checkpoint: "todo_progress", taskId: item.ticket.taskId, shadow: true,
              confidence: progress.confidence, layer: progress.layer },
          }));
        } catch (error) { if (currentItem(item, signal)) recordEvaluationFailure(`Todo shadow telemetry failed: ${String(error)}`); }
        todoHost.monitor.observed(item.ticket);
        return;
      }
      taskAction = todoHost.monitor.decide(item.ticket, progress);
      if (!taskAction) return;
      if (taskAction === "escalate" && !automaticReviewAvailable()) return;
    }
    state.evaluations++;
    gate?.beginWindow();
    try {
      const loaded = await loadTeammate();
      if (!currentItem(item, signal)) return;
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
          dedup: { scope: "target" },
          perWindowLimit: 1,
          downgradeAfter: GATE_DOWNGRADE_WINDOWS,
        });
      }

      if (item.ticket && taskAction === "reflect") {
        const message = todoReflection(item.ticket);
        const mode = gate.gate(`${item.ticket.actor}:${item.ticket.key}`, message, "batch");
        if (!mode || !currentItem(item, signal)) { state.suppressed++; return; }
        if (deliverTask(item, message, "concern", mode)) {
          todoHost.monitor.delivered(item.ticket, "reflect"); state.deliveries++;
        }
        return;
      }
      const prompt = buildAdvisorPrompt(config, item.tail);
      const selectedModel = resolveAdvisorModel(config, item.ctx.model);
      const options = await createDirectTeammateRunOptions(pi, item.ctx, { baseCwd: item.ctx.cwd });
      if (!currentItem(item, signal)) return;
      const availableModels = item.ctx.modelRegistry.getAvailable()
        .map((model) => `${model.provider}/${model.id}`);
      if (!selectedModel || !availableModels.includes(selectedModel)) {
        state.lastEvaluatedAt = Date.now();
        recordEvaluationFailure(`Advisor model is unavailable: ${selectedModel ?? "main-session model"}`);
        return;
      }

      if (!automaticReviewAvailable()) return;
      automaticReviews++;
      if (item.ticket) todoHost.monitor.delivered(item.ticket, "escalate");
      lastAutomaticReviewStartedAt = Date.now();
      const evaluation = await supervision.runSupervisedEvaluation<AdvisorVerdict>(
        async (dispatchContext) => {
          if (!currentItem(item, dispatchContext.signal ?? signal)) {
            throw new Error("Advisor runtime ownership changed before evaluation dispatch.");
          }
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

      if (!currentItem(item, signal)) return;
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
        if (item.ticket) todoHost.monitor.decide(item.ticket, { label: "on-track", confidence: 1, layer: "rule" });
        return;
      }

      const requested = verdictDeliveryMode(verdict);
      if (!requested
        || !gate
        || !currentItem(item, signal)) return;
      const message = verdict.message?.trim() || verdict.reason?.trim();
      if (!message) return;

      const mode = gate.gate(item.ticket ? `${item.ticket.actor}:${item.ticket.key}` : ADVISOR_TARGET, message, requested);
      if (mode === undefined) {
        state.suppressed++;
        return;
      }
      const severity = deliverySeverityFor(verdict);
      const advisory = formatAdvisory(message, severity);
      const interrupting = mode === "interrupt";
      const blocker = verdict.status === "blocker";

      if (item.ticket) {
        if (!currentItem(item, signal) || !deliverTask(item, message, severity, mode)) return;
      } else pi.sendMessage(
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
            target: item.ticket?.actor ?? ADVISOR_TARGET,
            message,
            meta: { status: verdict.status, delivery: mode, checkpoint: item.source },
          }),
        );
      } catch { /* best effort — supervision telemetry must never break the turn */ }
    } catch (error) {
      if (!currentItem(item, signal)) return;
      state.lastEvaluatedAt = Date.now();
      const reason = error instanceof Error ? error.message : String(error);
      recordEvaluationFailure(reason);
      if (!unavailableNotified && !signal.aborted) {
        unavailableNotified = true;
        item.ctx.ui.notify(`Advisor evaluation failed: ${reason}`, "warning");
      }
    }
  }

  function deliverTask(item: EvaluationItem, message: string, severity: "concern" | "blocker", mode: "interrupt" | "batch" | "notify"): boolean {
    if (!item.ticket || !currentItem(item, lifecycleController.signal) || config.todoReview.mode === "shadow") return false;
    const content = formatAdvisory(message, severity);
    if (item.ticket.actor !== "root") return item.steer?.(content) === true;
    pi.sendMessage({ customType: ADVISOR_CUSTOM_TYPE, content, display: true,
      details: { source: "advisor", checkpoint: "todo_progress", taskId: item.ticket.taskId, actor: item.ticket.actor, severity } },
      { triggerTurn: false, deliverAs: mode === "notify" ? "nextTurn" : "steer" });
    return true;
  }

  async function drainEvaluationQueue(): Promise<void> {
    if (evaluationInFlight || !ownsAdvisorRuntime()) return;
    evaluationInFlight = true;
    const signal = lifecycleController.signal;
    try {
      while (ownsAdvisorRuntime()
        && automaticAdvisorEnabled(config)
        && !signal.aborted
        && pendingEvaluations.length) {
        const item = pendingEvaluations.shift()!;
        try { await runAdvisorEvaluation(item, signal); }
        catch (error) { if (currentItem(item, signal)) recordEvaluationFailure(String(error)); }
        finally { if (item.ticket) todoHost.monitor.release(item.ticket); }
      }
    } finally {
      evaluationInFlight = false;
      if (ownsAdvisorRuntime()
        && automaticAdvisorEnabled(config)
        && !lifecycleController.signal.aborted
        && pendingEvaluations.length) {
        void drainEvaluationQueue();
      }
    }
  }

  function enqueueEvaluation(tail: string, ctx: ExtensionContext, source: EvaluationSource): void {
    if (!ownsAdvisorRuntime()
      || !automaticAdvisorEnabled(config)
      || !automaticReviewAvailable()
      || configCwd !== ctx.cwd
      || !tail.trim()) return;
    if (todoHost.monitored()) return;
    const legacy = pendingEvaluations.findIndex((item) => !item.ticket);
    const item = { tail, ctx, source, ownershipGeneration };
    if (legacy >= 0) pendingEvaluations[legacy] = item;
    else if (pendingEvaluations.length < 64) pendingEvaluations.push(item);
    void drainEvaluationQueue();
  }

  pi.registerTool({
    name: "advisor",
    label: "Advisor",
    description: "Ask the configured reviewer model for a second opinion using the full resolved conversation. Takes no parameters.",
    promptSnippet: "Consult a stronger reviewer for a plan, correction, or stop signal",
    promptGuidelines: [
      "Call `advisor` before committing to a risky or ambiguous approach, when progress is not converging, or before declaring a multi-step task complete.",
      "After the result, surface its key guidance to the user and reconcile it with primary evidence rather than following it blindly.",
    ],
    parameters: Type.Object({}),
    async execute(toolCallId, _params, signal, onUpdate, ctx) {
      return runManualConsultation(toolCallId, ctx, signal, onUpdate);
    },
  });

  pi.on("tool_result", (event, ctx) => {
    if (!ownsAdvisorRuntime()
      || !automaticAdvisorEnabled(config)
      || config.reviewEveryToolResults === 0
      || todoHost.monitored()) return;
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
    if (!ownsAdvisorRuntime() || !automaticAdvisorEnabled(config) || todoHost.monitored()) return;
    toolResultsSinceEvaluation = 0;
    toolCheckpoints = [];
    const tail = serializeTranscriptTail(
      (event as { messages: AgentMessage[] }).messages,
      config.maxTailMessages,
      config.maxTailChars,
    );
    enqueueEvaluation(tail, ctx, "agent_end");
  });

  pi.on("session_start", (_event, ctx) => loadWorkspaceConfig(ctx, true));
  pi.on("before_agent_start", async (_event, ctx) => {
    await ensureWorkspaceConfig(ctx);
    syncManualTool(ctx);
  });
  pi.on("model_select", async (event, ctx) => {
    resetAdvisorLifecycle();
    await ensureWorkspaceConfig(ctx);
    syncManualTool(ctx, event.model, pi.getThinkingLevel());
  });
  pi.on("thinking_level_select", async (event, ctx) => {
    resetAdvisorLifecycle();
    await ensureWorkspaceConfig(ctx);
    syncManualTool(ctx, ctx.model, event.level);
  });
  pi.on("session_compact", () => resetAdvisorLifecycle());
  pi.on("session_before_switch", () => { activeContext = undefined; resetAdvisorLifecycle(); });
  pi.on("session_before_fork", () => { activeContext = undefined; resetAdvisorLifecycle(); });
  pi.on("session_shutdown", () => {
    lifecycleController.abort();
    pendingEvaluations.length = 0;
    todoHost.close();
    activeContext = undefined;
    resetAdvisorSessionState();
    configGeneration++;
    configCwd = undefined;
    configLoadPromise = undefined;
  });

  async function handleAdvisorCommand(args: string, ctx: ExtensionCommandContext): Promise<void> {
    const generation = ownershipGeneration;
    if (!ownsAdvisorRuntime(generation)) return;
    await ensureWorkspaceConfig(ctx);
    if (!ownsAdvisorRuntime(generation)) return;
    const rawArgs = args.trim();
      const trimmed = rawArgs.toLowerCase();
      if (trimmed === "todo" || trimmed === "settings") {
        const configEpoch = configGeneration;
        const signal = lifecycleController.signal;
        const configuredFingerprint = JSON.stringify(storedConfig);
        const panelCwd = ctx.cwd;
        const panelSession = ctx.sessionManager?.getSessionId?.();
        const panelCurrent = (): boolean => {
          try {
            return ownsAdvisorRuntime(generation) && configEpoch === configGeneration && !signal.aborted
              && JSON.stringify(storedConfig) === configuredFingerprint && ctx.cwd === panelCwd
              && ctx.sessionManager?.getSessionId?.() === panelSession
              && activeContext?.cwd === panelCwd && activeContext.sessionManager?.getSessionId?.() === panelSession;
          } catch { return false; }
        };
        const { showAdvisorTodoSettings } = await import("../tui/advisor-todo-settings.ts");
        if (!panelCurrent()) return;
        await showAdvisorTodoSettings(ctx, {
          configured: storedConfig, effective: config,
          models: ctx.modelRegistry.getAvailable().map((model) => `${model.provider}/${model.id}`), signal,
          isCurrent: panelCurrent,
          save: async (next) => {
            if (!panelCurrent()) throw new Error("Advisor settings are stale; reopen the panel.");
            return commitConfig(next, ctx, "Advisor Todo settings saved.");
          },
        });
        return;
      }
      if (trimmed === "todo on" || trimmed === "todo off") {
        await commitConfig({ ...storedConfig, todoReview: { ...storedConfig.todoReview, enabled: trimmed === "todo on" } }, ctx,
          `Todo review ${trimmed === "todo on" ? "enabled (Advisor master switch unchanged)" : "disabled"}.`);
        return;
      }
      if (trimmed.startsWith("todo mode ")) {
        const mode = trimmed.slice("todo mode ".length).trim();
        if (mode !== "active" && mode !== "shadow") { ctx.ui.notify("Usage: /advisor todo mode <active|shadow>", "warning"); return; }
        await commitConfig({ ...storedConfig, todoReview: { ...storedConfig.todoReview, mode } }, ctx, `Todo review mode: ${mode}`);
        return;
      }
      if (trimmed.startsWith("todo ")) {
        ctx.ui.notify("Usage: /advisor todo (settings) | todo on|off | todo mode active|shadow. Thresholds: .pi/advisor.json todoReview or settings panel.", "info");
        return;
      }
      if (trimmed === "on") {
        await commitConfig(
          { ...storedConfig, enabled: true },
          ctx,
          config.mode === "manual"
            ? "Advisor enabled in manual consultation mode."
            : config.mode === "hybrid"
              ? "Advisor enabled in hybrid automatic + manual mode."
              : "Advisor enabled. Evaluations run in the background and inject results when ready.",
        );
        return;
      }
      if (trimmed === "off") {
        await commitConfig({ ...storedConfig, enabled: false }, ctx, "Advisor disabled.");
        return;
      }
      if (trimmed === "mode") {
        ctx.ui.notify("Usage: /advisor mode <automatic|manual|hybrid>", "info");
        return;
      }
      if (trimmed.startsWith("mode ")) {
        const requested = trimmed.slice("mode ".length).trim();
        if (!isAdvisorMode(requested)) {
          ctx.ui.notify(`Unknown Advisor mode: ${requested}`, "warning");
          return;
        }
        await commitConfig({ ...storedConfig, mode: requested }, ctx, `Advisor mode: ${requested}`);
        return;
      }
      if (trimmed === "model") {
        ctx.ui.notify("Usage: /advisor model <provider/model|inherit>", "info");
        return;
      }
      if (trimmed.startsWith("model ")) {
        const requested = rawArgs.slice(rawArgs.indexOf(" ") + 1).trim();
        if (["inherit", "main", "default", "auto"].includes(requested.toLowerCase())) {
          const { model: _ignored, ...rest } = storedConfig;
          await commitConfig(rest, ctx, "Advisor model now inherits the active main-session model.");
          return;
        }
        await ctx.modelRegistry.refresh();
        if (!ownsAdvisorRuntime(generation)) return;
        const available = ctx.modelRegistry.getAvailable()
          .map((model) => `${model.provider}/${model.id}`);
        if (!available.includes(requested)) {
          ctx.ui.notify(`Advisor model is unavailable: ${requested}`, "warning");
          return;
        }
        await commitConfig({ ...storedConfig, model: requested }, ctx, `Advisor dedicated model: ${requested}`);
        return;
      }
      if (trimmed === "thinking") {
        ctx.ui.notify("Usage: /advisor thinking <minimal|low|medium|high|xhigh|max|default>", "info");
        return;
      }
      if (trimmed.startsWith("thinking ")) {
        const requested = trimmed.slice("thinking ".length).trim();
        const level = requested === "default" ? DEFAULT_ADVISOR_CONFIG.consultThinking : requested;
        if (!isAdvisorThinkingLevel(level)) {
          ctx.ui.notify(`Unknown Advisor thinking level: ${requested}`, "warning");
          return;
        }
        const reference = resolveAdvisorModel(config, ctx.model);
        const slash = reference?.indexOf("/") ?? -1;
        const model = reference && slash > 0
          ? ctx.modelRegistry.find(reference.slice(0, slash), reference.slice(slash + 1))
          : undefined;
        if (model && !getSupportedThinkingLevels(model).includes(level)) {
          ctx.ui.notify(`Advisor model ${reference} does not support thinking level ${level}.`, "warning");
          return;
        }
        await commitConfig({ ...storedConfig, consultThinking: level }, ctx, `Advisor consultation thinking: ${level}`);
        return;
      }

      const activeModel = resolveAdvisorModel(config, ctx.model);
      const toolActive = pi.getActiveTools().includes("advisor");
      const blocked = isAdvisorExecutorBlocked(config, ctx.model, pi.getThinkingLevel());
      const lines = [
        `ADVISOR ${config.enabled ? "on" : "off"} · ${config.mode}`,
        `  owner: ${getAdvisorRuntimeOwner() ?? "unavailable"}`,
        `  config: ${configSource}${configEnvOverridden ? " + env" : ""}`,
        `  model: ${activeModel ?? "unavailable"}${config.model ? " (dedicated)" : " (main session)"}`,
        `  manual tool: ${toolActive ? "active" : blocked ? "blocked for executor" : "inactive"} · thinking: ${config.consultThinking}`,
        `  cadence: ${automaticAdvisorEnabled(config)
          ? config.reviewEveryToolResults === 0 ? "agent end only" : `every ${config.reviewEveryToolResults} tool results + agent end`
          : "automatic reviews disabled"}`,
        `  background: ${evaluationInFlight ? "running" : "idle"}${pendingEvaluations.length ? ` · pending ${pendingEvaluations.length} checkpoint(s)` : ""}`,
        `  todo review: ${config.todoReview.enabled ? config.todoReview.mode : "off"} · /advisor todo (settings) · ${config.todoReview.reviewSteps} steps OR ${config.todoReview.reviewActiveMs}ms effective · failures ${config.todoReview.sameFailureLimit}`,
        `  todo escalation: reflection + ${config.todoReview.reflectionSteps} steps; unresolved ${config.todoReview.unresolvedSteps} steps OR ${config.todoReview.unresolvedActiveMs}ms · max ${config.todoReview.maxReviewsPerTask} reviews / ${config.todoReview.maxEscalationsPerTask} escalations per task`,
        `  automatic budget: ${automaticReviews}/${config.maxAutomaticReviewsPerSession || "unlimited"} · cooldown: ${config.automaticReviewCooldownMs}ms`,
        `  delivery cooldown: ${config.cooldownMs}ms · tail: ${config.maxTailMessages} msgs / ${config.maxTailChars} chars`,
        config.guide ? `  guide: ${config.guide.slice(0, 120)}${config.guide.length > 120 ? "…" : ""}` : "  guide: (none)",
        `  last automatic: ${state.lastStatus ?? "never"}${state.lastEvaluatedAt ? ` · ${new Date(state.lastEvaluatedAt).toLocaleTimeString()}` : ""}`,
        `  TODO shadow records: ${state.todoShadowReviews ?? 0}`,
        state.lastTodoReview ? `  last TODO: #${state.lastTodoReview.taskId} @${state.lastTodoReview.actor} · ${state.lastTodoReview.status} · confidence ${state.lastTodoReview.confidence} · ${state.lastTodoReview.layer}${state.lastTodoReview.shadow ? " · shadow" : ""}${state.lastTodoReview.degradedReason ? ` · ${state.lastTodoReview.degradedReason}` : ""}` : "  last TODO: (none)",
        `  evaluations: ${state.evaluations} · failures: ${state.failures} · uneventful: ${state.uneventful}`,
        `  deliveries: ${state.deliveries} · suppressed: ${state.suppressed}`,
        `  consultations: ${consultations} · failures: ${consultationFailures}${lastConsultedAt ? ` · last ${new Date(lastConsultedAt).toLocaleTimeString()}` : ""}`,
        state.lastModel ? `  resolved automatic model: ${state.lastModel}` : "  resolved automatic model: (none yet)",
        state.lastError ? `  last error: ${state.lastError.slice(0, 200)}` : "  last error: (none)",
      ];
    ctx.ui.notify(lines.join("\n"), "info");
  }

  todoHost = new TodoReviewHost(pi, config.todoReview, {
    enabled: () => ownsAdvisorRuntime() && automaticAdvisorEnabled(config) && config.todoReview.enabled,
    context: () => activeContext,
    review: (ticket, ctx, steer) => {
      if (pendingEvaluations.length >= 64) { todoHost.monitor.release(ticket); return; }
      pendingEvaluations.push({ tail: todoReflection(ticket), ctx, source: "todo_progress", ownershipGeneration, ticket, steer });
      void drainEvaluationQueue();
    },
  });
  advisorRuntimeLease = registerAdvisorRuntime({
    id: "pi-maestro-flow/advisor",
    priority: 100,
    handleCommand: handleAdvisorCommand,
    onOwnershipChanged: handleAdvisorOwnershipChanged,
  });
  ensureAdvisorCommandRegistered(pi);
}

// Re-export runtime surface for tests and future consumers.
export { ADVISOR_OUTPUT_SCHEMA, DEFAULT_ADVISOR_CONFIG } from "./runtime.ts";
