/** Pure projections from authoritative Board/Session snapshots into operational handoff records. */
import { createHash } from "node:crypto";
import type { BoardTaskV1 } from "./board-contracts.ts";
import {
  boardHandoffProjection,
  gatewayHandoffContentDigest,
  normalizeGatewayHandoffOrigin,
  type GatewayHandoffRecordV1,
} from "./handoff-record-contracts.ts";
import type { CollaborativeSessionV1 } from "./session-contracts.ts";

function recordId(workspaceId: string, authority: "board" | "session", entityId: string, revision: number): string {
  return `handoff-${authority}-${createHash("sha256").update(`${workspaceId}\0${entityId}\0${revision}`, "utf8").digest("hex").slice(0, 40)}`;
}

export function projectBoardHandoff(task: BoardTaskV1): GatewayHandoffRecordV1 | undefined {
  const content = task.status === "completed" ? task.result?.handoff ?? task.handoff : task.handoff;
  if (!content) return undefined;
  return {
    version: 1,
    schema: "gateway-handoff/1",
    kind: "handoff",
    id: recordId(task.workspaceId, "board", task.id, task.revision),
    workspaceId: task.workspaceId,
    source: { authority: "board", entityId: task.id, revision: task.revision },
    origin: normalizeGatewayHandoffOrigin(task.handoffOrigin),
    projection: boardHandoffProjection(task.status),
    lifecycleStatus: task.status,
    resumable: task.status !== "completed" && task.status !== "cancelled",
    governanceState: "operational",
    createdAt: task.updatedAt,
    updatedAt: task.updatedAt,
    contentSha256: gatewayHandoffContentDigest(content),
    content: structuredClone(content),
  };
}

export function projectSessionHandoff(session: CollaborativeSessionV1): GatewayHandoffRecordV1 | undefined {
  if (!session.handoff) return undefined;
  const closed = session.status === "closed";
  return {
    version: 1,
    schema: "gateway-handoff/1",
    kind: "handoff",
    id: recordId(session.workspaceId, "session", session.id, session.revision),
    workspaceId: session.workspaceId,
    source: { authority: "session", entityId: session.id, revision: session.revision },
    origin: normalizeGatewayHandoffOrigin(session.handoffOrigin),
    projection: closed ? "unknown" : "incomplete",
    lifecycleStatus: session.status,
    resumable: !closed,
    governanceState: "operational",
    createdAt: session.updatedAt,
    updatedAt: session.updatedAt,
    contentSha256: gatewayHandoffContentDigest(session.handoff),
    content: structuredClone(session.handoff),
  };
}
