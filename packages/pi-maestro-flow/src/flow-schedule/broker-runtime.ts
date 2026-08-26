import { createHash } from "node:crypto";
import { mkdir, lstat, open, readFile, readdir, rename, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  runtimeBrokerModeFromEnv,
  type RuntimeActorHostClient,
} from "pi-maestro-teammate/v2/runtime-broker";
import { lockSettingsResource } from "../settings/resource-lock.ts";
import { FlowScheduleActorRuntime, type FlowScheduleActorStatus } from "./actor.ts";
import type { ExactWindowIdentity } from "./types.ts";

export const FLOW_SCHEDULE_V2_ENV = "PI_FLOW_SCHEDULE_V2" as const;
const PRIVATE_DIRECTORY_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;
const OUTBOX_MAX_BYTES = 256 * 1024;

export type FlowScheduleV2Mode = 0 | 1;

export function parseFlowScheduleV2(value: string | undefined): FlowScheduleV2Mode {
  if (value === undefined) return 1;
  return value.trim() === "1" ? 1 : 0;
}

export function flowScheduleV2FromEnv(env: NodeJS.ProcessEnv = process.env): FlowScheduleV2Mode {
  const configured = env[FLOW_SCHEDULE_V2_ENV];
  if (configured !== undefined) return parseFlowScheduleV2(configured);
  return runtimeBrokerModeFromEnv(env) === "off" ? 0 : 1;
}

export type FlowScheduleOutboxState = "prepared" | "published" | "accepted";

export interface FlowScheduleReportOutboxRecord {
  version: 2;
  type: "flow-schedule-report-outbox";
  messageId: string;
  resultMessageId: string;
  dispatchId: string;
  scheduleId: string;
  stepId: string;
  selector: string;
  targetIdentity: ExactWindowIdentity;
  body: string;
  state: FlowScheduleOutboxState;
  attempts: number;
  createdAt: number;
  updatedAt: number;
  publishedAt?: number;
  acceptedAt?: number;
  lastError?: string;
}

export interface FlowScheduleBrokerRuntimeOptions {
  projectRoot: string;
  env?: NodeJS.ProcessEnv;
  mode?: FlowScheduleV2Mode;
  actorHost?: RuntimeActorHostClient;
  holderId?: string;
  now?: () => number;
}

export class FlowScheduleBrokerRuntime {
  readonly projectRoot: string;
  readonly mode: FlowScheduleV2Mode;
  readonly actors?: FlowScheduleActorRuntime;
  readonly outbox?: FlowScheduleReportOutbox;

  constructor(options: FlowScheduleBrokerRuntimeOptions) {
    this.projectRoot = resolve(options.projectRoot);
    this.mode = options.mode ?? flowScheduleV2FromEnv(options.env);
    if (this.mode === 1) {
      this.actors = new FlowScheduleActorRuntime({
        projectRoot: this.projectRoot,
        env: options.env,
        actorHost: options.actorHost,
        holderId: options.holderId,
        now: options.now,
      });
      this.outbox = new FlowScheduleReportOutbox(this.projectRoot, options.now);
    }
  }

  get enabled(): boolean {
    return this.mode === 1;
  }

  assertAvailable(): void {
    if (this.mode !== 1 || !this.actors || !this.outbox) {
      throw new Error("Flow Schedule V2 is disabled");
    }
    if (!this.actors.enabled) {
      throw new Error("PI_FLOW_SCHEDULE_V2=1 requires PI_RUNTIME_BROKER=file|sqlite");
    }
  }

  actorStatus(kind: "schedule" | "dispatch", id: string): Promise<FlowScheduleActorStatus | undefined> {
    return this.actors?.status(kind, id) ?? Promise.resolve(undefined);
  }

  async stop(): Promise<void> {
    await this.actors?.stop();
  }
}

export class FlowScheduleReportOutbox {
  readonly rootDir: string;
  private readonly now: () => number;

  constructor(projectRoot: string, now: () => number = Date.now) {
    this.rootDir = join(resolve(projectRoot), ".pi", "flow-schedule", "v2", "outbox", "reports");
    this.now = now;
  }

  async prepare(input: Omit<FlowScheduleReportOutboxRecord,
    "version" | "type" | "state" | "attempts" | "createdAt" | "updatedAt">): Promise<FlowScheduleReportOutboxRecord> {
    const at = this.now();
    const record = parseOutboxRecord({
      version: 2,
      type: "flow-schedule-report-outbox",
      ...input,
      state: "prepared",
      attempts: 0,
      createdAt: at,
      updatedAt: at,
    });
    await ensurePrivateDirectory(this.rootDir);
    const path = this.path(record.messageId);
    const release = await lockSettingsResource(path);
    let handle;
    try {
      handle = await open(path, "wx", PRIVATE_FILE_MODE);
      await handle.writeFile(`${JSON.stringify(record)}\n`, "utf8");
      await handle.sync();
      return record;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const existing = await this.readUnlocked(record.messageId);
      if (!existing || !sameOutboxIdentity(existing, record)) {
        throw new Error("Flow report outbox messageId is bound to different content");
      }
      return existing;
    } finally {
      await handle?.close();
      await release();
    }
  }

  async recordAttempt(messageId: string, error?: string): Promise<FlowScheduleReportOutboxRecord> {
    return this.update(messageId, (current) => ({
      ...current,
      attempts: current.attempts + 1,
      updatedAt: this.now(),
      ...(error ? { lastError: error } : {}),
    }));
  }

  async markPublished(messageId: string): Promise<FlowScheduleReportOutboxRecord> {
    return this.update(messageId, (current) => {
      if (current.state === "accepted" || current.state === "published") return current;
      const at = this.now();
      return { ...current, state: "published", publishedAt: at, updatedAt: at, lastError: undefined };
    });
  }

  async markAccepted(messageId: string): Promise<FlowScheduleReportOutboxRecord> {
    return this.update(messageId, (current) => {
      if (current.state === "accepted") return current;
      const at = this.now();
      return {
        ...current,
        state: "accepted",
        publishedAt: current.publishedAt ?? at,
        acceptedAt: at,
        updatedAt: at,
        lastError: undefined,
      };
    });
  }

  async read(messageId: string): Promise<FlowScheduleReportOutboxRecord | undefined> {
    const release = await lockSettingsResource(this.path(messageId));
    try {
      return await this.readUnlocked(messageId);
    } finally {
      await release();
    }
  }

  private async readUnlocked(messageId: string): Promise<FlowScheduleReportOutboxRecord | undefined> {
    assertMessageId(messageId);
    const path = this.path(messageId);
    let details;
    try {
      details = await lstat(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        const backup = `${path}.previous`;
        try {
          await rename(backup, path);
          details = await lstat(path);
        } catch (recoveryError) {
          if ((recoveryError as NodeJS.ErrnoException).code === "ENOENT") return undefined;
          throw recoveryError;
        }
      } else {
        throw error;
      }
    }
    if (!details.isFile() || details.isSymbolicLink() || details.size > OUTBOX_MAX_BYTES) {
      throw new Error(`Invalid Flow report outbox record: ${path}`);
    }
    return parseOutboxRecord(JSON.parse(await readFile(path, "utf8")));
  }

  async listPending(): Promise<FlowScheduleReportOutboxRecord[]> {
    let entries;
    try {
      entries = await readdir(this.rootDir, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
    for (const entry of entries.filter((candidate) => candidate.name.endsWith(".json.previous"))) {
      if (!entry.isFile() || entry.isSymbolicLink()) throw new Error("Invalid Flow report outbox recovery entry");
      const backup = join(this.rootDir, entry.name);
      const destination = backup.slice(0, -".previous".length);
      try {
        await lstat(destination);
        await rm(backup, { force: true });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        await rename(backup, destination);
      }
    }
    entries = await readdir(this.rootDir, { withFileTypes: true });
    const records: FlowScheduleReportOutboxRecord[] = [];
    for (const entry of entries) {
      if (!entry.name.endsWith(".json")) continue;
      if (!entry.isFile() || entry.isSymbolicLink()) throw new Error("Invalid Flow report outbox entry");
      const path = join(this.rootDir, entry.name);
      const details = await lstat(path);
      if (details.size > OUTBOX_MAX_BYTES) throw new Error("Flow report outbox entry exceeds its byte limit");
      const record = parseOutboxRecord(JSON.parse(await readFile(path, "utf8")));
      if (entry.name !== `${outboxStorageKey(record.messageId)}.json`) throw new Error("Flow report outbox filename identity mismatch");
      if (record.state !== "accepted") records.push(record);
    }
    return records.sort((left, right) => left.createdAt - right.createdAt || left.messageId.localeCompare(right.messageId));
  }

  private async update(
    messageId: string,
    mutate: (current: FlowScheduleReportOutboxRecord) => FlowScheduleReportOutboxRecord,
  ): Promise<FlowScheduleReportOutboxRecord> {
    const release = await lockSettingsResource(this.path(messageId));
    try {
      return await this.updateUnlocked(messageId, mutate);
    } finally {
      await release();
    }
  }

  private async updateUnlocked(
    messageId: string,
    mutate: (current: FlowScheduleReportOutboxRecord) => FlowScheduleReportOutboxRecord,
  ): Promise<FlowScheduleReportOutboxRecord> {
    const current = await this.readUnlocked(messageId);
    if (!current) throw new Error(`Unknown Flow report outbox message: ${messageId}`);
    const next = parseOutboxRecord(mutate(current));
    if (!sameOutboxIdentity(current, next)) throw new Error("Flow report outbox identity is immutable");
    if (outboxRank(next.state) < outboxRank(current.state)) throw new Error("Flow report outbox state cannot regress");
    if (JSON.stringify(current) === JSON.stringify(next)) return current;
    const temporary = `${this.path(messageId)}.${process.pid}.${Date.now()}.tmp`;
    const handle = await open(temporary, "wx", PRIVATE_FILE_MODE);
    try {
      await handle.writeFile(`${JSON.stringify(next)}\n`, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    await replaceAtomic(temporary, this.path(messageId));
    return next;
  }

  private path(messageId: string): string {
    assertMessageId(messageId);
    return join(this.rootDir, `${outboxStorageKey(messageId)}.json`);
  }
}

function parseOutboxRecord(value: unknown): FlowScheduleReportOutboxRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid Flow report outbox record");
  const record = value as Partial<FlowScheduleReportOutboxRecord>;
  if (record.version !== 2
    || record.type !== "flow-schedule-report-outbox"
    || typeof record.messageId !== "string"
    || typeof record.resultMessageId !== "string"
    || typeof record.dispatchId !== "string"
    || typeof record.scheduleId !== "string"
    || typeof record.stepId !== "string"
    || typeof record.selector !== "string"
    || typeof record.body !== "string"
    || (record.state !== "prepared" && record.state !== "published" && record.state !== "accepted")
    || !Number.isSafeInteger(record.attempts)
    || !Number.isSafeInteger(record.createdAt)
    || !Number.isSafeInteger(record.updatedAt)
    || !record.targetIdentity
    || typeof record.targetIdentity.workspaceId !== "string"
    || typeof record.targetIdentity.endpointId !== "string"
    || typeof record.targetIdentity.ownerId !== "string"
    || typeof record.targetIdentity.ownerNonce !== "string") {
    throw new Error("Invalid Flow report outbox contract");
  }
  assertMessageId(record.messageId);
  return record as FlowScheduleReportOutboxRecord;
}

function sameOutboxIdentity(left: FlowScheduleReportOutboxRecord, right: FlowScheduleReportOutboxRecord): boolean {
  return left.messageId === right.messageId
    && left.resultMessageId === right.resultMessageId
    && left.dispatchId === right.dispatchId
    && left.scheduleId === right.scheduleId
    && left.stepId === right.stepId
    && left.selector === right.selector
    && JSON.stringify(left.targetIdentity) === JSON.stringify(right.targetIdentity)
    && left.body === right.body;
}

function outboxRank(state: FlowScheduleOutboxState): number {
  return state === "prepared" ? 0 : state === "published" ? 1 : 2;
}

async function replaceAtomic(temporary: string, destination: string): Promise<void> {
  try {
    await rename(temporary, destination);
    return;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (process.platform !== "win32" || (code !== "EINVAL" && code !== "EEXIST" && code !== "EPERM")) throw error;
  }
  const backup = `${destination}.previous`;
  await rm(backup, { force: true });
  await rename(destination, backup);
  try {
    await rename(temporary, destination);
  } catch (error) {
    await rename(backup, destination).catch(() => undefined);
    throw error;
  }
  await rm(backup, { force: true });
}

async function ensurePrivateDirectory(directory: string): Promise<void> {
  await mkdir(directory, { recursive: true, mode: PRIVATE_DIRECTORY_MODE });
  const details = await lstat(directory);
  if (!details.isDirectory() || details.isSymbolicLink()) throw new Error(`Invalid Flow report outbox directory: ${directory}`);
}

function outboxStorageKey(messageId: string): string {
  return createHash("sha256").update(messageId).digest("hex");
}

function assertMessageId(value: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/.test(value)) throw new Error("Invalid Flow report outbox messageId");
}
