/** Authorized read service for derived operational handoff records. */
import { randomUUID } from "node:crypto";
import type { GatewayAuthMode } from "../config.ts";
import type { GatewayPrincipal, GatewayResult } from "../contracts.ts";
import type { GatewayHandoffRecordV1, GatewayHandoffRequest } from "../handoff-record-contracts.ts";
import { GatewayHandoffRecordStore, type GatewayHandoffRecordFilter } from "../handoff-record-store.ts";
import { projectBoardHandoff, projectSessionHandoff } from "../handoff-projection.ts";
import { assertSessionScope } from "../identity-store.ts";
import type { GatewayPolicy } from "../policy.ts";
import { principalKey } from "../principal.ts";
import { gatewayError, gatewayOk } from "../result.ts";
import type { SessionStore } from "../session-store.ts";
import type { BoardStore } from "../board-store.ts";

export interface GatewayHandoffServiceOptions {
  policy: GatewayPolicy;
  sessions: SessionStore;
  records: GatewayHandoffRecordStore;
  boardStoreForWorkspace: (workspacePath: string) => BoardStore;
  authMode: GatewayAuthMode;
}

function options(principal: GatewayPrincipal, request: GatewayHandoffRequest) {
  return { requestId: request.requestId ?? randomUUID(), principalId: principalKey(principal) };
}

function visibleSessionRecord(record: GatewayHandoffRecordV1, states: Awaited<ReturnType<SessionStore["list"]>>, principal: GatewayPrincipal, memberId: string | undefined, authMode: GatewayAuthMode): boolean {
  if (record.source.authority !== "session") return true;
  if (!memberId) return false;
  const state = states.find((candidate) => candidate.session.id === record.source.entityId);
  if (!state) return false;
  try {
    assertSessionScope(state.session, state.members, { principal, memberId, authMode }, "session:read");
    return true;
  } catch { return false; }
}

export class GatewayHandoffService {
  private readonly policy: GatewayPolicy;
  private readonly sessions: SessionStore;
  private readonly records: GatewayHandoffRecordStore;
  private readonly boardStoreForWorkspace: (workspacePath: string) => BoardStore;
  private readonly authMode: GatewayAuthMode;

  constructor(value: GatewayHandoffServiceOptions) {
    this.policy = value.policy;
    this.sessions = value.sessions;
    this.records = value.records;
    this.boardStoreForWorkspace = value.boardStoreForWorkspace;
    this.authMode = value.authMode;
  }

  async handle(principal: GatewayPrincipal, request: GatewayHandoffRequest): Promise<GatewayResult<unknown>> {
    const resultOptions = options(principal, request);
    try {
      const decision = await this.policy.authorizeWorkspace(principal, request.workspaceId);
      if (!decision.allowed || !decision.workspacePath) return gatewayError({ code: "not_found", message: "Handoff resource was not found" }, resultOptions);
      await this.reconcile(decision.workspacePath, request.workspaceId);
      const sessionStates = await this.sessions.list(256);
      if (request.action === "get") {
        const record = await this.records.get(request.workspaceId, request.id);
        if (!record || !visibleSessionRecord(record, sessionStates, principal, request.memberId, this.authMode)) {
          return gatewayError({ code: "not_found", message: "Handoff resource was not found" }, resultOptions);
        }
        return gatewayOk({ record }, resultOptions);
      }
      const filter: GatewayHandoffRecordFilter = {
        ...(request.authority === undefined ? {} : { authority: request.authority }),
        ...(request.projection === undefined ? {} : { projection: request.projection }),
        ...(request.action === "list" && request.sourceId !== undefined ? { sourceId: request.sourceId } : {}),
        ...(request.action === "search" ? { query: request.query } : {}),
      };
      const records: GatewayHandoffRecordV1[] = [];
      let scanCursor = 0;
      while (true) {
        const page = await this.records.list(request.workspaceId, { ...filter, cursor: scanCursor, limit: 256 });
        records.push(...page.records.filter((record) => visibleSessionRecord(record, sessionStates, principal, request.memberId, this.authMode)));
        if (!page.hasMore) break;
        scanCursor = page.nextCursor;
      }
      const cursor = request.cursor ?? 0;
      const limit = request.limit ?? 64;
      if (!Number.isSafeInteger(cursor) || cursor < 0) throw new Error("cursor must be a non-negative safe integer");
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 256) throw new Error("limit must be in [1, 256]");
      const visible = records.slice(cursor, cursor + limit);
      return gatewayOk({ workspaceId: request.workspaceId, records: visible, nextCursor: cursor + visible.length, hasMore: cursor + visible.length < records.length }, resultOptions);
    } catch (error) {
      return gatewayError({ code: "handoff_action_failed", message: error instanceof Error ? error.message : String(error) }, resultOptions);
    }
  }

  private async reconcile(workspacePath: string, workspaceId: string): Promise<void> {
    const board = this.boardStoreForWorkspace(workspacePath);
    for (const task of await board.list()) {
      const record = projectBoardHandoff(task);
      if (record) await this.records.put(record);
    }
    for (const state of await this.sessions.list(256)) {
      if (state.session.workspaceId !== workspaceId) continue;
      const record = projectSessionHandoff(state.session);
      if (record) await this.records.put(record);
    }
  }
}
