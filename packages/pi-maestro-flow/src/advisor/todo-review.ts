import { createHash } from "node:crypto";
import type { ClassifyResult } from "pi-maestro-teammate/v1/classify";
import type { TodoTask } from "../tools/todo.ts";
import { redactAdvisorText } from "./runtime.ts";
import type { TodoProgressInput, TodoProgressLabel, TodoReviewConfig } from "./todo-progress.ts";
export { DEFAULT_TODO_REVIEW_CONFIG, normalizeTodoReviewConfig } from "./todo-progress.ts";
export type { TodoProgressInput, TodoProgressLabel, TodoReviewConfig } from "./todo-progress.ts";
interface TaskState {
  key: string;
  actor: string;
  taskId: string;
  signature: string;
  activation: number | undefined;
  task: string;
  version: number;
  reviewRevision: number;
  steps: number;
  activeMs: number;
  since?: number;
  online: boolean;
  pauses: Set<string>;
  iteration?: { key: string; version: number };
  incarnation: string;
  due: boolean;
  evidence: number;
  outcomes: string[];
  seen: Set<string>;
  failureKey?: string;
  sameFailures: number;
  reviews: number;
  escalations: number;
  baselineSteps: number;
  baselineMs: number;
  reflected?: { steps: number; evidence: number };
  lastReview?: number;
  inFlight: boolean;
  inFlightRevision?: number;
}
export interface TodoReviewTicket {
  key: string;
  actor: string;
  taskId: string;
  version: number;
  reviewRevision: number;
  evidence: number;
  incarnation: string;
  input: TodoProgressInput;
}
const hash = (text: string): string => createHash("sha256").update(text).digest("hex");
const signature = (task: TodoTask): string => JSON.stringify([task.id, task.assignee.id, task.activeStartedAt, task.subject, task.description, task.goalId, task.blockedBy]);

/** Ephemeral host-owned state. No persisted Todo shape changes, status-age timers or token heuristics. */
export class TodoReviewMonitor {
  readonly states = new Map<string, TaskState>();
  readonly active = new Map<string, string>();
  private serial = 0;
  private timer?: ReturnType<typeof setTimeout>;
  constructor(public config: TodoReviewConfig, private readonly now: () => number = Date.now) {}
  reset(config = this.config): void {
    this.config = config;
    this.serial++;
    this.states.clear(); this.active.clear();
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
  }
  fence(config = this.config): void {
    for (const state of this.states.values()) this.offline(state.actor);
    this.config = config;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
  }
  observed(ticket: TodoReviewTicket): void {
    if (!this.fresh(ticket)) return;
    const state = this.get(ticket.actor)!;
    state.baselineSteps = state.steps; state.baselineMs = state.activeMs; state.due = false;
  }
  sync(tasks: readonly TodoTask[]): void {
    const current = new Set<string>();
    for (const task of tasks) {
      if (task.status !== "in_progress" || task.origin) continue;
      const actor = task.assignee.id;
      current.add(actor);
      const previousKey = this.active.get(actor);
      let state = previousKey ? this.states.get(previousKey) : undefined;
      if (!state || state.taskId !== task.id || state.activation !== task.activeStartedAt) {
        if (state) { this.accrue(state); state.version++; state.online = false; state.iteration = undefined; }
        if (this.states.size >= 64) {
          const retired = [...this.states].find(([, candidate]) => this.active.get(candidate.actor) !== candidate.key);
          if (retired) this.states.delete(retired[0]);
          else { this.active.delete(actor); continue; }
        }
        const key = `${++this.serial}:${actor}:${task.id}`;
        state = {
          key, actor, taskId: task.id, signature: signature(task), activation: task.activeStartedAt,
          task: redactAdvisorText(`#${task.id} ${task.subject}\n${task.description ?? ""}`).slice(0, 1600),
          version: this.serial, reviewRevision: 0, steps: 0, activeMs: 0, online: false, pauses: new Set(),
          incarnation: "", due: false, evidence: 0, outcomes: [], seen: new Set(),
          sameFailures: 0, reviews: 0, escalations: 0, baselineSteps: 0, baselineMs: 0, inFlight: false,
        };
        this.states.set(key, state); this.active.set(actor, key);
      } else if (state.signature !== signature(task)) {
        // Task acceptance/ownership evidence changed, but this is not a fresh budget.
        this.accrue(state); state.version++; state.inFlight = false; state.iteration = undefined;
        state.signature = signature(task);
        state.task = redactAdvisorText(`#${task.id} ${task.subject}\n${task.description ?? ""}`).slice(0, 1600);
      }
    }
    for (const [actor, key] of this.active) {
      if (current.has(actor)) continue;
      const state = this.states.get(key);
      if (state) { this.accrue(state); state.version++; state.online = false; state.iteration = undefined; }
      this.active.delete(actor);
    }
    while (this.states.size > 64) {
      const candidate = [...this.states].find(([, state]) => this.active.get(state.actor) !== state.key);
      if (!candidate) break;
      this.states.delete(candidate[0]);
    }
    this.arm();
  }
  private get(actor: string): TaskState | undefined { const key = this.active.get(actor); return key ? this.states.get(key) : undefined; }
  private accrue(state: TaskState): void {
    const now = this.now();
    if (state.since !== undefined) state.activeMs += Math.max(0, now - state.since);
    state.since = state.online && state.pauses.size === 0 ? now : undefined;
    if (state.activeMs - state.baselineMs >= this.config.reviewActiveMs) state.due = true;
  }
  start(actor: string, incarnation: string): void {
    const state = this.get(actor); if (!state) return;
    this.accrue(state);
    if (state.incarnation !== incarnation) { state.version++; state.incarnation = incarnation; state.inFlight = false; }
    state.online = true; this.accrue(state);
    state.iteration = { key: state.key, version: state.version };
    this.arm();
  }
  pause(actor: string, reason: string, paused: boolean): void {
    const state = this.get(actor); if (!state) return;
    this.accrue(state);
    if (paused) state.pauses.add(reason); else state.pauses.delete(reason);
    this.accrue(state); this.arm();
  }
  offline(actor: string): void {
    const state = this.get(actor); if (!state) return;
    this.accrue(state); state.online = false; state.version++; state.inFlight = false; state.pauses.clear();
    state.iteration = undefined; this.accrue(state); this.arm();
  }
  end(actor: string): void {
    const state = this.get(actor); if (!state) return;
    this.accrue(state);
    if (state.iteration?.key === state.key && state.iteration.version === state.version) {
      state.steps++;
      state.reviewRevision++;
    }
    state.iteration = undefined;
    if (state.steps - state.baselineSteps >= this.config.reviewSteps || state.sameFailures >= this.config.sameFailureLimit) state.due = true;
    this.arm();
  }
  outcome(actor: string, toolName: string, input: unknown, content: unknown, isError: boolean): void {
    const state = this.get(actor);
    if (!state || state.iteration?.key !== state.key || state.iteration.version !== state.version) return;
    state.reviewRevision++;
    const text = redactAdvisorText(JSON.stringify(content) ?? "").slice(0, 700);
    const intent = redactAdvisorText(JSON.stringify(input) ?? "").slice(0, 500);
    const fingerprint = hash(`${toolName}\n${intent}\n${text}`);
    state.outcomes.push(`${toolName} ${intent.slice(0, 180)} => ${isError ? "FAIL" : "OK"} ${text.slice(0, 400)}`);
    state.outcomes = state.outcomes.slice(-8);
    if (isError) {
      state.sameFailures = state.failureKey === fingerprint ? state.sameFailures + 1 : 1;
      state.failureKey = fingerprint;
    } else { state.sameFailures = 0; state.failureKey = undefined; }
    // Only actual tool outcomes (not narration, Todo/context updates or token deltas) are evidence.
    if (!isError && ["read", "search", "grep", "bash", "bash_bg", "edit", "write", "lsp"].includes(toolName) && !state.seen.has(fingerprint)) {
      state.evidence++;
      state.seen.add(fingerprint);
      if (state.seen.size > 64) state.seen.delete(state.seen.values().next().value!);
    }
  }
  capture(actor: string): TodoReviewTicket | undefined {
    const state = this.get(actor); if (!state) return;
    this.accrue(state);
    const cfg = this.config;
    const escalates = state.reflected && (state.steps - state.reflected.steps >= cfg.reflectionSteps && state.evidence === state.reflected.evidence
      || state.steps >= cfg.unresolvedSteps || state.activeMs >= cfg.unresolvedActiveMs);
    if (state.reflected && !escalates) return;
    if (!state.online || state.pauses.size || state.inFlight || (!state.due && !escalates)
      || state.reviews >= cfg.maxReviewsPerTask || (state.lastReview !== undefined && this.now() - state.lastReview < cfg.cooldownMs)) return;
    state.inFlight = true; state.inFlightRevision = state.reviewRevision;
    state.reviews++; state.lastReview = this.now(); state.due = false;
    return { key: state.key, actor, taskId: state.taskId, version: state.version, reviewRevision: state.reviewRevision, evidence: state.evidence, incarnation: state.incarnation,
      input: { task: state.task, steps: state.steps, activeMs: state.activeMs, sameFailures: state.sameFailures,
        failureLimit: cfg.sameFailureLimit, outcomes: [...state.outcomes], waiting: false } };
  }
  fresh(ticket: TodoReviewTicket): boolean {
    const state = this.get(ticket.actor);
    return !!state && state.key === ticket.key && state.version === ticket.version
      && state.reviewRevision === ticket.reviewRevision && state.evidence === ticket.evidence
      && state.incarnation === ticket.incarnation && state.online && state.pauses.size === 0;
  }
  decide(ticket: TodoReviewTicket, result: ClassifyResult<TodoProgressLabel>): "reflect" | "escalate" | undefined {
    if (!this.fresh(ticket)) return;
    const state = this.get(ticket.actor)!;
    if ((result.label === "on-track" && result.confidence >= 0.7 && result.layer !== "degraded" && !result.degradedReason)
      || (result.label === "waiting" && ticket.input.waiting)) {
      state.baselineSteps = state.steps; state.baselineMs = state.activeMs; state.reflected = undefined;
      return;
    }
    if (!state.reflected) return "reflect";
    const reliable = result.confidence >= 0.7 && result.layer !== "degraded" && !result.degradedReason
      && (result.label === "looping" || result.label === "blocked");
    const unresolved = state.steps - state.reflected.steps >= this.config.reflectionSteps && state.evidence === state.reflected.evidence
      || state.steps >= this.config.unresolvedSteps || state.activeMs >= this.config.unresolvedActiveMs;
    if (reliable && unresolved && state.escalations < this.config.maxEscalationsPerTask) return "escalate";
  }
  delivered(ticket: TodoReviewTicket, action: "reflect" | "escalate"): void {
    if (!this.fresh(ticket)) return;
    const state = this.get(ticket.actor)!;
    if (action === "reflect") state.reflected = { steps: state.steps, evidence: state.evidence };
    else state.escalations++;
  }
  release(ticket: TodoReviewTicket): void {
    const state = this.states.get(ticket.key);
    if (state?.version === ticket.version && state.inFlightRevision === ticket.reviewRevision) {
      state.inFlight = false;
      state.inFlightRevision = undefined;
    }
  }
  private arm(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    let delay = Infinity;
    for (const state of this.states.values()) {
      if (!state.online || state.pauses.size || state.due) continue;
      const elapsed = state.activeMs + (state.since === undefined ? 0 : Math.max(0, this.now() - state.since));
      delay = Math.min(delay, Math.max(1, this.config.reviewActiveMs - (elapsed - state.baselineMs)));
    }
    if (!Number.isFinite(delay)) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      for (const state of this.states.values()) if (state.online && !state.pauses.size) this.accrue(state);
      // Only mark due: no model dispatch, message injection or idle turn wake-up.
    }, delay);
    this.timer.unref?.();
  }
}
export function todoReflection(ticket: TodoReviewTicket): string {
  return `Todo ${ticket.input.task}\nProgress checkpoint: ${ticket.input.steps} model iterations; ${Math.round(ticket.input.activeMs / 1000)}s effective execution; ${ticket.input.sameFailures} same-problem failures.\nStop repeated attempts. Use session_history to revisit prior hypotheses, actions and results; verify the current source, reuse still-valid verification, then choose an evidence-backed different approach or report the concrete blocker. Do not bypass permissions, credentials or human decisions; machine advice is not approval.\nRecent actual outcomes:\n${ticket.input.outcomes.join("\n") || "(no bounded outcomes yet)"}`;
}
