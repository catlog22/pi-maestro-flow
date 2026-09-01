import { createHash } from "node:crypto";
import type {
  MonitorWorkRefV1,
  MonitorWindowAttentionV1,
  MonitorWindowCardV1,
  MonitorWindowCompletionEvidenceV1,
  MonitorWindowCompletionV1,
  MonitorWindowDeliveryV1,
  MonitorWindowFacetTargetV1,
  MonitorWindowFacetV1,
  MonitorWindowIdentityV1,
  MonitorWindowJsonValueV1,
  MonitorWindowStateV1,
  MonitorWindowTodoDisplayV1,
} from "../public/v1/monitor-window-state.ts";
import { MONITOR_WINDOW_STATE_VERSION } from "../public/v1/monitor-window-state.ts";
import type { SessionEndpoint, WindowThreadEntry } from "../sessions/session-core.ts";
import type { WorkspaceOwnerSnapshot } from "../sessions/workspace-peer-core.ts";

/** Minimal adapter over the root extension's managed-window record. */
export interface MonitorManagedWindowMetadataV1 {
  name: string;
  sessionName: string;
  objective?: string;
  presentation?: "interactive" | "headless";
  management?: "monitor" | "delegation";
  pid?: number;
  startedAt?: number;
  launchError?: string;
}

export interface MonitorManagedWindowEvidenceV1 {
  target: MonitorWindowFacetTargetV1;
  metadata: MonitorManagedWindowMetadataV1;
}

/** A journal entry plus the exact endpoint/work incarnation captured before reading it. */
export interface MonitorWindowThreadEvidenceV1 {
  target: Required<MonitorWindowFacetTargetV1>;
  entry: WindowThreadEntry;
}

export interface MonitorWindowReductionItemV1 {
  endpoint: SessionEndpoint;
  /** Current owner snapshot. A non-exact snapshot is treated as stale evidence. */
  owner?: WorkspaceOwnerSnapshot;
  managed?: MonitorManagedWindowEvidenceV1;
  workRef?: MonitorWorkRefV1;
  delivery?: readonly MonitorWindowThreadEvidenceV1[];
  completion?: readonly MonitorWindowCompletionEvidenceV1[];
  facets?: readonly MonitorWindowFacetV1[];
}

export interface MonitorWindowReductionInputV1 {
  /** Caller-supplied observation time; the reducer never reads the clock. */
  observedAt: number;
  windows: readonly MonitorWindowReductionItemV1[];
}

const DELIVERY_RANK: Record<WindowThreadEntry["status"], number> = {
  pending: 1,
  accepted: 2,
  queued: 3,
  rejected: 4,
  timeout: 4,
  injected: 5,
  replied: 6,
};

const COMPLETION_RANK: Record<MonitorWindowCompletionEvidenceV1["source"], number> = {
  "exact-report": 1,
  "canonical-completion": 2,
};

const SEVERITY_RANK = { info: 1, warning: 2, error: 3 } as const;

/**
 * Pure reduction of exact endpoint, owner, journal, completion, and optional
 * facet evidence into the public MonitorWindowStateV1 read model.
 */
export function reduceMonitorWindowStateV1(input: MonitorWindowReductionInputV1): MonitorWindowStateV1 {
  assertSafeTimestamp(input.observedAt, "Monitor observation time");
  const seen = new Set<string>();
  const windows = input.windows.map((item) => {
    const identity = identityFromEndpoint(item.endpoint);
    const key = identityKey(identity);
    if (seen.has(key)) throw new Error(`Duplicate Monitor endpoint incarnation: ${identity.endpointId}`);
    seen.add(key);
    return reduceWindow(item, identity);
  }).sort((left, right) => identityKey(left.identity).localeCompare(identityKey(right.identity)));

  const attention = windows.flatMap((window) => window.attention);
  const semantic = windows.map(semanticCard);
  const revision = hashMonitorWindowSemanticV1({
    version: MONITOR_WINDOW_STATE_VERSION,
    windows: semantic,
    attention,
  });

  return {
    version: MONITOR_WINDOW_STATE_VERSION,
    revision,
    cursor: `monitor-window-state:v1:${revision}`,
    observedAt: input.observedAt,
    windows,
    attention,
  };
}

function reduceWindow(item: MonitorWindowReductionItemV1, identity: MonitorWindowIdentityV1): MonitorWindowCardV1 {
  const target: MonitorWindowFacetTargetV1 = {
    identity,
    ...(item.workRef === undefined ? {} : { workRef: copyWorkRef(item.workRef) }),
  };
  const attention: MonitorWindowAttentionV1[] = [];

  const owner = item.owner && ownerMatches(item.owner, identity) ? item.owner : undefined;
  if (!item.owner) {
    attention.push(makeAttention(target, "owner-snapshot-unknown", "info", "Current owner snapshot is unavailable; owner details are unknown.", "reducer"));
  } else if (!owner) {
    attention.push(makeAttention(target, "owner-identity-mismatch", "warning", "A stale owner incarnation was ignored.", "reducer"));
  }

  const managed = item.managed && targetMatchesWindow(item.managed.target, identity)
    ? item.managed.metadata
    : undefined;
  if (item.managed && !managed) {
    attention.push(makeAttention(target, "managed-identity-mismatch", "warning", "Managed-window metadata for another owner incarnation was ignored.", "reducer"));
  }
  if (managed?.launchError) {
    attention.push(makeAttention(target, "managed-window-failed", "error", managed.launchError, "reducer"));
  }

  const deliveryCandidates = (item.delivery ?? []).filter((candidate) => {
    const matches = targetMatches(candidate.target, identity, item.workRef)
      && threadMatches(candidate.entry, identity, item.workRef);
    if (!matches) {
      attention.push(makeAttention(target, "delivery-identity-mismatch", "warning", "Delivery evidence for another owner or WorkRef was ignored.", "reducer"));
    }
    return matches;
  });
  const delivery = reduceDelivery(selectDelivery(deliveryCandidates)?.entry);

  const completionCandidates = (item.completion ?? []).filter((candidate) => {
    const matches = targetMatches(candidate.target, identity, item.workRef);
    if (!matches) {
      attention.push(makeAttention(target, "completion-identity-mismatch", "warning", "Late completion evidence for another owner or WorkRef was ignored.", "reducer"));
    }
    return matches;
  });
  const completion = reduceCompletion(selectCompletion(completionCandidates));

  const facets = (item.facets ?? []).filter((facet) => {
    const matches = targetMatches(facet.target, identity, facet.target.workRef === undefined ? undefined : item.workRef);
    if (!matches || (facet.target.workRef !== undefined && item.workRef === undefined)) {
      attention.push(makeAttention(target, "facet-identity-mismatch", "warning", "Facet data for another owner or WorkRef was ignored.", "reducer"));
      return false;
    }
    return true;
  }).map(copyFacet).sort((left, right) => {
    const kind = left.kind.localeCompare(right.kind);
    return kind === 0 ? left.revision.localeCompare(right.revision) : kind;
  });

  for (const facet of facets) {
    for (const facetAttention of facet.attention ?? []) {
      attention.push(makeAttention(
        target,
        facetAttention.dedupeKey ?? facetAttention.code,
        facetAttention.severity,
        facetAttention.message,
        `facet:${facet.kind}`,
        facetAttention.code,
      ));
    }
  }

  if (item.workRef !== undefined && completion.outcome === "unknown") {
    const lifecycleOnly = owner?.mainLastSettle !== undefined;
    attention.push(makeAttention(
      target,
      "completion-unknown",
      "info",
      lifecycleOnly
        ? "The window lifecycle settled, but exact work completion is still unknown."
        : "No exact report or canonical completion proves that this work completed.",
      lifecycleOnly ? "lifecycle" : "reducer",
    ));
  }
  if (item.workRef !== undefined && delivery.source === "unknown") {
    attention.push(makeAttention(target, "delivery-unknown", "info", "Delivery stage is unknown.", "reducer"));
  } else if (!delivery.consumed && (delivery.publicationStage === "accepted" || delivery.consumptionStage === "queued")) {
    attention.push(makeAttention(target, "delivery-not-consumed", "info", "The message was accepted or queued, but model consumption is not proven.", "reducer"));
  } else if (delivery.publicationStage === "rejected" || delivery.publicationStage === "timeout") {
    attention.push(makeAttention(target, "delivery-failed", "warning", `Message delivery ${delivery.publicationStage}.`, "reducer"));
  }

  const todos: MonitorWindowTodoDisplayV1[] = (owner?.todos ?? []).map((todo) => ({
    id: todo.id,
    subject: todo.subject,
    status: todo.status,
    ...(todo.assigneeLabel === undefined ? {} : { assigneeLabel: todo.assigneeLabel }),
    ...(todo.dispatchId === undefined ? {} : { dispatchId: todo.dispatchId }),
    ...(todo.scheduleId === undefined ? {} : { scheduleId: todo.scheduleId }),
    ...(todo.stepId === undefined ? {} : { stepId: todo.stepId }),
    ...(todo.bindingActive === undefined ? {} : { bindingActive: todo.bindingActive }),
    updatedAt: todo.updatedAt,
    authority: "display-only" as const,
    source: "workspace-owner" as const,
  })).sort((left, right) => left.id.localeCompare(right.id));

  const lifecycleStatus = managed?.launchError
    ? "failed" as const
    : endpointLifecycle(item.endpoint.status);
  const workStatus = completion.outcome !== "unknown"
    ? completion.outcome
    : delivery.consumed
      ? "active" as const
      : delivery.publicationStage === "rejected" || delivery.publicationStage === "timeout"
        ? "delivery-failed" as const
        : delivery.source !== "unknown"
          ? "waiting-delivery" as const
          : "unknown" as const;
  const dedupedAttention = dedupeAttention(attention);

  return {
    identity,
    endpoint: {
      status: item.endpoint.status,
      scope: item.endpoint.scope,
      transport: item.endpoint.transport,
      contentRevision: item.endpoint.contentRevision,
    },
    window: {
      ...((managed?.name ?? item.endpoint.name) === undefined ? {} : { name: managed?.name ?? item.endpoint.name }),
      ...((managed?.sessionName ?? owner?.sessionName ?? item.endpoint.sessionName) === undefined
        ? {}
        : { sessionName: managed?.sessionName ?? owner?.sessionName ?? item.endpoint.sessionName }),
      ...(managed?.objective === undefined ? {} : { objective: managed.objective }),
      ...(managed?.presentation === undefined ? {} : { presentation: managed.presentation }),
      ...(managed?.management === undefined ? {} : { management: managed.management }),
      ...((managed?.pid ?? owner?.pid) === undefined ? {} : { pid: managed?.pid ?? owner?.pid }),
      ...(managed?.startedAt === undefined ? {} : { startedAt: managed.startedAt }),
      lifecycle: {
        status: lifecycleStatus,
        source: managed?.launchError ? "managed-window" : lifecycleStatus === "unknown" ? "unknown" : "endpoint",
        ...(owner === undefined ? {} : { ownerPublishedAt: owner.publishedAt }),
        ...(owner?.mainLastSettle === undefined
          ? {}
          : {
              lastSettle: {
                at: owner.mainLastSettle.at,
                ...(owner.mainLastSettle.lastResult === undefined ? {} : { lastResult: owner.mainLastSettle.lastResult }),
                source: "lifecycle" as const,
              },
            }),
      },
    },
    work: {
      ...(item.workRef === undefined ? {} : { ref: copyWorkRef(item.workRef) }),
      status: workStatus,
      delivery,
      completion,
      todos,
    },
    facets,
    attention: dedupedAttention,
  };
}

function identityFromEndpoint(endpoint: SessionEndpoint): MonitorWindowIdentityV1 {
  for (const [label, value] of [
    ["workspaceId", endpoint.workspaceId],
    ["ownerId", endpoint.ownerId],
    ["ownerNonce", endpoint.ownerNonce],
    ["endpointId", endpoint.id],
  ] as const) {
    if (typeof value !== "string" || value.length === 0) throw new Error(`Monitor endpoint ${label} must not be empty.`);
  }
  return {
    workspaceId: endpoint.workspaceId,
    ownerId: endpoint.ownerId,
    ownerNonce: endpoint.ownerNonce,
    endpointId: endpoint.id,
  };
}

function ownerMatches(owner: WorkspaceOwnerSnapshot, identity: MonitorWindowIdentityV1): boolean {
  return owner.workspaceId === identity.workspaceId
    && owner.ownerId === identity.ownerId
    && owner.ownerNonce === identity.ownerNonce;
}

function targetMatchesWindow(target: MonitorWindowFacetTargetV1, identity: MonitorWindowIdentityV1): boolean {
  return sameIdentity(target.identity, identity) && target.workRef === undefined;
}

function targetMatches(
  target: MonitorWindowFacetTargetV1,
  identity: MonitorWindowIdentityV1,
  workRef: MonitorWorkRefV1 | undefined,
): boolean {
  return sameIdentity(target.identity, identity) && sameWorkRef(target.workRef, workRef);
}

function sameIdentity(left: MonitorWindowIdentityV1, right: MonitorWindowIdentityV1): boolean {
  return left.workspaceId === right.workspaceId
    && left.ownerId === right.ownerId
    && left.ownerNonce === right.ownerNonce
    && left.endpointId === right.endpointId;
}

function sameWorkRef(left: MonitorWorkRefV1 | undefined, right: MonitorWorkRefV1 | undefined): boolean {
  return left === undefined
    ? right === undefined
    : right !== undefined && left.kind === right.kind && left.id === right.id;
}

function threadMatches(
  entry: WindowThreadEntry,
  identity: MonitorWindowIdentityV1,
  workRef: MonitorWorkRefV1 | undefined,
): boolean {
  return entry.workspaceId === identity.workspaceId
    && entry.peerOwnerId === identity.ownerId
    && entry.peerOwnerNonce === identity.ownerNonce
    && (workRef?.kind !== "message" || entry.messageId === workRef.id);
}

function selectDelivery(candidates: readonly MonitorWindowThreadEvidenceV1[]): MonitorWindowThreadEvidenceV1 | undefined {
  return [...candidates].sort((left, right) => {
    const rank = DELIVERY_RANK[right.entry.status] - DELIVERY_RANK[left.entry.status];
    if (rank !== 0) return rank;
    const time = right.entry.updatedAt - left.entry.updatedAt;
    return time !== 0 ? time : right.entry.contentRevision.localeCompare(left.entry.contentRevision);
  })[0];
}

function reduceDelivery(entry: WindowThreadEntry | undefined): MonitorWindowDeliveryV1 {
  if (!entry) {
    return {
      publicationStage: "unknown",
      consumptionStage: "unknown",
      source: "unknown",
      consumed: false,
    };
  }
  const publicationStage: MonitorWindowDeliveryV1["publicationStage"] = entry.status === "pending"
    ? "pending"
    : entry.status === "rejected"
      ? "rejected"
      : entry.status === "timeout"
        ? "timeout"
        : "accepted";
  const consumptionStage: MonitorWindowDeliveryV1["consumptionStage"] = entry.status === "queued"
    || entry.status === "injected"
    || entry.status === "replied"
    ? entry.status
    : "unknown";
  return {
    publicationStage,
    consumptionStage,
    source: "thread",
    consumed: consumptionStage === "injected" || consumptionStage === "replied",
    messageId: entry.messageId,
    updatedAt: entry.updatedAt,
  };
}

function selectCompletion(
  candidates: readonly MonitorWindowCompletionEvidenceV1[],
): MonitorWindowCompletionEvidenceV1 | undefined {
  return [...candidates].sort((left, right) => {
    const rank = COMPLETION_RANK[right.source] - COMPLETION_RANK[left.source];
    if (rank !== 0) return rank;
    const time = right.completedAt - left.completedAt;
    return time !== 0 ? time : right.revision.localeCompare(left.revision);
  })[0];
}

function reduceCompletion(evidence: MonitorWindowCompletionEvidenceV1 | undefined): MonitorWindowCompletionV1 {
  if (!evidence) return { outcome: "unknown", source: "unknown" };
  return {
    outcome: evidence.outcome,
    source: evidence.source,
    revision: evidence.revision,
    completedAt: evidence.completedAt,
    ...(evidence.summary === undefined ? {} : { summary: evidence.summary }),
  };
}

function endpointLifecycle(status: SessionEndpoint["status"]): MonitorWindowCardV1["window"]["lifecycle"]["status"] {
  if (status === "running" || status === "sleeping" || status === "settled") return status;
  return "unknown";
}

function makeAttention(
  target: MonitorWindowFacetTargetV1,
  dedupeKey: string,
  severity: MonitorWindowAttentionV1["severity"],
  message: string,
  source: MonitorWindowAttentionV1["source"],
  code = dedupeKey,
): MonitorWindowAttentionV1 {
  return {
    code,
    severity,
    message,
    target: copyTarget(target),
    source,
    dedupeKey,
  };
}

function dedupeAttention(items: readonly MonitorWindowAttentionV1[]): MonitorWindowAttentionV1[] {
  const byKey = new Map<string, MonitorWindowAttentionV1>();
  for (const item of items) {
    const key = `${targetKey(item.target)}\u0000${item.dedupeKey}`;
    const previous = byKey.get(key);
    if (!previous
      || SEVERITY_RANK[item.severity] > SEVERITY_RANK[previous.severity]
      || (item.severity === previous.severity && canonicalJson(item).localeCompare(canonicalJson(previous)) < 0)) {
      byKey.set(key, item);
    }
  }
  return [...byKey.values()].sort((left, right) => {
    const target = targetKey(left.target).localeCompare(targetKey(right.target));
    return target === 0 ? left.dedupeKey.localeCompare(right.dedupeKey) : target;
  });
}

function semanticCard(card: MonitorWindowCardV1): unknown {
  const lifecycle = {
    ...card.window.lifecycle,
    ...(card.window.lifecycle.lastSettle === undefined
      ? {}
      : { lastSettle: { ...card.window.lifecycle.lastSettle, at: undefined } }),
    ownerPublishedAt: undefined,
  };
  return {
    ...card,
    window: { ...card.window, lifecycle },
    work: {
      ...card.work,
      delivery: { ...card.work.delivery, updatedAt: undefined },
      completion: { ...card.work.completion, completedAt: undefined },
      todos: card.work.todos.map((todo) => ({ ...todo, updatedAt: undefined })),
    },
  };
}

function copyFacet(facet: MonitorWindowFacetV1): MonitorWindowFacetV1 {
  return {
    kind: facet.kind,
    target: copyTarget(facet.target),
    revision: facet.revision,
    data: cloneJson(facet.data),
    ...(facet.attention === undefined
      ? {}
      : { attention: facet.attention.map((item) => ({ ...item })) }),
  };
}

function cloneJson(value: MonitorWindowJsonValueV1): MonitorWindowJsonValueV1 {
  if (Array.isArray(value)) return value.map((item) => cloneJson(item));
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, cloneJson(item)]));
  }
  return value;
}

function copyTarget(target: MonitorWindowFacetTargetV1): MonitorWindowFacetTargetV1 {
  return {
    identity: { ...target.identity },
    ...(target.workRef === undefined ? {} : { workRef: copyWorkRef(target.workRef) }),
  };
}

function copyWorkRef(workRef: MonitorWorkRefV1): MonitorWorkRefV1 {
  if (!workRef.kind || !workRef.id) throw new Error("Monitor WorkRef kind and id must not be empty.");
  return { kind: workRef.kind, id: workRef.id };
}

function identityKey(identity: MonitorWindowIdentityV1): string {
  return [identity.workspaceId, identity.ownerId, identity.ownerNonce, identity.endpointId].join("\u0000");
}

function targetKey(target: MonitorWindowFacetTargetV1): string {
  return [identityKey(target.identity), target.workRef?.kind ?? "", target.workRef?.id ?? ""].join("\u0000");
}

/** Canonical semantic hash shared by the state reducer and query cursors. */
export function hashMonitorWindowSemanticV1(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value), "utf8").digest("hex");
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalValue(value));
}

function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
      .map(([key, item]) => [key, canonicalValue(item)]));
  }
  return value;
}

function assertSafeTimestamp(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${label} must be a safe non-negative integer.`);
}
