/** Provider-neutral contracts for externally managed Gateway ingress tunnels. */
import type { ChildProcess } from "node:child_process";

export const GATEWAY_TUNNEL_RECORD_VERSION = 1 as const;
export const GATEWAY_TUNNEL_PHASES = ["stopped", "starting", "ready", "degraded", "quiescing", "failed"] as const;
export type GatewayTunnelPhase = typeof GATEWAY_TUNNEL_PHASES[number];
export type GatewayTunnelDesiredState = "stopped" | "running";

export interface GatewayTunnelProcessIdentity {
  pid: number;
  executableRealpath: string;
  processStartIdentity: string;
  invocationDigest: string;
  generation: number;
  ownerToken: string;
}

export interface GatewayTunnelObservedState {
  phase: GatewayTunnelPhase;
  changedAt: number;
  detail?: string;
  endpoint?: string;
  opaqueId?: string;
  lastExit?: GatewayTunnelExit;
}

/** Durable state. Secrets, argv and environment values must never be placed here. */
export interface GatewayTunnelState {
  version: typeof GATEWAY_TUNNEL_RECORD_VERSION;
  provider: string;
  instance: string;
  desiredState: GatewayTunnelDesiredState;
  observed: GatewayTunnelObservedState;
  generation: number;
  ownerToken: string;
  pid?: number;
  executableRealpath?: string;
  processStartIdentity?: string;
  invocationDigest?: string;
  restartHistory: number[];
  updatedAt: number;
}

export interface GatewayTunnelDeadlineContext {
  /** One absolute monotonic wall-clock deadline shared by doctor/start/probe/stop. */
  readonly deadlineAt: number;
  readonly signal: AbortSignal;
  readonly now: () => number;
  remainingMs(): number;
  throwIfExpired(stage?: string): void;
}

export interface GatewayTunnelDoctorResult {
  ok: boolean;
  detail?: string;
  executablePath?: string;
  version?: string;
}

export interface GatewayTunnelExit {
  code: number | null;
  signal?: NodeJS.Signals | null;
  at?: number;
  detail?: string;
}

export interface GatewayTunnelStartResult {
  pid: number;
  executablePath: string;
  /** Exact argv passed to spawn, excluding argv[0]. Never persisted. */
  args: readonly string[];
  processStartIdentity?: string;
  endpoint?: string;
  opaqueId?: string;
  /** Resolves exactly once when the owned process exits. */
  exited?: Promise<GatewayTunnelExit>;
  /** Optional owned handle for provider implementations that spawn with Node. */
  child?: Pick<ChildProcess, "pid" | "kill">;
}

export interface GatewayTunnelProbeResult {
  ready: boolean;
  detail?: string;
  endpoint?: string;
  opaqueId?: string;
  /** Provider hint only; the supervisor clamps it to the shared deadline. */
  retryAfterMs?: number;
  terminal?: boolean;
}

export interface GatewayTunnelProviderRequest {
  provider: string;
  instance: string;
  generation: number;
  ownerToken: string;
  input?: Readonly<Record<string, unknown>>;
}

export interface GatewayTunnelStopRequest extends GatewayTunnelProviderRequest {
  reason: "explicit" | "restart" | "shutdown" | "startup-failed";
}

/**
 * Providers own protocol-specific behavior only. They may not register Gateway
 * tools or proxy MCP requests; all lifecycle entry points remain local control.
 */
export interface GatewayTunnelProvider {
  readonly name: string;
  readonly stability?: "stable" | "experimental";
  doctor(context: GatewayTunnelDeadlineContext, request: GatewayTunnelProviderRequest): Promise<GatewayTunnelDoctorResult>;
  start(context: GatewayTunnelDeadlineContext, request: GatewayTunnelProviderRequest): Promise<GatewayTunnelStartResult>;
  probe(context: GatewayTunnelDeadlineContext, process: GatewayTunnelStartResult, request: GatewayTunnelProviderRequest): Promise<GatewayTunnelProbeResult>;
  stop(context: GatewayTunnelDeadlineContext, process: GatewayTunnelProcessIdentity, request: GatewayTunnelStopRequest): Promise<void>;
  /** Called only after the persisted process identity has been independently verified. */
  adopt?(context: GatewayTunnelDeadlineContext, process: GatewayTunnelProcessIdentity, request: GatewayTunnelProviderRequest): Promise<GatewayTunnelStartResult | undefined>;
}

export interface GatewayTunnelRestartBudget {
  maxRestarts: number;
  windowMs: number;
}

export interface GatewayTunnelOperationOptions {
  timeoutMs?: number;
  deadlineAt?: number;
  expectedGeneration?: number;
  input?: Readonly<Record<string, unknown>>;
}
