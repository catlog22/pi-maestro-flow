/**
 * Goal-linked monitoring context — lightweight interop with the pi-peer
 * goal board (`.pi/peer-goals.json`, G:\github_lib\pi-peer goal-store).
 *
 * The Monitor does not depend on pi-peer: when the file exists it injects
 * the goal's closure standards into drift analysis so "drifting" is judged
 * against the real completion criteria; when the file is missing or the goal
 * is unknown, supervision falls back to the plain objective + output tail.
 */

import { randomUUID } from "node:crypto";
import { appendFile, mkdir, readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

export const PEER_GOAL_BOARD_RELATIVE_PATH = ".pi/peer-goals.json";
export const PEER_GOAL_JOURNAL_RELATIVE_PATH = ".pi/peer-goals.journal.jsonl";

export interface GoalClosureContext {
  goalId: string;
  title?: string;
  status?: string;
  requiredVotes?: number;
  minIndependentVotes?: number;
  requiredEvidence?: string[];
  openProposals?: number;
  activeClaims?: number;
}

/** Best-effort load of one goal's closure context from the pi-peer board. */
export async function loadPeerGoalContext(root: string, goalId: string): Promise<GoalClosureContext | undefined> {
  if (!root || !goalId) return undefined;
  try {
    const parsed = JSON.parse(await readFile(resolve(root, PEER_GOAL_BOARD_RELATIVE_PATH), "utf8")) as {
      goals?: Record<string, unknown>;
    };
    const goal = parsed?.goals?.[goalId];
    if (!goal || typeof goal !== "object") return undefined;
    return extractGoalClosureContext(goalId, goal);
  } catch {
    return undefined; // board missing/corrupt → supervision proceeds without goal context
  }
}

export function extractGoalClosureContext(goalId: string, goal: unknown): GoalClosureContext | undefined {
  if (!goal || typeof goal !== "object") return undefined;
  const source = goal as Record<string, unknown>;
  const policy = plainObject(source.closurePolicy) ? source.closurePolicy : plainObject(source.metadata) ? (source.metadata as Record<string, unknown>).closurePolicy : undefined;
  const policySource = plainObject(policy) ? policy as Record<string, unknown> : {};
  // pi-peer board stores raw goals with an `events` array; derived fields
  // (state.activeClaims / resolved proposals) must be computed from events.
  const events = Array.isArray(source.events) ? source.events.filter(plainObject) : [];
  const resolvedIds = new Set(
    events
      .filter((event) => event.type === "resolve" && typeof event.resolves === "string")
      .map((event) => event.resolves as string),
  );
  const openProposals = events.filter((event) => event.type === "proposal" && !resolvedIds.has(String(event.id ?? ""))).length;
  const releasedIds = new Set(
    events
      .filter((event) => event.type === "release" && typeof event.resolves === "string")
      .map((event) => event.resolves as string),
  );
  const activeClaims = events.filter((event) => event.type === "claim" && !releasedIds.has(String(event.id ?? ""))).length;
  return {
    goalId,
    ...stripEmpty({
      title: text(source.title) ?? text(source.objective) ?? text(source.summary),
      status: text(source.status),
      requiredVotes: positiveInteger(policySource.requiredVotes),
      minIndependentVotes: positiveInteger(policySource.minIndependentVotes ?? policySource.minVotes),
      requiredEvidence: stringList(policySource.requiredEvidence),
      openProposals,
      activeClaims,
    }),
  };
}

/**
 * Compact closure-standard block injected into drift analysis prompts so the
 * analyst judges the agent against the goal's real completion gates.
 */
export function buildGoalContextBlock(context: GoalClosureContext): string {
  const parts: string[] = [`Goal: ${context.goalId}`];
  if (context.title) parts.push(`Title: ${context.title}`);
  if (context.status) parts.push(`Status: ${context.status}`);
  const gates: string[] = [];
  if (context.requiredVotes !== undefined) gates.push(`votes >= ${context.requiredVotes}`);
  if (context.minIndependentVotes !== undefined) gates.push(`independent votes >= ${context.minIndependentVotes}`);
  if (context.requiredEvidence && context.requiredEvidence.length > 0) gates.push(`evidence: ${context.requiredEvidence.join(", ")}`);
  if (context.openProposals !== undefined) gates.push(`open proposals: ${context.openProposals}`);
  if (context.activeClaims !== undefined) gates.push(`active claims: ${context.activeClaims}`);
  if (gates.length > 0) parts.push(`Closure gates: ${gates.join(" · ")}`);
  parts.push("Judge drift against these completion criteria, not just the literal prompt.");
  return parts.join("\n");
}

// ---------------------------------------------------------------------------
// Objection posting — monitor escalations become goal-board evidence
// ---------------------------------------------------------------------------

/**
 * Append a blocking objection event to the pi-peer goal journal
 * (`.pi/peer-goals.journal.jsonl`, `{ type: "event", goalId, event }` shape).
 * Best-effort: unknown goals, missing boards, or write failures are ignored
 * so supervision never fails because of the board.
 */
export async function appendPeerGoalObjection(
  root: string,
  goalId: string,
  input: { peerId: string; summary: string; severity?: string },
): Promise<boolean> {
  if (!root || !goalId) return false;
  try {
    const board = JSON.parse(await readFile(resolve(root, PEER_GOAL_BOARD_RELATIVE_PATH), "utf8")) as {
      goals?: Record<string, unknown>;
    };
    if (!board?.goals?.[goalId]) return false; // unknown goal → not our board
    const event = {
      id: `obj_${Date.now().toString(36)}_${randomUUID().slice(0, 8)}`,
      at: new Date().toISOString(),
      type: "objection",
      severity: input.severity ?? "blocking",
      peerId: input.peerId,
      summary: input.summary,
      metadata: { source: "monitor" },
    };
    const record = { type: "event", goalId, event };
    const journalPath = resolve(root, PEER_GOAL_JOURNAL_RELATIVE_PATH);
    await mkdir(dirname(journalPath), { recursive: true });
    await appendFile(journalPath, `${JSON.stringify(record)}\n`, "utf8");
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function plainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function positiveInteger(value: unknown): number | undefined {
  if (value == null || value === "") return undefined;
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : undefined;
}

function stringList(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const items = value.map(text).filter((item): item is string => Boolean(item));
  return items.length > 0 ? items : undefined;
}

function stripEmpty(object: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(object).filter(([, value]) => {
    if (value === undefined || value === "") return false;
    if (Array.isArray(value) && value.length === 0) return false;
    return true;
  }));
}
