/** Principal-filtered workspace discovery and trusted local registry control. */
import { randomUUID } from "node:crypto";
import type { GatewayPrincipal, GatewayResult, GatewayWorkspace } from "../contracts.ts";
import { GatewayPolicy, type GatewayVisibleWorkspace } from "../policy.ts";
import { principalKey } from "../principal.ts";
import { gatewayError, gatewayOk } from "../result.ts";
import { canonicalizeWorkspacePath } from "../state-paths.ts";
import {
  WorkspaceLeaseConflictError,
  WorkspaceNotFoundError,
  WorkspaceRegistry,
} from "../workspace-registry.ts";

const DEFAULT_PAGE_SIZE = 64;

export type GatewayWorkspaceAction = "list" | "get";
export interface GatewayWorkspaceRequest {
  action: GatewayWorkspaceAction;
  requestId?: string;
  cursor?: number;
  limit?: number;
  workspaceId?: string;
  id?: string;
  workspace?: string;
  path?: string;
}

export type GatewayWorkspaceControlAction = "workspace-list" | "workspace-register" | "workspace-renew" | "workspace-remove";
export interface GatewayWorkspaceControlRequest {
  path?: unknown;
  workspaceId?: unknown;
  id?: unknown;
  ttlSeconds?: unknown;
  expectedGeneration?: unknown;
}

export interface GatewayWorkspaceListData {
  workspaces: GatewayVisibleWorkspace[];
  nextCursor: number;
  hasMore: boolean;
}

export interface GatewayWorkspaceGetData {
  workspace: GatewayVisibleWorkspace;
}

export interface GatewayWorkspaceRemoveData {
  removed: boolean;
}

function positiveInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) throw new Error(`${label} must be a positive safe integer`);
  return value as number;
}

function nonNegativeInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) throw new Error(`${label} must be a non-negative safe integer`);
  return value as number;
}

function reference(request: Pick<GatewayWorkspaceRequest, "workspaceId" | "id" | "workspace" | "path">): string {
  const value = request.workspaceId ?? request.id ?? request.workspace ?? request.path;
  if (typeof value !== "string" || !value.trim()) throw new Error("workspaceId or path is required");
  return value.trim();
}

function visible(workspace: GatewayWorkspace): GatewayVisibleWorkspace {
  const { ownerToken: _ownerToken, ...result } = workspace;
  return result;
}

export class WorkspaceService {
  constructor(
    readonly policy: GatewayPolicy,
    readonly registry: WorkspaceRegistry,
  ) {}

  async handle(principal: GatewayPrincipal, request: GatewayWorkspaceRequest): Promise<GatewayResult<unknown>> {
    const requestId = request.requestId ?? randomUUID();
    const principalId = principalKey(principal);
    try {
      if (request.action === "list") {
        const cursor = request.cursor === undefined ? 0 : nonNegativeInteger(request.cursor, "cursor");
        const limit = request.limit === undefined ? DEFAULT_PAGE_SIZE : positiveInteger(request.limit, "limit");
        if (limit > this.policy.limits.maxWorkspaceCount) throw new Error(`limit must be <= ${this.policy.limits.maxWorkspaceCount}`);
        const authorized = await this.policy.listAuthorizedWorkspaces(principal);
        const workspaces = authorized.slice(cursor, cursor + limit);
        const nextCursor = cursor + workspaces.length;
        return gatewayOk({ workspaces, nextCursor, hasMore: nextCursor < authorized.length }, { requestId, principalId });
      }
      if (request.action === "get") {
        const requested = reference(request);
        const decision = await this.policy.authorizeWorkspace(principal, requested);
        if (!decision.allowed || decision.workspacePath === undefined) {
          return gatewayError({ code: "not_found", message: "Workspace was not found" }, { requestId, principalId });
        }
        const workspace = (await this.policy.listAuthorizedWorkspaces(principal)).find((entry) => entry.id === decision.workspaceId || entry.path === decision.workspacePath);
        if (!workspace) return gatewayError({ code: "not_found", message: "Workspace was not found" }, { requestId, principalId });
        return gatewayOk({ workspace }, { requestId, principalId });
      }
      return gatewayError({ code: "invalid_action", message: "Unsupported workspace action" }, { requestId, principalId });
    } catch (error) {
      return gatewayError({ code: "workspace_action_failed", message: error instanceof Error ? error.message : String(error) }, { requestId, principalId });
    }
  }

  async control(action: GatewayWorkspaceControlAction, request: GatewayWorkspaceControlRequest = {}): Promise<GatewayVisibleWorkspace[] | GatewayVisibleWorkspace | GatewayWorkspaceRemoveData> {
    if (action === "workspace-list") return this.policy.listAuthorizedWorkspaces({ version: 1, id: "local-owner", transport: "stdio", scopes: ["gateway.control"], authenticated: true });
    if (action === "workspace-register") {
      if (typeof request.path !== "string" || !request.path.trim()) throw new Error("workspace-register requires a path");
      const path = canonicalizeWorkspacePath(request.path);
      const ttlSeconds = request.ttlSeconds === undefined ? 300 : nonNegativeInteger(request.ttlSeconds, "ttlSeconds");
      const expectedGeneration = request.expectedGeneration === undefined ? undefined : positiveInteger(request.expectedGeneration, "expectedGeneration");
      const current = await this.findRegistered(path);
      if (expectedGeneration !== undefined && current?.generation !== expectedGeneration) throw new WorkspaceLeaseConflictError();
      const mode = ttlSeconds === 0 ? "permanent" as const : "lease" as const;
      const active = current !== undefined && await this.registry.get(current.id) !== undefined;
      const next = active
        ? await this.registry.renew(current.id, {
          mode,
          ...(mode === "lease" ? { ttlSeconds } : {}),
          expectedGeneration: current.generation,
          ...(current.ownerToken === undefined ? {} : { ownerToken: current.ownerToken }),
        })
        : await this.registry.register(path, {
          mode,
          ...(mode === "lease" ? { ttlSeconds } : {}),
          ...(current === undefined ? {} : {
            expectedGeneration: current.generation,
            ...(current.ownerToken === undefined ? {} : { ownerToken: current.ownerToken }),
          }),
        });
      return visible(next);
    }
    const requested = controlReference(request);
    const expectedGeneration = positiveInteger(request.expectedGeneration, "expectedGeneration");
    const current = await this.findRegistered(requested);
    if (!current) throw new WorkspaceNotFoundError(requested);
    if (action === "workspace-renew") {
      const ttlSeconds = request.ttlSeconds === undefined ? 300 : positiveInteger(request.ttlSeconds, "ttlSeconds");
      return visible(await this.registry.renew(current.id, {
        ttlSeconds,
        expectedGeneration,
        ...(current.ownerToken === undefined ? {} : { ownerToken: current.ownerToken }),
      }));
    }
    if (action === "workspace-remove") {
      return { removed: await this.registry.unregister(current.id, {
        expectedGeneration,
        ...(current.ownerToken === undefined ? {} : { ownerToken: current.ownerToken }),
      }) };
    }
    throw new Error(`Unsupported workspace control action: ${action}`);
  }

  private async findRegistered(pathOrId: string): Promise<GatewayWorkspace | undefined> {
    const workspaces = await this.registry.list({ includeExpired: true });
    const byId = workspaces.find((entry) => entry.id === pathOrId);
    if (byId) return byId;
    let path: string;
    try { path = canonicalizeWorkspacePath(pathOrId); } catch { return undefined; }
    return workspaces.find((entry) => (entry.canonicalPath ?? entry.path) === path);
  }
}

function controlReference(request: GatewayWorkspaceControlRequest): string {
  const value = request.workspaceId ?? request.id ?? request.path;
  if (typeof value !== "string" || !value.trim()) throw new Error("workspaceId or path is required");
  return value.trim();
}
