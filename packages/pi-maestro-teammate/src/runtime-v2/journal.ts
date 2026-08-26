import { createHash, randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  RUNTIME_V2_REVISION,
  RUNTIME_V2_VERSION,
  type RuntimeEventDraftV2,
  type RuntimeEventV2,
} from "./contracts.ts";
import { normalizePersistedRuntimeEventV2, parseRuntimeEventV2 } from "./validation.ts";

export const RUNTIME_V2_MAX_EVENTS = 50_000;
export const RUNTIME_V2_MAX_STREAM_BYTES = 64 * 1024 * 1024;
export const RUNTIME_V2_MAX_LINE_BYTES = 1024 * 1024;
const PRIVATE_DIRECTORY_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;

export interface RuntimeV2JournalMetadata {
  version: typeof RUNTIME_V2_VERSION;
  revision: typeof RUNTIME_V2_REVISION;
  streamId: string;
  /** Immutable owner derived from the first Runtime event. Absent only on legacy empty streams. */
  workspaceId?: string;
  eventCount: number;
  lastSequence: number;
  eventsBytes: number;
  updatedAt: number;
}

export interface RuntimeV2JournalStream {
  metadata: RuntimeV2JournalMetadata;
  events: RuntimeEventV2[];
}

export interface RuntimeV2ShadowJournalOptions {
  maxEvents?: number;
  maxBytes?: number;
  maxLineBytes?: number;
  onQuarantine?: (directory: string, error: unknown) => void;
}

export interface RuntimeV2JournalListOptions {
  workspaceId: string;
  prefix: string;
  afterStreamId?: string;
  limit: number;
}

export class RuntimeV2JournalCorruptionError extends Error {
  constructor(
    readonly streamId: string,
    readonly directory: string,
    options?: { cause?: unknown },
  ) {
    super(`Runtime V2 journal stream is quarantined as corrupt: ${streamId}`, options);
    this.name = "RuntimeV2JournalCorruptionError";
  }
}

function isMissing(error: unknown): boolean {
  return error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT";
}

function ensureDirectory(directory: string): void {
  fs.mkdirSync(directory, { recursive: true, mode: PRIVATE_DIRECTORY_MODE });
  const stat = fs.lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`Invalid Runtime V2 journal directory: ${directory}`);
  if (process.platform !== "win32") fs.chmodSync(directory, PRIVATE_DIRECTORY_MODE);
}

function fsyncDirectory(directory: string): void {
  if (process.platform === "win32") return;
  const fd = fs.openSync(directory, "r");
  try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}

function atomicWriteJson(filePath: string, value: unknown): void {
  const directory = path.dirname(filePath);
  const temporary = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  let fd: number | undefined;
  try {
    fd = fs.openSync(temporary, "wx", PRIVATE_FILE_MODE);
    fs.writeFileSync(fd, `${JSON.stringify(value)}\n`, "utf8");
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;
    fs.renameSync(temporary, filePath);
    if (process.platform !== "win32") fs.chmodSync(filePath, PRIVATE_FILE_MODE);
    fsyncDirectory(directory);
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
    fs.rmSync(temporary, { force: true });
  }
}

function storageKey(streamId: string): string {
  return createHash("sha256").update(streamId).digest("hex");
}

function integer(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) throw new Error(`Invalid ${label}`);
  return value as number;
}

function parseMetadata(value: unknown): RuntimeV2JournalMetadata {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid Runtime V2 journal metadata");
  const input = value as Record<string, unknown>;
  const version = input.version === "2" ? 2 : input.version;
  const revision = input.revision ?? RUNTIME_V2_REVISION;
  if (version !== RUNTIME_V2_VERSION || revision !== RUNTIME_V2_REVISION || typeof input.streamId !== "string" || !input.streamId) {
    throw new Error("Unsupported Runtime V2 journal metadata");
  }
  return {
    version: RUNTIME_V2_VERSION,
    revision: RUNTIME_V2_REVISION,
    streamId: input.streamId,
    ...(input.workspaceId === undefined ? {} : { workspaceId: metadataWorkspaceId(input.workspaceId) }),
    eventCount: integer(input.eventCount, "Runtime V2 eventCount"),
    lastSequence: integer(input.lastSequence, "Runtime V2 lastSequence"),
    eventsBytes: integer(input.eventsBytes, "Runtime V2 eventsBytes"),
    updatedAt: integer(input.updatedAt, "Runtime V2 updatedAt"),
  };
}

function metadataWorkspaceId(value: unknown): string {
  if (typeof value !== "string" || !value || value.includes("\0") || Buffer.byteLength(value, "utf8") > 1024) {
    throw new Error("Invalid Runtime V2 journal workspaceId");
  }
  return value;
}

export class RuntimeV2ShadowJournal {
  readonly rootDirectory: string;
  readonly #streamsDirectory: string;
  readonly #corruptDirectory: string;
  readonly #maxEvents: number;
  readonly #maxBytes: number;
  readonly #maxLineBytes: number;
  readonly #onQuarantine: RuntimeV2ShadowJournalOptions["onQuarantine"];

  constructor(rootDirectory: string, options: RuntimeV2ShadowJournalOptions = {}) {
    this.rootDirectory = path.resolve(rootDirectory);
    this.#streamsDirectory = path.join(this.rootDirectory, "streams");
    this.#corruptDirectory = path.join(this.rootDirectory, "corrupt-streams");
    this.#maxEvents = options.maxEvents ?? RUNTIME_V2_MAX_EVENTS;
    this.#maxBytes = options.maxBytes ?? RUNTIME_V2_MAX_STREAM_BYTES;
    this.#maxLineBytes = options.maxLineBytes ?? RUNTIME_V2_MAX_LINE_BYTES;
    this.#onQuarantine = options.onQuarantine;
    for (const [value, label] of [[this.#maxEvents, "events"], [this.#maxBytes, "bytes"], [this.#maxLineBytes, "line bytes"]] as const) {
      if (!Number.isSafeInteger(value) || value < 1) throw new Error(`Runtime V2 maximum ${label} must be positive`);
    }
    ensureDirectory(this.rootDirectory);
    ensureDirectory(this.#streamsDirectory);
    ensureDirectory(this.#corruptDirectory);
    fsyncDirectory(this.rootDirectory);
  }

  append(draft: RuntimeEventDraftV2): RuntimeEventV2 {
    const streamId = typeof draft.streamId === "string" ? draft.streamId : "";
    if (!streamId) throw new Error("Runtime V2 event streamId is required");
    const directory = this.#streamDirectory(streamId);
    this.#throwIfQuarantined(streamId, directory);
    let stream: RuntimeV2JournalStream;
    if (fs.existsSync(directory)) {
      try {
        stream = this.#load(directory, streamId, true);
      } catch (error) {
        throw this.#quarantine(streamId, directory, error);
      }
    } else {
      ensureDirectory(directory);
      fsyncDirectory(this.#streamsDirectory);
      stream = {
        metadata: {
          version: RUNTIME_V2_VERSION,
          revision: RUNTIME_V2_REVISION,
          streamId,
          eventCount: 0,
          lastSequence: 0,
          eventsBytes: 0,
          updatedAt: 0,
        },
        events: [],
      };
      atomicWriteJson(path.join(directory, "metadata.json"), stream.metadata);
    }

    const event = parseRuntimeEventV2({
      ...draft,
      producerEpoch: "producerEpoch" in draft ? draft.producerEpoch : draft.actor.generation,
      sequence: stream.metadata.lastSequence + 1,
    });
    if (stream.metadata.workspaceId !== undefined && stream.metadata.workspaceId !== event.actor.workspaceId) {
      throw new Error("Runtime V2 stream workspace owner mismatch");
    }
    const encoded = `${JSON.stringify(event)}\n`;
    const encodedBytes = Buffer.byteLength(encoded, "utf8");
    if (encodedBytes > this.#maxLineBytes
      || stream.metadata.eventCount + 1 > this.#maxEvents
      || stream.metadata.eventsBytes + encodedBytes > this.#maxBytes) {
      throw new Error("Runtime V2 shadow journal limit exceeded");
    }

    const eventsPath = path.join(directory, "events.jsonl");
    const existed = fs.existsSync(eventsPath);
    const noFollow = process.platform !== "win32" && "O_NOFOLLOW" in fs.constants ? fs.constants.O_NOFOLLOW : 0;
    const fd = fs.openSync(eventsPath, fs.constants.O_APPEND | fs.constants.O_CREAT | fs.constants.O_WRONLY | noFollow, PRIVATE_FILE_MODE);
    try {
      if (process.platform !== "win32") fs.fchmodSync(fd, PRIVATE_FILE_MODE);
      fs.writeFileSync(fd, encoded, "utf8");
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    if (!existed) fsyncDirectory(directory);
    const metadata: RuntimeV2JournalMetadata = {
      version: RUNTIME_V2_VERSION,
      revision: RUNTIME_V2_REVISION,
      streamId,
      workspaceId: stream.metadata.workspaceId ?? event.actor.workspaceId,
      eventCount: stream.metadata.eventCount + 1,
      lastSequence: event.sequence,
      eventsBytes: stream.metadata.eventsBytes + encodedBytes,
      updatedAt: event.occurredAt,
    };
    atomicWriteJson(path.join(directory, "metadata.json"), metadata);
    return event;
  }

  read(streamId: string): RuntimeV2JournalStream | undefined {
    const directory = this.#streamDirectory(streamId);
    this.#throwIfQuarantined(streamId, directory);
    if (!fs.existsSync(directory)) return undefined;
    try {
      return this.#load(directory, streamId, true);
    } catch (error) {
      throw this.#quarantine(streamId, directory, error);
    }
  }

  replay(streamId: string, afterSequence = 0): RuntimeEventV2[] {
    if (!Number.isSafeInteger(afterSequence) || afterSequence < 0) throw new Error("Invalid Runtime V2 replay sequence");
    return this.read(streamId)?.events.filter((event) => event.sequence > afterSequence) ?? [];
  }

  listStreams(options: RuntimeV2JournalListOptions): string[] {
    if (!options.workspaceId || !options.prefix || options.workspaceId.includes("\0") || options.prefix.includes("\0")) {
      throw new Error("Invalid Runtime V2 journal stream query");
    }
    const afterStreamId = options.afterStreamId ?? "";
    if (afterStreamId.includes("\0") || !Number.isSafeInteger(options.limit) || options.limit < 1 || options.limit > 512) {
      throw new Error("Invalid Runtime V2 journal stream page");
    }
    this.#throwOnQuarantinedList(options.prefix);
    const streamIds: string[] = [];
    const directory = fs.opendirSync(this.#streamsDirectory);
    let scanned = 0;
    try {
      for (let entry = directory.readSync(); entry; entry = directory.readSync()) {
        scanned += 1;
        if (scanned > RUNTIME_V2_MAX_EVENTS) throw new Error("Runtime V2 journal stream listing limit exceeded");
        if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
        const streamDirectory = path.join(this.#streamsDirectory, entry.name);
        let streamId = `corrupt:${entry.name}`;
        try {
          const metadataPath = path.join(streamDirectory, "metadata.json");
          const stat = fs.lstatSync(metadataPath);
          if (!stat.isFile() || stat.isSymbolicLink() || stat.size > this.#maxLineBytes) {
            throw new Error("Invalid Runtime V2 metadata file");
          }
          const metadata = parseMetadata(JSON.parse(fs.readFileSync(metadataPath, "utf8")));
          streamId = metadata.streamId;
          if (metadata.streamId <= afterStreamId || !metadata.streamId.startsWith(options.prefix)) continue;
          const stream = this.#load(streamDirectory, metadata.streamId, true);
          if (stream.metadata.workspaceId === options.workspaceId) streamIds.push(metadata.streamId);
        } catch (error) {
          throw this.#quarantine(streamId, streamDirectory, error);
        }
      }
    } finally {
      directory.closeSync();
    }
    return streamIds.sort().slice(0, options.limit);
  }

  #streamDirectory(streamId: string): string {
    if (!streamId || streamId.includes("\0") || Buffer.byteLength(streamId, "utf8") > 1024) throw new Error("Invalid Runtime V2 streamId");
    return path.join(this.#streamsDirectory, storageKey(streamId));
  }

  #load(directory: string, streamId: string, repairTail: boolean): RuntimeV2JournalStream {
    const directoryStat = fs.lstatSync(directory);
    if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()) throw new Error("Invalid Runtime V2 stream directory");
    const metadataPath = path.join(directory, "metadata.json");
    const metadataStat = fs.lstatSync(metadataPath);
    if (!metadataStat.isFile() || metadataStat.isSymbolicLink() || metadataStat.size > this.#maxLineBytes) throw new Error("Invalid Runtime V2 metadata file");
    const metadata = parseMetadata(JSON.parse(fs.readFileSync(metadataPath, "utf8")));
    if (metadata.streamId !== streamId || path.basename(directory) !== storageKey(streamId)) throw new Error("Runtime V2 stream identity mismatch");

    const eventsPath = path.join(directory, "events.jsonl");
    let raw = Buffer.alloc(0);
    try {
      const stat = fs.lstatSync(eventsPath);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > this.#maxBytes) throw new Error("Invalid Runtime V2 event journal");
      raw = fs.readFileSync(eventsPath);
    } catch (error) {
      if (!isMissing(error)) throw error;
    }
    if (raw.length > 0 && raw[raw.length - 1] !== 0x0a) {
      if (!repairTail) throw new Error("Incomplete Runtime V2 event tail");
      const newline = raw.lastIndexOf(0x0a);
      const repairedLength = newline < 0 ? 0 : newline + 1;
      const fd = fs.openSync(eventsPath, "r+");
      try {
        fs.ftruncateSync(fd, repairedLength);
        fs.fsyncSync(fd);
      } finally {
        fs.closeSync(fd);
      }
      raw = raw.subarray(0, repairedLength);
    }

    const events: RuntimeEventV2[] = [];
    let workspaceId = metadata.workspaceId;
    for (const line of raw.toString("utf8").split("\n")) {
      if (!line) continue;
      if (Buffer.byteLength(line, "utf8") + 1 > this.#maxLineBytes) throw new Error("Runtime V2 event record is too large");
      const event = normalizePersistedRuntimeEventV2(JSON.parse(line));
      if (event.streamId !== streamId || event.sequence !== events.length + 1) throw new Error("Runtime V2 event sequence or identity mismatch");
      workspaceId ??= event.actor.workspaceId;
      if (event.actor.workspaceId !== workspaceId) throw new Error("Runtime V2 stream workspace owner mismatch");
      events.push(event);
    }
    const last = events.at(-1);
    const reconciled: RuntimeV2JournalMetadata = {
      version: RUNTIME_V2_VERSION,
      revision: RUNTIME_V2_REVISION,
      streamId,
      ...(workspaceId === undefined ? {} : { workspaceId }),
      eventCount: events.length,
      lastSequence: last?.sequence ?? 0,
      eventsBytes: raw.length,
      updatedAt: last?.occurredAt ?? 0,
    };
    if (JSON.stringify(metadata) !== JSON.stringify(reconciled)) atomicWriteJson(metadataPath, reconciled);
    return { metadata: reconciled, events };
  }

  #throwOnQuarantinedList(prefix: string): void {
    const directory = fs.opendirSync(this.#corruptDirectory);
    let scanned = 0;
    try {
      for (let entry = directory.readSync(); entry; entry = directory.readSync()) {
        if (!entry.name.endsWith(".json")) continue;
        scanned += 1;
        if (scanned > RUNTIME_V2_MAX_EVENTS) throw new Error("Runtime V2 corruption marker listing limit exceeded");
        const marker = path.join(this.#corruptDirectory, entry.name);
        const streamDirectory = path.join(this.#streamsDirectory, entry.name.slice(0, -".json".length));
        try {
          const stat = fs.lstatSync(marker);
          if (!stat.isFile() || stat.isSymbolicLink() || stat.size > this.#maxLineBytes) {
            throw new Error("Invalid Runtime V2 corruption marker");
          }
          const value = JSON.parse(fs.readFileSync(marker, "utf8")) as { streamId?: unknown };
          if (typeof value.streamId !== "string" || !value.streamId) {
            throw new Error("Invalid Runtime V2 corruption marker identity");
          }
          if (entry.name !== `${storageKey(value.streamId)}.json`) {
            throw new Error("Runtime V2 corruption marker filename identity mismatch");
          }
          if (value.streamId.startsWith("corrupt:") || value.streamId.startsWith(prefix)) {
            throw new RuntimeV2JournalCorruptionError(value.streamId, streamDirectory);
          }
        } catch (error) {
          if (error instanceof RuntimeV2JournalCorruptionError) throw error;
          throw new RuntimeV2JournalCorruptionError(`corrupt:${entry.name}`, streamDirectory, { cause: error });
        }
      }
    } finally {
      directory.closeSync();
    }
  }

  #throwIfQuarantined(streamId: string, directory: string): void {
    const marker = this.#quarantineMarker(directory);
    let stat: fs.Stats;
    try {
      stat = fs.lstatSync(marker);
    } catch (error) {
      if (isMissing(error)) return;
      throw error;
    }
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > this.#maxLineBytes) {
      throw new RuntimeV2JournalCorruptionError(streamId, directory, {
        cause: new Error("Invalid Runtime V2 corruption marker"),
      });
    }
    try {
      const value = JSON.parse(fs.readFileSync(marker, "utf8")) as { streamId?: unknown };
      if (value.streamId !== streamId) throw new Error("Runtime V2 corruption marker identity mismatch");
    } catch (error) {
      throw new RuntimeV2JournalCorruptionError(streamId, directory, { cause: error });
    }
    throw new RuntimeV2JournalCorruptionError(streamId, directory);
  }

  #quarantine(streamId: string, directory: string, error: unknown): RuntimeV2JournalCorruptionError {
    const marker = this.#quarantineMarker(directory);
    try {
      atomicWriteJson(marker, {
        version: RUNTIME_V2_VERSION,
        revision: RUNTIME_V2_REVISION,
        streamId,
        quarantinedAt: Date.now(),
      });
      let stat: fs.Stats;
      try {
        stat = fs.lstatSync(directory);
      } catch (statError) {
        if (!isMissing(statError)) throw statError;
        return new RuntimeV2JournalCorruptionError(streamId, directory, { cause: error });
      }
      if (!stat.isDirectory() || stat.isSymbolicLink()) {
        return new RuntimeV2JournalCorruptionError(streamId, directory, { cause: error });
      }
      const destination = path.join(this.#corruptDirectory, `${path.basename(directory)}.${Date.now()}.${randomUUID()}`);
      fs.renameSync(directory, destination);
      fsyncDirectory(this.#streamsDirectory);
      fsyncDirectory(this.#corruptDirectory);
      try { this.#onQuarantine?.(directory, error); } catch {}
      return new RuntimeV2JournalCorruptionError(streamId, destination, { cause: error });
    } catch (quarantineError) {
      return new RuntimeV2JournalCorruptionError(streamId, directory, { cause: quarantineError });
    }
  }

  #quarantineMarker(directory: string): string {
    return path.join(this.#corruptDirectory, `${path.basename(directory)}.json`);
  }

}
