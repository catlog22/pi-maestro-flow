import {
  RUNTIME_V2_REVISION,
  RUNTIME_V2_VERSION,
  type ActorAddressV2,
  type RuntimeCommandV2,
  type RuntimeEventV2,
  type RuntimeLeaseV2,
  type RuntimeProjectionV2,
} from "./contracts.ts";

const MAX_ID_BYTES = 1024;
const MAX_ERROR_BYTES = 64 * 1024;

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`Invalid ${label}`);
  return value as Record<string, unknown>;
}

function text(value: unknown, label: string, maxBytes = MAX_ID_BYTES): string {
  if (typeof value !== "string" || value.length === 0 || value.includes("\0") || Buffer.byteLength(value, "utf8") > maxBytes) {
    throw new Error(`Invalid ${label}`);
  }
  return value;
}

function integer(value: unknown, label: string, minimum = 0): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum) throw new Error(`Invalid ${label}`);
  return value as number;
}

function canonicalHeader(value: Record<string, unknown>, label: string): void {
  if (value.version !== RUNTIME_V2_VERSION || value.revision !== RUNTIME_V2_REVISION) {
    throw new Error(`Unsupported ${label} version or revision`);
  }
}

export function parseActorAddressV2(value: unknown): ActorAddressV2 {
  const input = record(value, "runtime actor address");
  canonicalHeader(input, "runtime actor address");
  if (input.actorKind !== "root" && input.actorKind !== "teammate" && input.actorKind !== "remote" && input.actorKind !== "process"
    && input.actorKind !== "schedule" && input.actorKind !== "dispatch") {
    throw new Error("Invalid runtime actor kind");
  }
  return {
    version: RUNTIME_V2_VERSION,
    revision: RUNTIME_V2_REVISION,
    workspaceId: text(input.workspaceId, "runtime workspaceId"),
    actorKind: input.actorKind,
    actorId: text(input.actorId, "runtime actorId"),
    generation: integer(input.generation, "runtime actor generation", 1),
  };
}

export function parseRuntimeCommandV2(value: unknown): RuntimeCommandV2 {
  const input = record(value, "runtime command");
  canonicalHeader(input, "runtime command");
  if (input.kind !== "run.start" && input.kind !== "run.input" && input.kind !== "run.cancel" && input.kind !== "process.reclaim") {
    throw new Error("Invalid runtime command kind");
  }
  return {
    version: RUNTIME_V2_VERSION,
    revision: RUNTIME_V2_REVISION,
    commandId: text(input.commandId, "runtime commandId"),
    streamId: text(input.streamId, "runtime streamId"),
    target: parseActorAddressV2(input.target),
    kind: input.kind,
    issuedAt: integer(input.issuedAt, "runtime command issuedAt"),
    ...(input.payload === undefined ? {} : { payload: input.payload }),
  };
}

export function parseRuntimeEventV2(value: unknown): RuntimeEventV2 {
  const input = record(value, "runtime event");
  canonicalHeader(input, "runtime event");
  const base = {
    version: RUNTIME_V2_VERSION,
    revision: RUNTIME_V2_REVISION,
    streamId: text(input.streamId, "runtime event streamId"),
    sequence: integer(input.sequence, "runtime event sequence", 1),
    actor: parseActorAddressV2(input.actor),
    producerEpoch: integer(input.producerEpoch, "runtime event producerEpoch", 1),
    occurredAt: integer(input.occurredAt, "runtime event occurredAt"),
  } as const;
  switch (input.kind) {
    case "tool.started":
      return { ...base, kind: input.kind, toolCallId: text(input.toolCallId, "toolCallId"), toolName: text(input.toolName, "toolName") };
    case "tool.finished":
      if (input.outcome !== "succeeded" && input.outcome !== "failed") throw new Error("Invalid tool outcome");
      return { ...base, kind: input.kind, toolCallId: text(input.toolCallId, "toolCallId"), toolName: text(input.toolName, "toolName"), outcome: input.outcome };
    case "result.published":
      if (typeof input.hasStructuredOutput !== "boolean") throw new Error("Invalid result structured-output marker");
      return { ...base, kind: input.kind, publicationId: text(input.publicationId, "publicationId"), hasStructuredOutput: input.hasStructuredOutput };
    case "run.settled":
      if (input.outcome !== "completed" && input.outcome !== "failed" && input.outcome !== "cancelled" && input.outcome !== "lost") {
        throw new Error("Invalid run outcome");
      }
      return {
        ...base,
        kind: input.kind,
        outcome: input.outcome,
        ...(input.error === undefined ? {} : { error: text(input.error, "runtime settlement error", MAX_ERROR_BYTES) }),
      };
    case "process.reclaimed":
      if (input.exitCode !== null && !Number.isSafeInteger(input.exitCode)) throw new Error("Invalid process exitCode");
      if (input.signal !== null && typeof input.signal !== "string") throw new Error("Invalid process signal");
      return {
        ...base,
        kind: input.kind,
        processId: text(input.processId, "runtime processId"),
        exitCode: input.exitCode as number | null,
        signal: input.signal === null ? null : text(input.signal, "runtime process signal", 128),
      };
    case "domain.event":
      return {
        ...base,
        kind: input.kind,
        eventType: text(input.eventType, "runtime domain eventType"),
        eventId: text(input.eventId, "runtime domain eventId"),
        payload: input.payload,
      };
    default:
      throw new Error("Invalid runtime event kind");
  }
}

/**
 * Compatibility is intentionally confined to persisted V2 reads. Admission
 * and the public teammate tool schemas continue to use their existing strict
 * parsers and never call this function.
 */
export function normalizePersistedRuntimeEventV2(value: unknown): RuntimeEventV2 {
  const input = record(value, "persisted runtime event");
  const normalized: Record<string, unknown> = {
    ...input,
    version: input.version === "2" ? 2 : input.version,
    revision: input.revision ?? RUNTIME_V2_REVISION,
    kind: input.kind === "tool_start" ? "tool.started"
      : input.kind === "tool_end" ? "tool.finished"
        : input.kind === "result_published" ? "result.published"
          : input.kind === "run_settled" ? "run.settled"
            : input.kind === "process_reclaimed" ? "process.reclaimed"
              : input.kind,
  };
  if (input.actor && typeof input.actor === "object" && !Array.isArray(input.actor)) {
    const actor = input.actor as Record<string, unknown>;
    normalized.actor = {
      ...actor,
      version: actor.version === "2" ? 2 : actor.version,
      revision: actor.revision ?? RUNTIME_V2_REVISION,
    };
    normalized.producerEpoch ??= actor.generation;
  }
  return parseRuntimeEventV2(normalized);
}

export function parseRuntimeLeaseV2(value: unknown): RuntimeLeaseV2 {
  const input = record(value, "runtime lease");
  canonicalHeader(input, "runtime lease");
  const acquiredAt = integer(input.acquiredAt, "runtime lease acquiredAt");
  const expiresAt = integer(input.expiresAt, "runtime lease expiresAt");
  if (expiresAt <= acquiredAt) throw new Error("Runtime lease must expire after acquisition");
  return {
    version: RUNTIME_V2_VERSION,
    revision: RUNTIME_V2_REVISION,
    leaseId: text(input.leaseId, "runtime leaseId"),
    streamId: text(input.streamId, "runtime lease streamId"),
    holder: parseActorAddressV2(input.holder),
    epoch: integer(input.epoch, "runtime lease epoch", 1),
    acquiredAt,
    expiresAt,
  };
}

export function parseRuntimeProjectionV2(value: unknown): RuntimeProjectionV2 {
  const input = record(value, "runtime projection");
  canonicalHeader(input, "runtime projection");
  if (input.lifecycle !== "pending" && input.lifecycle !== "running" && input.lifecycle !== "settled" && input.lifecycle !== "reclaimed") {
    throw new Error("Invalid runtime projection lifecycle");
  }
  if (!Array.isArray(input.activeToolCallIds)) throw new Error("Invalid active tool-call projection");
  const activeToolCallIds = input.activeToolCallIds.map((entry) => text(entry, "active toolCallId"));
  if (typeof input.resultPublished !== "boolean") throw new Error("Invalid result-published projection");
  if (input.outcome !== undefined && input.outcome !== "completed" && input.outcome !== "failed" && input.outcome !== "cancelled" && input.outcome !== "lost") {
    throw new Error("Invalid runtime projection outcome");
  }
  return {
    version: RUNTIME_V2_VERSION,
    revision: RUNTIME_V2_REVISION,
    streamId: text(input.streamId, "runtime projection streamId"),
    lastSequence: integer(input.lastSequence, "runtime projection sequence"),
    lifecycle: input.lifecycle,
    activeToolCallIds,
    resultPublished: input.resultPublished,
    ...(input.outcome === undefined ? {} : { outcome: input.outcome }),
    updatedAt: integer(input.updatedAt, "runtime projection updatedAt"),
  };
}
