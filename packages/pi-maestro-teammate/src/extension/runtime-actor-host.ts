import { randomUUID } from "node:crypto";
import { logDiagnosticError } from "../shared/diagnostic-log.ts";
import {
  createRuntimeActorHost,
  type RuntimeActorHostClient,
  type RuntimeActorLease,
} from "../runtime-broker/actor-host.ts";
import type { SessionEndpointCapability } from "../sessions/session-core.ts";
import { RUNTIME_V2_REVISION, RUNTIME_V2_VERSION, type ActorAddressV2 } from "../runtime-v2/contracts.ts";
import {
  SESSION_MESSAGE_ACCEPTED_EVENT_V2,
  SESSION_MESSAGE_INJECTED_EVENT_V2,
  SESSION_MESSAGE_REPLIED_EVENT_V2,
  SESSION_WINDOW_ADVERTISED_EVENT_V2,
  SESSION_WINDOW_HEARTBEAT_EVENT_V2,
  SESSION_WINDOW_WITHDRAWN_EVENT_V2,
  createSessionDomainEventDraftV2,
  type SessionDomainEventTypeV2,
  type SessionMessageDomainPayloadV2,
  type SessionRouteCaptureV2,
  type SessionWindowDomainPayloadV2,
} from "../runtime-v2/session-domain.ts";

export interface WindowSupervisorRuntimeActorOptions {
  cwd: string;
  workspaceId: string;
  ownerId: string;
  ownerNonce: string;
  generation: number;
  capabilities?: readonly SessionEndpointCapability[];
  host?: RuntimeActorHostClient;
  onError?: (error: unknown) => void;
}

/** Advisory Runtime Broker binding for the v1 workspace-peer window owner. */
export class WindowSupervisorRuntimeActor {
  readonly #ownsHost: boolean;
  readonly #options: WindowSupervisorRuntimeActorOptions;
  #host: RuntimeActorHostClient | undefined;
  #lease: RuntimeActorLease | undefined;
  #actor: ActorAddressV2 | undefined;
  #heartbeatTimer: ReturnType<typeof setInterval> | undefined;
  #stopped = false;

  constructor(options: WindowSupervisorRuntimeActorOptions) {
    this.#options = options;
    this.#host = options.host;
    this.#ownsHost = options.host === undefined;
  }

  get active(): boolean {
    return this.#lease?.active === true;
  }

  async start(): Promise<boolean> {
    if (this.#stopped) return false;
    try {
      const host = this.#host ??= createRuntimeActorHost({ cwd: this.#options.cwd });
      const actor: ActorAddressV2 = {
        version: RUNTIME_V2_VERSION,
        revision: RUNTIME_V2_REVISION,
        workspaceId: this.#options.workspaceId,
        actorKind: "root" as const,
        actorId: this.#options.ownerId,
        generation: this.#options.generation,
      };
      const lease = await host.acquire({
        leaseActorId: `window-supervisor:${this.#options.workspaceId}:${this.#options.ownerId}`,
        holderId: `${this.#options.ownerId}:${this.#options.ownerNonce}`,
        streamId: `window-supervisor:${this.#options.workspaceId}:${this.#options.ownerId}:${this.#options.generation}`,
        actor,
      });
      if (this.#stopped) {
        await lease?.release().catch(() => undefined);
        return false;
      }
      this.#lease = lease;
      this.#actor = actor;
      try {
        await this.#appendWindowEvent(SESSION_WINDOW_ADVERTISED_EVENT_V2, "running");
      } catch (error) {
        this.#report(error);
      }
      if (lease?.active) this.#startHeartbeat();
      return host.mode === "off" || lease?.active === true;
    } catch (error) {
      this.#report(error);
      if (this.#ownsHost) {
        await this.#host?.stop().catch((stopError) => this.#report(stopError));
        this.#host = undefined;
      }
      return false;
    }
  }

  async publishMessage(
    stage: "accepted" | "injected" | "replied",
    messageId: string,
    direction: "incoming" | "outgoing",
    mode: "steer" | "follow_up",
    inReplyTo?: string,
  ): Promise<void> {
    const eventType = stage === "accepted" ? SESSION_MESSAGE_ACCEPTED_EVENT_V2
      : stage === "injected" ? SESSION_MESSAGE_INJECTED_EVENT_V2
      : SESSION_MESSAGE_REPLIED_EVENT_V2;
    const payload: SessionMessageDomainPayloadV2 = {
      version: 1,
      route: this.#route(),
      messageId,
      direction,
      mode,
      ...(inReplyTo === undefined ? {} : { inReplyTo }),
    };
    await this.#append(eventType, payload);
  }

  async stop(): Promise<void> {
    if (this.#stopped) return;
    this.#stopped = true;
    if (this.#heartbeatTimer) clearInterval(this.#heartbeatTimer);
    this.#heartbeatTimer = undefined;
    const lease = this.#lease;
    this.#lease = undefined;
    try {
      if (lease?.active) {
        await this.#appendWindowEvent(SESSION_WINDOW_WITHDRAWN_EVENT_V2, "unavailable", "monitor-exited", lease)
          .catch((error) => this.#report(error));
      }
      await lease?.release();
    } catch (error) {
      this.#report(error);
    } finally {
      if (this.#ownsHost) await this.#host?.stop().catch((error) => this.#report(error));
    }
  }

  #startHeartbeat(): void {
    this.#heartbeatTimer = setInterval(() => {
      void this.#appendWindowEvent(SESSION_WINDOW_HEARTBEAT_EVENT_V2, "running").catch((error) => this.#report(error));
    }, 5_000);
    this.#heartbeatTimer.unref?.();
  }

  #route(): SessionRouteCaptureV2 {
    const actor = this.#actor;
    if (!actor) throw new Error("Window supervisor Runtime V2 actor is unavailable");
    return {
      version: 1,
      authority: {
        kind: "local",
        authorityId: this.#options.workspaceId,
        instanceNonce: this.#options.ownerNonce,
      },
      actor,
      transport: "local-root",
      capabilities: [...(this.#options.capabilities ?? ["inspect", "message", "steer", "follow_up"])],
      ownerId: this.#options.ownerId,
      ownerNonce: this.#options.ownerNonce,
      cancel: false,
    };
  }

  async #appendWindowEvent(
    eventType: typeof SESSION_WINDOW_ADVERTISED_EVENT_V2 | typeof SESSION_WINDOW_HEARTBEAT_EVENT_V2 | typeof SESSION_WINDOW_WITHDRAWN_EVENT_V2,
    status: SessionWindowDomainPayloadV2["status"],
    reason?: SessionWindowDomainPayloadV2["reason"],
    lease: RuntimeActorLease | undefined = this.#lease,
  ): Promise<void> {
    const payload: SessionWindowDomainPayloadV2 = {
      version: 1,
      route: this.#route(),
      status,
      agentCount: 0,
      ...(reason === undefined ? {} : { reason }),
    };
    await this.#append(eventType, payload, lease);
  }

  async #append(
    eventType: SessionDomainEventTypeV2,
    payload: SessionWindowDomainPayloadV2 | SessionMessageDomainPayloadV2,
    lease: RuntimeActorLease | undefined = this.#lease,
  ): Promise<void> {
    const actor = this.#actor;
    if (!lease?.active || !actor) return;
    await lease.append([createSessionDomainEventDraftV2({
      eventType,
      streamId: lease.registration.streamId,
      actor,
      eventId: randomUUID(),
      occurredAt: Date.now(),
      payload,
    })]);
  }

  #report(error: unknown): void {
    try {
      this.#options.onError?.(error);
    } catch {}
    if (!this.#options.onError) {
      logDiagnosticError("[pi-maestro-teammate] WindowSupervisor runtime actor mutation failed:", error);
    }
  }
}

export function createWindowSupervisorRuntimeActor(
  options: WindowSupervisorRuntimeActorOptions,
): WindowSupervisorRuntimeActor {
  return new WindowSupervisorRuntimeActor(options);
}
