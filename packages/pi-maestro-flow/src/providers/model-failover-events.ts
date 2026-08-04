/**
 * Persistent model-failover settlement event stream.
 *
 * Every main-agent failover settlement (success / failed / cancelled /
 * fallback-scheduled) is appended to `~/.pi/agent/model-failover-events.jsonl`
 * so the recovery history survives process restarts. Writes are synchronous,
 * crash-durable (writeFileDurableSync under the settings resource lock), and
 * strictly best-effort: a persistence failure must never break the failover
 * arbitration path.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ReplayFence, RetryErrorKind } from "pi-maestro-teammate/v1/retry";
import { lockSettingsResourceSync } from "../settings/resource-lock.ts";
import { writeFileDurableSync } from "../settings/durable-write.ts";

export const MODEL_FAILOVER_EVENTS_FILE = "model-failover-events.jsonl";
/** Upper bound on persisted events; oldest entries are trimmed on append. */
export const MAX_MODEL_FAILOVER_EVENTS = 500;

export type ModelFailoverSettlementOutcome =
  | "success"
  | "failed"
  | "cancelled"
  | "fallback-scheduled"
  | "replay-blocked";

/** Structural slice of the failover settlement, independent of model-failover.ts. */
export interface ModelFailoverSettlementInput {
  protocolVersion: number;
  recoveryId: string;
  outcome: ModelFailoverSettlementOutcome;
  model: string;
  failure?: string;
  fallbackModel?: string;
  replayFence: ReplayFence;
}

export interface ModelFailoverSettlementRecord extends ModelFailoverSettlementInput {
  failureKind?: RetryErrorKind;
  at: number;
}

export interface AppendSettlementOptions {
  homeDir?: string;
  failureKind?: RetryErrorKind;
}

export function getModelFailoverEventsPath(homeDir = os.homedir()): string {
  return path.join(homeDir, ".pi", "agent", MODEL_FAILOVER_EVENTS_FILE);
}

/**
 * Append one settlement record (best-effort, bounded). Runs synchronously so
 * the caller's arbitration snapshot and the persisted stream never diverge.
 */
export function appendModelFailoverSettlement(
  settlement: ModelFailoverSettlementInput,
  options: AppendSettlementOptions = {},
): void {
  const filePath = getModelFailoverEventsPath(options.homeDir);
  const release = lockSettingsResourceSync(filePath);
  try {
    const record: ModelFailoverSettlementRecord = {
      ...settlement,
      ...(options.failureKind === undefined ? {} : { failureKind: options.failureKind }),
      at: Date.now(),
    };
    const line = JSON.stringify(record);
    let lines: string[] = [];
    if (fs.existsSync(filePath)) {
      try {
        lines = fs.readFileSync(filePath, "utf8").split("\n").filter((entry) => entry.length > 0);
      } catch {
        lines = [];
      }
    }
    lines.push(line);
    if (lines.length > MAX_MODEL_FAILOVER_EVENTS) {
      lines = lines.slice(lines.length - MAX_MODEL_FAILOVER_EVENTS);
    }
    writeFileDurableSync(filePath, `${lines.join("\n")}\n`);
  } catch {
    // Best-effort persistence: a settlement log failure must never break the
    // failover arbitration path.
  } finally {
    release();
  }
}

/** Read the most recent `limit` settlement records; corrupt lines are skipped. */
export function listModelFailoverEvents(
  homeDir = os.homedir(),
  limit = 20,
): readonly ModelFailoverSettlementRecord[] {
  const filePath = getModelFailoverEventsPath(homeDir);
  if (!fs.existsSync(filePath)) return [];
  let lines: string[];
  try {
    lines = fs.readFileSync(filePath, "utf8").split("\n").filter((entry) => entry.length > 0);
  } catch {
    return [];
  }
  const records: ModelFailoverSettlementRecord[] = [];
  for (const line of lines) {
    try {
      records.push(JSON.parse(line) as ModelFailoverSettlementRecord);
    } catch {
      // Skip corrupt lines (e.g. a torn write) — the stream stays readable.
    }
  }
  return records.slice(-limit);
}
