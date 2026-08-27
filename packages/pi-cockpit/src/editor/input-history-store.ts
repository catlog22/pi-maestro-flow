/**
 * Per-workspace input history, owned by Cockpit's unified editor.
 *
 * The prompt history Pi's editor offers on up/down lives in memory only, so it is
 * gone the moment the session ends. This store mirrors it to
 * `~/.pi/workspaces/<workspace-id>/input-history.json`, keyed by working directory,
 * so a brand new session picks up where the previous one left off.
 */

import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";

const FILE_NAME = "input-history.json";
/** Matches the built-in editor's in-memory cap, so the list feels the same. */
const DEFAULT_MAX_ENTRIES = 100;
/** Session restore replays every past prompt; one debounce window collapses it into one write. */
const DEFAULT_SAVE_DEBOUNCE_MS = 250;
const PRIVATE_DIRECTORY_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;
const DEFAULT_SAVE_RETRY_DELAYS_MS = Object.freeze([25, 75, 150]);

type RenameFile = (oldPath: string, newPath: string) => Promise<void>;

/**
 * Serializes every save across store instances so a fresh store's load() never
 * races an older store's pending flush (reload/new/resume in the same process):
 * the next load waits for the previous store's save to land before reading.
 */
let pendingWrites: Promise<void> = Promise.resolve();

export interface InputHistoryStoreOptions {
  rootDir?: string;
  maxEntries?: number;
  debounceMs?: number;
  onError?: (error: unknown) => void;
  renameFile?: RenameFile;
  retryDelaysMs?: readonly number[];
}

/**
 * Stable per-workspace storage id, byte-identical to the historical
 * pi-maestro-flow implementation so persisted history keeps resolving to the
 * same file across the module move.
 */
export function workspaceStorageId(cwd: string): string {
  const normalized = normalizeWorkspacePath(cwd);
  const slug = basename(resolve(cwd))
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "") || "workspace";
  return `${slug}-${createHash("sha256").update(normalized).digest("hex").slice(0, 8)}`;
}

function normalizeWorkspacePath(cwd: string): string {
  const normalized = resolve(cwd).replaceAll("\\", "/").replace(/\/$/, "");
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

export class InputHistoryStore {
  readonly filePath: string;
  private readonly dir: string;
  private readonly maxEntries: number;
  private readonly debounceMs: number;
  private readonly onError: ((error: unknown) => void) | undefined;
  private readonly renameFile: RenameFile;
  private readonly retryDelaysMs: readonly number[];
  private entries: string[] = [];
  private timer: NodeJS.Timeout | undefined;
  private writes: Promise<void> = Promise.resolve();

  constructor(cwd: string, options: InputHistoryStoreOptions = {}) {
    const rootDir = options.rootDir ?? join(homedir(), ".pi", "workspaces");
    this.dir = join(rootDir, workspaceStorageId(cwd));
    this.filePath = join(this.dir, FILE_NAME);
    this.maxEntries = Math.max(1, options.maxEntries ?? DEFAULT_MAX_ENTRIES);
    this.debounceMs = Math.max(0, options.debounceMs ?? DEFAULT_SAVE_DEBOUNCE_MS);
    this.onError = options.onError;
    this.renameFile = options.renameFile ?? rename;
    this.retryDelaysMs = retryDelays(options.retryDelaysMs);
  }

  /** Newest first. */
  list(): readonly string[] {
    return this.entries;
  }

  async load(): Promise<readonly string[]> {
    // Let any older store's pending save land first, so a session that starts
    // right after a shutdown sees the previous session's last prompt.
    await pendingWrites;
    const disk = await this.readFromDisk();
    // Entries recorded before the first load settled (an immediate submit right
    // after startup) must survive: keep them ahead of the disk entries.
    const known = new Set(this.entries);
    this.entries = capped([...this.entries, ...disk.filter((value) => !known.has(value))], this.maxEntries);
    return this.entries;
  }

  /** Move `text` to the front of the history and schedule a save. */
  record(text: string): void {
    const entry = text.trim();
    if (!entry || this.entries[0] === entry) return;
    this.entries = capped([entry, ...this.entries.filter((value) => value !== entry)], this.maxEntries);
    this.schedule();
  }

  /** Run any pending save now and wait for every outstanding write. */
  async flush(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
      this.enqueueSave();
    }
    await this.writes;
  }

  private schedule(): void {
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.enqueueSave();
    }, this.debounceMs);
  }

  private enqueueSave(): void {
    const save = pendingWrites.then(() => this.save());
    pendingWrites = save.catch(() => undefined);
    this.writes = save.catch((error: unknown) => {
      this.onError?.(error);
    });
  }

  private async save(): Promise<void> {
    await mkdir(this.dir, { recursive: true, mode: PRIVATE_DIRECTORY_MODE });
    for (let attempt = 0; ; attempt += 1) {
      await this.mergeDiskEntries();
      const temp = `${this.filePath}.${process.pid}.${randomUUID()}.tmp`;
      try {
        const payload = JSON.stringify({ version: 1, entries: this.entries }, null, 2);
        await writeFile(temp, payload, { mode: PRIVATE_FILE_MODE, flag: "wx" });
        await this.renameFile(temp, this.filePath);
        return;
      } catch (error) {
        await rm(temp, { force: true }).catch(() => undefined);
        const retryDelay = this.retryDelaysMs[attempt];
        if (retryDelay === undefined || !isTransientReplaceError(error)) throw error;
        await delay(retryDelay);
      }
    }
  }

  private async mergeDiskEntries(): Promise<void> {
    // Another pi window in the same workspace may have written since we loaded;
    // keep whatever it added instead of overwriting it.
    const known = new Set(this.entries);
    const disk = (await this.readFromDisk()).filter((value) => !known.has(value));
    this.entries = capped([...this.entries, ...disk], this.maxEntries);
  }

  private async readFromDisk(): Promise<string[]> {
    try {
      return parseEntries(JSON.parse(await readFile(this.filePath, "utf8")) as unknown);
    } catch (error) {
      // No history yet is the normal first-run state, not a failure.
      if ((error as NodeJS.ErrnoException | null)?.code === "ENOENT") return [];
      this.onError?.(error);
      return [];
    }
  }
}

function parseEntries(raw: unknown): string[] {
  const list = (raw as { entries?: unknown } | null)?.entries;
  if (!Array.isArray(list)) return [];
  const seen = new Set<string>();
  const entries: string[] = [];
  for (const value of list) {
    if (typeof value !== "string") continue;
    const entry = value.trim();
    if (!entry || seen.has(entry)) continue;
    seen.add(entry);
    entries.push(entry);
  }
  return entries;
}

function capped(entries: string[], maxEntries: number): string[] {
  return entries.length > maxEntries ? entries.slice(0, maxEntries) : entries;
}

function retryDelays(value: readonly number[] | undefined): readonly number[] {
  const source = value ?? DEFAULT_SAVE_RETRY_DELAYS_MS;
  return Object.freeze(source.map((delayMs) => Math.max(0, delayMs)).filter(Number.isFinite));
}

function isTransientReplaceError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | null)?.code;
  return code === "EPERM" || code === "EBUSY" || code === "EACCES";
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
