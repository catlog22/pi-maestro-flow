import { createHash, randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { lstat, mkdir, open, readFile, readdir, rename, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
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
import { lockSettingsResource } from "../settings/resource-lock.ts";

const MANIFEST_VERSION = 1 as const;
const MANIFEST_DIR = ".completion-intents";
const MAX_MANIFEST_BYTES = 256 * 1024;
const OPEN_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const APPLIED_TTL_MS = 24 * 60 * 60 * 1000;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;

interface PublishedEntry extends CompletionResource {
  state: "staged" | "committed";
  stagedAt: number;
  committedAt?: number;
}

interface DispatchManifest {
  version: typeof MANIFEST_VERSION;
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
  published: readonly PublishedEntry[];
  state: "open" | "finalized" | "applied" | "abandoned";
  deliveryId?: string;
  intent?: CompletionIntent;
  createdAt: number;
  updatedAt: number;
  expiresAt: number;
  contentRevision: string;
}

function fileCode(error: unknown): string | undefined {
  return error instanceof Error && "code" in error ? String((error as NodeJS.ErrnoException).code) : undefined;
}

function hash(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function semantic(manifest: Omit<DispatchManifest, "contentRevision">): unknown {
  return manifest;
}

function revision(manifest: Omit<DispatchManifest, "contentRevision">): string {
  return createHash("sha256").update(JSON.stringify(semantic(manifest)), "utf8").digest("hex");
}

function withRevision(manifest: Omit<DispatchManifest, "contentRevision">): DispatchManifest {
  return { ...manifest, contentRevision: revision(manifest) };
}

function validTarget(value: unknown): value is CompletionTarget {
  if (!value || typeof value !== "object") return false;
  const target = value as Partial<CompletionTarget>;
  return typeof target.workspaceId === "string" && target.workspaceId.length > 0
    && typeof target.sessionId === "string" && target.sessionId.length > 0
    && (target.correlationId === undefined || typeof target.correlationId === "string");
}

function validManifest(value: unknown): value is DispatchManifest {
  if (!value || typeof value !== "object") return false;
  const manifest = value as Partial<DispatchManifest>;
  if (manifest.version !== MANIFEST_VERSION
    || typeof manifest.dispatchId !== "string" || !SAFE_ID.test(manifest.dispatchId)
    || typeof manifest.reservationId !== "string" || !SAFE_ID.test(manifest.reservationId)
    || typeof manifest.deliveryGroupId !== "string"
    || !validTarget(manifest.target)
    || typeof manifest.originCwd !== "string" || manifest.originCwd.length === 0
    || !Array.isArray(manifest.expectedTasks) || !Array.isArray(manifest.published)
    || !["open", "finalized", "applied", "abandoned"].includes(String(manifest.state))
    || !Number.isSafeInteger(manifest.createdAt) || !Number.isSafeInteger(manifest.updatedAt)
    || !Number.isSafeInteger(manifest.expiresAt)
    || typeof manifest.contentRevision !== "string") return false;
  const { contentRevision, ...withoutRevision } = manifest as DispatchManifest;
  return revision(withoutRevision) === contentRevision;
}

async function ensureRealDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 });
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error(`Completion manifest directory must be a real directory: ${path}`);
}

async function fsyncDirectory(path: string): Promise<void> {
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(path, "r");
    await handle.sync();
  } catch (error) {
    if (!new Set(["EPERM", "EINVAL", "ENOSYS", "EBADF"]).has(fileCode(error) ?? "")) throw error;
  } finally { await handle?.close().catch(() => undefined); }
}

async function writeAtomic(path: string, value: unknown): Promise<void> {
  const payload = Buffer.from(`${JSON.stringify(value)}\n`, "utf8");
  if (payload.byteLength > MAX_MANIFEST_BYTES) throw new Error(`Completion manifest exceeds ${MAX_MANIFEST_BYTES} bytes.`);
  await ensureRealDirectory(dirname(path));
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(temporary, "wx", 0o600);
    await handle.writeFile(payload);
    await handle.sync();
    await handle.close();
    handle = undefined;
    try { await rename(temporary, path); }
    catch (error) {
      if (!new Set(["EPERM", "EACCES", "EEXIST"]).has(fileCode(error) ?? "")) throw error;
      await rm(path, { force: true });
      await rename(temporary, path);
    }
    await fsyncDirectory(dirname(path));
  } catch (error) {
    await handle?.close().catch(() => undefined);
    await rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
}

async function readManifest(path: string): Promise<DispatchManifest | undefined> {
  try {
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink() || info.size > MAX_MANIFEST_BYTES) return undefined;
    const value = JSON.parse(await readFile(path, "utf8"));
    return validManifest(value) ? value : undefined;
  } catch (error) {
    if (fileCode(error) === "ENOENT" || error instanceof SyntaxError) return undefined;
    throw error;
  }
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
    // A reused dispatchId must resolve its existing manifest across ALL
    // buckets before a new path is chosen, otherwise a relocated originCwd
    // would silently create a second manifest for the same dispatch.
    const existingPath = await this.#locate(seed.dispatchId);
    const bucket = await ensureAgentOutputBucket(seed.originCwd);
    const path = existingPath ?? join(bucket, MANIFEST_DIR, `${hash(seed.dispatchId)}.json`);
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
          || current.expectedTasks.join("\n") !== [...seed.expectedTasks].join("\n")) {
          throw new Error(`Completion dispatch ${seed.dispatchId} already belongs to another target.`);
        }
        return current;
      }
      return withRevision({
        version: MANIFEST_VERSION,
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
    await this.#mutateDispatch(input.dispatchId, (current, now) => withRevision({
      ...this.#withoutRevision(current),
      notificationRequired: true,
      notificationKind: input.kind,
      updatedAt: now,
    }));
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
      published.push({ ...input.resource, state: "staged", stagedAt: input.stagedAt });
      return withRevision({ ...this.#withoutRevision(current), published, updatedAt: now });
    });
  }

  async commitPublication(input: CompletionPublicationCommit): Promise<void> {
    await this.#mutateDispatch(input.dispatchId, async (current, now) => {
      this.#assertReservation(current, input.reservationId);
      const staged = current.published.find((entry) => entry.publicationId === input.publicationId);
      if (!staged) throw new Error(`Publication ${input.publicationId} was not staged.`);
      // Legacy manifests may lack per-resource originCwd; the dispatch origin
      // is then the only known location.
      const record = await readExactAgentPublication(input.publicationId, staged.originCwd ?? current.originCwd);
      if (!record) throw new Error(`Immutable agent://${input.publicationId} is not readable.`);
      const published = current.published.map((entry) => entry.publicationId === input.publicationId
        ? { ...entry, state: "committed" as const, committedAt: input.committedAt }
        : entry);
      return withRevision({ ...this.#withoutRevision(current), published, updatedAt: now });
    });
  }

  async finalizeDelivery(input: CompletionFinalizeInput): Promise<CompletionIntent> {
    let intent: CompletionIntent | undefined;
    await this.#mutateDispatch(input.dispatchId, async (current, now) => {
      this.#assertReservation(current, input.reservationId);
      if (current.intent) { intent = current.intent; return current; }
      if (!current.notificationRequired) throw new Error(`Completion dispatch ${input.dispatchId} does not require notification.`);
      const committed = new Map(current.published.filter((entry) => entry.state === "committed").map((entry) => [entry.publicationId, entry]));
      const resolvedResources: CompletionResource[] = [];
      for (const resource of input.resources) {
        // The committed entry owns the publication's location and identity;
        // caller-supplied metadata never overrides it.
        const entry = committed.get(resource.publicationId);
        const origin = entry?.originCwd ?? current.originCwd;
        if (!entry || !await readExactAgentPublication(resource.publicationId, origin)) {
          throw new Error(`Completion publication ${resource.publicationId} is not durably committed.`);
        }
        resolvedResources.push({ ...resource, originCwd: origin });
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
        summary: Buffer.from(input.summary, "utf8").subarray(0, 4096).toString("utf8"),
        resources: resolvedResources,
        createdAt: current.createdAt,
        finalizedAt: input.finalizedAt,
      };
      const withId = { ...base, deliveryId: computeCompletionDeliveryId(base) };
      intent = { ...withId, contentRevision: computeCompletionIntentRevision(withId) };
      return withRevision({
        ...this.#withoutRevision(current),
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
      if (manifest.state !== "finalized" || !manifest.intent || manifest.expiresAt <= Date.now()) continue;
      if (manifest.target.workspaceId !== target.workspaceId || manifest.target.sessionId !== target.sessionId
        || manifest.target.correlationId !== target.correlationId) continue;
      const complete = await Promise.all(manifest.intent.resources.map((resource) => readExactAgentPublication(resource.publicationId, resource.originCwd ?? manifest.originCwd)));
      if (complete.every(Boolean)) intents.push(manifest.intent);
    }
    return intents.sort((left, right) => left.createdAt - right.createdAt || left.deliveryId.localeCompare(right.deliveryId));
  }

  async acknowledgeApplied(receipt: CompletionAppliedReceipt): Promise<void> {
    await this.#mutateDispatch(receipt.dispatchId, (current, now) => {
      if (current.deliveryId !== receipt.deliveryId || current.intent?.contentRevision !== receipt.contentRevision) {
        throw new Error(`Completion applied receipt mismatch for ${receipt.dispatchId}.`);
      }
      return withRevision({ ...this.#withoutRevision(current), state: "applied", updatedAt: now, expiresAt: now + APPLIED_TTL_MS });
    });
  }

  async abandonDispatch(input: CompletionAbandonInput): Promise<void> {
    await this.#mutateDispatch(input.dispatchId, (current, now) => {
      this.#assertReservation(current, input.reservationId);
      return withRevision({ ...this.#withoutRevision(current), state: "abandoned", updatedAt: now, expiresAt: now + APPLIED_TTL_MS });
    });
  }

  async prune(now: number): Promise<void> {
    for (const { path, manifest } of await this.#scanManifests()) {
      if (manifest.expiresAt <= now) await rm(path, { force: true });
    }
  }

  async #mutateDispatch(
    dispatchId: string,
    update: (current: DispatchManifest, now: number) => DispatchManifest | Promise<DispatchManifest>,
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
    update: (current: DispatchManifest | undefined, now: number) => DispatchManifest | Promise<DispatchManifest>,
  ): Promise<void> {
    await ensureRealDirectory(dirname(path));
    const release = await lockSettingsResource(join(dirname(path), `.manifest-${hash(dispatchId)}`));
    try {
      const current = await readManifest(path);
      const next = await update(current, Date.now());
      if (!validManifest(next)) throw new Error(`Invalid completion manifest transition: ${dispatchId}.`);
      await writeAtomic(path, next);
      this.#manifestPaths.set(dispatchId, path);
    } finally { await release(); }
  }

  async #locate(dispatchId: string): Promise<string | undefined> {
    const cached = this.#manifestPaths.get(dispatchId);
    if (cached && await readManifest(cached)) return cached;
    const fileName = `${hash(dispatchId)}.json`;
    for (const { path, manifest } of await this.#scanManifests()) {
      if (manifest.dispatchId === dispatchId || path.endsWith(fileName)) return path;
    }
    return undefined;
  }

  async #scanManifests(): Promise<Array<{ path: string; manifest: DispatchManifest }>> {
    let buckets: string[];
    try { buckets = (await readdir(this.#outputRoot, { withFileTypes: true })).filter((entry) => entry.isDirectory() && !entry.isSymbolicLink()).map((entry) => join(this.#outputRoot, entry.name)); }
    catch (error) { if (fileCode(error) === "ENOENT") return []; throw error; }
    const found: Array<{ path: string; manifest: DispatchManifest }> = [];
    for (const bucket of buckets) {
      const dir = join(bucket, MANIFEST_DIR);
      let names: string[];
      try { names = await readdir(dir); } catch (error) { if (fileCode(error) === "ENOENT") continue; throw error; }
      for (const name of names) {
        if (!name.endsWith(".json")) continue;
        const path = join(dir, name);
        const manifest = await readManifest(path);
        if (manifest) found.push({ path, manifest });
      }
    }
    return found;
  }

  #assertReservation(manifest: DispatchManifest, reservationId: string): void {
    if (manifest.reservationId !== reservationId) throw new Error(`Completion reservation mismatch for ${manifest.dispatchId}.`);
  }

  #withoutRevision(manifest: DispatchManifest): Omit<DispatchManifest, "contentRevision"> {
    const { contentRevision: _revision, ...withoutRevision } = manifest;
    return withoutRevision;
  }
}
