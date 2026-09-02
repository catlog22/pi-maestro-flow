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

/** Request-only completion transition; it is never persisted in Todo state. */
export const TODO_ADVANCE_TRANSITIONS = ["keep_context", "new_context"] as const;
export type TodoAdvanceTransition = (typeof TODO_ADVANCE_TRANSITIONS)[number];

export const TODO_UPDATE_FIELDS = [
  "subject",
  "description",
  "status",
  "blockedBy",
  "context",
  "skills",
  "summary",
  "resourceUris",
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

function isTodoResourceUri(uri: string): boolean {
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
