import { resolve } from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { DecisionPolicy, PolicyDomain } from "./config.ts";

export const DECISION_POLICY_STATUS_KEY = "decision-policy";
interface Identity {
  cwd: string;
  sessionManager: Pick<ExtensionContext["sessionManager"], "getSessionId">;
}
type Backend = "none" | "classifier" | "llm";
type Phase = "loading" | "classifying" | "advising" | "waiting-user";
interface Outcome {
  backend?: Backend;
  owner?: "internal" | "external" | "uncertain";
  mode?: "off" | "shadow" | "enforce";
  advice?: boolean;
  worthCapturing?: boolean;
  degraded?: boolean;
  cancelled?: boolean;
  humanAnswered?: boolean;
}
interface Operation { seq: number; domain: PolicyDomain; phase: Phase; backend: Backend; }
interface Result { seq: number; label: string; mark: string; backend?: Backend; }
interface StatusState {
  cwd: string;
  loaded: boolean;
  invalid: boolean;
  policy?: DecisionPolicy;
  configuring: boolean;
  active: Map<symbol, Operation>;
  seq: number;
  result?: Result;
  backend: Backend;
  emit: (text: string | undefined) => void;
  lastText?: string;
}
const registryKey = Symbol.for("pi-maestro-flow.decision-policy.status");
const globals = globalThis as typeof globalThis & { [registryKey]?: Map<string, StatusState> };
const states = globals[registryKey] ??= new Map<string, StatusState>();
const phaseNames: Record<Phase, string> = { loading: "读取规范", classifying: "判别中", advising: "生成建议", "waiting-user": "等待用户" };
const priority: Record<Phase, number> = { loading: 0, classifying: 1, advising: 2, "waiting-user": 3 };
const backendName = (backend: Backend): string => backend === "classifier" ? "CLF" : backend === "llm" ? "LLM" : "";
function format(state: StatusState): string {
  const policy = state.policy;
  const configuration = state.invalid ? "规范无效" : !state.loaded ? "加载中" : !policy ? "未配置" : `A:${policy.ask.mode} E:${policy.selfEvolve.mode}`;
  if (state.configuring) return `DEC ? ${configuration} · 配置中`;
  const active = [...state.active.values()].sort((a, b) => priority[b.phase] - priority[a.phase] || b.seq - a.seq)[0];
  const actualBackend = backendName(active?.backend && active.backend !== "none" ? active.backend : state.result?.backend ?? state.backend);
  const backend = actualBackend || (policy && (policy.ask.mode !== "off" || policy.selfEvolve.mode !== "off") ? policy.backend : "");
  const label = active ? `${active.domain === "ask" ? "问答" : "自进化"} ${phaseNames[active.phase]}${state.active.size > 1 ? ` ×${state.active.size}` : ""}` : state.result?.label;
  const mark = active ? active.phase === "waiting-user" ? "?" : "▶" : state.invalid ? "!" : state.result?.mark ?? "○";
  return [`DEC ${mark} ${configuration}`, backend, label].filter(Boolean).join(" · ");
}
function publish(sessionId: string, state: StatusState): void {
  if (states.get(sessionId) !== state) return;
  const text = format(state);
  if (state.lastText === text) return;
  try { state.emit(text); state.lastText = text; }
  catch (error) { console.warn("[decision-policy] Status publication failed:", error instanceof Error ? error.message : String(error)); }
}

/** One host footer producer per session; never owns or replaces the footer itself. */
export function connectDecisionPolicyStatus(ctx: Identity, emit: StatusState["emit"]) {
  const sessionId = ctx.sessionManager.getSessionId();
  const state: StatusState = { cwd: resolve(ctx.cwd), loaded: false, invalid: false, configuring: false, active: new Map(), seq: 0, backend: "none", emit };
  states.set(sessionId, state);
  publish(sessionId, state);
  return {
    configure(policy: DecisionPolicy | undefined, invalid = false): void {
      if (states.get(sessionId) !== state) return;
      state.policy = policy; state.loaded = true; state.invalid = invalid;
      publish(sessionId, state);
    },
    dispose(): void {
      if (states.get(sessionId) !== state) return;
      states.delete(sessionId);
      try { emit(undefined); }
      catch (error) { console.warn("[decision-policy] Status cleanup failed:", error instanceof Error ? error.message : String(error)); }
    },
  };
}
export function configureDecisionPolicyStatus(ctx: Identity, policy: DecisionPolicy): void {
  const id = ctx.sessionManager.getSessionId();
  const state = states.get(id);
  if (!state || state.cwd !== resolve(ctx.cwd)) return;
  state.policy = policy; state.loaded = true; state.invalid = false;
  publish(id, state);
}
export function setDecisionPolicyConfiguring(ctx: Identity, configuring: boolean): void {
  const id = ctx.sessionManager.getSessionId();
  const state = states.get(id);
  if (!state || state.cwd !== resolve(ctx.cwd)) return;
  state.configuring = configuring;
  publish(id, state);
}
export function resetDecisionPolicyStatus(sessionId: string): void {
  const state = states.get(sessionId);
  if (!state) return;
  state.active.clear(); state.result = undefined; state.backend = "none";
  publish(sessionId, state);
}

/** Tokens fence late completions; human replies outrank settled background work. */
export function beginDecisionPolicyStatus(ctx: Identity, domain: PolicyDomain, phase: Phase, backend: Backend = "none") {
  const id = ctx.sessionManager.getSessionId();
  const state = states.get(id);
  const token = Symbol(domain);
  const operation: Operation = { seq: state ? ++state.seq : 0, domain, phase, backend };
  const current = (): boolean => {
    if (!state || states.get(id) !== state || state.active.get(token) !== operation) return false;
    try {
      return ctx.sessionManager.getSessionId() === id && resolve(ctx.cwd) === state.cwd;
    } catch {
      state.active.delete(token); // Old Pi context getters can be invalidated before status disposal.
      return false;
    }
  };
  if (state) { state.active.set(token, operation); if (backend !== "none") state.backend = backend; publish(id, state); }
  return {
    update(nextPhase: Phase, nextBackend: Backend): void {
      if (!current()) return;
      operation.phase = nextPhase; operation.backend = nextBackend;
      if (nextBackend !== "none") state!.backend = nextBackend;
      publish(id, state!);
    },
    finish(outcome: Outcome): void {
      if (!current()) return;
      state!.active.delete(token);
      if (!state!.result || operation.seq >= state!.result.seq || operation.phase === "waiting-user") {
        if (outcome.backend && outcome.backend !== "none") state!.backend = outcome.backend;
        const result: Result = outcome.cancelled ? { seq: operation.seq, label: "已取消", mark: "○" }
          : outcome.degraded ? { seq: operation.seq, label: "已降级", mark: "!" }
          : outcome.humanAnswered ? { seq: operation.seq, label: "真人已答", mark: "✓" }
          : outcome.mode === "shadow" ? { seq: operation.seq, label: "仅观察", mark: "○" }
          : domain === "evolve-capture" ? { seq: operation.seq, label: outcome.worthCapturing ? "知识候选" : "跳过噪声", mark: "○" }
          : outcome.owner === "internal" && outcome.advice ? { seq: operation.seq, label: "内部建议", mark: "✓" }
          : { seq: operation.seq, label: "外部决策", mark: "?" };
        state!.result = { ...result, backend: outcome.backend && outcome.backend !== "none" ? outcome.backend : operation.backend !== "none" ? operation.backend : state!.backend };
      }
      publish(id, state!);
    },
  };
}
