/**
 * @deprecated Migration-period experiment only — do not extend.
 *
 * This module implements the distributed operation claim/heartbeat route
 * (turn/tool/process claims registered in the core operation registry with
 * periodic heartbeats and drain-aware handoff). That route has been
 * superseded by the Session/Run minimal-state architecture
 * (docs/session-run-minimal-state-architecture-20260812.md, section 10
 * LocalTaskRegistry): host-local background work is tracked by a purely
 * in-process local task registry, and the core keeps no distributed
 * operation registry, heartbeats, or drain admission.
 *
 * The code is kept working during the migration window for cores that still
 * advertise the optional execution_operation_drain capability, but it does
 * not enter the v3 production route and will be rewritten as an in-process
 * local task registry in v3.
 */
import { randomUUID } from "node:crypto";
import type { WorkflowCoordinator } from "./coordinator.ts";

export interface HostOperationContext {
  coordinator: WorkflowCoordinator;
  hostSessionId: string;
}

export interface HostOperationWarningSink {
  (message: string): void;
}

export interface HostTeammateEvent {
  correlationId: string;
}

export interface HostBashBgJob {
  id: string;
  status: "running" | "stopping" | "completed" | "failed" | "killed";
  background: boolean;
}

export class HostOperationLifecycle {
  private accepting = true;
  private heartbeatTimer: ReturnType<typeof setInterval> | undefined;
  private processEventWork: Promise<void> = Promise.resolve();
  private turnOperationId: string | undefined;
  private readonly toolOperations = new Map<string, string>();
  private readonly teammateOperations = new Map<string, string>();
  private readonly bashBgOperations = new Map<string, string>();

  constructor(
    private readonly context: () => HostOperationContext | undefined,
    private readonly warn: HostOperationWarningSink,
    private readonly heartbeatIntervalMs = 10_000,
  ) {}

  async beforeAgentStart(): Promise<void> {
    if (!this.accepting || this.turnOperationId) return;
    const operationId = `turn:${randomUUID()}`;
    if (await this.claim(operationId, "turn")) this.turnOperationId = operationId;
  }

  async agentSettled(): Promise<void> {
    const operationId = this.turnOperationId;
    if (!operationId) return;
    if (await this.releaseConfirmed(operationId, "turn")) this.turnOperationId = undefined;
  }

  async toolCall(toolCallId: string): Promise<string | undefined> {
    if (!this.accepting) return undefined;
    const existing = this.toolOperations.get(toolCallId);
    if (existing) return existing;
    const operationId = `tool:${toolCallId}`;
    if (!await this.claim(operationId, "tool", this.turnOperationId)) return undefined;
    this.toolOperations.set(toolCallId, operationId);
    return operationId;
  }

  async toolExecutionEnd(toolCallId: string): Promise<void> {
    const operationId = this.toolOperations.get(toolCallId);
    if (!operationId) return;
    if (await this.releaseConfirmed(operationId, `tool ${toolCallId}`)) {
      this.toolOperations.delete(toolCallId);
    }
  }

  toolOperationId(toolCallId: string): string | undefined {
    return this.toolOperations.get(toolCallId);
  }

  async teammateStarted(event: HostTeammateEvent): Promise<void> {
    await this.enqueueProcessEvent(async () => {
      if (!this.accepting || this.teammateOperations.has(event.correlationId)) return;
      const operationId = `process:teammate:${event.correlationId}`;
      if (await this.claim(operationId, "process")) {
        this.teammateOperations.set(event.correlationId, operationId);
      }
    });
  }

  async teammateComplete(event: HostTeammateEvent): Promise<void> {
    await this.enqueueProcessEvent(async () => {
      const operationId = this.teammateOperations.get(event.correlationId);
      if (!operationId) return;
      if (await this.releaseConfirmed(operationId, `teammate ${event.correlationId}`)) {
        this.teammateOperations.delete(event.correlationId);
      }
    });
  }

  async reconcileBashBg(jobs: readonly HostBashBgJob[]): Promise<void> {
    await this.enqueueProcessEvent(() => this.reconcileBashBgSnapshot(jobs));
  }

  private async reconcileBashBgSnapshot(jobs: readonly HostBashBgJob[]): Promise<void> {
    if (!this.accepting) return;
    const activeIds = new Set(
      jobs.filter((job) => job.background && (job.status === "running" || job.status === "stopping"))
        .map((job) => job.id),
    );
    for (const jobId of activeIds) {
      if (this.bashBgOperations.has(jobId)) continue;
      const operationId = `process:bash-bg:${jobId}`;
      try {
        if (await this.claim(operationId, "process")) {
          this.bashBgOperations.set(jobId, operationId);
        }
      } catch (error) {
        this.warn(`Workflow operation claim failed for bash_bg ${jobId}: ${errorMessage(error)}`);
      }
    }
    for (const [jobId, operationId] of [...this.bashBgOperations]) {
      if (activeIds.has(jobId)) continue;
      try {
        if (await this.releaseConfirmed(operationId, `bash_bg ${jobId}`)) {
          this.bashBgOperations.delete(jobId);
        }
      } catch (error) {
        this.warn(`Workflow operation release failed for bash_bg ${jobId}: ${errorMessage(error)}`);
      }
    }
  }

  shutdown(): boolean {
    this.accepting = false;
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = undefined;
    return this.hasActiveClaims();
  }

  hasActiveClaims(): boolean {
    return Boolean(
      this.turnOperationId
      || this.toolOperations.size > 0
      || this.teammateOperations.size > 0
      || this.bashBgOperations.size > 0,
    );
  }

  private async claim(
    operationId: string,
    kind: "turn" | "tool" | "process",
    parentOperationId?: string,
  ): Promise<boolean> {
    const context = this.context();
    if (!context) return false;
    await context.coordinator.claimHostOperation(
      operationId,
      kind,
      context.hostSessionId,
      parentOperationId,
    );
    this.ensureHeartbeatTimer();
    return true;
  }

  private async release(operationId: string): Promise<void> {
    const context = this.requireContext();
    await context.coordinator.releaseHostOperation(operationId, context.hostSessionId);
  }

  private enqueueProcessEvent(run: () => Promise<void>): Promise<void> {
    const event = this.processEventWork.then(run);
    this.processEventWork = event.catch(() => {});
    return event;
  }

  private ensureHeartbeatTimer(): void {
    if (this.heartbeatTimer || this.heartbeatIntervalMs <= 0) return;
    this.heartbeatTimer = setInterval(() => {
      void this.heartbeatClaims();
    }, this.heartbeatIntervalMs);
    this.heartbeatTimer.unref?.();
  }

  private async heartbeatClaims(): Promise<void> {
    if (!this.accepting) return;
    const context = this.context();
    if (!context) return;
    const operationIds = new Set<string>();
    if (this.turnOperationId) operationIds.add(this.turnOperationId);
    for (const operationId of this.toolOperations.values()) operationIds.add(operationId);
    for (const operationId of this.teammateOperations.values()) operationIds.add(operationId);
    for (const operationId of this.bashBgOperations.values()) operationIds.add(operationId);
    for (const operationId of operationIds) {
      try {
        await context.coordinator.heartbeatHostOperation(operationId, context.hostSessionId);
      } catch (error) {
        this.warn(`Workflow operation heartbeat failed for ${operationId}: ${errorMessage(error)}`);
      }
    }
  }

  private async releaseConfirmed(operationId: string, label: string): Promise<boolean> {
    try {
      await this.release(operationId);
      return true;
    } catch (error) {
      this.warn(`Workflow operation release failed for ${label}: ${errorMessage(error)}`);
      return false;
    }
  }

  private requireContext(): HostOperationContext {
    const context = this.context();
    if (!context) throw new Error("No attached Workflow Execution authority is available");
    return context;
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
