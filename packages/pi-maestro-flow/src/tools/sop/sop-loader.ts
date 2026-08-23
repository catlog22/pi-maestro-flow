/**
 * SOP loader — discovers SOP documents from the knowhow directory.
 *
 * A knowhow file is treated as a SOP document when its frontmatter carries a
 * non-empty `sop_topic` (kebab-case topic id) and a `tools` array naming at
 * least one pi tool. The loader scans `.workflow/knowhow/*.md` (project) and an
 * optional global dir, parses frontmatter, and returns {@link SopDoc}s.
 *
 * Design mirrors `skills/skill-loader.ts`: a stat-based version key
 * (`path\0size\0mtimeNs`) backs a bounded raw cache so repeated `guide` calls
 * do not re-read unchanged files. The loader is read-only and never writes;
 * SOP updates flow through `maestro knowledge stage → review → promote`.
 */

import { createHash } from "node:crypto";
import { readFile, readdir, stat } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { parseFrontmatter } from "@earendil-works/pi-coding-agent";
import { SkillCache } from "../../skills/skill-cache.ts";
import type {
  SopDoc,
  SopFrontmatter,
  SopLoaderOptions,
  SopSource,
} from "./sop-types.ts";

const DEFAULT_MAX_FILE_BYTES = 256 * 1024;
const DEFAULT_MAX_FILES_PER_DIR = 500;
const DEFAULT_CACHE_ENTRIES = 128;
const DEFAULT_CACHE_BYTES = 4 * 1024 * 1024;

/** Parsed raw file snapshot cached by stat version key. */
interface RawSnapshot {
  readonly filePath: string;
  readonly content: string;
  readonly contentHash: string;
  readonly bytes: number;
}

export type SopLoadErrorCode = "E_SOP_READ_FAILED" | "E_SOP_FILE_TOO_LARGE" | "E_SOP_TOO_MANY_FILES";

export class SopLoadError extends Error {
  readonly code: SopLoadErrorCode;
  constructor(code: SopLoadErrorCode, message: string) {
    super(`${code}: ${message}`);
    this.name = "SopLoadError";
    this.code = code;
  }
}

export class SopLoader {
  private readonly cwd: string;
  private readonly globalDir: string | undefined;
  private readonly maxFileBytes: number;
  private readonly maxFilesPerDir: number;
  private readonly rawCache: SkillCache<RawSnapshot>;

  constructor(options: SopLoaderOptions) {
    this.cwd = options.cwd;
    this.globalDir = options.globalDir;
    this.maxFileBytes = options.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES;
    this.maxFilesPerDir = options.maxFilesPerDir ?? DEFAULT_MAX_FILES_PER_DIR;
    this.rawCache = new SkillCache(DEFAULT_CACHE_ENTRIES, {
      maxWeight: DEFAULT_CACHE_BYTES,
      measure: (snapshot) => snapshot.bytes,
    });
  }

  /**
   * Scan project (+ optional global) knowhow dirs and return every SOP document.
   * Files without `sop_topic` + `tools` are skipped silently (they are regular
   * knowhow entries, not SOPs). Read failures are skipped with the error
   * swallowed: a single corrupt file must not break the whole registry.
   */
  async loadAll(): Promise<SopDoc[]> {
    const dirs = this.scanDirs();
    const docs: SopDoc[] = [];
    for (const dir of dirs) {
      const files = await this.listKnowhowFiles(dir);
      for (const file of files) {
        const doc = await this.loadFile(file, "knowhow").catch(() => undefined);
        if (doc) docs.push(doc);
      }
    }
    return docs;
  }

  /**
   * Load a single knowhow file as a SOP document. Returns undefined when the
   * file lacks `sop_topic` + `tools` (not a SOP) or fails frontmatter
   * validation. Throws {@link SopLoadError} only for unreadable/oversized
   * files; callers decide whether to swallow.
   */
  async loadFile(filePath: string, source: SopSource = "knowhow"): Promise<SopDoc | undefined> {
    const snapshot = await this.readRaw(filePath);
    const { frontmatter, body } = parseFrontmatter<SopFrontmatter>(snapshot.content);
    const tools = parseToolsField(frontmatter.tools);
    if (tools.length === 0) return undefined;
    const topic = parseTopicField(frontmatter.sop_topic);
    if (!topic) return undefined;
    const title = parseTitleField(frontmatter.title, filePath);
    const order = parseOrderField(frontmatter.sop_order);
    const tool = tools[0];
    return Object.freeze({
      tool,
      topic,
      title,
      body: body.replace(/^\r?\n(?:\r?\n)?/, ""),
      order,
      source,
      filePath,
      contentHash: snapshot.contentHash,
    });
  }

  /** Drop the raw cache (used on explicit refresh / session boundary). */
  clearCache(): void {
    this.rawCache.clear();
  }

  /** Raw cache stats for diagnostics. */
  get cacheStats(): Readonly<{ size: number; hits: number; misses: number }> {
    const s = this.rawCache.stats();
    return Object.freeze({ size: s.size, hits: s.hits, misses: s.misses });
  }

  private scanDirs(): string[] {
    const dirs = [resolve(this.cwd, ".workflow", "knowhow")];
    if (this.globalDir) dirs.push(resolve(this.globalDir));
    return dirs;
  }

  private async listKnowhowFiles(dir: string): Promise<string[]> {
    let names: string[];
    try {
      names = await readdir(dir);
    } catch {
      return [];
    }
    const mdFiles = names.filter((name) => name.endsWith(".md"));
    if (mdFiles.length > this.maxFilesPerDir) {
      throw new SopLoadError(
        "E_SOP_TOO_MANY_FILES",
        `${dir} has ${mdFiles.length} .md files (limit ${this.maxFilesPerDir})`,
      );
    }
    return mdFiles.map((name) => join(dir, name));
  }

  private async readRaw(filePath: string): Promise<RawSnapshot> {
    let versionKey: string;
    try {
      const metadata = await stat(filePath, { bigint: true });
      versionKey = `${filePath}\0${metadata.size}\0${metadata.mtimeNs}`;
    } catch (error) {
      throw new SopLoadError(
        "E_SOP_READ_FAILED",
        `could not stat "${filePath}": ${errorMessage(error)}`,
      );
    }
    const cached = this.rawCache.get(versionKey);
    if (cached) return cached;
    let content: string;
    try {
      content = await readFile(filePath, "utf-8");
    } catch (error) {
      throw new SopLoadError(
        "E_SOP_READ_FAILED",
        `could not read "${filePath}": ${errorMessage(error)}`,
      );
    }
    const bytes = Buffer.byteLength(content, "utf-8");
    if (bytes > this.maxFileBytes) {
      throw new SopLoadError(
        "E_SOP_FILE_TOO_LARGE",
        `"${filePath}" is ${bytes} bytes (limit ${this.maxFileBytes})`,
      );
    }
    const snapshot = Object.freeze({
      filePath,
      content,
      contentHash: sha256Hex(content),
      bytes,
    });
    this.rawCache.set(versionKey, snapshot);
    return snapshot;
  }
}

/** Resolve a possibly-relative path against the loader cwd (for test injection). */
export function resolveKnowhowPath(raw: string, cwd: string): string {
  if (isAbsolute(raw)) return raw;
  return resolve(cwd, raw);
}

// ---------------------------------------------------------------------------
// Frontmatter field parsers (lenient: unknown shapes skip the file, never throw)
// ---------------------------------------------------------------------------

function parseToolsField(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value
      .map((entry) => (typeof entry === "string" ? entry.trim() : ""))
      .filter((entry) => entry.length > 0);
  }
  if (typeof value === "string" && value.trim()) {
    // YAML inline flow `tools: browser` (single string) — tolerate it.
    return [value.trim()];
  }
  return [];
}

function parseTopicField(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  return trimmed;
}

function parseTitleField(value: unknown, filePath: string): string {
  if (typeof value === "string" && value.trim()) return value.trim();
  // Fall back to the filename stem so the index still has something to show.
  const base = filePath.replace(/[\\/]/g, "/").split("/").pop() ?? filePath;
  return base.replace(/\.md$/i, "");
}

function parseOrderField(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number.parseFloat(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return 0;
}

function sha256Hex(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
