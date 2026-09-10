/** Provider registry and local-control adapter. No MCP tools are registered here. */
import type { GatewayTunnelControlAction } from "../control-dispatcher.ts";
import type { GatewayTunnelOperationOptions, GatewayTunnelProvider, GatewayTunnelState } from "./contracts.ts";
import { GatewayTunnelProcessOwner } from "./process-owner.ts";
import { GatewayTunnelStateStore, gatewayTunnelStatePath, gatewayTunnelStateRoot } from "./state-store.ts";
import { GatewayTunnelSupervisor, type GatewayTunnelSupervisorOptions } from "./supervisor.ts";
import type { GatewayObservationSink } from "../observability.ts";

export type GatewayTunnelPublicState = Omit<GatewayTunnelState, "ownerToken">;

export interface GatewayTunnelManagerOptions {
  providers?: readonly GatewayTunnelProvider[];
  stateRoot?: string;
  processOwner?: GatewayTunnelProcessOwner;
  supervisorOptions?: Omit<Partial<GatewayTunnelSupervisorOptions>, "provider" | "instance" | "stateStore" | "processOwner" | "observer">;
  observer?: GatewayObservationSink;
}

export class GatewayTunnelProviderRegistry {
  private readonly providers = new Map<string, GatewayTunnelProvider>();
  constructor(providers: readonly GatewayTunnelProvider[] = []) { for (const provider of providers) this.register(provider); }
  register(provider: GatewayTunnelProvider): void {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(provider.name)) throw new Error("Tunnel provider name must be a safe identifier");
    if (this.providers.has(provider.name)) throw new Error(`Tunnel provider is already registered: ${provider.name}`);
    this.providers.set(provider.name, provider);
  }
  get(name: string): GatewayTunnelProvider | undefined { return this.providers.get(name); }
  list(): GatewayTunnelProvider[] { return [...this.providers.values()]; }
}

export class GatewayTunnelManager {
  readonly registry: GatewayTunnelProviderRegistry;
  readonly stateRoot: string;
  private readonly processOwner?: GatewayTunnelProcessOwner;
  private readonly supervisorOptions: GatewayTunnelManagerOptions["supervisorOptions"];
  private readonly observer?: GatewayObservationSink;
  private readonly supervisors = new Map<string, GatewayTunnelSupervisor>();

  constructor(options: GatewayTunnelManagerOptions = {}) {
    this.registry = new GatewayTunnelProviderRegistry(options.providers);
    this.stateRoot = options.stateRoot ?? gatewayTunnelStateRoot();
    this.processOwner = options.processOwner;
    this.supervisorOptions = options.supervisorOptions;
    this.observer = options.observer;
  }

  register(provider: GatewayTunnelProvider): void { this.registry.register(provider); }

  supervisor(providerName: string, instance = "default"): GatewayTunnelSupervisor {
    const provider = this.registry.get(providerName);
    if (!provider) throw controlError("tunnel_provider_unavailable", `Unknown tunnel provider: ${providerName}`);
    const path = gatewayTunnelStatePath(providerName, instance, this.stateRoot);
    const key = `${providerName}\0${instance}`;
    let supervisor = this.supervisors.get(key);
    if (!supervisor) {
      supervisor = new GatewayTunnelSupervisor({
        provider,
        instance,
        stateStore: new GatewayTunnelStateStore({ path, provider: providerName, instance }),
        ...(this.processOwner ? { processOwner: this.processOwner } : {}),
        ...(this.observer ? { observer: this.observer } : {}),
        ...this.supervisorOptions,
      });
      this.supervisors.set(key, supervisor);
    }
    return supervisor;
  }

  async control(action: GatewayTunnelControlAction, data?: Record<string, unknown>): Promise<unknown> {
    if (action === "tunnel-status" && data?.provider === undefined) {
      const states = await Promise.all(this.registry.list().map(async (provider) => {
        const state = await this.supervisor(provider.name).status();
        return state ? publicState(state) : { provider: provider.name, instance: "default", desiredState: "stopped", observed: { phase: "stopped" } };
      }));
      return { providers: states };
    }
    const provider = requiredIdentifier(data?.provider, "provider");
    const instance = data?.instance === undefined ? "default" : requiredIdentifier(data.instance, "instance");
    const supervisor = this.supervisor(provider, instance);
    const options = operationOptions(data);
    const state = action === "tunnel-status" ? await supervisor.status()
      : action === "tunnel-start" ? await supervisor.start(options)
        : action === "tunnel-stop" ? await supervisor.stop(options)
          : await supervisor.restart(options);
    return state ? publicState(state) : { provider, instance, desiredState: "stopped", observed: { phase: "stopped" } };
  }

  async recoverAll(options: GatewayTunnelOperationOptions = {}): Promise<void> {
    // Providers may add named instances later through explicit control. Default
    // instance recovery is deterministic and does not scan untrusted paths.
    await Promise.allSettled(this.registry.list().map((provider) => this.supervisor(provider.name).recover(options)));
  }

  async quiesceAll(deadlineAt: number): Promise<void> {
    await Promise.allSettled([...this.supervisors.values()].map((supervisor) => supervisor.quiesce(deadlineAt)));
  }

  async closeAll(deadlineAt: number): Promise<void> {
    await Promise.allSettled([...this.supervisors.values()].map((supervisor) => supervisor.close(deadlineAt)));
  }
}

function operationOptions(data?: Record<string, unknown>): GatewayTunnelOperationOptions {
  const timeoutMs = optionalPositiveInteger(data?.timeoutMs, "timeoutMs");
  const deadlineAt = optionalPositiveInteger(data?.deadlineAt, "deadlineAt");
  const expectedGeneration = optionalNonNegativeInteger(data?.expectedGeneration ?? data?.generation, "expectedGeneration");
  const input = data?.input;
  if (input !== undefined && (!input || typeof input !== "object" || Array.isArray(input))) throw controlError("invalid_arguments", "Tunnel input must be an object");
  return {
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
    ...(deadlineAt === undefined ? {} : { deadlineAt }),
    ...(expectedGeneration === undefined ? {} : { expectedGeneration }),
    ...(input === undefined ? {} : { input: input as Record<string, unknown> }),
  };
}

function requiredIdentifier(value: unknown, field: string): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(value)) throw controlError("invalid_arguments", `Tunnel ${field} is required and must be a safe identifier`);
  return value;
}
function optionalPositiveInteger(value: unknown, field: string): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) throw controlError("invalid_arguments", `Tunnel ${field} must be a positive integer`);
  return parsed;
}
function optionalNonNegativeInteger(value: unknown, field: string): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw controlError("invalid_arguments", `Tunnel ${field} must be a non-negative integer`);
  return parsed;
}
function publicState(state: GatewayTunnelState): GatewayTunnelPublicState {
  const { ownerToken: _ownerToken, ...safe } = state;
  return safe;
}
function controlError(code: string, message: string): Error & { code: string } { return Object.assign(new Error(message), { code }); }
