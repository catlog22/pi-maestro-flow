/** Versioned, fenced persistence for one tunnel instance. */
import { dirname, join } from "node:path";
import { gatewayTunnelsRoot, readGatewayJson, writeGatewayJsonAtomic } from "../state-paths.ts";
import {
  GATEWAY_TUNNEL_PHASES,
  GATEWAY_TUNNEL_RECORD_VERSION,
  type GatewayTunnelState,
} from "./contracts.ts";

const MAX_TUNNEL_STATE_BYTES = 128 * 1024;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;

export class GatewayTunnelStateConflictError extends Error {
  readonly code = "stale_generation";
  constructor(message: string) { super(message); this.name = "GatewayTunnelStateConflictError"; }
}

export interface GatewayTunnelStateFence {
  expectedGeneration?: number;
  expectedOwnerToken?: string;
}

export interface GatewayTunnelStateStoreOptions {
  path: string;
  provider: string;
  instance?: string;
}

export function gatewayTunnelStateRoot(homeDir?: string): string {
  return gatewayTunnelsRoot(homeDir);
}

export function gatewayTunnelStatePath(provider: string, instance = "default", root = gatewayTunnelStateRoot()): string {
  if (!SAFE_ID.test(provider)) throw new Error("Tunnel provider must be a safe identifier");
  if (!SAFE_ID.test(instance)) throw new Error("Tunnel instance must be a safe identifier");
  return join(root, provider, `${instance}.json`);
}

export class GatewayTunnelStateStore {
  readonly path: string;
  readonly provider: string;
  readonly instance: string;
  private tail: Promise<void> = Promise.resolve();

  constructor(options: GatewayTunnelStateStoreOptions) {
    this.path = options.path;
    this.provider = options.provider;
    this.instance = options.instance ?? "default";
    gatewayTunnelStatePath(this.provider, this.instance, dirname(dirname(this.path)));
  }

  async read(): Promise<GatewayTunnelState | undefined> {
    const value = await readGatewayJson<unknown>(this.path, MAX_TUNNEL_STATE_BYTES);
    if (value === undefined) return undefined;
    return validateGatewayTunnelState(value, this.provider, this.instance);
  }

  save(state: GatewayTunnelState, fence: GatewayTunnelStateFence = {}): Promise<GatewayTunnelState> {
    return this.serial(async () => {
      const current = await this.read();
      if (fence.expectedGeneration !== undefined && (current?.generation ?? 0) !== fence.expectedGeneration) {
        throw new GatewayTunnelStateConflictError(`Tunnel generation is stale (expected ${fence.expectedGeneration}, current ${current?.generation ?? 0})`);
      }
      if (fence.expectedOwnerToken !== undefined && current?.ownerToken !== fence.expectedOwnerToken) {
        throw new GatewayTunnelStateConflictError("Tunnel owner token is stale");
      }
      const validated = validateGatewayTunnelState(state, this.provider, this.instance);
      for (let attempt = 0; ; attempt += 1) {
        try {
          await writeGatewayJsonAtomic(this.path, validated, { maximumBytes: MAX_TUNNEL_STATE_BYTES, mode: 0o600 });
          break;
        } catch (error) {
          const code = (error as NodeJS.ErrnoException).code;
          if (process.platform !== "win32" || (code !== "EPERM" && code !== "EACCES") || attempt >= 4) throw error;
          await new Promise((resolve) => setTimeout(resolve, 5 * (attempt + 1)));
        }
      }
      return validated;
    });
  }

  private serial<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.tail.then(operation, operation);
    this.tail = result.then(() => undefined, () => undefined);
    return result;
  }
}

export function validateGatewayTunnelState(value: unknown, provider?: string, instance?: string): GatewayTunnelState {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid Gateway tunnel state");
  const state = value as Record<string, unknown>;
  if (state.version !== GATEWAY_TUNNEL_RECORD_VERSION) throw new Error("Unsupported Gateway tunnel state version");
  if (typeof state.provider !== "string" || !SAFE_ID.test(state.provider) || (provider !== undefined && state.provider !== provider)) throw new Error("Invalid Gateway tunnel provider");
  if (typeof state.instance !== "string" || !SAFE_ID.test(state.instance) || (instance !== undefined && state.instance !== instance)) throw new Error("Invalid Gateway tunnel instance");
  if (state.desiredState !== "stopped" && state.desiredState !== "running") throw new Error("Invalid Gateway tunnel desired state");
  if (!state.observed || typeof state.observed !== "object" || Array.isArray(state.observed)) throw new Error("Invalid Gateway tunnel observed state");
  const observed = state.observed as Record<string, unknown>;
  if (typeof observed.phase !== "string" || !(GATEWAY_TUNNEL_PHASES as readonly string[]).includes(observed.phase)) throw new Error("Invalid Gateway tunnel observed phase");
  for (const field of ["generation", "updatedAt"] as const) {
    if (!Number.isSafeInteger(state[field]) || Number(state[field]) < (field === "generation" ? 0 : 0)) throw new Error(`Invalid Gateway tunnel ${field}`);
  }
  if (!Number.isSafeInteger(observed.changedAt) || Number(observed.changedAt) < 0) throw new Error("Invalid Gateway tunnel observed timestamp");
  if (typeof state.ownerToken !== "string" || state.ownerToken.length < 16 || state.ownerToken.length > 256) throw new Error("Invalid Gateway tunnel owner token");
  if (!Array.isArray(state.restartHistory) || state.restartHistory.length > 256 || state.restartHistory.some((entry) => !Number.isSafeInteger(entry) || Number(entry) < 0)) throw new Error("Invalid Gateway tunnel restart history");
  const identityFields = ["executableRealpath", "processStartIdentity", "invocationDigest"] as const;
  const present = identityFields.filter((field) => state[field] !== undefined).length + (state.pid !== undefined ? 1 : 0);
  if (present !== 0 && present !== 4) throw new Error("Gateway tunnel process identity must be complete");
  if (state.pid !== undefined && (!Number.isSafeInteger(state.pid) || Number(state.pid) < 1 || Number(state.pid) > 0x7fffffff)) throw new Error("Invalid Gateway tunnel pid");
  for (const field of identityFields) if (state[field] !== undefined && (typeof state[field] !== "string" || String(state[field]).length < 1 || String(state[field]).length > 4096)) throw new Error(`Invalid Gateway tunnel ${field}`);
  for (const field of ["detail", "endpoint", "opaqueId"] as const) if (observed[field] !== undefined && (typeof observed[field] !== "string" || String(observed[field]).length > 16 * 1024)) throw new Error(`Invalid Gateway tunnel observed ${field}`);
  return value as GatewayTunnelState;
}
