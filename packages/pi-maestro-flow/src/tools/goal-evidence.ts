import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { parseSessionHistoryUri } from "pi-maestro-teammate/v1/session-history";
import { resolveResource } from "./resource.ts";
import { createSessionHistoryInventoryProvider } from "./session-history.ts";
import type { GoalContext } from "./goal.ts";

export interface GoalEvidenceRef {
  requirement: string;
  uri?: string;
  path?: string;
  offset?: number;
  limit?: number;
  charOffset?: number;
}

export function evidenceRefsValidationError(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length > 16) return "evidenceRefs must be an array of at most 16 references.";
  const seen = new Set<string>();
  for (const raw of value) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return "Each evidence reference must be an object.";
    const ref = raw as Record<string, unknown>;
    if (Object.keys(ref).some((key) => !["requirement", "uri", "path", "offset", "limit", "charOffset"].includes(key))) return "Unknown evidence reference field.";
    if (typeof ref.requirement !== "string" || !ref.requirement.trim() || ref.requirement.length > 256) return "Evidence requirement must contain 1..256 characters.";
    if ((ref.uri === undefined) === (ref.path === undefined)) return "Evidence requires exactly one uri or local path.";
    const target = ref.uri ?? ref.path;
    if (typeof target !== "string" || !target.trim() || target.length > 2048 || /[\u0000-\u001f\u007f]/.test(target)) return "Evidence target must contain 1..2048 characters without control characters.";
    if (ref.path !== undefined && /^[a-z][a-z0-9+.-]*:\/\//i.test(target)) return "Use uri for protocol evidence, not path.";
    if (ref.uri !== undefined) {
      const session = parseSessionHistoryUri(target);
      const safeId = (id: string) => id.length <= 512 && id !== "." && id !== ".." && !/[\\/%?#\s]/.test(id);
      const validSession = session?.entryId && safeId(session.sessionId) && safeId(session.entryId)
        && target === `session://${session.sessionId}/entry/${session.entryId}`;
      const validAgent = /^agent:\/\/[a-zA-Z0-9-]+(?:\/[a-zA-Z0-9_.-]+){0,10}$/.test(target)
        && !target.split("/").some((part) => part === "." || part === "..");
      if (!validSession && !validAgent) return "Evidence URI must be an exact session://id/entry/id or agent://exact-id[/subpath].";
    }
    for (const [key, max] of [["offset", 1_000_000], ["limit", 2_000]] as const) {
      if (ref[key] !== undefined && (typeof ref[key] !== "number" || !Number.isSafeInteger(ref[key]) || (ref[key] as number) < 1 || (ref[key] as number) > max)) return `Evidence ${key} must be a positive integer <= ${max}.`;
    }
    if (ref.charOffset !== undefined && (ref.path !== undefined || typeof ref.charOffset !== "number" || !Number.isSafeInteger(ref.charOffset) || ref.charOffset < 0 || ref.charOffset > 10_000_000)) return "Evidence charOffset must be an integer 0..10000000 on URI evidence only.";
    const identity = JSON.stringify([ref.requirement.trim(), target.trim(), ref.offset ?? 1, ref.limit ?? 200, ref.charOffset ?? 0]);
    if (seen.has(identity)) return "Duplicate evidence reference.";
    seen.add(identity);
  }
  return undefined;
}

export function normalizeEvidenceRefs(value: unknown): GoalEvidenceRef[] | undefined {
  const error = evidenceRefsValidationError(value);
  if (error) throw new Error(error);
  return value === undefined ? undefined : (value as GoalEvidenceRef[]).map((ref) => ({ ...ref, requirement: ref.requirement.trim(), ...(ref.path === undefined ? {} : { path: ref.path.trim() }) }));
}

export async function resolveGoalEvidenceUri(uri: string, ctx: GoalContext, page: Pick<GoalEvidenceRef, "offset" | "limit" | "charOffset"> = {}, signal?: AbortSignal, redactEvidence?: (text: string) => string) {
  const error = evidenceRefsValidationError([{ requirement: "resource check", uri, ...page }]);
  if (error) throw new Error(error);
  const requestedSessionId = parseSessionHistoryUri(uri)?.sessionId;
  return resolveResource(uri, ctx.cwd, signal, {
    exactEvidence: true,
    redactEvidence,
    ...page,
    sessionHistory: createSessionHistoryInventoryProvider(ctx as ExtensionContext, "all", requestedSessionId),
  });
}
