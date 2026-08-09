/**
 * Per-workspace input history.
 *
 * The prompt history Pi's editor offers on up/down lives in memory only, so it is
 * gone the moment the session ends. This store mirrors it to
 * `~/.pi/workspaces/<workspace-id>/input-history.json`, keyed by working directory,
 * so a brand new session picks up where the previous one left off.
 */

import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import type { ExtensionContext, ThemeColor } from "@earendil-works/pi-coding-agent";

import { workspaceStorageId } from "../tools/plan-store.ts";
import { HistoryEditor } from "./history-editor.ts";

const FILE_NAME = "input-history.json";
/** Matches the built-in editor's in-memory cap, so the list feels the same. */
const DEFAULT_MAX_ENTRIES = 100;
/** Session restore replays every past prompt; one debounce window collapses it into one write. */
const DEFAULT_SAVE_DEBOUNCE_MS = 250;
const PRIVATE_DIRECTORY_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;

export interface InputHistoryStoreOptions {
  rootDir?: string;
  maxEntries?: number;
  debounceMs?: number;
  onError?: (error: unknown) => void;
}

export class InputHistoryStore {
  readonly filePath: string;
  private readonly dir: string;
  private readonly maxEntries: number;
  private readonly debounceMs: number;
  private readonly onError: ((error: unknown) => void) | undefined;
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
  }

  /** Newest first. */
  list(): readonly string[] {
    return this.entries;
  }

  async load(): Promise<readonly string[]> {
    this.entries = capped(await this.readFromDisk(), this.maxEntries);
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
    this.writes = this.writes
      .then(() => this.save())
      .catch((error: unknown) => {
        this.onError?.(error);
      });
  }

  private async save(): Promise<void> {
    // Another pi window in the same workspace may have written since we loaded;
    // keep whatever it added instead of overwriting it.
    const known = new Set(this.entries);
    const disk = (await this.readFromDisk()).filter((value) => !known.has(value));
    this.entries = capped([...this.entries, ...disk], this.maxEntries);
    await mkdir(this.dir, { recursive: true, mode: PRIVATE_DIRECTORY_MODE });
    const temp = `${this.filePath}.${process.pid}.tmp`;
    try {
      const payload = JSON.stringify({ version: 1, entries: this.entries }, null, 2);
      await writeFile(temp, payload, { mode: PRIVATE_FILE_MODE });
      await rename(temp, this.filePath);
    } catch (error) {
      await rm(temp, { force: true });
      throw error;
    }
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

/** The subset of the extension context this feature touches. */
export type InputHistoryContext = Pick<ExtensionContext, "cwd" | "hasUI"> & {
  ui: Pick<ExtensionContext["ui"], "notify" | "getEditorComponent" | "setEditorComponent" | "theme">;
};

type EditorFactory = Parameters<InputHistoryContext["ui"]["setEditorComponent"]>[0];

export interface InputRouteTarget {
  label: string;
  color: ThemeColor;
  sigil?: "@" | "#";
}

export interface InputHistory {
  onSessionStart(ctx: InputHistoryContext): Promise<void>;
  onSessionShutdown(): Promise<void>;
  setRouteTarget(target: InputRouteTarget | undefined): void;
}

/**
 * One instance per extension load. `storeOptions` exists so tests can point the
 * history somewhere other than the real `~/.pi/workspaces`.
 */
export function createInputHistory(storeOptions: InputHistoryStoreOptions = {}): InputHistory {
  let store: InputHistoryStore | undefined;
  let ourFactory: EditorFactory | undefined;
  let errorReported = false;
  let activeEditor: HistoryEditor | undefined;
  let activeTheme: ExtensionContext["ui"]["theme"] | undefined;
  let routeTarget: InputRouteTarget | undefined;

  const editorRouteTarget = () => routeTarget && activeTheme
    ? {
      label: routeTarget.label,
      sigil: routeTarget.sigil,
      paint: (text: string) => activeTheme!.fg(routeTarget!.color, text),
    }
    : undefined;

  return {
    /** Load this workspace's history, and claim the editor slot whenever it is free. */
    async onSessionStart(ctx: InputHistoryContext): Promise<void> {
      if (!ctx.hasUI) return;
      const next = new InputHistoryStore(ctx.cwd, {
        ...storeOptions,
        onError: (error) => {
          if (errorReported) return;
          errorReported = true;
          ctx.ui.notify(`Input history unavailable: ${errorMessage(error)}`, "warning");
        },
      });
      await next.load();
      activeTheme = ctx.ui.theme;
      // A later session in another cwd gets its own store behind the same editor.
      store = next;
      // pi restores the default editor on every session switch (/new, /resume, /fork,
      // quit-rebind) via resetExtensionUI in teardownCurrent, so a one-shot latch would
      // silently lose the persistent editor after the first switch. Compare the slot
      // identity instead: keep an editor we installed, defer to a foreign one, and
      // re-claim when pi reset the slot to undefined.
      const owner = ctx.ui.getEditorComponent();
      if (ourFactory !== undefined && owner === ourFactory) {
        activeEditor?.refreshRouteTarget();
        return;
      }
      if (owner !== undefined) return;
      ourFactory = (tui, theme, keybindings) => {
        activeEditor = new HistoryEditor(tui, theme, keybindings, {
          getEntries: () => store?.list() ?? [],
          record: (text) => store?.record(text),
          getRouteTarget: editorRouteTarget,
        });
        return activeEditor;
      };
      ctx.ui.setEditorComponent(ourFactory);
    },

    /** Only the pending write has to land; the editor re-claims itself next session start. */
    async onSessionShutdown(): Promise<void> {
      await store?.flush();
      activeEditor = undefined;
      activeTheme = undefined;
      routeTarget = undefined;
    },

    setRouteTarget(target): void {
      routeTarget = target;
      activeEditor?.refreshRouteTarget();
    },
  };
}

/** The instance the extension runs on; `createInputHistory` is the seam tests use. */
const defaultInputHistory = createInputHistory();

export function onSessionStart(ctx: InputHistoryContext): Promise<void> {
  return defaultInputHistory.onSessionStart(ctx);
}

export function setInputRouteTarget(target: InputRouteTarget | undefined): void {
  defaultInputHistory.setRouteTarget(target);
}

export function onSessionShutdown(): Promise<void> {
  return defaultInputHistory.onSessionShutdown();
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
