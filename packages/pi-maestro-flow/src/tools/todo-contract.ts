/** The resource URI schemes Todo may retain as durable references. */
export const TODO_RESOURCE_URI_SCHEMES = [
  "agent",
  "session",
  "pr",
  "issue",
  "skill",
  "rule",
] as const;

export type TodoResourceUriScheme = (typeof TODO_RESOURCE_URI_SCHEMES)[number];

export const TODO_MAX_RESOURCE_URIS = 16;
export const TODO_MAX_RESOURCE_URI_BYTES = 2048;

export const TODO_HANDOFF_FILE_VALUES = ["required", "conditional", "skip", "unknown"] as const;
export type TodoHandoffFileValue = (typeof TODO_HANDOFF_FILE_VALUES)[number];

export const TODO_MAX_HANDOFF_NEXT_STEPS = 3;
export const TODO_MAX_HANDOFF_FILES = 16;
export const TODO_MAX_HANDOFF_BYTES = 8 * 1024;
export const TODO_MAX_HANDOFF_TEXT_BYTES = 2 * 1024;
export const TODO_MAX_HANDOFF_PATH_BYTES = 2 * 1024;

export interface TodoHandoffFileInput {
  path: string;
  value: TodoHandoffFileValue;
  reason: string;
  when?: string;
}

export interface TodoHandoffInput {
  nextSteps?: readonly string[];
  files?: readonly TodoHandoffFileInput[];
}

export interface TodoHandoffFile extends TodoHandoffFileInput {
  /** Todo revision at which this path was explicitly annotated. */
  annotationRevision: number;
}

export interface TodoHandoff {
  nextSteps: string[];
  files: TodoHandoffFile[];
  /** Todo revision at which nextSteps was explicitly replaced. */
  nextStepsRevision?: number;
}

/** Request-only context transition; update supports only new_context, while advance supports both values. */
export const TODO_ADVANCE_TRANSITIONS = ["keep_context", "new_context"] as const;
export type TodoAdvanceTransition = (typeof TODO_ADVANCE_TRANSITIONS)[number];

/** Request-only progressive reads; offsets and limits count Unicode code points. */
export const TODO_GET_FIELDS = [
  "all", "subject", "description", "context", "summary", "resourceUris", "handoff", "skills",
] as const;
export type TodoGetField = (typeof TODO_GET_FIELDS)[number];
export const TODO_GET_DEFAULT_LIMIT = 4 * 1024;
export const TODO_GET_MAX_LIMIT = 16 * 1024;
/** List pages count tasks, in creation order, after applying the filter. */
export const TODO_LIST_DEFAULT_LIMIT = 20;
export const TODO_LIST_MAX_LIMIT = 50;

export const TODO_UPDATE_FIELDS = [
  "subject",
  "description",
  "status",
  "blockedBy",
  "context",
  "skills",
  "summary",
  "resourceUris",
  "handoff",
  "assignee",
  "goalId",
] as const;

export type TodoUpdateField = (typeof TODO_UPDATE_FIELDS)[number];

const TODO_RESOURCE_URI_PATTERN = /^([a-z][a-z0-9+.-]*):\/\/(.*)$/i;

function safeResourceSegment(value: string): boolean {
  return value.length > 0
    && value !== "."
    && value !== ".."
    && !/[\\/\u0000-\u001f\u007f]/.test(value)
    && !/%(?:2f|5c)/i.test(value);
}

export function isTodoResourceUri(uri: string): boolean {
  const match = uri.match(TODO_RESOURCE_URI_PATTERN);
  if (!match) return false;
  const scheme = match[1]?.toLowerCase();
  const rest = match[2] ?? "";
  if (!scheme || !(TODO_RESOURCE_URI_SCHEMES as readonly string[]).includes(scheme)) return false;
  const segments = rest.split("/");
  switch (scheme) {
    case "agent":
      return safeResourceSegment(segments[0] ?? "");
    case "session":
      return segments.length === 3
        && safeResourceSegment(segments[0] ?? "")
        && segments[1] === "entry"
        && safeResourceSegment(segments[2] ?? "");
    case "pr":
      return (/^\d+$/.test(segments[0] ?? "") && segments.length === 1)
        || (segments.length >= 3
          && segments.length <= 4
          && safeResourceSegment(segments[0] ?? "")
          && safeResourceSegment(segments[1] ?? "")
          && /^\d+$/.test(segments[2] ?? "")
          && (segments.length === 3 || segments[3] === "diff" || segments[3] === "files"));
    case "issue":
      return (/^\d+$/.test(segments[0] ?? "") && segments.length === 1)
        || (segments.length === 3
          && safeResourceSegment(segments[0] ?? "")
          && safeResourceSegment(segments[1] ?? "")
          && /^\d+$/.test(segments[2] ?? ""));
    case "skill":
    case "rule":
      return segments.length > 0 && segments.every(safeResourceSegment);
    default:
      return false;
  }
}

/**
 * Normalize caller-provided resource references before they enter Todo state.
 * URI schemes are intentionally limited to resource protocols that the host
 * can address; content is not fetched here. Trimming and stable de-duplication
 * keep equivalent tool calls from growing state, while validation remains
 * strict for create/update/advance requests.
 */
export function normalizeTodoResourceUris(value: readonly string[] | undefined): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error("resourceUris must be an array of resource URI strings");

  const normalized: string[] = [];
  const seen = new Set<string>();
  for (const [index, raw] of value.entries()) {
    if (typeof raw !== "string") {
      throw new Error(`resourceUris[${index}] must be a string`);
    }
    const uri = raw.trim();
    if (!uri) throw new Error(`resourceUris[${index}] must be a non-empty URI`);
    if (Buffer.byteLength(uri, "utf8") > TODO_MAX_RESOURCE_URI_BYTES) {
      throw new Error(`resourceUris[${index}] exceeds ${TODO_MAX_RESOURCE_URI_BYTES} UTF-8 bytes`);
    }
    if (!isTodoResourceUri(uri)) {
      throw new Error(
        `resourceUris[${index}] must be a structurally valid ${TODO_RESOURCE_URI_SCHEMES.join(", ")} resource URI`,
      );
    }
    if (seen.has(uri)) continue;
    seen.add(uri);
    if (normalized.length >= TODO_MAX_RESOURCE_URIS) {
      throw new Error(`resourceUris cannot contain more than ${TODO_MAX_RESOURCE_URIS} unique URIs`);
    }
    normalized.push(uri);
  }
  return normalized;
}

/**
 * Read persisted resource references defensively. Legacy and malformed state
 * must not prevent a session from loading; invalid entries are discarded and
 * valid entries retain their persisted order.
 */
export function readTodoResourceUris(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const normalized: string[] = [];
  const seen = new Set<string>();
  for (const raw of value) {
    if (typeof raw !== "string") continue;
    const uri = raw.trim();
    if (!uri || seen.has(uri)) continue;
    if (Buffer.byteLength(uri, "utf8") > TODO_MAX_RESOURCE_URI_BYTES || !isTodoResourceUri(uri)) continue;
    seen.add(uri);
    if (normalized.length >= TODO_MAX_RESOURCE_URIS) break;
    normalized.push(uri);
  }
  return normalized;
}

export function appendTodoResourceUris(
  existing: readonly string[] | undefined,
  additions: readonly string[],
): string[] {
  return normalizeTodoResourceUris([...(existing ?? []), ...additions]);
}

function boundedHandoffText(value: unknown, label: string): string {
  if (typeof value !== "string") throw new Error(`${label} must be a string`);
  const normalized = value.trim();
  if (!normalized) throw new Error(`${label} must be non-empty`);
  if (Buffer.byteLength(normalized, "utf8") > TODO_MAX_HANDOFF_TEXT_BYTES) {
    throw new Error(`${label} exceeds ${TODO_MAX_HANDOFF_TEXT_BYTES} UTF-8 bytes`);
  }
  return normalized;
}

/** Lexically normalize a handoff pointer without touching the file system. */
export function normalizeTodoHandoffPath(value: unknown, label = "handoff.files[].path"): string {
  if (typeof value !== "string") throw new Error(`${label} must be a string`);
  const trimmed = value.trim();
  if (!trimmed) throw new Error(`${label} must be non-empty`);
  if (Buffer.byteLength(trimmed, "utf8") > TODO_MAX_HANDOFF_PATH_BYTES) {
    throw new Error(`${label} exceeds ${TODO_MAX_HANDOFF_PATH_BYTES} UTF-8 bytes`);
  }
  if (/[\u0000-\u001f\u007f]/.test(trimmed)) throw new Error(`${label} contains control characters`);
  if (TODO_RESOURCE_URI_PATTERN.test(trimmed)) {
    if (!isTodoResourceUri(trimmed)) {
      throw new Error(`${label} must use a supported Todo resource URI or a local file path`);
    }
    return trimmed;
  }
  if (/^[a-z][a-z0-9+.-]*:/i.test(trimmed) && !/^[a-z]:[\\/]/i.test(trimmed)) {
    throw new Error(`${label} must use a supported Todo resource URI or a local file path`);
  }

  const slashed = trimmed.replace(/\\/g, "/");
  const absolute = slashed.startsWith("/");
  const parts: string[] = [];
  for (const part of slashed.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") {
      if (parts.length > 0 && parts.at(-1) !== ".." && !/^[A-Za-z]:$/.test(parts.at(-1)!)) parts.pop();
      else if (!absolute) parts.push(part);
      continue;
    }
    parts.push(part);
  }
  let normalized = `${absolute ? "/" : ""}${parts.join("/")}`;
  if (/^[a-z]:\//.test(normalized)) normalized = normalized[0]!.toUpperCase() + normalized.slice(1);
  if (!normalized || normalized === "/") throw new Error(`${label} must identify a file or resource`);
  return normalized;
}

export function todoHandoffPathKey(path: string): string {
  const normalized = normalizeTodoHandoffPath(path);
  return /^[A-Za-z]:\//.test(normalized)
    ? normalized[0]!.toLowerCase() + normalized.slice(1)
    : normalized;
}

export function cloneTodoHandoff(handoff: TodoHandoff | undefined): TodoHandoff | undefined {
  if (!handoff) return undefined;
  return {
    nextSteps: [...handoff.nextSteps],
    files: handoff.files.map((file) => ({ ...file })),
    ...(handoff.nextStepsRevision !== undefined ? { nextStepsRevision: handoff.nextStepsRevision } : {}),
  };
}

/**
 * Merge a partial handoff update. Omitted children preserve prior state;
 * explicit empty arrays clear only that child collection.
 */
export function normalizeTodoHandoff(
  value: TodoHandoffInput,
  existing: TodoHandoff | undefined,
  annotationRevision: number,
): TodoHandoff | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("handoff must be an object");
  }
  const previous = cloneTodoHandoff(existing) ?? { nextSteps: [], files: [] };
  let nextSteps = previous.nextSteps;
  let nextStepsRevision = previous.nextStepsRevision;
  if (value.nextSteps !== undefined) {
    if (!Array.isArray(value.nextSteps)) throw new Error("handoff.nextSteps must be an array of strings");
    if (value.nextSteps.length > TODO_MAX_HANDOFF_NEXT_STEPS) {
      throw new Error(`handoff.nextSteps cannot contain more than ${TODO_MAX_HANDOFF_NEXT_STEPS} entries`);
    }
    nextSteps = value.nextSteps.map((step, index) => boundedHandoffText(step, `handoff.nextSteps[${index}]`));
    nextStepsRevision = annotationRevision;
  }

  let files = previous.files;
  if (value.files !== undefined) {
    if (!Array.isArray(value.files)) throw new Error("handoff.files must be an array");
    if (value.files.length > TODO_MAX_HANDOFF_FILES) {
      throw new Error(`handoff.files cannot contain more than ${TODO_MAX_HANDOFF_FILES} entries`);
    }
    if (value.files.length === 0) files = [];
    else {
      const merged = new Map(files.map((file) => [todoHandoffPathKey(file.path), { ...file }]));
      for (const [index, raw] of value.files.entries()) {
        if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
          throw new Error(`handoff.files[${index}] must be an object`);
        }
        const path = normalizeTodoHandoffPath(raw.path, `handoff.files[${index}].path`);
        if (!(TODO_HANDOFF_FILE_VALUES as readonly unknown[]).includes(raw.value)) {
          throw new Error(`handoff.files[${index}].value must be ${TODO_HANDOFF_FILE_VALUES.join(", ")}`);
        }
        const reason = boundedHandoffText(raw.reason, `handoff.files[${index}].reason`);
        const when = raw.when === undefined
          ? undefined
          : boundedHandoffText(raw.when, `handoff.files[${index}].when`);
        if (raw.value === "conditional" && when === undefined) {
          throw new Error(`handoff.files[${index}].when is required when value is conditional`);
        }
        merged.set(todoHandoffPathKey(path), {
          path,
          value: raw.value,
          reason,
          ...(when ? { when } : {}),
          annotationRevision,
        });
      }
      files = [...merged.values()];
      if (files.length > TODO_MAX_HANDOFF_FILES) {
        throw new Error(`handoff.files cannot contain more than ${TODO_MAX_HANDOFF_FILES} merged entries`);
      }
    }
  }

  if (nextSteps.length === 0 && files.length === 0) return undefined;
  const normalized: TodoHandoff = {
    nextSteps,
    files,
    ...(nextStepsRevision !== undefined ? { nextStepsRevision } : {}),
  };
  if (Buffer.byteLength(JSON.stringify(normalized), "utf8") > TODO_MAX_HANDOFF_BYTES) {
    throw new Error(`handoff exceeds ${TODO_MAX_HANDOFF_BYTES} UTF-8 bytes`);
  }
  return normalized;
}

/** Defensive persisted-state reader; malformed legacy annotations are discarded. */
export function readTodoHandoff(value: unknown): TodoHandoff | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const nextSteps: string[] = [];
  if (Array.isArray(record.nextSteps)) {
    for (const [index, step] of record.nextSteps.entries()) {
      if (nextSteps.length >= TODO_MAX_HANDOFF_NEXT_STEPS) break;
      try {
        nextSteps.push(boundedHandoffText(step, `handoff.nextSteps[${index}]`));
      } catch {
        // Malformed persisted entries are skipped independently.
      }
    }
  }
  const files: TodoHandoffFile[] = [];
  const seen = new Set<string>();
  if (Array.isArray(record.files)) {
    for (const raw of record.files) {
      if (files.length >= TODO_MAX_HANDOFF_FILES || !raw || typeof raw !== "object" || Array.isArray(raw)) continue;
      const file = raw as Record<string, unknown>;
      try {
        const path = normalizeTodoHandoffPath(file.path);
        if (!(TODO_HANDOFF_FILE_VALUES as readonly unknown[]).includes(file.value)) continue;
        const reason = boundedHandoffText(file.reason, "handoff.files[].reason");
        const when = file.when === undefined
          ? undefined
          : boundedHandoffText(file.when, "handoff.files[].when");
        if (file.value === "conditional" && !when) continue;
        const key = todoHandoffPathKey(path);
        if (seen.has(key)) continue;
        seen.add(key);
        files.push({
          path,
          value: file.value as TodoHandoffFileValue,
          reason,
          ...(when ? { when } : {}),
          annotationRevision: typeof file.annotationRevision === "number"
            && Number.isSafeInteger(file.annotationRevision)
            && file.annotationRevision >= 0
            ? file.annotationRevision
            : 0,
        });
      } catch {
        // One malformed persisted annotation must not prevent Todo recovery.
      }
    }
  }
  if (nextSteps.length === 0 && files.length === 0) return undefined;
  const handoff: TodoHandoff = {
    nextSteps,
    files,
    ...(typeof record.nextStepsRevision === "number"
      && Number.isSafeInteger(record.nextStepsRevision)
      && record.nextStepsRevision >= 0
      ? { nextStepsRevision: record.nextStepsRevision }
      : {}),
  };
  return Buffer.byteLength(JSON.stringify(handoff), "utf8") <= TODO_MAX_HANDOFF_BYTES ? handoff : undefined;
}
