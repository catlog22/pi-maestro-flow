import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

export type SessionOwner = "child" | "main" | "none";
export type HandoffState =
  | "active"
  | "parking"
  | "parked"
  | "handoff_pending"
  | "main_active"
  | "reloading"
  | "fenced"
  | "recovery";

export interface SessionLease {
  owner: SessionOwner;
  state: HandoffState;
  epoch: number;
  nonce: string;
}

export interface LeaseToken {
  owner: SessionOwner;
  epoch: number;
  nonce: string;
}

const LEASE_PREFIX = "[pi-teammate-lease:";

export function wrapLeasedMessage(message: string, token?: LeaseToken): string {
  if (!token) return message;
  const encoded = Buffer.from(JSON.stringify(token), "utf8").toString("base64url");
  return `${LEASE_PREFIX}${encoded}]${message}`;
}

export function unwrapLeasedMessage(message: string): { message: string; token?: LeaseToken; malformed?: boolean } {
  if (!message.startsWith(LEASE_PREFIX)) return { message };
  const end = message.indexOf("]", LEASE_PREFIX.length);
  if (end < 0) return { message, malformed: true };
  try {
    const token = JSON.parse(Buffer.from(message.slice(LEASE_PREFIX.length, end), "base64url").toString("utf8")) as LeaseToken;
    return { message: message.slice(end + 1), token };
  } catch {
    return { message, malformed: true };
  }
}

export function sameLeaseToken(expected: LeaseToken | undefined, actual: LeaseToken | undefined): boolean {
  return Boolean(expected && actual
    && expected.owner === actual.owner
    && expected.epoch === actual.epoch
    && expected.nonce === actual.nonce);
}

export function createChildLease(): SessionLease {
  return { owner: "child", state: "active", epoch: 1, nonce: randomUUID() };
}

export function leaseToken(lease: SessionLease): LeaseToken {
  return { owner: lease.owner, epoch: lease.epoch, nonce: lease.nonce };
}

export function ownsLease(lease: SessionLease, token: LeaseToken): boolean {
  return lease.owner === token.owner
    && lease.epoch === token.epoch
    && lease.nonce === token.nonce
    && lease.state !== "fenced"
    && lease.state !== "recovery";
}

export function canChildWrite(lease: SessionLease | undefined): boolean {
  return !lease || (lease.owner === "child" && lease.state === "active");
}

export function handoffBarrierReached(requiredPromptSeq: number, completedPromptSeq: number, idleStableTicks: number): boolean {
  return completedPromptSeq >= requiredPromptSeq && idleStableTicks >= 2;
}

export function isSessionPathContained(sessionDir: string | undefined, sessionFile: string | undefined): boolean {
  if (!sessionDir || !sessionFile) return false;
  try {
    const root = fs.realpathSync(sessionDir);
    const file = fs.realpathSync(sessionFile);
    const relative = path.relative(root, file);
    return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
  } catch {
    return false;
  }
}

export function buildFenceRecoveryMessages(lease: SessionLease, cancelNonce?: string): Record<string, unknown>[] {
  const messages: Record<string, unknown>[] = [];
  if (cancelNonce) messages.push({ type: "teammate_handoff_cancel", nonce: cancelNonce });
  messages.push({ type: "teammate_lease_update", token: leaseToken(lease) });
  return messages;
}

function advance(lease: SessionLease, owner: SessionOwner, state: HandoffState): SessionLease {
  return { owner, state, epoch: lease.epoch + 1, nonce: randomUUID() };
}

export function requestPark(lease: SessionLease): SessionLease {
  if (lease.owner !== "child" || lease.state !== "active") return lease;
  return { ...lease, state: "parking" };
}

export function confirmParked(lease: SessionLease): SessionLease {
  if (lease.owner !== "child" || lease.state !== "parking") return lease;
  return { ...lease, state: "parked" };
}

export function transferToMain(lease: SessionLease): SessionLease {
  if (lease.owner !== "child" || lease.state !== "parked") return lease;
  return advance(lease, "main", "main_active");
}

export function requestHandback(lease: SessionLease): SessionLease {
  if (lease.owner !== "main" || lease.state !== "main_active") return lease;
  return advance(lease, "none", "reloading");
}

export function confirmChildReloaded(lease: SessionLease): SessionLease {
  if (lease.owner !== "none" || lease.state !== "reloading") return lease;
  return advance(lease, "child", "active");
}

export function fenceLease(lease: SessionLease): SessionLease {
  return advance(lease, "none", "fenced");
}

export function recoverChild(lease: SessionLease): SessionLease {
  if (lease.state !== "fenced" && lease.state !== "recovery") return lease;
  return advance(lease, "child", "active");
}
