/** Local machine capability and liveness operations for the Gateway. */
import { randomUUID } from "node:crypto";
import {
  arch,
  cpus,
  freemem,
  hostname,
  loadavg,
  platform,
  release,
  totalmem,
  uptime,
} from "node:os";
import type { GatewayPrincipal, GatewayResult } from "../contracts.ts";
import { createLocalGatewayPrincipal } from "../principal.ts";
import { gatewayError, gatewayOk } from "../result.ts";
import { parseGatewayPrincipal } from "../validation.ts";

export interface HostRequest {
  principal?: GatewayPrincipal;
  requestId?: string;
}

export interface HostServiceOptions {
  principal?: GatewayPrincipal;
}

export interface HostDescription {
  service: "gateway";
  version: 1;
  platform: NodeJS.Platform;
  arch: string;
  release: string;
  nodeVersion: string;
  hostname: string;
  pid: number;
  cwd: string;
  cpuCount: number;
  features: string[];
}

export interface HostStatus extends HostDescription {
  uptimeSeconds: number;
  loadAverage: number[];
  memory: {
    totalBytes: number;
    freeBytes: number;
  };
}

export interface HostTest {
  reachable: true;
  checkedAt: string;
  pid: number;
}

export type HostAction = "describe" | "status" | "test";
export interface HostActionRequest extends HostRequest {
  action: HostAction;
}

function resultOptions(principal: GatewayPrincipal, requestId: string | undefined, startedAt: number) {
  return {
    requestId: requestId && requestId.trim() ? requestId : randomUUID(),
    principalId: principal.id,
    startedAt: new Date(startedAt).toISOString(),
    durationMs: Math.max(0, Date.now() - startedAt),
  };
}

function errorResult(error: unknown, principal: GatewayPrincipal, requestId: string | undefined, startedAt: number): GatewayResult {
  const code = error instanceof Error && error.name === "GatewayValidationError" ? "invalid_principal" : "internal_error";
  return gatewayError({
    code,
    message: error instanceof Error ? error.message : String(error),
  }, resultOptions(principal, requestId, startedAt));
}

export class HostService {
  private readonly defaultPrincipal: GatewayPrincipal;

  constructor(options: HostServiceOptions = {}) {
    this.defaultPrincipal = options.principal === undefined
      ? createLocalGatewayPrincipal("gateway-host")
      : parseGatewayPrincipal(options.principal);
  }

  describe(principalOrRequest?: GatewayPrincipal | HostRequest): GatewayResult<HostDescription> {
    const startedAt = Date.now();
    const request = principalOrRequest && "transport" in principalOrRequest
      ? { principal: principalOrRequest }
      : (principalOrRequest ?? {});
    let principal: GatewayPrincipal;
    try { principal = this.principal(request.principal); }
    catch (error) { return errorResult(error, this.defaultPrincipal, request.requestId, startedAt) as GatewayResult<HostDescription>; }
    try {
      return gatewayOk(this.description(), resultOptions(principal, request.requestId, startedAt));
    } catch (error) {
      return errorResult(error, principal, request.requestId, startedAt) as GatewayResult<HostDescription>;
    }
  }

  status(principalOrRequest?: GatewayPrincipal | HostRequest): GatewayResult<HostStatus> {
    const startedAt = Date.now();
    const request = principalOrRequest && "transport" in principalOrRequest
      ? { principal: principalOrRequest }
      : (principalOrRequest ?? {});
    let principal: GatewayPrincipal;
    try { principal = this.principal(request.principal); }
    catch (error) { return errorResult(error, this.defaultPrincipal, request.requestId, startedAt) as GatewayResult<HostStatus>; }
    try {
      return gatewayOk({
        ...this.description(),
        uptimeSeconds: uptime(),
        loadAverage: [...loadavg()],
        memory: { totalBytes: totalmem(), freeBytes: freemem() },
      }, resultOptions(principal, request.requestId, startedAt));
    } catch (error) {
      return errorResult(error, principal, request.requestId, startedAt) as GatewayResult<HostStatus>;
    }
  }

  test(principalOrRequest?: GatewayPrincipal | HostRequest): GatewayResult<HostTest> {
    const startedAt = Date.now();
    const request = principalOrRequest && "transport" in principalOrRequest
      ? { principal: principalOrRequest }
      : (principalOrRequest ?? {});
    let principal: GatewayPrincipal;
    try { principal = this.principal(request.principal); }
    catch (error) { return errorResult(error, this.defaultPrincipal, request.requestId, startedAt) as GatewayResult<HostTest>; }
    try {
      return gatewayOk({ reachable: true, checkedAt: new Date().toISOString(), pid: process.pid }, resultOptions(principal, request.requestId, startedAt));
    } catch (error) {
      return errorResult(error, principal, request.requestId, startedAt) as GatewayResult<HostTest>;
    }
  }

  handle(request: HostActionRequest): GatewayResult<HostDescription | HostStatus | HostTest> {
    if (request.action === "describe") return this.describe(request);
    if (request.action === "status") return this.status(request);
    if (request.action === "test") return this.test(request);
    let principal: GatewayPrincipal;
    try { principal = this.principal(request.principal); }
    catch (error) { return errorResult(error, this.defaultPrincipal, request.requestId, Date.now()) as GatewayResult<HostDescription | HostStatus | HostTest>; }
    return gatewayError({ code: "invalid_action", message: `Unsupported host action: ${String(request.action)}` }, {
      requestId: request.requestId ?? randomUUID(),
      principalId: principal.id,
    });
  }

  private principal(value: GatewayPrincipal | undefined): GatewayPrincipal {
    return value === undefined ? this.defaultPrincipal : parseGatewayPrincipal(value);
  }

  private description(): HostDescription {
    return {
      service: "gateway",
      version: 1,
      platform: platform(),
      arch: arch(),
      release: release(),
      nodeVersion: process.version,
      hostname: hostname(),
      pid: process.pid,
      cwd: process.cwd(),
      cpuCount: cpus().length,
      features: ["host.describe", "host.status", "host.test", "bounded-process", "workspace-guard", "monitor-stream-v1"],
    };
  }
}

export const GatewayHostService = HostService;
export const createHostService = (options?: HostServiceOptions): HostService => new HostService(options);
export const createGatewayHostService = createHostService;
