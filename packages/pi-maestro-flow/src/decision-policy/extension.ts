import { resolve } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { DecisionPolicySchema, defaultDecisionPolicy, loadDecisionPolicy, saveDecisionPolicy, type DecisionPolicy } from "./config.ts";
import { invalidateDecisionPolicySession } from "./service.ts";
import { registerDecisionPolicyDomains, POLICY_CLASSIFY_NAMES } from "./domains.ts";
import { classifierStatus } from "pi-maestro-teammate/v1/classify";
import { configureDecisionPolicyStatus, connectDecisionPolicyStatus, DECISION_POLICY_STATUS_KEY, setDecisionPolicyConfiguring } from "./status.ts";

const TOOL = "policy_config";
type IdentityContext = Pick<ExtensionContext, "cwd" | "sessionManager">;
interface Lane {
  key: string;
  cwd: string;
  sessionId: string;
  host: IdentityContext;
  revision?: number;
  draft?: DecisionPolicy;
  busy: boolean;
  close: () => void;
}
interface Registry {
  lanes: Map<string, Lane>;
  owners: WeakMap<ExtensionAPI, () => void>;
}
// Survives extension reload so the prior generation can revoke its own activation.
const registrySymbol = Symbol.for("pi-maestro-flow.decision-policy.config-lanes");
const globals = globalThis as typeof globalThis & { [registrySymbol]?: Registry };
const registry = globals[registrySymbol] ??= { lanes: new Map(), owners: new WeakMap() };
const keyFor = (cwd: string, sessionId: string): string => `${resolve(cwd)}\0${sessionId}`;
const isChild = (): boolean => process.env.PI_TEAMMATE_CHILD === "1" || process.env.PI_TEAMMATE_MANAGED_WINDOW === "1";

/** Host-only configuration marker used to keep ask decisions human during editing. */
export function isDecisionPolicyConfiguring(ctx: IdentityContext): boolean;
export function isDecisionPolicyConfiguring(cwd: string, sessionId: string): boolean;
export function isDecisionPolicyConfiguring(ctxOrCwd: IdentityContext | string, sessionId?: string): boolean {
  if (isChild()) return false;
  const cwd = typeof ctxOrCwd === "string" ? ctxOrCwd : ctxOrCwd.cwd;
  const id = typeof ctxOrCwd === "string" ? sessionId : ctxOrCwd.sessionManager.getSessionId();
  if (!id) return false;
  const lane = registry.lanes.get(keyFor(cwd, id));
  if (!lane) return false;
  try {
    if (keyFor(lane.host.cwd, lane.host.sessionManager.getSessionId()) === lane.key) return true;
  } catch {
    lane.close();
    return false; // The host can invalidate context getters during a switch.
  }
  lane.close();
  return false;
}

const parameters = Type.Object({
  action: Type.Union([Type.Literal("read"), Type.Literal("propose"), Type.Literal("commit"), Type.Literal("cancel")]),
  draft: Type.Optional(Type.Unknown()),
  expectedRevision: Type.Optional(Type.Integer({ minimum: 0 })),
}, { additionalProperties: false });
const result = (details: Record<string, unknown>) => ({ content: [{ type: "text" as const, text: JSON.stringify(details, null, 2) }], details });

function runtimeSettings(policy: DecisionPolicy): string {
  const { description: _description, rules: _rules, specIds: _specIds, revision: _revision, ...settings } = policy;
  return JSON.stringify(settings);
}

function featureSettings(policy: DecisionPolicy): string {
  return JSON.stringify({ description: policy.description, rules: policy.rules, specIds: policy.specIds });
}

export interface DecisionPolicyPanel {
  readonly policy: DecisionPolicy;
  save(draft: DecisionPolicy, expectedRevision: number, signal?: AbortSignal): Promise<DecisionPolicy | undefined>;
  close(): void;
}

/** Trusted command UI only; this capability is never exposed as a model tool. */
export async function openDecisionPolicyPanel(ctx: ExtensionContext): Promise<DecisionPolicyPanel> {
  if (isChild() || !ctx.hasUI || !ctx.ui.confirm || ctx.signal?.aborted) {
    throw new Error("Decision policy settings require the interactive parent session.");
  }
  const cwd = resolve(ctx.cwd);
  const sessionId = ctx.sessionManager.getSessionId();
  if (!sessionId) throw new Error("Decision policy settings require an active session.");
  const key = keyFor(cwd, sessionId);
  registry.lanes.get(key)?.close();
  const identity = { cwd, sessionManager: { getSessionId: () => sessionId } };
  const lifetimeSignal = ctx.signal;
  const onAbort = (): void => current.close();
  const current: Lane = {
    key, cwd, sessionId, host: ctx, busy: false,
    close() {
      lifetimeSignal?.removeEventListener("abort", onAbort);
      if (registry.lanes.get(key) !== current) return;
      registry.lanes.delete(key);
      setDecisionPolicyConfiguring(identity, false);
    },
  };
  const authorized = (signal?: AbortSignal): void => {
    const fresh = (): boolean => {
      try {
        return !isChild() && ctx.hasUI && !lifetimeSignal?.aborted && !signal?.aborted
          && registry.lanes.get(key) === current && keyFor(ctx.cwd, ctx.sessionManager.getSessionId()) === key;
      } catch {
        return false; // Context getters can be invalidated by the host.
      }
    };
    if (!fresh()) {
      current.close();
      throw new Error("Decision policy settings changed or closed; reopen /classifier.");
    }
  };
  registry.lanes.set(key, current);
  setDecisionPolicyConfiguring(identity, true);
  lifetimeSignal?.addEventListener("abort", onAbort, { once: true });
  try {
    let policy = await loadDecisionPolicy(cwd) ?? defaultDecisionPolicy();
    authorized();
    return {
      get policy() { return DecisionPolicySchema.parse(policy); },
      close: () => current.close(),
      async save(input, expectedRevision, signal) {
        authorized(signal);
        if (current.busy) throw new Error("Decision policy operation already in progress; cancel or wait.");
        current.busy = true;
        const onSaveAbort = (): void => current.close();
        signal?.addEventListener("abort", onSaveAbort, { once: true });
        try {
          const draft = DecisionPolicySchema.parse(input);
          const persisted = await loadDecisionPolicy(cwd) ?? defaultDecisionPolicy();
          authorized(signal);
          if (draft.revision !== expectedRevision || persisted.revision !== expectedRevision) throw new Error("Decision policy revision conflict; reopen /classifier.");
          if (featureSettings(draft) !== featureSettings(persisted)) throw new Error("Use /skill:decision-policy to change confirmed feature rules.");
          const confirmed = await ctx.ui.confirm("Save decision policy settings?", `Workspace: ${cwd}\nSession: ${sessionId}\nExpected revision: ${expectedRevision}\nClassifier effective settings vs policy fallback (runtime snapshot):\n${JSON.stringify(backendSummary(draft), null, 2)}\nExact draft (saved revision becomes ${expectedRevision + 1}):\n${JSON.stringify(draft, null, 2)}`);
          authorized(signal);
          if (!confirmed) return undefined;
          policy = await saveDecisionPolicy(cwd, draft, expectedRevision, () => authorized(signal));
          invalidateDecisionPolicySession(sessionId);
          configureDecisionPolicyStatus(identity, policy);
          return DecisionPolicySchema.parse(policy);
        } catch (error) {
          current.close();
          throw error;
        } finally {
          current.busy = false;
          signal?.removeEventListener("abort", onSaveAbort);
        }
      },
    };
  } catch (error) {
    current.close();
    throw error;
  }
}

function backendSummary(policy: DecisionPolicy) {
  const status = classifierStatus();
  return {
    classifierEffectiveSettings: {
      enabled: status.enabled,
      runtimeAvailable: status.runtimeStatus === "available",
      runtimeStatus: status.runtimeStatus ?? "unknown",
      runtimeReason: status.runtimeReason,
      endpoint: status.endpoint ?? "auto",
      model: status.model ?? "auto",
      effectiveModel: status.effectiveModel,
      callsUsed: status.callsUsed,
      maxCallsPerSession: status.maxCalls,
      domainModes: Object.fromEntries(Object.values(POLICY_CLASSIFY_NAMES).map((name) => [name, status.domains[name]?.mode ?? "off"])),
    },
    policySettings: { backend: policy.backend, ask: policy.ask.mode, selfEvolve: policy.selfEvolve.mode, classification: policy.classification, advice: policy.advice },
    fallback: policy.backend === "auto"
      ? "Auto tries a usable classifier in jev mode, then falls back to the policy classification LLM within its budget. Classifier off/shadow is not policy off/shadow. Unavailable models, exhausted budgets or uncertain/low-confidence results fall back to the human."
      : policy.backend === "classifier"
        ? "Classifier-only: no LLM classification fallback. Disabled/unavailable classifier or non-jev domain falls back to the human. Policy advice still uses its separately configured LLM."
        : "LLM-only: bypass classifier for classification; use policy classification/advice model settings. Unavailable models, exhausted budgets or uncertain/low-confidence results fall back to the human.",
  };
}

/** Only raw, interactive /skill input authorizes this otherwise dormant tool. */
export function registerDecisionPolicy(pi: ExtensionAPI): () => void {
  registry.owners.get(pi)?.();
  // Make /classifier mode controls discoverable before any policy model call.
  registerDecisionPolicyDomains();
  let lane: Lane | undefined;
  let disposed = false;
  let activeSessionId: string | undefined;
  let activeKey: string | undefined;
  let footerStatus: ReturnType<typeof connectDecisionPolicyStatus> | undefined;
  let generation = 0;
  const unsubscribers: Array<() => void> = [];
  const close = (): void => {
    lane?.close();
    if (activeKey) registry.lanes.get(activeKey)?.close();
  };
  const resetSession = (ctx?: ExtensionContext): void => {
    generation++;
    close();
    footerStatus?.dispose();
    footerStatus = ctx ? connectDecisionPolicyStatus(ctx, (text) => ctx.ui.setStatus?.(DECISION_POLICY_STATUS_KEY, text)) : undefined;
    const previous = activeSessionId;
    if (previous) invalidateDecisionPolicySession(previous);
    activeSessionId = ctx?.sessionManager.getSessionId();
    activeKey = ctx && activeSessionId ? keyFor(ctx.cwd, activeSessionId) : undefined;
    if (activeSessionId && activeSessionId !== previous) invalidateDecisionPolicySession(activeSessionId);
  };
  const dispose = (): void => {
    if (disposed) return;
    disposed = true;
    resetSession();
    for (const unsubscribe of unsubscribers) unsubscribe();
    if (registry.owners.get(pi) === dispose) registry.owners.delete(pi);
  };
  registry.owners.set(pi, dispose);
  async function refreshFooter(ctx: ExtensionContext): Promise<void> {
    const footer = footerStatus;
    const epoch = generation;
    const sessionId = ctx.sessionManager.getSessionId();
    const cwd = ctx.cwd;
    try {
      const policy = await loadDecisionPolicy(cwd);
      if (!disposed && epoch === generation && sessionId === activeSessionId && cwd === ctx.cwd) footer?.configure(policy);
    } catch {
      if (!disposed && epoch === generation && sessionId === activeSessionId && cwd === ctx.cwd) footer?.configure(undefined, true);
    }
  }
  const authorized = (candidate: Lane, ctx: ExtensionContext, signal?: AbortSignal): void => {
    if (disposed || isChild() || !ctx.hasUI || signal?.aborted || lane !== candidate
      || registry.lanes.get(candidate.key) !== candidate
      || keyFor(ctx.cwd, ctx.sessionManager.getSessionId()) !== candidate.key
      || keyFor(candidate.host.cwd, candidate.host.sessionManager.getSessionId()) !== candidate.key) {
      candidate.close();
      throw new Error("Decision policy configuration requires a fresh interactive /skill:decision-policy invocation in this session.");
    }
  };

  pi.registerTool({
    name: TOOL,
    label: "Decision policy configuration",
    description: "Manual Skill feature rules only (description/rules/specIds). read returns policy/revision; propose preserves all runtime settings and validates a complete draft with expectedRevision; commit confirms that exact staged draft in the host UI then CAS saves; cancel revokes the lane. Use /classifier for models, modes and budgets. No approval or identity argument grants authorization.",
    exposure: "model-only",
    defaultActive: false,
    parameters,
    async execute(_id, params, signal, _onUpdate, ctx) {
      const current = lane;
      if (!current) throw new Error("Run /skill:decision-policy interactively before using policy_config.");
      authorized(current, ctx, signal);
      if (params.action === "cancel") {
        current.close();
        return result({ cancelled: true });
      }
      // Refuse parallel mutation/read rather than letting a late read replace a confirmed draft.
      if (current.busy) throw new Error("Decision policy operation already in progress; cancel or wait.");
      current.busy = true;
      const onAbort = (): void => current.close();
      signal?.addEventListener("abort", onAbort, { once: true });
      try {
        if (params.action === "read" || params.action === "propose") {
          const persisted = await loadDecisionPolicy(current.cwd);
          const policy = persisted ?? defaultDecisionPolicy();
          authorized(current, ctx, signal);
          footerStatus?.configure(persisted);
          if (params.action === "read") {
            current.revision = policy.revision;
            current.draft = undefined;
            return result({ policy, expectedRevision: policy.revision, configuring: true, backendSummary: backendSummary(policy) });
          }
          if (params.expectedRevision !== policy.revision) throw new Error("Decision policy revision conflict; read and propose again.");
          const draft = DecisionPolicySchema.parse(params.draft);
          if (draft.revision !== policy.revision) throw new Error("Draft revision must match expectedRevision.");
          if (runtimeSettings(draft) !== runtimeSettings(policy)) throw new Error("Use /classifier for runtime settings; the Skill may only change feature rules.");
          current.revision = policy.revision;
          current.draft = draft;
          return result({ draft, expectedRevision: policy.revision, confirmationRequired: true, backendSummary: backendSummary(draft) });
        }
        if (params.action !== "commit") throw new Error("Unknown policy_config action.");
        if (params.draft !== undefined) throw new Error("Commit uses only the previously proposed draft; propose changes first.");
        if (!current.draft || params.expectedRevision !== current.revision) throw new Error("Propose a draft at the current revision before committing.");
        const draft = current.draft;
        const revision = current.revision!;
        const policy = await loadDecisionPolicy(current.cwd);
        authorized(current, ctx, signal);
        if ((policy?.revision ?? 0) !== revision) throw new Error("Decision policy revision conflict; read and confirm a new draft.");
        const confirmed = await ctx.ui.confirm("Save decision policy?", `Workspace: ${current.cwd}\nSession: ${current.sessionId}\nExpected revision: ${revision}\nClassifier effective settings vs policy fallback (runtime snapshot):\n${JSON.stringify(backendSummary(draft), null, 2)}\nExact draft (saved revision becomes ${revision + 1}):\n${JSON.stringify(draft, null, 2)}`);
        // UI is an awaited trust boundary: cancellation, reload, switching or abort wins.
        authorized(current, ctx, signal);
        if (current.draft !== draft || current.revision !== revision) throw new Error("Decision policy draft changed during confirmation.");
        if (!confirmed) {
          current.close();
          return result({ cancelled: true, saved: false });
        }
        const saved = await saveDecisionPolicy(current.cwd, draft, revision, () => authorized(current, ctx, signal));
        // A completed save must not revive a lane cancelled while persistence was in flight.
        current.close();
        invalidateDecisionPolicySession(current.sessionId);
        if (activeSessionId === current.sessionId && ctx.cwd === current.cwd) footerStatus?.configure(saved);
        return result({ saved: true, policy: saved });
      } catch (error) {
        current.close();
        throw error;
      } finally {
        current.busy = false;
        signal?.removeEventListener("abort", onAbort);
      }
    },
  });

  unsubscribers.push(pi.on("input", async (event, ctx) => {
    const match = /^\/skill:decision-policy(?:\s+([\s\S]*))?$/.exec(event.text.trim());
    if (!match || event.source !== "interactive") return { action: "continue" as const };
    if (disposed || isChild() || !ctx.hasUI || event.images?.length) {
      close();
      ctx.ui.notify("Decision policy configuration requires the interactive parent session, without images.", "warning");
      return { action: "handled" as const };
    }
    const args = match[1]?.trim() ?? "";
    if (args === "cancel") {
      close();
      ctx.ui.notify("Decision policy configuration cancelled.", "info");
      return { action: "handled" as const };
    }
    if (args === "status") {
      try {
        const policy = await loadDecisionPolicy(ctx.cwd) ?? defaultDecisionPolicy();
        ctx.ui.notify(JSON.stringify({ policy, configuring: isDecisionPolicyConfiguring(ctx) }, null, 2), "info");
      } catch (error) { ctx.ui.notify(String(error), "error"); }
      return { action: "handled" as const };
    }
    close();
    const sessionId = ctx.sessionManager.getSessionId();
    if (!sessionId) return { action: "handled" as const };
    if (activeSessionId && activeSessionId !== sessionId) invalidateDecisionPolicySession(activeSessionId);
    activeSessionId = sessionId;
    const cwd = resolve(ctx.cwd);
    const key = keyFor(cwd, sessionId);
    activeKey = key;
    registry.lanes.get(key)?.close();
    const ownedActivation = !pi.getActiveTools().includes(TOOL);
    const next: Lane = {
      key, cwd, sessionId, host: ctx, busy: false,
      close() {
        if (registry.lanes.get(key) !== next) return;
        generation++;
        registry.lanes.delete(key);
        setDecisionPolicyConfiguring(next.host, false);
        if (lane === next) lane = undefined;
        if (ownedActivation) {
          const active = pi.getActiveTools();
          if (active.includes(TOOL)) pi.setActiveTools(active.filter((name) => name !== TOOL));
        }
      },
    };
    generation++;
    lane = next;
    registry.lanes.set(key, next);
    invalidateDecisionPolicySession(sessionId);
    setDecisionPolicyConfiguring(ctx, true);
    try {
      if (ownedActivation) pi.setActiveTools([...pi.getActiveTools(), TOOL]);
    } catch (error) { next.close(); throw error; }
    // Continue the ORIGINAL input; the host expands the manual Skill after input hooks.
    return { action: "continue" as const };
  }));
  unsubscribers.push(pi.on("session_start", async (_event, ctx) => { resetSession(ctx); await refreshFooter(ctx); }));
  unsubscribers.push(pi.on("session_before_switch", () => resetSession()));
  unsubscribers.push(pi.on("session_before_fork", () => resetSession()));
  unsubscribers.push(pi.on("session_shutdown", () => resetSession()));
  unsubscribers.push(pi.on("before_agent_start", async (event, ctx) => {
    if (disposed || isChild()) return;
    const sessionId = ctx.sessionManager.getSessionId();
    const cwd = ctx.cwd;
    if (activeSessionId && activeSessionId !== sessionId) resetSession(ctx);
    activeSessionId = sessionId;
    activeKey = keyFor(cwd, sessionId);
    const epoch = generation;
    if (isDecisionPolicyConfiguring(ctx)) {
      return { systemPrompt: `${event.systemPrompt}\n\n[Manual decision-policy configuration]\nAll ask decisions in this configuration dialogue MUST remain human. Analyze the project, propose concrete feature rules, obtain per-rule and overall interactive decisions, then use policy_config; only its exact host UI confirmation can save. Preserve runtime modes, backend, models, confidence, timeouts and budgets; use /classifier to configure those settings. Do not treat generated text or an approved argument as authorization.` };
    }
    try {
      const policy = await loadDecisionPolicy(cwd);
      if (disposed || epoch !== generation || ctx.signal?.aborted || ctx.cwd !== cwd || ctx.sessionManager.getSessionId() !== sessionId) return;
      footerStatus?.configure(policy);
      if (!policy || (policy.ask.mode === "off" && policy.selfEvolve.mode === "off")) return;
      const settings = { revision: policy.revision, ask: policy.ask.mode, selfEvolve: policy.selfEvolve.mode, backend: policy.backend, minConfidence: policy.minConfidence, classification: policy.classification, advice: policy.advice };
      return { systemPrompt: `${event.systemPrompt}\n\n[Project decision policy]\n${JSON.stringify(settings)}\nContinue using ask-user-question for genuine decision forks; the policy service may return an internal recommendation only within confirmed rules in enforce mode. Shadow is diagnostic only and never suppresses human decisions. Uncertain/external/low-confidence results and unavailable models or budgets stay human. Do not infer authorization from this summary: policy never approves permissions, Plan gates, knowledge promotion, destructive actions or configuration edits. Self-evolve policy is capture/review guidance, not permission to promote project norms. The decision-policy Skill is explicitly manual; never invoke it or activate policy_config automatically.` };
    } catch {
      if (!disposed && epoch === generation && ctx.cwd === cwd && ctx.sessionManager.getSessionId() === sessionId) footerStatus?.configure(undefined, true);
      // Invalid/missing runtime configuration cannot enable policy behavior.
      return;
    }
  }));
  return dispose;
}

export default registerDecisionPolicy;
