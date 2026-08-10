/**
 * Best-effort permission audit logging, isolated from the reply path.
 *
 * One JSONL stream belongs to one parent Pi session. Writes are queued on a
 * promise tail, serialized in-process, and fully contained so filesystem
 * failure can never change a permission decision or delay its IPC reply.
 */

import { constants as fsConstants } from "node:fs";
import type { Stats } from "node:fs";
import * as fs from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import * as path from "node:path";
import {
  PRIVATE_DIRECTORY_MODE,
  PRIVATE_FILE_MODE,
  getTeammateSessionRoot,
  shouldEnforcePosixMode,
} from "../execution-infra.ts";
import { previewToolCallArgs } from "./tool-preview.ts";

export const PERMISSION_AUDIT_MAX_BYTES = 10 * 1024 * 1024;
export const PERMISSION_AUDIT_FILE_COUNT = 3;
export const PERMISSION_AUDIT_REASON_MAX_BYTES = 1024;
export const PERMISSION_AUDIT_RELATIVE_PATH = path.join("audit", "permissions.jsonl");

export type PermissionAuditEventType = "permission_request" | "permission_decision";
export type PermissionAuditSource =
  | "child"
  | "automatic"
  | "broker"
  | "ui"
  | "headless"
  | "queue_cancel"
  | "queue_timeout"
  | "queue_error"
  | "error";

export interface PermissionAuditInput {
  parentSessionFile?: string | null;
  event: PermissionAuditEventType;
  requestId: string;
  correlationId?: string;
  agent?: string;
  toolName?: string;
  input?: unknown;
  action: string;
  source: PermissionAuditSource;
  reason?: unknown;
  timestamp?: number;
}

export interface PermissionAuditRecord {
  version: 1;
  timestamp: string;
  event: PermissionAuditEventType;
  requestId: string;
  correlationId?: string;
  agent?: string;
  toolName: string;
  preview?: string;
  action: string;
  source: PermissionAuditSource;
  reason?: string;
}

export interface PermissionAuditIdentity {
  correlationId?: string;
  agent?: string;
}

export interface PermissionRequestAuditAdmission {
  parentSessionFile: string | null;
  decisionRecorded: boolean;
}

const permissionRequestAuditAdmissions = new WeakMap<
  Record<string, unknown>,
  PermissionRequestAuditAdmission
>();

/** Preserve queue admission context without mutating the child-owned event. */
export function markPermissionRequestAuditAdmission(
  event: Record<string, unknown>,
  parentSessionFile: string | null | undefined,
): void {
  permissionRequestAuditAdmissions.set(event, {
    parentSessionFile: parentSessionFile ?? null,
    decisionRecorded: false,
  });
}

export function permissionRequestAuditAdmission(
  event: Record<string, unknown>,
): PermissionRequestAuditAdmission | undefined {
  return permissionRequestAuditAdmissions.get(event);
}

export function permissionAuditFilePath(parentSessionFile: string | null | undefined): string | undefined {
  const sessionRoot = getTeammateSessionRoot(parentSessionFile ?? null);
  return sessionRoot ? path.join(sessionRoot, PERMISSION_AUDIT_RELATIVE_PATH) : undefined;
}

function flattenIdentifier(value: string, maxBytes: number): string {
  const flattened = value.replace(/[\u0000-\u001F\u007F-\u009F]+/g, " ").replace(/\s+/g, " ").trim();
  if (Buffer.byteLength(flattened, "utf8") <= maxBytes) return flattened;
  let result = "";
  let bytes = 0;
  for (const character of flattened) {
    const next = Buffer.byteLength(character, "utf8");
    if (bytes + next > maxBytes - 3) break;
    result += character;
    bytes += next;
  }
  return `${result}...`;
}

const REASON_SECRET_ASSIGNMENT = /(\b(?:api[-_]?key|access[-_]?token|refresh[-_]?token|password|passphrase|secret|token)\s*[:=]\s*)(?:["'][^"']*["']|[^\s,;]+)/gi;

function redactedReason(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  const preview = previewToolCallArgs(typeof value === "string" ? value : String(value));
  const scrubbed = preview?.replace(REASON_SECRET_ASSIGNMENT, "$1[redacted]");
  return scrubbed ? flattenIdentifier(scrubbed, PERMISSION_AUDIT_REASON_MAX_BYTES) : undefined;
}

export function buildPermissionAuditRecord(input: PermissionAuditInput): PermissionAuditRecord {
  const preview = previewToolCallArgs(input.input, input.toolName);
  const reason = redactedReason(input.reason);
  const correlationId = input.correlationId?.trim();
  const agent = input.agent?.trim();
  return {
    version: 1,
    timestamp: new Date(input.timestamp ?? Date.now()).toISOString(),
    event: input.event,
    requestId: flattenIdentifier(input.requestId || "unknown", 256),
    // A correlation id locates the child precisely. The display label is only
    // retained as a fallback when no correlation identity is available.
    ...(correlationId
      ? { correlationId: flattenIdentifier(correlationId, 256) }
      : agent ? { agent: flattenIdentifier(agent, 256) } : {}),
    toolName: flattenIdentifier(input.toolName?.trim() || "unknown", 256),
    ...(preview ? { preview } : {}),
    action: flattenIdentifier(input.action, 64),
    source: input.source,
    ...(reason ? { reason } : {}),
  };
}

function errorCode(error: unknown): string | undefined {
  return error instanceof Error && "code" in error
    ? String((error as NodeJS.ErrnoException).code)
    : undefined;
}

async function lstatIfExists(filePath: string): Promise<Stats | undefined> {
  try {
    return await fs.lstat(filePath);
  } catch (error) {
    if (errorCode(error) === "ENOENT") return undefined;
    throw error;
  }
}

function assertCanonicalContainment(canonicalRoot: string, canonicalTarget: string): void {
  const relative = path.relative(canonicalRoot, canonicalTarget);
  if (
    relative === ""
    || (!relative.startsWith(`..${path.sep}`)
      && relative !== ".."
      && !path.isAbsolute(relative))
  ) {
    return;
  }
  throw new Error(`Permission audit path escapes its session root: ${canonicalTarget}`);
}

async function assertExistingDirectory(directoryPath: string): Promise<void> {
  const stat = await fs.lstat(directoryPath);
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new Error(`Permission audit path is not a real directory: ${directoryPath}`);
  }
}

async function ensurePrivateRealDirectory(directoryPath: string, recursive: boolean): Promise<void> {
  await fs.mkdir(directoryPath, { recursive, mode: PRIVATE_DIRECTORY_MODE });
  await assertExistingDirectory(directoryPath);
  if (shouldEnforcePosixMode()) await fs.chmod(directoryPath, PRIVATE_DIRECTORY_MODE);
}

async function assertRegularRotationTarget(
  canonicalRoot: string,
  filePath: string,
): Promise<Stats | undefined> {
  const stat = await lstatIfExists(filePath);
  if (!stat) return undefined;
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw new Error(`Permission audit path is not a regular file: ${filePath}`);
  }
  assertCanonicalContainment(canonicalRoot, await fs.realpath(filePath));
  return stat;
}

function rotatedPath(filePath: string, generation: number): string {
  return `${filePath}.${generation}`;
}

interface ValidatedAuditPath {
  canonicalRoot: string;
  current: Stats | undefined;
}

async function validatePermissionAuditPath(filePath: string): Promise<ValidatedAuditPath> {
  const auditDirectory = path.dirname(filePath);
  const sessionRoot = path.dirname(auditDirectory);
  if (
    path.basename(auditDirectory) !== "audit"
    || path.basename(filePath) !== "permissions.jsonl"
  ) {
    throw new Error(`Permission audit path is outside the fixed audit layout: ${filePath}`);
  }

  // The session root is the trust boundary. Reject it when it already names a
  // link/junction, then create and validate the single child directory without
  // a recursive traversal that could silently accept an existing link.
  await ensurePrivateRealDirectory(sessionRoot, true);
  const canonicalRoot = await fs.realpath(sessionRoot);
  const existingAuditDirectory = await lstatIfExists(auditDirectory);
  if (!existingAuditDirectory) {
    try {
      await ensurePrivateRealDirectory(auditDirectory, false);
    } catch (error) {
      if (errorCode(error) !== "EEXIST") throw error;
      await assertExistingDirectory(auditDirectory);
    }
  } else {
    await assertExistingDirectory(auditDirectory);
    if (shouldEnforcePosixMode()) await fs.chmod(auditDirectory, PRIVATE_DIRECTORY_MODE);
  }
  assertCanonicalContainment(canonicalRoot, await fs.realpath(auditDirectory));

  let current: Stats | undefined;
  for (let generation = 0; generation < PERMISSION_AUDIT_FILE_COUNT; generation += 1) {
    const stat = await assertRegularRotationTarget(
      canonicalRoot,
      generation === 0 ? filePath : rotatedPath(filePath, generation),
    );
    if (generation === 0) current = stat;
  }
  return { canonicalRoot, current };
}

async function rotatePermissionAudit(filePath: string, canonicalRoot: string): Promise<void> {
  // Revalidate every existing component immediately before rotation. The first
  // validation also prevents rename from moving an unchecked link into history.
  for (let generation = 0; generation < PERMISSION_AUDIT_FILE_COUNT; generation += 1) {
    await assertRegularRotationTarget(
      canonicalRoot,
      generation === 0 ? filePath : rotatedPath(filePath, generation),
    );
  }
  await fs.rm(rotatedPath(filePath, PERMISSION_AUDIT_FILE_COUNT - 1), { force: true });
  for (let generation = PERMISSION_AUDIT_FILE_COUNT - 2; generation >= 1; generation -= 1) {
    const source = rotatedPath(filePath, generation);
    if (await assertRegularRotationTarget(canonicalRoot, source)) {
      await fs.rename(source, rotatedPath(filePath, generation + 1));
    }
  }
  if (await assertRegularRotationTarget(canonicalRoot, filePath)) {
    await fs.rename(filePath, rotatedPath(filePath, 1));
  }
}

type PermissionAuditFileOpen = (
  filePath: string,
  flags: number,
  mode: number,
) => Promise<FileHandle>;

let permissionAuditFileOpen: PermissionAuditFileOpen = (filePath, flags, mode) =>
  fs.open(filePath, flags, mode);

async function openPrivateRegularFile(filePath: string): Promise<FileHandle> {
  const noFollow = fsConstants.O_NOFOLLOW ?? 0;
  const existingFlags = fsConstants.O_WRONLY | fsConstants.O_APPEND | noFollow;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    let handle: FileHandle;
    try {
      handle = await permissionAuditFileOpen(filePath, existingFlags, PRIVATE_FILE_MODE);
    } catch (error) {
      const code = errorCode(error);
      if (code === "ELOOP" || code === "EISDIR") {
        throw new Error(`Permission audit path is not a regular file: ${filePath}`);
      }
      if (code !== "ENOENT") throw error;
      try {
        handle = await permissionAuditFileOpen(
          filePath,
          existingFlags | fsConstants.O_CREAT | fsConstants.O_EXCL,
          PRIVATE_FILE_MODE,
        );
      } catch (createError) {
        if (errorCode(createError) === "EEXIST" && attempt === 0) continue;
        throw createError;
      }
    }

    try {
      const stat = await handle.stat();
      if (!stat.isFile()) {
        throw new Error(`Permission audit path is not a regular file: ${filePath}`);
      }
      return handle;
    } catch (error) {
      try {
        await handle.close();
      } catch {
        // Preserve the validation failure that prevented ownership transfer.
      }
      throw error;
    }
  }
  throw new Error(`Permission audit path changed while opening: ${filePath}`);
}

async function assertOpenedAuditFile(
  handle: Awaited<ReturnType<typeof fs.open>>,
  filePath: string,
  canonicalRoot: string,
): Promise<Stats> {
  const openedStat = await handle.stat();
  const pathStat = await fs.lstat(filePath);
  if (
    !openedStat.isFile()
    || pathStat.isSymbolicLink()
    || !pathStat.isFile()
    || openedStat.dev !== pathStat.dev
    || openedStat.ino !== pathStat.ino
  ) {
    throw new Error(`Permission audit path changed while opening: ${filePath}`);
  }
  assertCanonicalContainment(canonicalRoot, await fs.realpath(filePath));
  return openedStat;
}

export async function appendPermissionAuditRecord(
  filePath: string,
  record: PermissionAuditRecord,
  maxBytes = PERMISSION_AUDIT_MAX_BYTES,
): Promise<void> {
  const line = `${JSON.stringify(record)}\n`;
  const lineBytes = Buffer.byteLength(line, "utf8");
  let validated = await validatePermissionAuditPath(filePath);
  const currentBytes = validated.current?.size ?? 0;
  if (currentBytes > 0 && currentBytes + lineBytes > maxBytes) {
    await rotatePermissionAudit(filePath, validated.canonicalRoot);
    validated = await validatePermissionAuditPath(filePath);
  }

  const handle = await openPrivateRegularFile(filePath);
  try {
    await assertOpenedAuditFile(handle, filePath, validated.canonicalRoot);
    if (shouldEnforcePosixMode()) await handle.chmod(PRIVATE_FILE_MODE);
    await handle.write(line, undefined, "utf8");
  } finally {
    await handle.close();
  }
}

let writeTail: Promise<void> = Promise.resolve();
type PermissionAuditWriter = typeof appendPermissionAuditRecord;
let permissionAuditWriter: PermissionAuditWriter = appendPermissionAuditRecord;
let lastWarningAt = 0;
let suppressedWarnings = 0;
const WARNING_INTERVAL_MS = 30_000;
const WARNING_MAX_BYTES = 512;

function warnBounded(error: unknown): void {
  const now = Date.now();
  if (now - lastWarningAt < WARNING_INTERVAL_MS) {
    suppressedWarnings += 1;
    return;
  }
  const detail = error instanceof Error ? error.message : String(error);
  const suffix = suppressedWarnings > 0 ? ` (${suppressedWarnings} similar warnings suppressed)` : "";
  suppressedWarnings = 0;
  lastWarningAt = now;
  console.warn(`[pi-maestro-teammate] permission audit write failed: ${flattenIdentifier(detail, WARNING_MAX_BYTES)}${suffix}`);
}

/** Schedule an audit record without exposing filesystem work to the reply path. */
export function schedulePermissionAudit(input: PermissionAuditInput): void {
  try {
    const filePath = permissionAuditFilePath(input.parentSessionFile);
    if (!filePath) return;
    const record = buildPermissionAuditRecord(input);
    const writer = permissionAuditWriter;
    writeTail = writeTail
      .then(() => writer(filePath, record))
      .catch((error) => { warnBounded(error); });
  } catch (error) {
    // Even record construction is non-authoritative and must fail closed over
    // the audit channel only, never over the permission reply channel.
    warnBounded(error);
  }
}

/** Test-only writer injection for deterministic slow/failing I/O coverage. */
export function setPermissionAuditWriterForTests(writer: PermissionAuditWriter): () => void {
  const previous = permissionAuditWriter;
  permissionAuditWriter = writer;
  return () => {
    if (permissionAuditWriter === writer) permissionAuditWriter = previous;
  };
}

/** Test-only open injection for deterministic post-open validation failures. */
export function setPermissionAuditFileOpenForTests(openFile: PermissionAuditFileOpen): () => void {
  const previous = permissionAuditFileOpen;
  permissionAuditFileOpen = openFile;
  return () => {
    if (permissionAuditFileOpen === openFile) permissionAuditFileOpen = previous;
  };
}

/** Test/cleanup barrier for work already appended to the promise tail. */
export async function flushPermissionAuditWrites(): Promise<void> {
  await writeTail;
}

function permissionPayload(event: Record<string, unknown>): Record<string, unknown> {
  return event.payload && typeof event.payload === "object" && !Array.isArray(event.payload)
    ? event.payload as Record<string, unknown>
    : {};
}

export function schedulePermissionRequestAudit(
  parentSessionFile: string | null | undefined,
  event: Record<string, unknown>,
  identity: PermissionAuditIdentity = {},
): void {
  if (event.interaction !== "permission") return;
  const payload = permissionPayload(event);
  schedulePermissionAudit({
    parentSessionFile,
    event: "permission_request",
    requestId: typeof event.requestId === "string" ? event.requestId : "unknown",
    correlationId: identity.correlationId,
    agent: identity.agent,
    toolName: typeof payload.toolName === "string" ? payload.toolName : undefined,
    input: payload.input,
    action: "request",
    source: "child",
    reason: payload.reason,
  });
}

export function schedulePermissionDecisionAudit(
  parentSessionFile: string | null | undefined,
  event: Record<string, unknown>,
  identity: PermissionAuditIdentity,
  action: string,
  source: Exclude<PermissionAuditSource, "child">,
  reason?: unknown,
): void {
  if (event.interaction !== "permission") return;
  const admission = permissionRequestAuditAdmissions.get(event);
  if (admission?.decisionRecorded) return;
  if (admission) admission.decisionRecorded = true;
  const payload = permissionPayload(event);
  schedulePermissionAudit({
    parentSessionFile,
    event: "permission_decision",
    requestId: typeof event.requestId === "string" ? event.requestId : "unknown",
    correlationId: identity.correlationId,
    agent: identity.agent,
    toolName: typeof payload.toolName === "string" ? payload.toolName : undefined,
    input: payload.input,
    action,
    source,
    reason,
  });
}
