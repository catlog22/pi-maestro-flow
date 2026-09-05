/** Principal construction and migration helpers for Gateway callers. */
import { randomUUID } from "node:crypto";
import {
  GATEWAY_PRINCIPAL_TRANSPORTS,
  GATEWAY_STATE_VERSION,
  type GatewayPrincipal,
  type GatewayPrincipalTransport,
} from "./contracts.ts";
import { parseGatewayPrincipal } from "./validation.ts";

export interface GatewayPrincipalOptions {
  workspaceId?: string;
  workspacePath?: string;
  authenticated?: boolean;
  scopes?: string[];
  source?: string;
}

export function createGatewayPrincipal(
  transport: GatewayPrincipalTransport,
  id: string,
  options: GatewayPrincipalOptions = {},
): GatewayPrincipal {
  if (!GATEWAY_PRINCIPAL_TRANSPORTS.includes(transport)) throw new Error(`Unsupported Gateway principal transport: ${transport}`);
  if (typeof id !== "string" || id.trim() === "") throw new Error("Gateway principal id must be non-empty");
  return parseGatewayPrincipal({
    version: GATEWAY_STATE_VERSION,
    id: id.trim(),
    transport,
    scopes: [...(options.scopes ?? [])],
    ...(options.workspaceId === undefined ? {} : { workspaceId: options.workspaceId }),
    ...(options.workspacePath === undefined ? {} : { workspacePath: options.workspacePath }),
    ...(options.authenticated === undefined ? {} : { authenticated: options.authenticated }),
    ...(options.source === undefined ? {} : { source: options.source }),
  });
}

export function createAnonymousGatewayPrincipal(id = "anonymous"): GatewayPrincipal {
  return createGatewayPrincipal("http", id, { authenticated: false });
}

export function createLocalGatewayPrincipal(id = `local-${randomUUID()}`, options: GatewayPrincipalOptions = {}): GatewayPrincipal {
  return createGatewayPrincipal("stdio", id, { authenticated: true, ...options });
}

/** Normalize pre-v1 records at the read boundary; writes always include version. */
export function normalizeGatewayPrincipal(value: unknown): GatewayPrincipal {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return parseGatewayPrincipal(value);
  const source = value as Record<string, unknown>;
  const legacyKind = source.kind ?? source.type;
  const transport = source.transport ?? (legacyKind === "http" ? "http" : "stdio");
  const id = source.id ?? source.principalId ?? source.ownerId;
  const normalized: Record<string, unknown> = {
    version: GATEWAY_STATE_VERSION,
    id,
    transport,
    scopes: Array.isArray(source.scopes) ? source.scopes : [],
  };
  for (const key of ["workspaceId", "workspacePath", "authenticated", "source"]) {
    if (source[key] !== undefined) normalized[key] = source[key];
  }
  return parseGatewayPrincipal(normalized);
}

export function principalKey(principal: GatewayPrincipal | unknown): string {
  const parsed = parseGatewayPrincipal(principal);
  return `${parsed.transport}:${parsed.id}`;
}
export const gatewayPrincipalKey = principalKey;

export function sameGatewayPrincipal(left: GatewayPrincipal | unknown, right: GatewayPrincipal | unknown): boolean {
  return principalKey(left) === principalKey(right);
}

export function principalHasScope(principal: GatewayPrincipal | unknown, scope: string): boolean {
  return parseGatewayPrincipal(principal).scopes.includes(scope);
}

export function isAuthenticatedPrincipal(principal: GatewayPrincipal | unknown): boolean {
  const parsed = parseGatewayPrincipal(principal);
  return parsed.authenticated === true || parsed.transport === "stdio";
}
