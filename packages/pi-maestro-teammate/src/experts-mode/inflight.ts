import { getMode, resolveStatePath } from "./mode.ts";
import { mutateJsonStateFile, readJsonStateFile } from "./state-io.ts";
import type { InFlightExpert } from "./types.ts";

function parseList(raw: Record<string, unknown>): InFlightExpert[] {
  if (!Array.isArray(raw.inFlight)) return [];
  const out: InFlightExpert[] = [];
  for (const item of raw.inFlight) {
    if (!item || typeof item !== "object") continue;
    const o = item as Record<string, unknown>;
    const id = typeof o.id === "string" ? o.id : "";
    if (!id) continue;
    out.push({
      id,
      agent: typeof o.agent === "string" ? o.agent : undefined,
      taskType: typeof o.taskType === "string" ? o.taskType : undefined,
      name: typeof o.name === "string" ? o.name : undefined,
      stage: typeof o.stage === "string" ? o.stage : undefined,
      at: typeof o.at === "string" ? o.at : new Date().toISOString(),
      correlationId: typeof o.correlationId === "string" ? o.correlationId : undefined,
    });
  }
  return out;
}

/** Read current in-flight experts (P6 observability). */
export function getInFlight(cwd = process.cwd(), statePath?: string): InFlightExpert[] {
  return parseList(readJsonStateFile(resolveStatePath(cwd, statePath)));
}

/** Append or replace in-flight entries by id. */
export function trackInFlight(
  entries: Array<Partial<InFlightExpert> & { id?: string; name?: string; agent?: string }>,
  opts: { cwd?: string; statePath?: string; stage?: string } = {},
): InFlightExpert[] {
  const cwd = opts.cwd ?? process.cwd();
  const file = resolveStatePath(cwd, opts.statePath);
  const now = new Date().toISOString();
  const next = mutateJsonStateFile(file, (prev) => {
    const list = parseList(prev);
    for (const entry of entries) {
      const id = String(entry.id || entry.correlationId || entry.name || entry.agent || "").trim();
      if (!id) continue;
      const nextEntry: InFlightExpert = {
        id,
        agent: entry.agent ? String(entry.agent) : undefined,
        taskType: entry.taskType ? String(entry.taskType) : undefined,
        name: entry.name ? String(entry.name) : undefined,
        stage: entry.stage ? String(entry.stage) : opts.stage,
        at: now,
        correlationId: entry.correlationId ? String(entry.correlationId) : undefined,
      };
      const idx = list.findIndex((e) => e.id === id);
      if (idx >= 0) list[idx] = { ...list[idx], ...nextEntry, at: now };
      else list.push(nextEntry);
    }
    return {
      ...prev,
      mode: prev.mode === "experts" || prev.mode === "normal" ? prev.mode : getMode(cwd, opts.statePath),
      inFlight: list,
      updatedAt: now,
    };
  });
  return parseList(next);
}

/**
 * Remove settled experts from in-flight (MV-04).
 * 1) Exact match: id / correlationId / name (all matching entries).
 * 2) Agent fallback: only for keys not satisfied by exact match, remove at most
 *    ONE entry per agent key (avoids wiping parallel same-agent tasks).
 */
export function settleInFlight(
  keys: string | string[],
  opts: { cwd?: string; statePath?: string } = {},
): InFlightExpert[] {
  const cwd = opts.cwd ?? process.cwd();
  const want = new Set(
    (Array.isArray(keys) ? keys : [keys]).map((k) => String(k || "").trim()).filter(Boolean),
  );
  if (want.size === 0) return getInFlight(cwd, opts.statePath);
  const file = resolveStatePath(cwd, opts.statePath);
  const next = mutateJsonStateFile(file, (prev) => {
    const list = parseList(prev);
    const removeIdx = new Set<number>();
    const unmatched = new Set(want);

    for (let i = 0; i < list.length; i++) {
      const e = list[i]!;
      if (want.has(e.id)) {
        removeIdx.add(i);
        unmatched.delete(e.id);
        continue;
      }
      if (e.correlationId && want.has(e.correlationId)) {
        removeIdx.add(i);
        unmatched.delete(e.correlationId);
        continue;
      }
      if (e.name && want.has(e.name)) {
        removeIdx.add(i);
        unmatched.delete(e.name);
        continue;
      }
    }

    for (let i = 0; i < list.length; i++) {
      if (removeIdx.has(i)) continue;
      const e = list[i]!;
      if (e.agent && unmatched.has(e.agent)) {
        removeIdx.add(i);
        unmatched.delete(e.agent);
      }
    }

    return {
      ...prev,
      inFlight: list.filter((_, i) => !removeIdx.has(i)),
      updatedAt: new Date().toISOString(),
    };
  });
  return parseList(next);
}

export function clearInFlight(
  cwd = process.cwd(),
  opts: { statePath?: string } = {},
): InFlightExpert[] {
  mutateJsonStateFile(resolveStatePath(cwd, opts.statePath), (prev) => ({
    ...prev,
    inFlight: [],
    updatedAt: new Date().toISOString(),
  }));
  return [];
}
