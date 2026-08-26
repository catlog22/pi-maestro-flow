import { constants as fsConstants, type Stats } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { lstat, open, readdir, rename } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import {
  COMPLETION_DURABILITY_VERSION,
  computeCompletionDeliveryId,
  computeCompletionIntentRevision,
  type CompletionDispatchSeed,
  type CompletionIntent,
  type CompletionNotificationRequirement,
  type CompletionResource,
  type CompletionTarget,
} from "pi-maestro-teammate/v1";

export const COMPLETION_MANIFEST_VERSION = 1 as const;
export const COMPLETION_MANIFEST_DIR = ".completion-intents";
export const MAX_COMPLETION_MANIFEST_BYTES = 256 * 1024;
/** Maximum UTF-8 byte length of a completion resource/intent summary. */
export const COMPLETION_SUMMARY_MAX_BYTES = 4096;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
const HASH_ID = /^[a-f0-9]{64}$/;
const ORDERED_REPLACEMENT_PATTERN = /^(.*\.json)\.replace-(\d{20})-([A-Za-z0-9-]+)\.(new|bak)$/;
const LEGACY_REPLACEMENT_PATTERN = /^(.*\.json)\.replace-([A-Za-z0-9-]+)\.(new|bak)$/;

/** Truncate a string to its leading `maxBytes` of UTF-8 without splitting a
 * multi-byte character at the cut point. Callers that persist a summary must
 * run their input through this so the strict manifest validator (which caps by
 * `Buffer.byteLength`) never rejects and quarantines a manifest we just wrote. */
export function truncateCompletionSummary(value: string, maxBytes: number = COMPLETION_SUMMARY_MAX_BYTES): string {
  if (maxBytes <= 0) return "";
  if (value.length * 3 <= maxBytes) return value;
  if (Buffer.byteLength(value, "utf8") <= maxBytes) return value;
  const encoded = Buffer.from(value, "utf8");
  let end = Math.min(encoded.length, maxBytes);
  while (end > 0 && (encoded[end] & 0xc0) === 0x80) end -= 1;
  return encoded.subarray(0, end).toString("utf8");
}

export interface CompletionManifestPublishedEntry extends CompletionResource {
  state: "staged" | "committed";
  stagedAt: number;
  committedAt?: number;
}

export interface CompletionDispatchManifest {
  version: typeof COMPLETION_MANIFEST_VERSION;
  dispatchId: string;
  reservationId: string;
  deliveryGroupId: string;
  mode: CompletionDispatchSeed["mode"];
  target: CompletionTarget;
  replyTarget: CompletionDispatchSeed["replyTarget"];
  originCwd: string;
  expectedTasks: readonly string[];
  notificationRequired: boolean;
  notificationKind?: CompletionNotificationRequirement["kind"];
  notificationRequiredAt?: number;
  published: readonly CompletionManifestPublishedEntry[];
  state: "open" | "finalized" | "applied" | "abandoned";
  deliveryId?: string;
  intent?: CompletionIntent;
  createdAt: number;
  updatedAt: number;
  expiresAt: number;
  contentRevision: string;
}

function fileCode(error: unknown): string | undefined {
  return error instanceof Error && "code" in error
    ? String((error as NodeJS.ErrnoException).code)
    : undefined;
}

function boundedString(value: unknown, maxBytes: number): value is string {
  return typeof value === "string" && value.length > 0 && Buffer.byteLength(value, "utf8") <= maxBytes;
}

function validTarget(value: unknown): value is CompletionTarget {
  if (!value || typeof value !== "object") return false;
  const target = value as Partial<CompletionTarget>;
  return boundedString(target.workspaceId, 128)
    && boundedString(target.sessionId, 256)
    && (target.correlationId === undefined || boundedString(target.correlationId, 128));
}

function validResource(value: unknown, originRequired: boolean): value is CompletionResource {
  if (!value || typeof value !== "object") return false;
  const resource = value as Partial<CompletionResource>;
  return boundedString(resource.correlationId, 128)
    && typeof resource.publicationId === "string" && SAFE_ID.test(resource.publicationId)
    && resource.uri === `agent://${resource.publicationId}`
    && (originRequired ? boundedString(resource.originCwd, 4096) : resource.originCwd === undefined || boundedString(resource.originCwd, 4096))
    && (resource.name === undefined || boundedString(resource.name, 1024))
    && (resource.agent === undefined || boundedString(resource.agent, 1024))
    && typeof resource.summary === "string" && Buffer.byteLength(resource.summary, "utf8") <= COMPLETION_SUMMARY_MAX_BYTES
    && (resource.outcome === "completed" || resource.outcome === "failed" || resource.outcome === "terminated");
}

export function validCompletionResource(value: unknown): value is CompletionResource {
  return validResource(value, true);
}

function validPublishedEntry(value: unknown): value is CompletionManifestPublishedEntry {
  if (!validResource(value, false)) return false;
  const entry = value as CompletionManifestPublishedEntry;
  return (entry.state === "staged" || entry.state === "committed")
    && Number.isSafeInteger(entry.stagedAt) && entry.stagedAt >= 0
    && (entry.committedAt === undefined || Number.isSafeInteger(entry.committedAt) && entry.committedAt >= 0)
    && (entry.state !== "committed" || entry.committedAt !== undefined);
}

function validIntent(value: unknown, manifest: Omit<CompletionDispatchManifest, "contentRevision">): value is CompletionIntent {
  if (!value || typeof value !== "object") return false;
  const intent = value as CompletionIntent;
  if (intent.version !== COMPLETION_DURABILITY_VERSION
    || !HASH_ID.test(intent.deliveryId)
    || intent.dispatchId !== manifest.dispatchId
    || intent.reservationId !== manifest.reservationId
    || intent.mode !== manifest.mode
    || !["single", "graph", "additional", "failure"].includes(intent.kind)
    || !validTarget(intent.target)
    || JSON.stringify(intent.target) !== JSON.stringify(manifest.target)
    || intent.replyTarget !== manifest.replyTarget
    || !["completed", "failed", "terminated"].includes(intent.outcome)
    || typeof intent.summary !== "string" || Buffer.byteLength(intent.summary, "utf8") > COMPLETION_SUMMARY_MAX_BYTES
    || !Array.isArray(intent.resources) || !intent.resources.every((resource) => validResource(resource, false))
    || !Number.isSafeInteger(intent.createdAt) || intent.createdAt !== manifest.createdAt
    || !Number.isSafeInteger(intent.finalizedAt)
    || !HASH_ID.test(intent.contentRevision)) return false;
  const { contentRevision, ...withoutRevision } = intent;
  return computeCompletionDeliveryId(intent) === intent.deliveryId
    && computeCompletionIntentRevision(withoutRevision) === contentRevision;
}

export function completionManifestRevision(
  manifest: Omit<CompletionDispatchManifest, "contentRevision">,
): string {
  return createHash("sha256").update(JSON.stringify(manifest), "utf8").digest("hex");
}

export function withCompletionManifestRevision(
  manifest: Omit<CompletionDispatchManifest, "contentRevision">,
): CompletionDispatchManifest {
  return { ...manifest, contentRevision: completionManifestRevision(manifest) };
}

export function parseCompletionManifest(value: unknown): CompletionDispatchManifest | undefined {
  if (!value || typeof value !== "object") return undefined;
  const manifest = value as Partial<CompletionDispatchManifest>;
  if (manifest.version !== COMPLETION_MANIFEST_VERSION
    || typeof manifest.dispatchId !== "string" || !SAFE_ID.test(manifest.dispatchId)
    || typeof manifest.reservationId !== "string" || !SAFE_ID.test(manifest.reservationId)
    || !boundedString(manifest.deliveryGroupId, 128)
    || !["single", "parallel", "chain", "graph"].includes(String(manifest.mode))
    || !validTarget(manifest.target)
    || (manifest.replyTarget !== "main" && manifest.replyTarget !== "caller")
    || !boundedString(manifest.originCwd, 4096)
    || !Array.isArray(manifest.expectedTasks)
    || manifest.expectedTasks.length > 64
    || !manifest.expectedTasks.every((task) => boundedString(task, 128))
    || typeof manifest.notificationRequired !== "boolean"
    || (manifest.notificationKind !== undefined && !["single", "graph", "additional", "failure"].includes(manifest.notificationKind))
    || (manifest.notificationRequiredAt !== undefined && (!Number.isSafeInteger(manifest.notificationRequiredAt) || manifest.notificationRequiredAt < 0))
    || (manifest.notificationRequired && !manifest.notificationKind)
    || !Array.isArray(manifest.published) || manifest.published.length > 64
    || !manifest.published.every(validPublishedEntry)
    || !["open", "finalized", "applied", "abandoned"].includes(String(manifest.state))
    || !Number.isSafeInteger(manifest.createdAt) || manifest.createdAt! < 0
    || !Number.isSafeInteger(manifest.updatedAt) || manifest.updatedAt! < manifest.createdAt!
    || !Number.isSafeInteger(manifest.expiresAt) || manifest.expiresAt! < manifest.createdAt!
    || typeof manifest.contentRevision !== "string" || !HASH_ID.test(manifest.contentRevision)) return undefined;
  const typed = manifest as CompletionDispatchManifest;
  const { contentRevision, ...withoutRevision } = typed;
  if (completionManifestRevision(withoutRevision) !== contentRevision) return undefined;
  if (typed.state === "finalized" || typed.state === "applied") {
    if (!typed.intent || typed.deliveryId !== typed.intent.deliveryId || !validIntent(typed.intent, withoutRevision)) return undefined;
  } else if (typed.intent !== undefined || typed.deliveryId !== undefined) {
    return undefined;
  }
  return typed;
}

export function parseCompletionManifestText(text: string): CompletionDispatchManifest | undefined {
  if (Buffer.byteLength(text, "utf8") > MAX_COMPLETION_MANIFEST_BYTES) return undefined;
  try {
    return parseCompletionManifest(JSON.parse(text));
  } catch {
    return undefined;
  }
}

interface CompletionReplacementName {
  name: string;
  canonical: string;
  transaction: string;
  generation?: string;
  kind: "new" | "bak";
}

function parseReplacementName(name: string): CompletionReplacementName | undefined {
  const ordered = ORDERED_REPLACEMENT_PATTERN.exec(name);
  if (ordered?.[1] && ordered[2] && ordered[3] && ordered[4]) {
    return {
      name,
      canonical: ordered[1],
      transaction: `${ordered[2]}-${ordered[3]}`,
      generation: ordered[2],
      kind: ordered[4] as "new" | "bak",
    };
  }
  const legacy = LEGACY_REPLACEMENT_PATTERN.exec(name);
  if (!legacy?.[1] || !legacy[2] || !legacy[3]) return undefined;
  return {
    name,
    canonical: legacy[1],
    transaction: legacy[2],
    kind: legacy[3] as "new" | "bak",
  };
}

export function completionManifestCanonicalNames(names: readonly string[]): string[] {
  const found = new Set<string>();
  for (const name of names) {
    if (name.endsWith(".json")) found.add(name);
    else {
      const replacement = parseReplacementName(name);
      if (replacement) found.add(replacement.canonical);
    }
  }
  return [...found].sort();
}

async function fsyncDirectory(path: string): Promise<void> {
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(path, "r");
    await handle.sync();
  } catch (error) {
    if (!new Set(["EPERM", "EINVAL", "ENOSYS", "EBADF"]).has(fileCode(error) ?? "")) throw error;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

interface CandidateIdentity {
  dev: number;
  ino: number;
  size: number;
  mtimeMs: number;
  symbolicLink: boolean;
  regularFile: boolean;
}

function candidateIdentity(info: Stats): CandidateIdentity {
  return {
    dev: info.dev,
    ino: info.ino,
    size: info.size,
    mtimeMs: info.mtimeMs,
    symbolicLink: info.isSymbolicLink(),
    regularFile: info.isFile(),
  };
}

function sameCandidateIdentity(
  info: Stats,
  expected: CandidateIdentity,
): boolean {
  return info.dev === expected.dev && info.ino === expected.ino
    && info.size === expected.size && info.mtimeMs === expected.mtimeMs
    && info.isSymbolicLink() === expected.symbolicLink
    && info.isFile() === expected.regularFile;
}

/** Rename only the rejected directory entry after a no-follow metadata check. */
async function quarantineRejectedEntry(path: string, expected: CandidateIdentity): Promise<void> {
  const current = await lstat(path).catch((error) => {
    if (fileCode(error) === "ENOENT") return undefined;
    throw error;
  });
  if (!current || !sameCandidateIdentity(current, expected)) return;
  const quarantine = `${path}.invalid-${Date.now()}-${randomUUID()}.quarantine`;
  try {
    // rename moves the directory entry itself and never dereferences a rejected
    // symlink. Oversized/special files are therefore quarantined without reads.
    await rename(path, quarantine);
    await fsyncDirectory(dirname(path));
  } catch (error) {
    if (!new Set(["ENOENT", "EACCES", "EPERM"]).has(fileCode(error) ?? "")) throw error;
  }
}

async function readCappedRegularCandidate(path: string): Promise<{
  raw?: string;
  identity: CandidateIdentity;
}> {
  const initial = await lstat(path);
  const identity = candidateIdentity(initial);
  if (identity.symbolicLink || !identity.regularFile || identity.size > MAX_COMPLETION_MANIFEST_BYTES) {
    return { identity };
  }
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(path, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
    const opened = await handle.stat();
    if (!opened.isFile() || opened.dev !== initial.dev || opened.ino !== initial.ino
      || opened.size > MAX_COMPLETION_MANIFEST_BYTES) return { identity };
    const buffer = Buffer.allocUnsafe(MAX_COMPLETION_MANIFEST_BYTES + 1);
    let offset = 0;
    while (offset < buffer.byteLength) {
      const { bytesRead } = await handle.read(buffer, offset, buffer.byteLength - offset, offset);
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    if (offset > MAX_COMPLETION_MANIFEST_BYTES) return { identity };
    return { raw: buffer.subarray(0, offset).toString("utf8"), identity };
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

async function latestReplacementNames(
  dir: string,
  canonical: string,
  names: readonly string[],
): Promise<string[]> {
  const replacements = names
    .map(parseReplacementName)
    .filter((entry): entry is CompletionReplacementName => entry?.canonical === canonical);
  if (replacements.length === 0) return [];
  const ordered = replacements.filter((entry) => entry.generation !== undefined);
  if (ordered.length > 0) {
    const latestGeneration = ordered.map((entry) => entry.generation!).sort().at(-1)!;
    return ordered
      .filter((entry) => entry.generation === latestGeneration)
      .sort((left, right) => left.kind === right.kind ? left.name.localeCompare(right.name) : left.kind === "new" ? -1 : 1)
      .map((entry) => entry.name);
  }
  // Legacy UUID-only remnants predate ordered generations. Use the newest
  // transaction's directory-entry metadata once, but never mix candidates from
  // two legacy transactions.
  const transactions = new Map<string, { names: CompletionReplacementName[]; newest: number }>();
  for (const entry of replacements) {
    const mtimeMs = (await lstat(join(dir, entry.name)).catch(() => undefined))?.mtimeMs ?? 0;
    const transaction = transactions.get(entry.transaction) ?? { names: [], newest: 0 };
    transaction.names.push(entry);
    transaction.newest = Math.max(transaction.newest, mtimeMs);
    transactions.set(entry.transaction, transaction);
  }
  const latest = [...transactions.values()].sort((left, right) => right.newest - left.newest)[0];
  return (latest?.names ?? [])
    .sort((left, right) => left.kind === right.kind ? left.name.localeCompare(right.name) : left.kind === "new" ? -1 : 1)
    .map((entry) => entry.name);
}

/**
 * Read one canonical manifest or only the latest interrupted replacement pair.
 * Invalid entries are quarantined by inode/type metadata; every read is capped
 * and uses O_NOFOLLOW, so a rejected symlink or oversized file is never opened.
 */
export async function readCompletionManifestFile(path: string): Promise<CompletionDispatchManifest | undefined> {
  const dir = dirname(path);
  const canonical = basename(path);
  let names: string[];
  try {
    names = await readdir(dir);
  } catch (error) {
    if (fileCode(error) === "ENOENT") return undefined;
    throw error;
  }
  const replacements = await latestReplacementNames(dir, canonical, names);
  const candidates = names.includes(canonical)
    ? [canonical, ...replacements]
    : replacements;
  for (const name of candidates) {
    const candidatePath = join(dir, name);
    try {
      const candidate = await readCappedRegularCandidate(candidatePath);
      if (candidate.raw === undefined) {
        await quarantineRejectedEntry(candidatePath, candidate.identity);
        continue;
      }
      const manifest = parseCompletionManifestText(candidate.raw);
      if (manifest) return manifest;
      await quarantineRejectedEntry(candidatePath, candidate.identity);
    } catch (error) {
      if (fileCode(error) === "ENOENT") continue;
      throw error;
    }
  }
  return undefined;
}
