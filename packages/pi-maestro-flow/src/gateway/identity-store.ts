/** Membership, transport identity, workspace and open-mode authorization. */
import type { GatewayAuthMode } from "./config.ts";
import type { GatewayPrincipal } from "./contracts.ts";
import type { CollaborativeSessionV1, SessionMemberV1 } from "./session-contracts.ts";
import { principalKey } from "./principal.ts";

export type SessionScope =
  | "session:read"
  | "session:write"
  | "member:manage"
  | "todo:read"
  | "todo:write"
  | "execution:start"
  | "monitor:read"
  | "monitor:message"
  | "monitor:cancel";
export const SESSION_ROLE_SCOPES: Record<SessionMemberV1["role"], readonly SessionScope[]> = {
  owner: ["session:read", "session:write", "member:manage", "todo:read", "todo:write", "execution:start", "monitor:read", "monitor:message", "monitor:cancel"],
  agent: ["session:read", "todo:read", "todo:write", "execution:start", "monitor:read", "monitor:message", "monitor:cancel"],
  web: ["session:read", "todo:read", "todo:write", "execution:start", "monitor:read", "monitor:message", "monitor:cancel"],
  observer: ["session:read", "todo:read", "monitor:read"],
};

export class SessionAuthorizationError extends Error {
  constructor(message: string) { super(message); this.name = "SessionAuthorizationError"; }
}
export interface SessionIdentityContext { principal: GatewayPrincipal; memberId: string; authMode: GatewayAuthMode; }

export function sessionScopes(session: CollaborativeSessionV1, members: readonly SessionMemberV1[], context: SessionIdentityContext, now = Date.now()): SessionScope[] {
  if (context.principal.workspaceId !== undefined && context.principal.workspaceId !== session.workspaceId) return [];
  if (context.principal.workspacePath !== undefined && context.principal.workspacePath !== session.workspacePath) return [];
  const member = members.find((candidate) => candidate.id === context.memberId);
  if (!member || member.sessionId !== session.id || member.principalId !== principalKey(context.principal)) return [];
  if (member.status !== "active" || member.leaseExpiresAt <= now) return [];
  const roleScopes = SESSION_ROLE_SCOPES[member.role];
  const effective = member.capabilities.filter((value): value is SessionScope => roleScopes.includes(value as SessionScope));
  return context.authMode === "open" ? effective.filter((scope) => scope.endsWith(":read")) : effective;
}

export function assertSessionScope(session: CollaborativeSessionV1, members: readonly SessionMemberV1[], context: SessionIdentityContext, scope: SessionScope, now = Date.now()): SessionMemberV1 {
  if (!sessionScopes(session, members, context, now).includes(scope)) throw new SessionAuthorizationError(`Session scope denied: ${scope}`);
  return members.find((member) => member.id === context.memberId)!;
}

export function defaultSessionCapabilities(role: SessionMemberV1["role"]): SessionScope[] { return [...SESSION_ROLE_SCOPES[role]]; }

export class IdentityStore {
  scopes(session: CollaborativeSessionV1, members: readonly SessionMemberV1[], context: SessionIdentityContext, now = Date.now()): SessionScope[] {
    return sessionScopes(session, members, context, now);
  }
  assert(session: CollaborativeSessionV1, members: readonly SessionMemberV1[], context: SessionIdentityContext, scope: SessionScope, now = Date.now()): SessionMemberV1 {
    return assertSessionScope(session, members, context, scope, now);
  }
}
