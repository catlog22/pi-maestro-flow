import fs from "node:fs";
import path from "node:path";
import { getMode, resolveStatePath } from "./mode.ts";
import type { InFlightExpert } from "./types.ts";

function readRaw(cwd: string, statePath?: string): Record<string, unknown> {
  const file = resolveStatePath(cwd, statePath);
  try {
    if (!fs.existsSync(file)) return {};
    return JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function writeRaw(cwd: string, next: Record<string, unknown>, statePath?: string): void {
  const file = resolveStatePath(cwd, statePath);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(next, null, 2)}\n`, "utf8");
}

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
  return parseList(readRaw(cwd, statePath));
}

/** Append or replace in-flight entries by id. */
export function trackInFlight(
  entries: Array<Partial<InFlightExpert> & { id?: string; name?: string; agent?: string }>,
  opts: { cwd?: string; statePath?: string; stage?: string } = {},
): InFlightExpert[] {
  const cwd = opts.cwd ?? process.cwd();
  const prev = readRaw(cwd, opts.statePath);
  const list = parseList(prev);
  const now = new Date().toISOString();
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
  const next = {
    ...prev,
    mode: prev.mode === "experts" || prev.mode === "normal" ? prev.mode : getMode(cwd, opts.statePath),
    inFlight: list,
    updatedAt: now,
  };
  writeRaw(cwd, next, opts.statePath);
  return list;
}

/**
 * Remove settled experts from in-flight.
 * Match by id, correlationId, name, or agent (first match).
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
  const prev = readRaw(cwd, opts.statePath);
  const list = parseList(prev).filter((e) => {
    if (want.has(e.id)) return false;
    if (e.correlationId && want.has(e.correlationId)) return false;
    if (e.name && want.has(e.name)) return false;
    if (e.agent && want.has(e.agent)) return false;
    return true;
  });
  writeRaw(cwd, {
    ...prev,
    inFlight: list,
    updatedAt: new Date().toISOString(),
  }, opts.statePath);
  return list;
}

export function clearInFlight(
  cwd = process.cwd(),
  opts: { statePath?: string } = {},
): InFlightExpert[] {
  const prev = readRaw(cwd, opts.statePath);
  writeRaw(cwd, {
    ...prev,
    inFlight: [],
    updatedAt: new Date().toISOString(),
  }, opts.statePath);
  return [];
}
