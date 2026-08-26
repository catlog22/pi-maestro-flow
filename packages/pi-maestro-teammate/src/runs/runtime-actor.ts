import { createHash, randomUUID } from "node:crypto";
import { logDiagnosticWarn } from "../shared/diagnostic-log.ts";
import type { AgentProgress, AgentTerminalStatus, SingleResult } from "../shared/types.ts";
import type { ChildReclamationOutcome, RunTeammateOptions } from "./execution-infra.ts";
import {
  createRuntimeActorHost,
  type RuntimeActorHostClient,
  type RuntimeActorLease,
} from "../runtime-broker/actor-host.ts";
import { RuntimeBrokerError } from "../runtime-broker/contracts.ts";
import { canonicalizeRuntimeBrokerWorkspace } from "../runtime-broker/private-state.ts";
import { adaptAcpRuntimeSignalV2, adaptPiRuntimeSignalV2 } from "../runtime-v2/adapters.ts";
import {
  RUNTIME_V2_REVISION,
  RUNTIME_V2_VERSION,
  type ActorAddressV2,
  type RuntimeEventDraftV2,
} from "../runtime-v2/contracts.ts";

interface ChildCloseDetails {
  code: number | null;
  signal: NodeJS.Signals | null;
  settled: boolean;
}

export class AgentRunRuntimeActor {
  readonly #correlationId: string;
  readonly #host: RuntimeActorHostClient;
  readonly #ownsHost: boolean;
  readonly #actor: ActorAddressV2;
  readonly #streamId: string;
  #lease: RuntimeActorLease | undefined;
  #tail: Promise<void> = Promise.resolve();
  #authorityFailure: unknown;
  #released = false;
  #activeProcesses = 0;
  #reclamationIndex = 0;
  #lastChildClose: ChildCloseDetails | undefined;
  readonly #toolStates = new Map<number, string>();
  readonly #published = new Set<string>();
  readonly #settled = new Set<string>();
  readonly #pendingReclamationEvents: RuntimeEventDraftV2[] = [];
  #backend: string | undefined;

  private constructor(
    correlationId: string,
    host: RuntimeActorHostClient,
    ownsHost: boolean,
    actor: ActorAddressV2,
    streamId: string,
  ) {
    this.#correlationId = correlationId;
    this.#host = host;
    this.#ownsHost = ownsHost;
    this.#actor = actor;
    this.#streamId = streamId;
  }

  static async start(
    correlationId: string,
    params: { cwd?: string },
    options: RunTeammateOptions,
  ): Promise<AgentRunRuntimeActor> {
    const cwd = options.baseCwd;
    let host = options.runtimeActorHost;
    const ownsHost = host === undefined;
    const generation = Math.max(1, options.runtimeGeneration ?? 1);
    host ??= createRuntimeActorHost({ cwd });
    try {
      const workspaceId = createHash("sha256")
        .update(canonicalizeRuntimeBrokerWorkspace(cwd), "utf8")
        .digest("hex");
      const actor: ActorAddressV2 = {
        version: RUNTIME_V2_VERSION,
        revision: RUNTIME_V2_REVISION,
        workspaceId,
        actorKind: params.cwd?.startsWith("remote:") ? "remote" : "teammate",
        actorId: correlationId,
        generation,
      };
      const streamId = `agent-run:${correlationId}:${generation}`;
      const runtime = new AgentRunRuntimeActor(correlationId, host, ownsHost, actor, streamId);
      runtime.#lease = await host.acquire({
        leaseActorId: `agent-run:${workspaceId}:${correlationId}`,
        holderId: `process-${process.pid}:${randomUUID()}`,
        streamId,
        actor,
        correlationId,
      });
      if (host.mode !== "off" && !runtime.#lease) {
        throw new RuntimeBrokerError("lease_unavailable", "AgentRun Runtime actor lease is owned elsewhere", {
          actorId: `agent-run:${workspaceId}:${correlationId}`,
          streamId,
          generation,
        });
      }
      return runtime;
    } catch (error) {
      if (ownsHost) await host.stop().catch(() => undefined);
      throw error;
    }
  }

  wrap(options: RunTeammateOptions): RunTeammateOptions {
    if (!this.#lease) return options;
    const v1 = options;
    return {
      ...options,
      onProgress: (progress) => {
        try {
          v1.onProgress?.(progress);
        } finally {
          this.progressAfterV1(progress);
        }
      },
      onChildSpawned: (stdin, sendControl, sessionDir, correlationId, generation) => {
        try {
          v1.onChildSpawned?.(stdin, sendControl, sessionDir, correlationId, generation);
        } finally {
          this.#activeProcesses += 1;
        }
      },
      onChildClosed: (correlationId, generation, details) => {
        try {
          v1.onChildClosed?.(correlationId, generation, details);
        } finally {
          this.#lastChildClose = details;
        }
      },
      onResultPublished: async (result, originCwd) => {
        await this.resultPublishedAfterV1(result);
        await v1.onResultPublished?.(result, originCwd);
      },
      onTurnComplete: (result, status) => {
        this.settledAfterV1(result, status, () => v1.onTurnComplete?.(result, status));
      },
      onReclamationOutcome: (correlationId, outcome) => {
        this.reclaimedAfterV1(outcome, () => v1.onReclamationOutcome?.(correlationId, outcome));
      },
    };
  }

  progressAfterV1(progress: AgentProgress): void {
    const events: RuntimeEventDraftV2[] = [];
    const baseIndex = Math.max(0, progress.toolCount - progress.recentTools.length);
    for (const [offset, tool] of progress.recentTools.entries()) {
      const index = baseIndex + offset;
      const previous = this.#toolStates.get(index);
      if (previous === tool.status) continue;
      const context = this.#context(progress.lastActivityAt);
      if (previous === undefined) {
        events.push(...adaptPiRuntimeSignalV2({
          type: "tool_execution_start",
          toolCallId: `${this.#correlationId}:tool:${index + 1}`,
          toolName: tool.name,
        }, context));
      }
      if (isFinishedToolStatus(tool.status)) {
        events.push(...adaptPiRuntimeSignalV2({
          type: "tool_execution_end",
          toolCallId: `${this.#correlationId}:tool:${index + 1}`,
          toolName: tool.name,
          isError: isFailedToolStatus(tool.status),
        }, context));
      }
      this.#toolStates.set(index, tool.status);
    }
    this.#appendAdvisory(events, "progress commit");
  }

  async resultPublishedAfterV1(result: SingleResult): Promise<void> {
    const publicationId = result.publicationId;
    if (!publicationId || this.#published.has(publicationId)) return;
    this.#published.add(publicationId);
    this.#backend = result.backend;
    const signal = {
      type: "result_published" as const,
      publicationId,
      hasStructuredOutput: result.structuredOutput !== undefined,
    };
    await this.#appendAfterV1(this.#isAcp()
      ? adaptAcpRuntimeSignalV2(signal, this.#context())
      : adaptPiRuntimeSignalV2(signal, this.#context()), "result publication commit");
  }

  settledAfterV1(
    result: SingleResult,
    status?: AgentTerminalStatus,
    afterPersist?: () => void,
  ): void {
    const key = result.publicationId ?? `${result.correlationId}:${result.durationMs}:${status ?? result.exitCode}`;
    if (this.#settled.has(key)) return;
    this.#settled.add(key);
    this.#backend = result.backend ?? this.#backend;
    const outcome = runtimeOutcome(status ?? result.terminalStatus, result.exitCode);
    const error = outcome === "failed" || outcome === "lost"
      ? result.messages.at(-1)?.content
      : undefined;
    const signal = this.#isAcp()
      ? { type: "run_settled" as const, outcome, ...(error ? { error } : {}) }
      : { type: "agent_settled" as const, outcome, ...(error ? { error } : {}) };
    const settlementEvents = this.#isAcp()
      ? adaptAcpRuntimeSignalV2(signal as Parameters<typeof adaptAcpRuntimeSignalV2>[0], this.#context())
      : adaptPiRuntimeSignalV2(signal as Parameters<typeof adaptPiRuntimeSignalV2>[0], this.#context());
    const missingPublication = result.publicationId && !this.#published.has(result.publicationId)
      ? (this.#isAcp() ? adaptAcpRuntimeSignalV2 : adaptPiRuntimeSignalV2)({
          type: "result_published",
          publicationId: result.publicationId,
          hasStructuredOutput: result.structuredOutput !== undefined,
        } as never, this.#context())
      : [];
    if (result.publicationId) this.#published.add(result.publicationId);
    const events = [...missingPublication, ...settlementEvents, ...this.#pendingReclamationEvents.splice(0)];
    const releaseWhenIdle = this.#activeProcesses === 0;
    this.#appendAuthoritative(events, "settlement commit", afterPersist, releaseWhenIdle);
  }

  reclaimedAfterV1(outcome: ChildReclamationOutcome, afterPersist?: () => void): void {
    if (outcome.status === "reclaimed") {
      this.#activeProcesses = Math.max(0, this.#activeProcesses - 1);
    }
    const close = this.#lastChildClose;
    this.#lastChildClose = undefined;
    const events = outcome.status === "reclaimed"
      ? (this.#isAcp() ? adaptAcpRuntimeSignalV2 : adaptPiRuntimeSignalV2)({
          type: "process_reclaimed",
          processId: `${this.#correlationId}:${++this.#reclamationIndex}`,
          exitCode: close?.code ?? null,
          signal: close?.signal ?? null,
        } as never, this.#context())
      : [];
    if (outcome.status === "unreaped") {
      afterPersist?.();
      return;
    }
    if (this.#settled.size === 0) {
      this.#pendingReclamationEvents.push(...events);
      afterPersist?.();
      return;
    }
    this.#appendAuthoritative(events, "reclamation commit", afterPersist, true);
  }

  async finish(): Promise<void> {
    await this.#tail;
    if (this.#authorityFailure !== undefined) throw this.#authorityFailure;
  }

  async abort(): Promise<void> {
    await this.#enqueue(async () => this.#release());
  }

  #context(occurredAt = Date.now()) {
    return { streamId: this.#streamId, actor: this.#actor, occurredAt };
  }

  #isAcp(): boolean {
    return this.#backend === "acp-cli";
  }

  #appendAdvisory(events: readonly RuntimeEventDraftV2[], phase: string): void {
    void this.#enqueue(async () => {
      try {
        await this.#append(events);
      } catch (error) {
        this.#report(error, phase);
      }
    });
  }

  #appendAuthoritative(
    events: readonly RuntimeEventDraftV2[],
    phase: string,
    afterPersist: (() => void) | undefined,
    releaseWhenIdle = false,
  ): void {
    void this.#enqueue(async () => {
      try {
        await this.#append(events);
      } catch (error) {
        await this.#recordAuthorityFailure(error, phase);
        return;
      }
      try {
        afterPersist?.();
      } catch {
        // V1 projection callbacks remain non-fatal in enabled mode.
      }
      if (releaseWhenIdle && this.#activeProcesses === 0) await this.#release();
    });
  }

  async #appendAfterV1(events: readonly RuntimeEventDraftV2[], phase: string): Promise<void> {
    try {
      await this.#append(events);
    } catch (error) {
      await this.#recordAuthorityFailure(error, phase);
      throw error;
    }
  }

  async #append(events: readonly RuntimeEventDraftV2[]): Promise<void> {
    if (this.#authorityFailure !== undefined) throw this.#authorityFailure;
    if (!this.#lease || events.length === 0 || this.#released) return;
    await this.#lease.append(events);
  }

  #enqueue(operation: () => Promise<void>): Promise<void> {
    const run = this.#tail.catch(() => undefined).then(operation);
    this.#tail = run.catch(() => undefined);
    return run;
  }

  async #recordAuthorityFailure(error: unknown, phase: string): Promise<void> {
    this.#authorityFailure ??= error;
    this.#report(error, phase);
    await this.#release();
  }

  async #release(): Promise<void> {
    if (this.#released) return;
    this.#released = true;
    const lease = this.#lease;
    this.#lease = undefined;
    await lease?.release().catch((error) => this.#report(error, "lease release"));
    if (this.#ownsHost) await this.#host.stop().catch((error) => this.#report(error, "host stop"));
  }

  #report(error: unknown, phase: string): void {
    logDiagnosticWarn(
      `[pi-maestro-teammate] advisory AgentRun runtime actor ${phase} failed for ${this.#correlationId}: `
      + `${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function isFinishedToolStatus(status: string): boolean {
  const normalized = status.toLowerCase();
  return normalized === "completed"
    || normalized === "succeeded"
    || normalized === "failed"
    || normalized === "error";
}

function isFailedToolStatus(status: string): boolean {
  const normalized = status.toLowerCase();
  return normalized === "failed" || normalized === "error";
}

function runtimeOutcome(
  status: AgentTerminalStatus | undefined,
  exitCode: number,
): "completed" | "failed" | "cancelled" | "lost" {
  if (status === "terminated") return "cancelled";
  if (status === "failed") return "failed";
  if (status === "completed") return "completed";
  return exitCode === 0 ? "completed" : "failed";
}
