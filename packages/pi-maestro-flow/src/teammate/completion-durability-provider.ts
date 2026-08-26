import { createHash, randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { lstat, mkdir, open, readdir, rename, rm } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import {
  COMPLETION_DURABILITY_VERSION,
  computeCompletionDeliveryId,
  computeCompletionIntentRevision,
  type CompletionAbandonInput,
  type CompletionAppliedReceipt,
  type CompletionDispatchHandle,
  type CompletionDispatchSeed,
  type CompletionDurabilityProvider,
  type CompletionFinalizeInput,
  type CompletionIntent,
  type CompletionNotificationRequirement,
  type CompletionPublicationCommit,
  type CompletionPublicationInput,
  type CompletionResource,
  type CompletionTarget,
} from "pi-maestro-teammate/v1";
import { ensureAgentOutputBucket, readExactAgentPublication } from "./agent-output-store.ts";
import {
  COMPLETION_MANIFEST_DIR,
  COMPLETION_MANIFEST_VERSION,
  MAX_COMPLETION_MANIFEST_BYTES,
  completionManifestCanonicalNames,
  parseCompletionManifest,
  readCompletionManifestFile,
  truncateCompletionSummary,
  withCompletionManifestRevision,
  type CompletionDispatchManifest,
} from "./completion-manifest.ts";
import { lockSettingsResource } from "../settings/resource-lock.ts";

const OPEN_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const APPLIED_TTL_MS = 24 * 60 * 60 * 1000;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
const REPLACE_ERRORS = new Set(["EPERM", "EACCES", "EEXIST"]);
const RENAME_RETRIES = 5;
const RENAME_RETRY_MS = 25;
const ORDERED_REPLACEMENT_PATTERN = /^.*\.json\.replace-(\d{20})-[A-Za-z0-9-]+\.(?:new|bak)$/;

function fileCode(error: unknown): string | undefined {
  return error instanceof Error && "code" in error ? String((error as NodeJS.ErrnoException).code) : undefined;
}

function persistenceBoundary(boundary: string): void {
  const expected = `manifest:${boundary}`;
  if (process.env.PI_TEST_COMPLETION_FAIL_AT !== expected) return;
  delete process.env.PI_TEST_COMPLETION_FAIL_AT;
  if (process.env.PI_TEST_COMPLETION_CRASH === "1") process.exit(86);
  throw Object.assign(new Error(`Injected completion persistence failure at ${expected}`), { code: "EIO" });
}

function hash(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

async function ensureRealDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 });
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink()) {
    throw new Error(`Completion manifest directory must be a real directory: ${path}`);
  }
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

async function renameWithRetry(source: string, target: string): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      await rename(source, target);
      return;
    } catch (error) {
      if (!REPLACE_ERRORS.has(fileCode(error) ?? "") || attempt >= RENAME_RETRIES) throw error;
      await new Promise((resolveDelay) => setTimeout(resolveDelay, RENAME_RETRY_MS * (attempt + 1)));
    }
  }
}

async function nextReplacementGeneration(path: string): Promise<string> {
  const dir = dirname(path);
  const canonical = basename(path);
  let highest = 0n;
  for (const name of await readdir(dir).catch((error) => {
    if (fileCode(error) === "ENOENT") return [] as string[];
    throw error;
  })) {
    if (!name.startsWith(`${canonical}.replace-`)) continue;
    const match = ORDERED_REPLACEMENT_PATTERN.exec(name);
    if (match?.[1]) highest = highest > BigInt(match[1]) ? highest : BigInt(match[1]);
  }
  return (highest + 1n).toString().padStart(20, "0");
}

async function cleanupReplacementRemnants(path: string): Promise<void> {
  const dir = dirname(path);
  const canonical = basename(path);
  const names = await readdir(dir).catch((error) => {
    if (fileCode(error) === "ENOENT") return [] as string[];
    throw error;
  });
  for (const name of names) {
    if (name.startsWith(`${canonical}.replace-`) && (name.endsWith(".new") || name.endsWith(".bak"))) {
      await rm(join(dir, name), { force: true });
    }
  }
  await fsyncDirectory(dir);
}

/**
 * Publish a replacement without ever unlinking the sole committed destination.
 * If Windows refuses rename-over-existing, the old file is first moved to a
 * recoverable .bak name and directory-synced. A crash then leaves either the
 * canonical old/new record or a parser-visible .new/.bak candidate.
 */
async function writeRecoverableAtomic(path: string, value: unknown): Promise<void> {
  const payload = Buffer.from(`${JSON.stringify(value)}\n`, "utf8");
  if (payload.byteLength > MAX_COMPLETION_MANIFEST_BYTES) {
    throw new Error(`Completion manifest exceeds ${MAX_COMPLETION_MANIFEST_BYTES} bytes.`);
  }
  const dir = dirname(path);
  await ensureRealDirectory(dir);
  const generation = await nextReplacementGeneration(path);
  const token = `${generation}-${randomUUID()}`;
  const replacement = `${path}.replace-${token}.new`;
  const backup = `${path}.replace-${token}.bak`;
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(replacement, "wx", 0o600);
    await handle.writeFile(payload);
    persistenceBoundary("after-write");
    await handle.sync();
    persistenceBoundary("after-file-sync");
    await handle.close();
    handle = undefined;
    persistenceBoundary("after-close");
    const current = await lstat(path).catch((error) => {
      if (fileCode(error) === "ENOENT") return undefined;
      throw error;
    });
    if (!current) {
      await renameWithRetry(replacement, path);
      persistenceBoundary("after-new-to-canonical");
      await fsyncDirectory(dir);
      persistenceBoundary("after-directory-sync");
      await cleanupReplacementRemnants(path);
      return;
    }
    if (!current.isFile() || current.isSymbolicLink()) {
      throw new Error(`Completion manifest path must be a regular file: ${path}`);
    }
    await renameWithRetry(path, backup);
    persistenceBoundary("after-canonical-to-backup");
    await fsyncDirectory(dir);
    await renameWithRetry(replacement, path);
    persistenceBoundary("after-new-to-canonical");
    await fsyncDirectory(dir);
    persistenceBoundary("after-directory-sync");
    await rm(backup, { force: true });
    persistenceBoundary("after-backup-cleanup");
    await fsyncDirectory(dir);
    await cleanupReplacementRemnants(path);
  } catch (error) {
    await handle?.close().catch(() => undefined);
    // Do not delete replacement/backup remnants: the shared parser can recover
    // a byte-valid old or new record after interruption.
    throw error;
  }
}

async function removeManifestFamily(path: string): Promise<void> {
  const dir = dirname(path);
  const canonical = basename(path);
  let names: string[];
  try {
    names = await readdir(dir);
  } catch (error) {
    if (fileCode(error) === "ENOENT") return;
    throw error;
  }
  for (const name of names) {
    if (name === canonical || name.startsWith(`${canonical}.replace-`)) {
      await rm(join(dir, name), { force: true });
    }
  }
  await fsyncDirectory(dir);
}

export class FlowCompletionDurabilityProvider implements CompletionDurabilityProvider {
  readonly #outputRoot: string;
  readonly #manifestPaths = new Map<string, string>();

  constructor(outputRoot = process.env.PI_AGENT_OUTPUT_ROOT ?? join(homedir(), ".pi", "teammate-output")) {
    this.#outputRoot = resolve(outputRoot);
  }

  async beginDispatch(seed: CompletionDispatchSeed): Promise<CompletionDispatchHandle> {
    if (!SAFE_ID.test(seed.dispatchId) || !SAFE_ID.test(seed.reservationId) || !seed.originCwd) {
      throw new Error("Invalid completion dispatch seed.");
    }
    const existingPath = await this.#locate(seed.dispatchId);
    const bucket = await ensureAgentOutputBucket(seed.originCwd);
    const path = existingPath ?? join(bucket, COMPLETION_MANIFEST_DIR, `${hash(seed.dispatchId)}.json`);
    this.#manifestPaths.set(seed.dispatchId, path);
    await this.#mutate(path, seed.dispatchId, (current, now) => {
      if (current) {
        if (current.reservationId !== seed.reservationId
          || current.deliveryGroupId !== seed.deliveryGroupId
          || current.mode !== seed.mode
          || current.replyTarget !== seed.replyTarget
          || current.originCwd !== seed.originCwd
          || current.target.workspaceId !== seed.target.workspaceId
          || current.target.sessionId !== seed.target.sessionId
          || current.target.correlationId !== seed.target.correlationId
          || current.expectedTasks.join("\n") !== [...seed.expectedTasks].join("\n")) {
          throw new Error(`Completion dispatch ${seed.dispatchId} already belongs to another target.`);
        }
        return current;
      }
      return withCompletionManifestRevision({
        version: COMPLETION_MANIFEST_VERSION,
        dispatchId: seed.dispatchId,
        reservationId: seed.reservationId,
        deliveryGroupId: seed.deliveryGroupId,
        mode: seed.mode,
        target: seed.target,
        replyTarget: seed.replyTarget,
        originCwd: seed.originCwd,
        expectedTasks: [...seed.expectedTasks],
        notificationRequired: false,
        published: [],
        state: "open",
        createdAt: seed.createdAt,
        updatedAt: now,
        expiresAt: now + OPEN_TTL_MS,
      });
    });
    return { dispatchId: seed.dispatchId, reservationId: seed.reservationId, deliveryGroupId: seed.deliveryGroupId };
  }

  async requireNotification(input: CompletionNotificationRequirement): Promise<void> {
    await this.#mutateDispatch(input.dispatchId, (current, now) => {
      this.#assertReservation(current, input.reservationId);
      return withCompletionManifestRevision({
        ...this.#withoutRevision(current),
        notificationRequired: true,
        notificationKind: input.kind,
        notificationRequiredAt: input.requiredAt,
        updatedAt: now,
      });
    });
  }

  async stagePublication(input: CompletionPublicationInput): Promise<void> {
    await this.#mutateDispatch(input.dispatchId, (current, now) => {
      this.#assertReservation(current, input.reservationId);
      const existing = current.published.find((entry) => entry.publicationId === input.resource.publicationId);
      if (existing?.state === "committed") return current;
      if (existing?.state === "staged" && existing.originCwd !== input.resource.originCwd) {
        throw new Error(`Publication ${input.resource.publicationId} already staged from a different origin.`);
      }
      const published = current.published.filter((entry) => entry.publicationId !== input.resource.publicationId);
      // Byte-cap the summary at the persistence boundary so an oversized summary
      // can never be written and then silently quarantined on the next read
      // (the strict validator caps by UTF-8 bytes, not characters).
      const resource = input.resource.summary === undefined
        ? input.resource
        : { ...input.resource, summary: truncateCompletionSummary(input.resource.summary) };
      published.push({ ...resource, state: "staged", stagedAt: input.stagedAt });
      return withCompletionManifestRevision({ ...this.#withoutRevision(current), published, updatedAt: now });
    });
  }

  async commitPublication(input: CompletionPublicationCommit): Promise<void> {
    await this.#mutateDispatch(input.dispatchId, async (current, now) => {
      this.#assertReservation(current, input.reservationId);
      const staged = current.published.find((entry) => entry.publicationId === input.publicationId);
      if (!staged) throw new Error(`Publication ${input.publicationId} was not staged.`);
      const record = await readExactAgentPublication(input.publicationId, staged.originCwd ?? current.originCwd);
      if (!record || record.correlationId !== staged.correlationId) {
        throw new Error(`Immutable agent://${input.publicationId} is not readable.`);
      }
      const published = current.published.map((entry) => entry.publicationId === input.publicationId
        ? { ...entry, state: "committed" as const, committedAt: input.committedAt }
        : entry);
      return withCompletionManifestRevision({ ...this.#withoutRevision(current), published, updatedAt: now });
    });
  }

  async finalizeDelivery(input: CompletionFinalizeInput): Promise<CompletionIntent> {
    let intent: CompletionIntent | undefined;
    await this.#mutateDispatch(input.dispatchId, async (current, now) => {
      this.#assertReservation(current, input.reservationId);
      if (current.intent) { intent = current.intent; return current; }
      if (!current.notificationRequired) {
        throw new Error(`Completion dispatch ${input.dispatchId} does not require notification.`);
      }
      const published = [...current.published];
      const resolvedResources: CompletionResource[] = [];
      for (const resource of input.resources) {
        const index = published.findIndex((entry) => entry.publicationId === resource.publicationId);
        const entry = index < 0 ? undefined : published[index];
        const origin = entry?.originCwd ?? current.originCwd;
        const record = entry
          ? await readExactAgentPublication(resource.publicationId, origin)
          : undefined;
        if (!entry
          || entry.state !== "staged" && entry.state !== "committed"
          || !record
          || record.correlationId !== entry.correlationId) {
          throw new Error(`Completion publication ${resource.publicationId} is not durably committed.`);
        }
        if (entry.state === "staged") {
          published[index] = { ...entry, state: "committed", committedAt: input.finalizedAt };
        }
        const { state: _state, stagedAt: _stagedAt, committedAt: _committedAt, ...canonicalResource } = entry;
        resolvedResources.push({ ...canonicalResource, originCwd: origin });
      }
      const base: Omit<CompletionIntent, "contentRevision"> = {
        version: COMPLETION_DURABILITY_VERSION,
        deliveryId: "",
        dispatchId: current.dispatchId,
        reservationId: current.reservationId,
        mode: current.mode,
        kind: input.kind,
        target: current.target,
        replyTarget: current.replyTarget,
        outcome: input.outcome,
        summary: truncateCompletionSummary(input.summary),
        resources: resolvedResources,
        createdAt: current.createdAt,
        finalizedAt: input.finalizedAt,
      };
      const withId = { ...base, deliveryId: computeCompletionDeliveryId(base) };
      intent = { ...withId, contentRevision: computeCompletionIntentRevision(withId) };
      return withCompletionManifestRevision({
        ...this.#withoutRevision(current),
        published,
        state: "finalized",
        intent,
        deliveryId: intent.deliveryId,
        updatedAt: now,
        expiresAt: now + OPEN_TTL_MS,
      });
    });
    if (!intent) throw new Error(`Completion dispatch ${input.dispatchId} could not be finalized.`);
    return intent;
  }

  async listRecoverable(target: CompletionTarget): Promise<readonly CompletionIntent[]> {
    const manifests = await this.#scanManifests();
    const intents: CompletionIntent[] = [];
    for (const { path, manifest } of manifests) {
      this.#manifestPaths.set(manifest.dispatchId, path);
      if (manifest.expiresAt <= Date.now()) continue;
      if (manifest.target.workspaceId !== target.workspaceId
        || manifest.target.sessionId !== target.sessionId
        || manifest.target.correlationId !== target.correlationId) continue;
      let candidate = manifest;
      if (candidate.state === "open") {
        const recovered = await this.#recoverFullyCommittedOpen(candidate);
        if (!recovered) continue;
        candidate = recovered;
      }
      if (candidate.state !== "finalized" || !candidate.intent) continue;
      const complete = await Promise.all(candidate.intent.resources.map((resource) =>
        readExactAgentPublication(resource.publicationId, resource.originCwd ?? candidate.originCwd)));
      if (complete.every(Boolean)) intents.push(candidate.intent);
    }
    return intents.sort((left, right) => left.createdAt - right.createdAt || left.deliveryId.localeCompare(right.deliveryId));
  }

  async acknowledgeApplied(receipt: CompletionAppliedReceipt): Promise<void> {
    await this.#mutateDispatch(receipt.dispatchId, (current, now) => {
      if (current.deliveryId !== receipt.deliveryId || current.intent?.contentRevision !== receipt.contentRevision) {
        throw new Error(`Completion applied receipt mismatch for ${receipt.dispatchId}.`);
      }
      return withCompletionManifestRevision({
        ...this.#withoutRevision(current),
        state: "applied",
        updatedAt: now,
        expiresAt: now + APPLIED_TTL_MS,
      });
    });
  }

  async abandonDispatch(input: CompletionAbandonInput): Promise<void> {
    await this.#mutateDispatch(input.dispatchId, (current, now) => {
      this.#assertReservation(current, input.reservationId);
      // Finalized is the irreversible commit point. A late foreground settle or
      // racing cancellation may observe finalized/applied state, but it must
      // never erase the intent or roll the manifest back to abandoned.
      if (current.state !== "open") return current;
      return withCompletionManifestRevision({
        ...this.#withoutRevision(current),
        state: "abandoned",
        intent: undefined,
        deliveryId: undefined,
        updatedAt: now,
        expiresAt: now + APPLIED_TTL_MS,
      });
    });
  }

  async prune(now: number): Promise<void> {
    for (const { path, manifest } of await this.#scanManifests()) {
      if (manifest.expiresAt <= now) await removeManifestFamily(path);
    }
  }

  async #recoverFullyCommittedOpen(manifest: CompletionDispatchManifest): Promise<CompletionDispatchManifest | undefined> {
    if (!manifest.notificationRequired || !manifest.notificationKind || manifest.expectedTasks.length === 0) return undefined;
    if (new Set(manifest.expectedTasks).size !== manifest.expectedTasks.length) return undefined;
    if (manifest.published.length !== manifest.expectedTasks.length
      || manifest.published.some((entry) => entry.state !== "committed")) return undefined;
    const byCorrelation = new Map<string, typeof manifest.published[number][]>();
    for (const entry of manifest.published) {
      const current = byCorrelation.get(entry.correlationId) ?? [];
      current.push(entry);
      byCorrelation.set(entry.correlationId, current);
    }
    const ordered = manifest.expectedTasks.map((correlationId) => byCorrelation.get(correlationId));
    if (ordered.some((entries) => entries?.length !== 1)) return undefined;
    const resources: CompletionResource[] = ordered.map((entries) => {
      const { state: _state, stagedAt: _stagedAt, committedAt: _committedAt, ...resource } = entries![0]!;
      return resource;
    });
    for (const resource of resources) {
      const exact = await readExactAgentPublication(resource.publicationId, resource.originCwd ?? manifest.originCwd);
      if (!exact || exact.correlationId !== resource.correlationId) return undefined;
    }
    const outcome = resources.some((resource) => resource.outcome === "failed")
      ? "failed" as const
      : resources.some((resource) => resource.outcome === "terminated")
        ? "terminated" as const
        : "completed" as const;
    const finalizedAt = Math.max(
      manifest.notificationRequiredAt ?? manifest.updatedAt,
      ...manifest.published.map((entry) => entry.committedAt ?? entry.stagedAt),
    );
    const summary = resources.map((resource) => resource.summary).filter(Boolean).join("\n")
      || `${resources.length} teammate result${resources.length === 1 ? "" : "s"} completed.`;
    await this.finalizeDelivery({
      dispatchId: manifest.dispatchId,
      reservationId: manifest.reservationId,
      kind: manifest.notificationKind,
      outcome,
      summary,
      resources,
      finalizedAt,
    });
    const path = await this.#locate(manifest.dispatchId);
    return path ? readCompletionManifestFile(path) : undefined;
  }

  async #mutateDispatch(
    dispatchId: string,
    update: (current: CompletionDispatchManifest, now: number) => CompletionDispatchManifest | Promise<CompletionDispatchManifest>,
  ): Promise<void> {
    const path = await this.#locate(dispatchId);
    if (!path) throw new Error(`Completion dispatch manifest not found: ${dispatchId}.`);
    await this.#mutate(path, dispatchId, (current, now) => {
      if (!current) throw new Error(`Completion dispatch manifest unreadable: ${dispatchId}.`);
      return update(current, now);
    });
  }

  async #mutate(
    path: string,
    dispatchId: string,
    update: (current: CompletionDispatchManifest | undefined, now: number) => CompletionDispatchManifest | Promise<CompletionDispatchManifest>,
  ): Promise<void> {
    await ensureRealDirectory(dirname(path));
    const release = await lockSettingsResource(join(dirname(path), `.manifest-${hash(dispatchId)}`));
    try {
      const current = await readCompletionManifestFile(path);
      const next = await update(current, Date.now());
      if (!parseCompletionManifest(next)) throw new Error(`Invalid completion manifest transition: ${dispatchId}.`);
      await writeRecoverableAtomic(path, next);
      this.#manifestPaths.set(dispatchId, path);
    } finally {
      await release();
    }
  }

  async #locate(dispatchId: string): Promise<string | undefined> {
    const cached = this.#manifestPaths.get(dispatchId);
    if (cached && await readCompletionManifestFile(cached)) return cached;
    const fileName = `${hash(dispatchId)}.json`;
    for (const { path, manifest } of await this.#scanManifests()) {
      if (manifest.dispatchId === dispatchId || path.endsWith(fileName)) return path;
    }
    return undefined;
  }

  async #scanManifests(): Promise<Array<{ path: string; manifest: CompletionDispatchManifest }>> {
    let buckets: string[];
    try {
      buckets = (await readdir(this.#outputRoot, { withFileTypes: true }))
        .filter((entry) => entry.isDirectory() && !entry.isSymbolicLink())
        .map((entry) => join(this.#outputRoot, entry.name));
    } catch (error) {
      if (fileCode(error) === "ENOENT") return [];
      throw error;
    }
    const found: Array<{ path: string; manifest: CompletionDispatchManifest }> = [];
    for (const bucket of buckets) {
      const dir = join(bucket, COMPLETION_MANIFEST_DIR);
      let names: string[];
      try {
        names = await readdir(dir);
      } catch (error) {
        if (fileCode(error) === "ENOENT") continue;
        throw error;
      }
      for (const name of completionManifestCanonicalNames(names)) {
        const path = join(dir, name);
        const manifest = await readCompletionManifestFile(path);
        if (manifest) found.push({ path, manifest });
      }
    }
    return found;
  }

  #assertReservation(manifest: CompletionDispatchManifest, reservationId: string): void {
    if (manifest.reservationId !== reservationId) {
      throw new Error(`Completion reservation mismatch for ${manifest.dispatchId}.`);
    }
  }

  #withoutRevision(
    manifest: CompletionDispatchManifest,
  ): Omit<CompletionDispatchManifest, "contentRevision"> {
    const { contentRevision: _revision, ...withoutRevision } = manifest;
    return withoutRevision;
  }
}
