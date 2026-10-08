import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { MAESTRO_TODO_STATE_CHANGED_EVENT } from "pi-cockpit/v1/events";
import { registerTeammateHostObserver, type TeammateHostBoundary } from "pi-maestro-teammate/v1/events";
import { getVisibleTasks, subscribeTodoStateChanges, type TodoTask } from "../tools/todo.ts";
import { TodoReviewMonitor, type TodoReviewConfig, type TodoReviewTicket } from "./todo-review.ts";

export interface TodoReviewHostOptions {
  enabled(): boolean;
  context(): ExtensionContext | undefined;
  review(ticket: TodoReviewTicket, ctx: ExtensionContext, steer?: (message: string) => boolean): void;
  getTasks?: () => TodoTask[];
  now?: () => number;
}
/** Root-authoritative adapter for root and real local subprocess telemetry. */
export class TodoReviewHost {
  readonly monitor: TodoReviewMonitor;
  private disposeObserver?: () => void;
  private disposeTodo?: () => void;
  private readonly child = new Map<string, { incarnation: string; model?: string; inputs: Map<string, unknown> }>();
  private readonly inputs = new Map<string, unknown>();
  private readonly highWater = new Map<string, number>();
  private readonly admitted = new Map<string, string>();
  private rootIncarnation = "root";
  private rootIterationMonitored = false;
  private closed = false;
  constructor(pi: ExtensionAPI, config: TodoReviewConfig, private readonly options: TodoReviewHostOptions) {
    this.monitor = new TodoReviewMonitor(config, options.now);
    const ready = (): boolean => !this.closed && options.enabled() && !!options.context();
    pi.events?.on?.(MAESTRO_TODO_STATE_CHANGED_EVENT, () => { if (ready()) this.sync(); });
    pi.events?.on?.("teammate:started", (payload) => {
      const record = payload as { correlationId?: string; projection?: { sessionId?: string } };
      const session = options.context()?.sessionManager?.getSessionId?.();
      if (!ready() || !session || record.projection?.sessionId !== session || !record.correlationId) return;
      this.admitted.set(record.correlationId, session);
      if (this.admitted.size > 64) this.admitted.delete(this.admitted.keys().next().value!);
    });
    pi.on("turn_start", (_event, ctx) => {
      if (!ready()) return;
      this.sync(); this.rootIncarnation = ctx.sessionManager?.getSessionId?.() ?? "root";
      this.monitor.start("root", this.rootIncarnation);
      this.rootIterationMonitored = this.monitor.active.has("root");
    });
    pi.on("tool_call", (event) => {
      if (!ready()) return;
      this.sync(); this.inputs.set(event.toolCallId, event.input);
      if (this.inputs.size > 64) this.inputs.delete(this.inputs.keys().next().value!);
      // Includes permission/human waits and healthy long-running execution. Never tool text.
      this.monitor.pause("root", `tool:${event.toolCallId}`, true);
    });
    pi.on("tool_result", (event) => {
      if (!ready()) return;
      this.sync(); this.monitor.pause("root", `tool:${event.toolCallId}`, false);
      this.monitor.outcome("root", event.toolName, this.inputs.get(event.toolCallId) ?? event.input, event.content, event.isError);
      this.inputs.delete(event.toolCallId);
    });
    pi.on("turn_end", (_event, ctx) => {
      if (!ready()) return;
      this.sync(); this.monitor.end("root"); this.review("root", ctx);
    });
    pi.on("ui_prompt_start", () => this.monitor.pause("root", "user", true));
    pi.on("ui_prompt_end", () => this.monitor.pause("root", "user", false));
    pi.on("after_provider_response", (event) => {
      if (event.status === 429 || event.status === 503) this.monitor.pause("root", "capacity", true);
    });
    pi.on("before_provider_request", () => this.monitor.pause("root", "capacity", false));
    pi.on("agent_end", () => this.monitor.offline("root"));
    pi.on("session_before_compact", () => { this.monitor.offline("root"); });
    pi.on("session_shutdown", () => this.close());
  }
  sync(): void { this.monitor.sync((this.options.getTasks ?? getVisibleTasks)()); }
  monitored(actor = "root"): boolean {
    if (!this.options.enabled() || this.closed) return false;
    this.sync(); return this.monitor.active.has(actor) || (actor === "root" && this.rootIterationMonitored);
  }
  reset(config: TodoReviewConfig, preserveState = false): void {
    this.disposeObserver?.(); this.disposeObserver = undefined;
    this.disposeTodo?.(); this.disposeTodo = undefined;
    if (preserveState) this.monitor.fence(config); else this.monitor.reset(config);
    this.child.clear(); this.inputs.clear(); this.closed = false; this.rootIterationMonitored = false;
    if (this.options.enabled()) {
      this.sync();
      this.disposeTodo = subscribeTodoStateChanges(() => { if (!this.closed && this.options.enabled()) this.sync(); });
      this.disposeObserver = registerTeammateHostObserver("pi-maestro-flow/advisor-todo", (boundary) => this.observeChild(boundary));
    }
  }
  close(): void {
    this.closed = true; this.disposeObserver?.(); this.disposeObserver = undefined;
    this.disposeTodo?.(); this.disposeTodo = undefined;
    this.monitor.reset(); this.child.clear(); this.inputs.clear();
  }
  private review(actor: string, ctx: ExtensionContext, steer?: (message: string) => boolean): void {
    const ticket = this.monitor.capture(actor);
    if (ticket) this.options.review(ticket, ctx, steer);
  }
  /** Actual events from the host-owned subprocess; actor identity never comes from model arguments. */
  observeChild(boundary: TeammateHostBoundary): void {
    if (this.closed || !this.options.enabled()) return;
    const ctx = this.options.context(); if (!ctx) return;
    const parentFile = ctx.sessionManager?.getSessionFile?.();
    const actor = boundary.correlationId;
    const parentSession = ctx.sessionManager?.getSessionId?.();
    const admittedHere = !!parentSession && this.admitted.get(actor) === parentSession;
    // Nested/fork children legitimately use the spawner's checkpoint, not the root file.
    // Their root-emitted roster projection still proves current root-session ownership.
    if (!(parentFile && parentFile === boundary.parentSessionFile) && !admittedHere) return;
    const lastSequence = this.highWater.get(actor) ?? -1;
    if (boundary.sequence < lastSequence) return;
    if (boundary.sequence > lastSequence) {
      if (boundary.event.type !== "turn_start") return;
      this.highWater.set(actor, boundary.sequence);
      if (this.highWater.size > 64) this.highWater.delete(this.highWater.keys().next().value!);
    }
    this.sync();
    if (!this.monitor.active.has(actor)) return;
    let child = this.child.get(actor);
    const event = boundary.event;
    if (!child || child.incarnation !== boundary.incarnation) {
      if (child) this.monitor.offline(actor);
      if (event.type !== "turn_start") return;
      child = { incarnation: boundary.incarnation, inputs: new Map() };
      this.child.set(actor, child);
      while (this.child.size > 64) this.child.delete(this.child.keys().next().value!);
    }
    if (event.type === "turn_start") this.monitor.start(actor, boundary.incarnation);
    if (event.type === "message_start") {
      const message = event.message && typeof event.message === "object" ? event.message as Record<string, unknown> : undefined;
      const model = message?.role === "assistant" ? `${String(message.provider)}/${String(message.model)}` : undefined;
      if (model && child.model && model !== child.model) {
        this.monitor.offline(actor); this.monitor.start(actor, boundary.incarnation);
      }
      if (model) child.model = model;
    }
    const id = typeof event.toolCallId === "string" ? event.toolCallId : "tool";
    if (event.type === "tool_execution_start") {
      child.inputs.set(id, event.args);
      if (child.inputs.size > 64) child.inputs.delete(child.inputs.keys().next().value!);
      this.monitor.pause(actor, `tool:${id}`, true);
    }
    if (event.type === "tool_execution_end") {
      this.monitor.pause(actor, `tool:${id}`, false);
      if (typeof event.toolName === "string") this.monitor.outcome(actor, event.toolName, child.inputs.get(id), event.result, event.isError === true);
      child.inputs.delete(id);
    }
    if (event.type === "auto_retry_start") this.monitor.pause(actor, "capacity", true);
    if (event.type === "auto_retry_end") this.monitor.pause(actor, "capacity", false);
    if (event.type === "host_compaction" || event.type === "auto_compaction_start") this.monitor.offline(actor);
    if (event.type === "turn_end") { this.monitor.end(actor); this.review(actor, ctx, boundary.steer); }
    if (event.type === "agent_end" || event.type === "host_offline") {
      this.monitor.offline(actor); this.child.delete(actor);
    }
  }
}
