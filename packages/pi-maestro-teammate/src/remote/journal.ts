import { createHash, randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { redactRemoteError } from "./child-security.ts";
import type { RemoteRunStartParams } from "./protocol.ts";
import { captureMatches, REMOTE_MAX_LINE_BYTES } from "./protocol.ts";
import { applyRemoteRunEvent, createRemoteRunSnapshot } from "./state.ts";
import {
  isRemoteStatus,
  isRemoteTerminalStatus,
  type RemoteDriverEvent,
  type RemoteRunCapture,
  type RemoteRunEvent,
  type RemoteRunSnapshot,
  type RemoteWorkerIdentity,
} from "./types.ts";

export const REMOTE_JOURNAL_VERSION = 1 as const;
export const REMOTE_MAX_JOURNAL_EVENTS = 50_000;
export const REMOTE_MAX_JOURNAL_BYTES = 64 * 1024 * 1024;
export const REMOTE_MAX_COMMAND_RECORDS = 4096;
export const REMOTE_PRIVATE_DIRECTORY_MODE = 0o700;
export const REMOTE_PRIVATE_FILE_MODE = 0o600;

interface WorkerRecord {
  version: typeof REMOTE_JOURNAL_VERSION;
  workerId: string;
}

export interface RemoteJournalRunRecord {
  version: typeof REMOTE_JOURNAL_VERSION;
  capture: RemoteRunCapture;
  request: RemoteRunStartParams;
  capabilities: readonly string[];
  snapshot: RemoteRunSnapshot;
  createdAt: number;
  updatedAt: number;
}

export interface RemoteStoredCommand {
  version: typeof REMOTE_JOURNAL_VERSION;
  commandId: string;
  fingerprint: string;
  state: "pending" | "completed";
  createdAt: number;
  completedAt?: number;
  outcome?: { ok: true; result: unknown } | { ok: false; code: number; message: string; data?: unknown };
}

class CorruptRunJournalError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "CorruptRunJournalError";
  }
}

function isPosix(): boolean {
  return process.platform !== "win32";
}

function isMissing(error: unknown): boolean {
  return error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT";
}

function removeFileIfPresent(filePath: string): void {
  try {
    fs.rmSync(filePath, { force: true });
  } catch (error) {
    if (!isMissing(error)) throw error;
  }
}

export function getRemoteStateDirectory(): string {
  const configured = process.env.PI_TEAMMATE_REMOTE_STATE_DIR;
  return configured ? path.resolve(configured) : path.join(os.homedir(), ".pi", "agent", "remote");
}

export function ensurePrivateRemoteDirectory(directoryPath: string): void {
  fs.mkdirSync(directoryPath, { recursive: true, mode: REMOTE_PRIVATE_DIRECTORY_MODE });
  const stat = fs.lstatSync(directoryPath);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error(`Remote state path is not a private directory: ${directoryPath}`);
  }
  if (isPosix()) fs.chmodSync(directoryPath, REMOTE_PRIVATE_DIRECTORY_MODE);
}

function fsyncDirectory(directoryPath: string): void {
  if (!isPosix()) return;
  const handle = fs.openSync(directoryPath, "r");
  try {
    fs.fsyncSync(handle);
  } finally {
    fs.closeSync(handle);
  }
}

function atomicWriteJson(filePath: string, value: unknown): void {
  const directory = path.dirname(filePath);
  ensurePrivateRemoteDirectory(directory);
  const temporary = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  let fd: number | undefined;
  try {
    fd = fs.openSync(temporary, "wx", REMOTE_PRIVATE_FILE_MODE);
    fs.writeFileSync(fd, `${JSON.stringify(value)}\n`, "utf8");
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;
    fs.renameSync(temporary, filePath);
    if (isPosix()) fs.chmodSync(filePath, REMOTE_PRIVATE_FILE_MODE);
    fsyncDirectory(directory);
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
    removeFileIfPresent(temporary);
  }
}

function readBoundedJson(filePath: string, maxBytes = 1024 * 1024): unknown {
  const stat = fs.lstatSync(filePath);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > maxBytes) {
    throw new Error(`Invalid remote journal file: ${filePath}`);
  }
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function storageKey(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function commandFingerprint(method: string, params: unknown): string {
  return createHash("sha256").update(JSON.stringify([method, params])).digest("hex");
}

function objectRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`Invalid ${label}`);
  return value as Record<string, unknown>;
}

function requiredString(value: unknown, label: string, maxBytes = REMOTE_MAX_LINE_BYTES): string {
  if (typeof value !== "string" || value.length === 0 || value.includes("\0") || Buffer.byteLength(value, "utf8") > maxBytes) {
    throw new Error(`Invalid ${label}`);
  }
  return value;
}

function optionalString(value: unknown, label: string, maxBytes = REMOTE_MAX_LINE_BYTES): string | undefined {
  if (value === undefined) return undefined;
  return requiredString(value, label, maxBytes);
}

function safeInteger(value: unknown, label: string, minimum = 0): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum) throw new Error(`Invalid ${label}`);
  return value as number;
}

function parseCapture(value: unknown): RemoteRunCapture {
  const record = objectRecord(value, "remote run capture");
  return {
    workerId: requiredString(record.workerId, "capture workerId", 128),
    instanceNonce: requiredString(record.instanceNonce, "capture instanceNonce", 128),
    runId: requiredString(record.runId, "capture runId", 128),
    generation: safeInteger(record.generation, "capture generation", 1),
    monitorOwnerNonce: requiredString(record.monitorOwnerNonce, "capture monitorOwnerNonce", 128),
    targetId: requiredString(record.targetId, "capture targetId", 128),
  };
}

/**
 * A persistence residue left by remote/1.
 *
 * Kept only so an existing version-1 record still parses, until the field is
 * removed together with the journal version bump.
 *
 * @param value - the raw field read off disk.
 * @returns the stored strings, bounded in count and length.
 */
function parsePersistedCapabilityResidue(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > 32) throw new Error("Invalid remote run capabilities");
  return value.map((entry) => requiredString(entry, "remote run capability", 128));
}

function parseStartRequest(value: unknown): RemoteRunStartParams {
  const record = objectRecord(value, "remote start request");
  if (!Array.isArray(record.command) || record.command.length === 0 || record.command.length > 64) {
    throw new Error("Invalid remote start command");
  }
  const command = record.command.map((entry) => requiredString(entry, "remote start argument", 8192));
  const executable = command[0];
  if (!executable) throw new Error("Invalid remote start executable");
  const driver = record.driver;
  if (driver !== "pi-rpc" && driver !== "acp") throw new Error("Invalid remote start driver");
  return {
    commandId: requiredString(record.commandId, "remote start commandId", 128),
    targetId: requiredString(record.targetId, "remote start targetId", 128),
    monitorOwnerNonce: requiredString(record.monitorOwnerNonce, "remote start monitorOwnerNonce", 128),
    name: requiredString(record.name, "remote start name", 1024),
    objective: requiredString(record.objective, "remote start objective", 256 * 1024),
    cwd: requiredString(record.cwd, "remote start cwd", 4096),
    driver,
    command: [executable, ...command.slice(1)],
    ...(record.outputSchema === undefined ? {} : { outputSchema: record.outputSchema }),
  };
}

function parseSnapshot(value: unknown): RemoteRunSnapshot {
  const record = objectRecord(value, "remote run snapshot");
  if (!isRemoteStatus(record.status)) throw new Error("Invalid remote run snapshot status");
  return {
    workerId: requiredString(record.workerId, "snapshot workerId", 128),
    instanceNonce: requiredString(record.instanceNonce, "snapshot instanceNonce", 128),
    runId: requiredString(record.runId, "snapshot runId", 128),
    generation: safeInteger(record.generation, "snapshot generation", 1),
    ...(record.targetId === undefined ? {} : { targetId: requiredString(record.targetId, "snapshot targetId", 128) }),
    status: record.status,
    lastSequence: safeInteger(record.lastSequence, "snapshot lastSequence"),
    updatedAt: safeInteger(record.updatedAt, "snapshot updatedAt"),
    ...(record.nativeStatus === undefined ? {} : { nativeStatus: requiredString(record.nativeStatus, "snapshot nativeStatus", 1024) }),
    ...(record.degradedReason === undefined ? {} : { degradedReason: requiredString(record.degradedReason, "snapshot degradedReason", 4096) }),
    ...(record.summary === undefined ? {} : { summary: requiredString(record.summary, "snapshot summary", REMOTE_MAX_LINE_BYTES) }),
  };
}

function sameSnapshotIdentity(snapshot: RemoteRunSnapshot, capture: RemoteRunCapture): boolean {
  return snapshot.workerId === capture.workerId
    && snapshot.instanceNonce === capture.instanceNonce
    && snapshot.runId === capture.runId
    && snapshot.generation === capture.generation
    && snapshot.targetId === capture.targetId;
}

function parseDriverEvent(value: unknown): RemoteDriverEvent {
  const record = objectRecord(value, "remote driver event");
  switch (record.type) {
    case "text":
      return { type: "text", text: requiredString(record.text, "driver event text", REMOTE_MAX_LINE_BYTES) };
    case "tool": {
      const tool = objectRecord(record.tool, "remote tool event");
      if (tool.phase !== "start" && tool.phase !== "end") throw new Error("Invalid remote tool phase");
      if (tool.isError !== undefined && typeof tool.isError !== "boolean") throw new Error("Invalid remote tool error flag");
      return {
        type: "tool",
        tool: {
          toolCallId: requiredString(tool.toolCallId, "toolCallId", 128),
          toolName: requiredString(tool.toolName, "toolName", 256),
          phase: tool.phase,
          ...(tool.isError === undefined ? {} : { isError: tool.isError }),
          ...(tool.summary === undefined ? {} : { summary: requiredString(tool.summary, "tool summary", 8192) }),
        },
      };
    }
    case "usage": {
      const usage = objectRecord(record.usage, "remote usage event");
      const parsed: { inputTokens?: number; outputTokens?: number; totalTokens?: number; costUsd?: number } = {};
      for (const key of ["inputTokens", "outputTokens", "totalTokens", "costUsd"] as const) {
        const entry = usage[key];
        if (entry === undefined) continue;
        if (typeof entry !== "number" || !Number.isFinite(entry) || entry < 0) throw new Error(`Invalid remote usage ${key}`);
        parsed[key] = entry;
      }
      return { type: "usage", usage: parsed };
    }
    case "native":
      return {
        type: "native",
        name: requiredString(record.name, "native event name", 256),
        ...(record.data === undefined ? {} : { data: record.data }),
      };
    default:
      throw new Error("Invalid remote driver event type");
  }
}

function parseEvent(value: unknown): RemoteRunEvent {
  const record = objectRecord(value, "remote run event");
  const identity = {
    workerId: requiredString(record.workerId, "event workerId", 128),
    instanceNonce: requiredString(record.instanceNonce, "event instanceNonce", 128),
    runId: requiredString(record.runId, "event runId", 128),
    generation: safeInteger(record.generation, "event generation", 1),
    sequence: safeInteger(record.sequence, "event sequence", 1),
    updatedAt: safeInteger(record.updatedAt, "event updatedAt"),
  };
  switch (record.type) {
    case "run/state":
      if (!isRemoteStatus(record.status)) throw new Error("Invalid remote state event status");
      return {
        type: "run/state",
        ...identity,
        status: record.status,
        ...(record.nativeStatus === undefined ? {} : { nativeStatus: requiredString(record.nativeStatus, "event nativeStatus", 1024) }),
        ...(record.degradedReason === undefined ? {} : { degradedReason: requiredString(record.degradedReason, "event degradedReason", 4096) }),
        ...(record.summary === undefined ? {} : { summary: requiredString(record.summary, "event summary", REMOTE_MAX_LINE_BYTES) }),
      };
    case "run/event":
      return { type: "run/event", ...identity, event: parseDriverEvent(record.event) };
    case "run/result":
      if (record.status !== "completed" && record.status !== "failed" && record.status !== "cancelled" && record.status !== "lost") {
        throw new Error("Invalid remote result event status");
      }
      return {
        type: "run/result",
        ...identity,
        status: record.status,
        ...(record.result === undefined ? {} : { result: requiredString(record.result, "event result", REMOTE_MAX_LINE_BYTES) }),
        ...(record.structuredOutput === undefined ? {} : { structuredOutput: record.structuredOutput }),
        ...(record.error === undefined ? {} : { error: requiredString(record.error, "event error", REMOTE_MAX_LINE_BYTES) }),
        ...(record.nativeStatus === undefined ? {} : { nativeStatus: requiredString(record.nativeStatus, "event nativeStatus", 1024) }),
        ...(record.degradedReason === undefined ? {} : { degradedReason: requiredString(record.degradedReason, "event degradedReason", 4096) }),
      };
    default:
      throw new Error("Invalid remote run event type");
  }
}

function sanitizePersistedValue(value: unknown, depth = 0): unknown {
  if (depth > 16) return "[REDACTED]";
  if (typeof value === "string") return redactRemoteError(value, { maximumBytes: REMOTE_MAX_LINE_BYTES });
  if (value === null || typeof value === "boolean" || typeof value === "number") return value;
  if (Array.isArray(value)) return value.map((entry) => sanitizePersistedValue(entry, depth + 1));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, sanitizePersistedValue(entry, depth + 1)]));
  }
  return undefined;
}

function sanitizeEvent(event: RemoteRunEvent): RemoteRunEvent {
  if (event.type === "run/state") {
    return {
      ...event,
      ...(event.nativeStatus === undefined ? {} : { nativeStatus: redactRemoteError(event.nativeStatus) }),
      ...(event.degradedReason === undefined ? {} : { degradedReason: redactRemoteError(event.degradedReason) }),
      ...(event.summary === undefined ? {} : { summary: redactRemoteError(event.summary) }),
    };
  }
  if (event.type === "run/result") {
    return {
      ...event,
      ...(event.result === undefined ? {} : { result: redactRemoteError(event.result, { maximumBytes: REMOTE_MAX_LINE_BYTES }) }),
      ...(event.error === undefined ? {} : { error: redactRemoteError(event.error, { maximumBytes: REMOTE_MAX_LINE_BYTES }) }),
      ...(event.nativeStatus === undefined ? {} : { nativeStatus: redactRemoteError(event.nativeStatus) }),
      ...(event.degradedReason === undefined ? {} : { degradedReason: redactRemoteError(event.degradedReason) }),
      ...(event.structuredOutput === undefined ? {} : { structuredOutput: sanitizePersistedValue(event.structuredOutput) }),
    };
  }
  if (event.event.type === "text") {
    return { ...event, event: { type: "text", text: redactRemoteError(event.event.text, { maximumBytes: REMOTE_MAX_LINE_BYTES }) } };
  }
  if (event.event.type === "tool") {
    return {
      ...event,
      event: {
        type: "tool",
        tool: {
          ...event.event.tool,
          ...(event.event.tool.summary === undefined ? {} : { summary: redactRemoteError(event.event.tool.summary) }),
        },
      },
    };
  }
  if (event.event.type === "native") {
    return {
      ...event,
      event: {
        ...event.event,
        ...(event.event.data === undefined ? {} : { data: sanitizePersistedValue(event.event.data) }),
      },
    };
  }
  return event;
}

function parseRunRecord(value: unknown): RemoteJournalRunRecord {
  const record = objectRecord(value, "remote run metadata");
  if (record.version !== REMOTE_JOURNAL_VERSION) throw new Error("Invalid remote run metadata version");
  const capture = parseCapture(record.capture);
  const request = parseStartRequest(record.request);
  const snapshot = parseSnapshot(record.snapshot);
  if (!sameSnapshotIdentity(snapshot, capture)
    || request.monitorOwnerNonce !== capture.monitorOwnerNonce
    || request.targetId !== capture.targetId) {
    throw new Error("Remote run metadata ownership mismatch");
  }
  return {
    version: REMOTE_JOURNAL_VERSION,
    capture,
    request,
    capabilities: parsePersistedCapabilityResidue(record.capabilities),
    snapshot,
    createdAt: safeInteger(record.createdAt, "run createdAt"),
    updatedAt: safeInteger(record.updatedAt, "run updatedAt"),
  };
}

function parseCommandRecord(value: unknown): RemoteStoredCommand {
  const record = objectRecord(value, "remote command record");
  if (record.version !== REMOTE_JOURNAL_VERSION) throw new Error("Invalid remote command version");
  if (record.state !== "pending" && record.state !== "completed") throw new Error("Invalid remote command state");
  const base = {
    version: REMOTE_JOURNAL_VERSION,
    commandId: requiredString(record.commandId, "commandId", 128),
    fingerprint: requiredString(record.fingerprint, "command fingerprint", 128),
    createdAt: safeInteger(record.createdAt, "command createdAt"),
  };
  if (record.state === "pending") {
    if (record.completedAt !== undefined || record.outcome !== undefined) throw new Error("Pending command contains a terminal outcome");
    return { ...base, state: "pending" };
  }
  const outcome = objectRecord(record.outcome, "remote command outcome");
  const completedAt = safeInteger(record.completedAt, "command completedAt");
  if (outcome.ok === true) return { ...base, state: "completed", completedAt, outcome: { ok: true, result: outcome.result } };
  if (outcome.ok !== false) throw new Error("Invalid remote command outcome");
  return {
    ...base,
    state: "completed",
    completedAt,
    outcome: {
      ok: false,
      code: safeInteger(outcome.code, "command error code", Number.MIN_SAFE_INTEGER),
      message: requiredString(outcome.message, "command error message", 8192),
      ...(outcome.data === undefined ? {} : { data: outcome.data }),
    },
  };
}

export class RemoteRunJournal {
  readonly stateDirectory: string;
  readonly identity: RemoteWorkerIdentity;
  readonly #runsDirectory: string;
  readonly #commandsDirectory: string;
  readonly #corruptRunsDirectory: string;

  constructor(stateDirectory = getRemoteStateDirectory()) {
    this.stateDirectory = path.resolve(stateDirectory);
    ensurePrivateRemoteDirectory(this.stateDirectory);
    this.#runsDirectory = path.join(this.stateDirectory, "runs");
    this.#commandsDirectory = path.join(this.stateDirectory, "commands");
    this.#corruptRunsDirectory = path.join(this.stateDirectory, "corrupt-runs");
    ensurePrivateRemoteDirectory(this.#runsDirectory);
    ensurePrivateRemoteDirectory(this.#commandsDirectory);
    ensurePrivateRemoteDirectory(this.#corruptRunsDirectory);
    fsyncDirectory(this.stateDirectory);
    const workerFile = path.join(this.stateDirectory, "worker.json");
    let workerId: string;
    try {
      const value = objectRecord(readBoundedJson(workerFile), "remote worker identity");
      if (value.version !== REMOTE_JOURNAL_VERSION) throw new Error("Invalid remote worker identity version");
      workerId = requiredString(value.workerId, "remote worker id", 128);
    } catch (error) {
      if (!isMissing(error)) throw error;
      workerId = randomUUID();
      atomicWriteJson(workerFile, { version: REMOTE_JOURNAL_VERSION, workerId } satisfies WorkerRecord);
    }
    this.identity = Object.freeze({ workerId, instanceNonce: randomUUID() });
    this.#markInterruptedRunsLost();
  }

  static fingerprint(method: string, params: unknown): string {
    return commandFingerprint(method, params);
  }

  createRun(
    capture: RemoteRunCapture,
    request: RemoteRunStartParams,
    capabilities: readonly string[] = [],
    now = Date.now(),
  ): RemoteJournalRunRecord {
    if (capture.workerId !== this.identity.workerId || capture.instanceNonce !== this.identity.instanceNonce) {
      throw new Error("Cannot create a run owned by another remote worker instance");
    }
    const directory = this.#runDirectory(capture.runId);
    ensurePrivateRemoteDirectory(directory);
    fsyncDirectory(this.#runsDirectory);
    const metadataPath = path.join(directory, "metadata.json");
    if (fs.existsSync(metadataPath)) throw new Error(`Remote run already exists: ${capture.runId}`);
    const record: RemoteJournalRunRecord = {
      version: REMOTE_JOURNAL_VERSION,
      capture: { ...capture },
      request: { ...request, command: [...request.command] as [string, ...string[]] },
      capabilities: [...capabilities],
      snapshot: createRemoteRunSnapshot(capture, "connecting", now),
      createdAt: now,
      updatedAt: now,
    };
    parseRunRecord(record);
    atomicWriteJson(metadataPath, record);
    return record;
  }

  getRun(runId: string): RemoteJournalRunRecord | undefined {
    const directory = this.#runDirectory(runId);
    try {
      return this.#loadRun(directory, runId, true);
    } catch (error) {
      if (isMissing(error)) return undefined;
      this.#quarantineRun(directory, error);
      return undefined;
    }
  }

  listRuns(monitorOwnerNonce?: string): RemoteJournalRunRecord[] {
    const records: RemoteJournalRunRecord[] = [];
    for (const entry of fs.readdirSync(this.#runsDirectory, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
      const directory = path.join(this.#runsDirectory, entry.name);
      try {
        const record = this.#loadRun(directory, undefined, true);
        if (monitorOwnerNonce === undefined || record.capture.monitorOwnerNonce === monitorOwnerNonce) records.push(record);
      } catch (error) {
        if (!isMissing(error)) this.#quarantineRun(directory, error);
      }
    }
    return records.sort((left, right) => left.createdAt - right.createdAt);
  }

  appendEvent(capture: RemoteRunCapture, event: RemoteRunEvent): RemoteJournalRunRecord {
    const current = this.getRun(capture.runId);
    if (!current || !captureMatches(current.capture, capture)) throw new Error("Remote run ownership capture mismatch");
    const storedEvent = parseEvent(sanitizeEvent(event));
    const nextSnapshot = applyRemoteRunEvent(current.snapshot, storedEvent);
    const runDirectory = this.#runDirectory(capture.runId);
    const eventsPath = path.join(runDirectory, "events.jsonl");
    let currentBytes = 0;
    let existed = true;
    try {
      const stat = fs.lstatSync(eventsPath);
      if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("Invalid remote event journal");
      currentBytes = stat.size;
    } catch (error) {
      if (!isMissing(error)) throw error;
      existed = false;
    }
    const encoded = `${JSON.stringify(storedEvent)}\n`;
    const encodedBytes = Buffer.byteLength(encoded);
    if (encodedBytes > REMOTE_MAX_LINE_BYTES
      || nextSnapshot.lastSequence > REMOTE_MAX_JOURNAL_EVENTS
      || currentBytes + encodedBytes > REMOTE_MAX_JOURNAL_BYTES) {
      throw new Error("Remote run journal limit exceeded");
    }
    const noFollow = isPosix() && "O_NOFOLLOW" in fs.constants ? fs.constants.O_NOFOLLOW : 0;
    const fd = fs.openSync(
      eventsPath,
      fs.constants.O_APPEND | fs.constants.O_CREAT | fs.constants.O_WRONLY | noFollow,
      REMOTE_PRIVATE_FILE_MODE,
    );
    try {
      if (isPosix()) fs.fchmodSync(fd, REMOTE_PRIVATE_FILE_MODE);
      fs.writeFileSync(fd, encoded, "utf8");
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    if (!existed) fsyncDirectory(runDirectory);
    const next = { ...current, snapshot: nextSnapshot, updatedAt: storedEvent.updatedAt };
    atomicWriteJson(path.join(runDirectory, "metadata.json"), next);
    return next;
  }

  readEvents(runId: string, afterSequence = 0): RemoteRunEvent[] {
    if (!Number.isInteger(afterSequence) || afterSequence < 0) throw new Error("Invalid replay sequence");
    const record = this.getRun(runId);
    if (!record) return [];
    return this.#readEvents(this.#runDirectory(runId), record.capture, true)
      .filter((event) => event.sequence > afterSequence);
  }

  getCommand(commandId: string): RemoteStoredCommand | undefined {
    const filePath = this.#commandPath(commandId);
    try {
      const command = parseCommandRecord(readBoundedJson(filePath));
      if (command.commandId !== commandId) throw new Error("Remote command journal hash collision");
      return command;
    } catch (error) {
      if (isMissing(error)) return undefined;
      throw error;
    }
  }

  beginCommand(commandId: string, fingerprint: string, now = Date.now()): RemoteStoredCommand {
    const existing = this.getCommand(commandId);
    if (existing) return existing;
    const command: RemoteStoredCommand = {
      version: REMOTE_JOURNAL_VERSION,
      commandId,
      fingerprint,
      state: "pending",
      createdAt: now,
    };
    parseCommandRecord(command);
    atomicWriteJson(this.#commandPath(commandId), command);
    this.#pruneCommands();
    return command;
  }

  completeCommand(
    commandId: string,
    fingerprint: string,
    outcome: NonNullable<RemoteStoredCommand["outcome"]>,
    now = Date.now(),
  ): RemoteStoredCommand {
    const current = this.getCommand(commandId);
    if (!current || current.fingerprint !== fingerprint) throw new Error("Remote command ownership mismatch");
    const sanitizedOutcome: NonNullable<RemoteStoredCommand["outcome"]> = outcome.ok
      ? { ok: true, result: outcome.result }
      : {
          ok: false,
          code: outcome.code,
          message: redactRemoteError(outcome.message),
          ...(outcome.data === undefined ? {} : { data: sanitizePersistedValue(outcome.data) }),
        };
    const completed: RemoteStoredCommand = { ...current, state: "completed", completedAt: now, outcome: sanitizedOutcome };
    parseCommandRecord(completed);
    atomicWriteJson(this.#commandPath(commandId), completed);
    return completed;
  }

  #runDirectory(runId: string): string {
    return path.join(this.#runsDirectory, storageKey(runId));
  }

  #commandPath(commandId: string): string {
    return path.join(this.#commandsDirectory, `${storageKey(commandId)}.json`);
  }

  #loadRun(directory: string, expectedRunId: string | undefined, repairTail: boolean): RemoteJournalRunRecord {
    try {
      const record = parseRunRecord(readBoundedJson(path.join(directory, "metadata.json"), 2 * 1024 * 1024));
      if ((expectedRunId !== undefined && record.capture.runId !== expectedRunId)
        || path.basename(directory) !== storageKey(record.capture.runId)) {
        throw new Error("Remote run journal hash collision");
      }
      const events = this.#readEvents(directory, record.capture, repairTail);
      let snapshot = createRemoteRunSnapshot(record.capture, "connecting", record.createdAt);
      for (const event of events) snapshot = applyRemoteRunEvent(snapshot, event);
      const updatedAt = events.at(-1)?.updatedAt ?? record.createdAt;
      if (JSON.stringify(snapshot) === JSON.stringify(record.snapshot) && updatedAt === record.updatedAt) return record;
      const reconciled = { ...record, snapshot, updatedAt };
      atomicWriteJson(path.join(directory, "metadata.json"), reconciled);
      return reconciled;
    } catch (error) {
      if (isMissing(error)) {
        try {
          fs.lstatSync(directory);
        } catch (directoryError) {
          if (isMissing(directoryError)) throw error;
          throw new CorruptRunJournalError("Corrupt remote run journal", { cause: directoryError });
        }
      }
      throw new CorruptRunJournalError("Corrupt remote run journal", { cause: error });
    }
  }

  #readEvents(directory: string, capture: RemoteRunCapture, repairTail: boolean): RemoteRunEvent[] {
    const filePath = path.join(directory, "events.jsonl");
    let stat: fs.Stats;
    try {
      stat = fs.lstatSync(filePath);
    } catch (error) {
      if (isMissing(error)) return [];
      throw error;
    }
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > REMOTE_MAX_JOURNAL_BYTES) {
      throw new Error("Invalid remote event journal");
    }
    let raw = fs.readFileSync(filePath);
    if (raw.length > 0 && raw[raw.length - 1] !== 0x0a) {
      if (!repairTail) throw new Error("Incomplete final remote event record");
      const lastNewline = raw.lastIndexOf(0x0a);
      const repairedLength = lastNewline < 0 ? 0 : lastNewline + 1;
      const fd = fs.openSync(filePath, "r+");
      try {
        fs.ftruncateSync(fd, repairedLength);
        fs.fsyncSync(fd);
      } finally {
        fs.closeSync(fd);
      }
      raw = raw.subarray(0, repairedLength);
    }
    const events: RemoteRunEvent[] = [];
    let snapshot = createRemoteRunSnapshot(capture, "connecting", 0);
    for (const line of raw.toString("utf8").split("\n")) {
      if (!line) continue;
      if (Buffer.byteLength(line, "utf8") + 1 > REMOTE_MAX_LINE_BYTES) throw new Error("Remote event journal record is too large");
      const event = parseEvent(JSON.parse(line));
      if (event.workerId !== capture.workerId
        || event.instanceNonce !== capture.instanceNonce
        || event.runId !== capture.runId
        || event.generation !== capture.generation) {
        throw new Error("Remote event journal ownership mismatch");
      }
      snapshot = applyRemoteRunEvent(snapshot, event);
      events.push(event);
    }
    return events;
  }

  #quarantineRun(directory: string, error: unknown): void {
    if (isMissing(error)) return;
    let stat: fs.Stats;
    try {
      stat = fs.lstatSync(directory);
    } catch (statError) {
      if (isMissing(statError)) return;
      throw statError;
    }
    if (!stat.isDirectory() || stat.isSymbolicLink()) return;
    const destination = path.join(
      this.#corruptRunsDirectory,
      `${path.basename(directory)}.${Date.now()}.${randomUUID()}`,
    );
    fs.renameSync(directory, destination);
    fsyncDirectory(this.#runsDirectory);
    fsyncDirectory(this.#corruptRunsDirectory);
  }

  #pruneCommands(): void {
    const files = fs.readdirSync(this.#commandsDirectory, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
      .map((entry) => {
        const filePath = path.join(this.#commandsDirectory, entry.name);
        return { filePath, mtimeMs: fs.statSync(filePath).mtimeMs };
      })
      .sort((left, right) => left.mtimeMs - right.mtimeMs);
    const removed = files.slice(0, Math.max(0, files.length - REMOTE_MAX_COMMAND_RECORDS));
    for (const entry of removed) fs.rmSync(entry.filePath, { force: true });
    if (removed.length > 0) fsyncDirectory(this.#commandsDirectory);
  }

  #markInterruptedRunsLost(): void {
    for (const record of this.listRuns()) {
      if (isRemoteTerminalStatus(record.snapshot.status)) continue;
      const event: RemoteRunEvent = {
        type: "run/result",
        workerId: record.capture.workerId,
        instanceNonce: record.capture.instanceNonce,
        runId: record.capture.runId,
        generation: record.capture.generation,
        sequence: record.snapshot.lastSequence + 1,
        status: "lost",
        updatedAt: Date.now(),
        error: "Remote bridge daemon restarted before the run reached a terminal state",
        degradedReason: "daemon-restarted",
      };
      this.appendEvent(record.capture, event);
    }
  }
}
