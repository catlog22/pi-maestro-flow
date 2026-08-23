/**
 * SOP loader types.
 *
 * A SOP document is a knowhow entry (`.workflow/knowhow/*.md`) whose frontmatter
 * carries `sop_topic` + `tools`, marking it as a Standard Operating Procedure
 * that the loader can attach to a pi tool's `guide` action. The loader reads
 * the knowhow directory; embedded baselines (the former hardcoded
 * `BROWSER_SOPS` / `COMPUTER_USE_SOPS`) are the zero-dependency fallback so a
 * missing or empty knowhow directory still serves SOPs.
 */

/** Source of a resolved SOP document. */
export type SopSource = "embedded" | "knowhow";

/**
 * A single resolved SOP document, already normalized from either an embedded
 * baseline constant or a parsed knowhow frontmatter + body.
 */
export interface SopDoc {
  /** Pi tool name this SOP attaches to (`browser`, `computer_use`, ...). */
  readonly tool: string;
  /** SOP topic id (the `guide { topic }` value). kebab-case. */
  readonly topic: string;
  /** Human-readable title shown in the guide index. */
  readonly title: string;
  /** Document body (markdown). */
  readonly body: string;
  /** `sop_order` from frontmatter (default 0); higher wins on merge. */
  readonly order: number;
  /** Where this document came from. */
  readonly source: SopSource;
  /** Knowhow source file (absolute); undefined for embedded baseline. */
  readonly filePath?: string;
  /** sha256 of the parsed body; used as a cache/version key. */
  readonly contentHash: string;
}

/** Raw shape of an embedded baseline entry (mirrors the former BROWSER_SOPS). */
export interface EmbeddedSopEntry {
  readonly title: string;
  readonly body: string;
}

/** Map of topic -> embedded baseline entry. */
export type EmbeddedSopMap = Record<string, EmbeddedSopEntry>;

/**
 * Frontmatter fields a knowhow SOP document may carry. The open
 * `Record<string, unknown>` base keeps unknown fields visible (the knowhow
 * parser already returns an open record); these typed accessors are the only
 * fields the loader consults.
 */
export interface SopFrontmatter extends Record<string, unknown> {
  readonly title?: unknown;
  readonly type?: unknown;
  readonly category?: unknown;
  readonly tools?: unknown;
  readonly sop_topic?: unknown;
  readonly sop_order?: unknown;
}

/** Options for {@link SopLoader.loadAll}. */
export interface SopLoaderOptions {
  /** Project root containing `.workflow/knowhow/`. */
  readonly cwd: string;
  /** Optional global knowhow dir (e.g. `~/.maestro/knowhow`); read-only. */
  readonly globalDir?: string;
  /** Max bytes per single knowhow file (default 256 KiB). */
  readonly maxFileBytes?: number;
  /** Max knowhow files scanned per directory (default 500). */
  readonly maxFilesPerDir?: number;
}
