/**
 * Durable monitor control-plane ledger.
 *
 * Port of pi-peer's `.pi/peer-control-ledger.jsonl` pattern
 * (G:\github_lib\pi-peer\src\peers\control-ledger.mjs) for the fleet
 * Monitor engine: append-only JSONL records, short directory-lock around
 * every append, tolerant load (trailing partial line), and a derived
 * read-model that lets a restarted session reconcile supervision state that
 * outlived the process that created it.
 *
 * Pure file module — no dependency on monitor.ts or index.ts.
 */

import { randomUUID } from "node:crypto";
import { appendFile, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

export const MONITOR_LEDGER_RELATIVE_PATH = ".pi/monitor-ledger.jsonl";

export const MONITOR_LEDGER_LOCK_STALE_MS = 30_000;
export const MONITOR_LEDGER_LOCK_RETRY_MS = 10;
export const MONITOR_LEDGER_LOCK_TIMEOUT_MS = 5_000;

export type MonitorLedgerRecordKind =
  | "binding"        // enter / exit (gone, removed, cleared, user-exit, shutdown, disconnected)
  | "intervention"   // a corrective message was delivered (status: sent)
  | "outcome"        // pending intervention resolved (recovered/repeated/escalated/failed)
  | "analysis"       // LLM drift verdict flips (on-track/drift)
  | "delivery"       // delivery failure / dead-letter
  | "review"         // turn-level advisor verdict (concern/blocker)
  | "checkpoint";    // engine start / stop / resume

export interface MonitorLedgerRecord {
  id: string;
  at: string;
  kind: MonitorLedgerRecordKind;
  action: string;
  status?: string;
  target?: string;
  traceId?: string;
  reason?: string;
  mode?: string;
  message?: string;
  outcome?: string;
  attempts?: number;
  metadata?: Record<string, unknown>;
}

const LEDGER_KINDS = new Set<MonitorLedgerRecordKind>([
  "binding",
  "intervention",
  "outcome",
  "analysis",
  "delivery",
  "review",
  "checkpoint",
]);

const MAX_LEDGER_MESSAGE_LENGTH = 800;

export function monitorLedgerPath(root: string): string {
  if (!root) throw new Error("monitor ledger requires root");
  return resolve(root, MONITOR_LEDGER_RELATIVE_PATH);
}

// ---------------------------------------------------------------------------
// Record normalization
// ---------------------------------------------------------------------------

export function normalizeMonitorLedgerRecord(input: unknown): MonitorLedgerRecord {
  if (!plainObject(input)) throw new Error("monitor ledger record must be an object");
  const kind = cleanText(input.kind).toLowerCase();
  if (!LEDGER_KINDS.has(kind as MonitorLedgerRecordKind)) {
    throw new Error(`monitor ledger record requires a valid kind, got ${JSON.stringify(input.kind)}`);
  }
  const message = cleanText(input.message);
  return {
    id: cleanText(input.id) || `mon_${Date.now().toString(36)}_${randomUUID().slice(0, 8)}`,
    at: cleanText(input.at) || new Date().toISOString(),
    kind: kind as MonitorLedgerRecordKind,
    action: cleanText(input.action).toLowerCase() || "record",
    ...stripEmpty({
      status: cleanText(input.status).toLowerCase(),
      target: cleanText(input.target),
      traceId: cleanText(input.traceId),
      reason: cleanText(input.reason).toLowerCase(),
      mode: cleanText(input.mode).toLowerCase(),
      message: message.length > MAX_LEDGER_MESSAGE_LENGTH ? `${message.slice(0, MAX_LEDGER_MESSAGE_LENGTH)}…` : message,
      outcome: cleanText(input.outcome).toLowerCase(),
      attempts: positiveNumber(input.attempts),
      metadata: plainObject(input.metadata) ? input.metadata : undefined,
    }),
  };
}

// ---------------------------------------------------------------------------
// Append (with short directory lock)
// ---------------------------------------------------------------------------

export async function appendMonitorLedgerRecord(
  root: string,
  record: MonitorLedgerRecord | Omit<MonitorLedgerRecord, "id" | "at">,
): Promise<MonitorLedgerRecord> {
  const path = monitorLedgerPath(root);
  await mkdir(dirname(path), { recursive: true });
  return withMonitorLedgerLock(root, async () => {
    const normalized = normalizeMonitorLedgerRecord(record);
    await appendFile(path, `${JSON.stringify(normalized)}\n`, "utf8");
    return normalized;
  });
}

// ---------------------------------------------------------------------------
// Load (tolerant of a trailing partial line)
// ---------------------------------------------------------------------------

export async function loadMonitorLedger(root: string): Promise<{ records: MonitorLedgerRecord[]; warnings: string[] }> {
  const path = monitorLedgerPath(root);
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { records: [], warnings: [] };
    throw error;
  }
  const warnings: string[] = [];
  const lines = text.split("\n");
  if (lines.at(-1) === "") lines.pop();
  const hasTerminatingNewline = text.endsWith("\n");
  const records: MonitorLedgerRecord[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (!line.trim()) continue;
    try {
      records.push(normalizeMonitorLedgerRecord(JSON.parse(line)));
    } catch (error) {
      const isTrailingPartial = index === lines.length - 1 && !hasTerminatingNewline;
      if (isTrailingPartial) {
        warnings.push(`trailing corrupt monitor ledger record at line ${index + 1}`);
        break;
      }
      throw new Error(`corrupt monitor ledger record at line ${index + 1}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return { records, warnings };
}

// ---------------------------------------------------------------------------
// Derived read-model
// ---------------------------------------------------------------------------

export interface MonitorBindingLedgerState {
  target: string;
  displayName?: string;
  mode?: string;
  customPrompt?: string;
  goalId?: string;
  /** Last binding status: active | disconnected | gone | removed | cleared | user-exit | shutdown */
  status: string;
  startedAt?: string;
  updatedAt: string;
  interventionCount: number;
  outcomeCount: number;
  escalated: boolean;
}

export interface MonitorLedgerState {
  records: number;
  bindings: MonitorBindingLedgerState[];
  activeBindings: MonitorBindingLedgerState[];
  disconnectedBindings: MonitorBindingLedgerState[];
  interventions: MonitorLedgerRecord[];
  outcomes: MonitorLedgerRecord[];
  deadLetters: MonitorLedgerRecord[];
  analyses: MonitorLedgerRecord[];
  reviews: MonitorLedgerRecord[];
}

export function deriveMonitorLedgerState(
  records: readonly (MonitorLedgerRecord | Omit<MonitorLedgerRecord, "id" | "at">)[],
  _options: { nowMs?: number } = {},
): MonitorLedgerState {
  const bindings = new Map<string, MonitorBindingLedgerState>();
  const interventions: MonitorLedgerRecord[] = [];
  const outcomes: MonitorLedgerRecord[] = [];
  const deadLetters: MonitorLedgerRecord[] = [];
  const analyses: MonitorLedgerRecord[] = [];
  const reviews: MonitorLedgerRecord[] = [];

  for (const raw of records) {
    const record = normalizeMonitorLedgerRecord(raw);
    const target = record.target;
    if (!target) {
      if (record.kind === "delivery" && record.action === "dead-letter") deadLetters.push(record);
      if (record.kind === "analysis") analyses.push(record);
      if (record.kind === "review") reviews.push(record);
      continue;
    }
    if (record.kind === "binding") {
      const current = bindings.get(target) ?? {
        target,
        status: "unknown",
        updatedAt: record.at,
        interventionCount: 0,
        outcomeCount: 0,
        escalated: false,
      };
      bindings.set(target, {
        target,
        displayName: stringOr(current.displayName, record.metadata?.displayName),
        mode: stringOr(current.mode, record.metadata?.mode),
        customPrompt: stringOr(current.customPrompt, record.metadata?.customPrompt),
        goalId: stringOr(current.goalId, record.metadata?.goalId),
        status: record.status ?? "unknown",
        startedAt: current.startedAt ?? (record.action === "enter" ? record.at : undefined),
        updatedAt: record.at,
        interventionCount: current.interventionCount,
        outcomeCount: current.outcomeCount,
        escalated: current.escalated,
      });
      continue;
    }
    if (record.kind === "intervention") {
      interventions.push(record);
      const current = bindings.get(target);
      if (current) {
        current.interventionCount += 1;
        current.updatedAt = record.at;
      }
      continue;
    }
    if (record.kind === "outcome") {
      outcomes.push(record);
      const current = bindings.get(target);
      if (current) {
        current.outcomeCount += 1;
        if (record.status === "escalated") current.escalated = true;
        current.updatedAt = record.at;
      }
      continue;
    }
    if (record.kind === "delivery" && record.action === "dead-letter") deadLetters.push(record);
    if (record.kind === "analysis") analyses.push(record);
    if (record.kind === "review") reviews.push(record);
  }

  const bindingList = [...bindings.values()];
  return {
    records: records.length,
    bindings: bindingList,
    activeBindings: bindingList.filter((binding) => binding.status === "active"),
    disconnectedBindings: bindingList.filter((binding) => binding.status === "disconnected"),
    interventions,
    outcomes,
    deadLetters,
    analyses,
    reviews,
  };
}

// ---------------------------------------------------------------------------
// Reconcile — mark ledger-active bindings without a live in-process owner
// ---------------------------------------------------------------------------

export async function reconcileMonitorLedger(
  root: string,
  input: { liveTargets?: readonly string[]; nowMs?: number } = {},
): Promise<{ records: MonitorLedgerRecord[]; state: MonitorLedgerState; warnings: string[] }> {
  const loaded = await loadMonitorLedger(root);
  const state = deriveMonitorLedgerState(loaded.records, { nowMs: input.nowMs });
  const live = new Set((input.liveTargets ?? []).map(cleanText).filter(Boolean));
  const records: MonitorLedgerRecord[] = [];
  for (const binding of state.activeBindings) {
    if (live.has(binding.target)) continue;
    records.push(await appendMonitorLedgerRecord(root, {
      kind: "binding",
      action: "exit",
      status: "disconnected",
      target: binding.target,
      metadata: {
        displayName: binding.displayName,
        reconciled: true,
        previousStatus: binding.status,
      },
    }));
  }
  const next = records.length > 0 ? await loadMonitorLedger(root) : loaded;
  return {
    records,
    state: deriveMonitorLedgerState(next.records, { nowMs: input.nowMs }),
    warnings: next.warnings,
  };
}

// ---------------------------------------------------------------------------
// Lock helpers (ported from pi-peer control-ledger)
// ---------------------------------------------------------------------------

async function withMonitorLedgerLock<T>(root: string, fn: () => Promise<T>): Promise<T> {
  const lockPath = `${monitorLedgerPath(root)}.lock`;
  const start = Date.now();
  for (;;) {
    try {
      await mkdir(lockPath);
      await writeFile(join(lockPath, "owner"), `${process.pid}\n${new Date().toISOString()}\n`, "utf8").catch(() => {});
      try {
        return await fn();
      } finally {
        await rm(lockPath, { recursive: true, force: true }).catch(() => {});
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      if (await removeStaleMonitorLedgerLock(lockPath)) continue;
      if (Date.now() - start >= MONITOR_LEDGER_LOCK_TIMEOUT_MS) {
        throw new Error(`timed out waiting for monitor ledger lock ${lockPath}`);
      }
      await sleep(MONITOR_LEDGER_LOCK_RETRY_MS);
    }
  }
}

async function removeStaleMonitorLedgerLock(lockPath: string): Promise<boolean> {
  try {
    const info = await stat(lockPath);
    if (Date.now() - info.mtimeMs < MONITOR_LEDGER_LOCK_STALE_MS) return false;
    await rm(lockPath, { recursive: true, force: true });
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return true;
    return false;
  }
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function cleanText(value: unknown): string {
  return typeof value === "string" ? value.trim() : value == null ? "" : String(value).trim();
}

function plainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function positiveNumber(value: unknown): number | undefined {
  if (value == null || value === "") return undefined;
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : undefined;
}

function stringOr(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return undefined;
}

function stripEmpty(object: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(object).filter(([, value]) => {
    if (value === undefined || value === "") return false;
    if (Array.isArray(value) && value.length === 0) return false;
    return true;
  }));
}
