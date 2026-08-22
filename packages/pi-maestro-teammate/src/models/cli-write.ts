import * as fs from "node:fs";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { parseModelRegistryManifest } from "./model-registry.ts";
import { redactText } from "./cli-redact.ts";
import { createModelsCliTranslator, type ModelsCliTranslator } from "./cli-i18n.ts";

/**
 * The safe write path for the pi-teammate-models CLI.
 *
 * Publishing a registry document is four gates in order, and every gate can
 * stop the write before anything on disk changes shape:
 *
 * 1. the candidate is validated through the same `parseModelRegistryManifest`
 *    the runtime loads with, so a document the CLI would not itself accept is
 *    never written;
 * 2. the file is re-read and compared against the bytes the edit started
 *    from — an external change is shown as a redacted diff summary and must
 *    be confirmed explicitly (`--yes` pre-confirms; continuing is documented
 *    last-writer-wins);
 * 3. backups rotate (current → `.bak`, prior `.bak` → `.bak.1`) and any
 *    rotation failure aborts before publish;
 * 4. the candidate publishes atomically: sibling temp file named with the
 *    pid and a UUID, fsynced, renamed over the target, with a Windows
 *    remove-retry fallback mirroring the state-io pattern.
 */

export interface WriteConfirmIO {
  /** Write one output chunk (already newline-terminated where needed). */
  write(text: string): void;
  /**
   * Ask a yes/no question; resolves false on decline or end of input, so an
   * aborted stream can never confirm destructive continuation.
   */
  confirm(prompt: string): Promise<boolean>;
}

export interface PublishModelRegistryOptions {
  /** Absolute registry document path. */
  file: string;
  /** Full serialized candidate document. */
  candidateRaw: string;
  /** Bytes the edit flow started from; undefined when the file did not exist. */
  baselineRaw?: string;
  /** Pre-confirm external-change overwrite (--yes). */
  yes?: boolean;
  io: WriteConfirmIO;
  /** Defaults to the English models-CLI translator. */
  translate?: ModelsCliTranslator;
}

export type PublishResult =
  | { kind: "written"; backupPath: string | undefined }
  | { kind: "declined-external-change" };

const REMOVE_RETRY_ATTEMPTS = 3;

/**
 * Publish a validated model-registry document with rotation and atomic
 * replacement.
 *
 * @throws when the candidate fails manifest validation or backup rotation
 * fails; in both cases nothing has been published yet.
 */
export async function publishModelRegistryDocument(
  options: PublishModelRegistryOptions,
): Promise<PublishResult> {
  const { file, candidateRaw, baselineRaw, yes = false, io } = options;
  const t = options.translate ?? createModelsCliTranslator("en");

  // Gate 1: the candidate must survive the exact parser the runtime loads
  // with. A document that cannot be read back is not a document we wrote.
  parseModelRegistryManifest(candidateRaw, file);

  // Gate 2: re-read and compare against the edit's baseline bytes.
  let currentRaw: string | undefined;
  try {
    currentRaw = fs.readFileSync(file, "utf8");
  } catch {
    currentRaw = undefined;
  }
  if (currentRaw !== undefined && currentRaw !== baselineRaw) {
    io.write(`${t("models.cli.write.externalChange", { path: file })}\n`);
    for (const line of summarizeLineDiff(baselineRaw ?? "", currentRaw)) {
      io.write(`  ${line}\n`);
    }
    io.write(`${t("models.cli.write.lastWriterWins")}\n`);
    if (!yes) {
      const proceed = await io.confirm(t("models.cli.write.confirmOverwrite"));
      if (!proceed) return { kind: "declined-external-change" };
    }
  }

  // Gate 3: rotate backups before publishing. A failure here leaves the
  // current document untouched on disk and no new content anywhere.
  const backupPath = `${file}.bak`;
  const priorBackupPath = `${file}.bak.1`;
  if (currentRaw !== undefined) {
    try {
      if (fs.existsSync(backupPath)) fs.renameSync(backupPath, priorBackupPath);
      fs.copyFileSync(file, backupPath);
    } catch (cause) {
      throw new Error(t("models.cli.write.rotationFailed", { path: file }), { cause });
    }
  }

  // Gate 4: atomic publish — sibling temp (pid + UUID), fsync, rename.
  const directory = path.dirname(file);
  const tempPath = path.join(
    directory,
    `.${path.basename(file)}.${process.pid}.${randomUUID()}.tmp`,
  );
  let fd: number | undefined;
  try {
    fd = fs.openSync(tempPath, "w");
    fs.writeSync(fd, candidateRaw);
    fs.fsyncSync(fd);
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
  try {
    fs.renameSync(tempPath, file);
  } catch (renameError) {
    // Windows: rename onto an existing target can fail; remove with retries,
    // then rename again (same fallback shape as experts-mode state-io).
    let lastError: unknown = renameError;
    for (let attempt = 0; attempt < REMOVE_RETRY_ATTEMPTS; attempt += 1) {
      try {
        fs.rmSync(file, { force: true });
        fs.renameSync(tempPath, file);
        return { kind: "written", backupPath: currentRaw === undefined ? undefined : backupPath };
      } catch (retryError) {
        lastError = retryError;
      }
    }
    try {
      fs.rmSync(tempPath, { force: true });
    } catch {
      /* the temp file must not mask the publish failure */
    }
    throw lastError;
  }
  return { kind: "written", backupPath: currentRaw === undefined ? undefined : backupPath };
}

/**
 * Summarize the line-level difference between two document snapshots.
 *
 * Output lines are redacted: a diff exists to show what moved, not to become
 * a channel for whatever a concurrent writer pasted into the file.
 */
function summarizeLineDiff(before: string, after: string): string[] {
  const removed = symmetricOverage(before.split("\n"), after.split("\n"));
  const summary: string[] = [];
  const limit = 6;
  for (const line of removed.before.slice(0, limit)) summary.push(`- ${redactText(line)}`);
  if (removed.before.length > limit) summary.push(`- … ${removed.before.length - limit} more line(s)`);
  for (const line of removed.after.slice(0, limit)) summary.push(`+ ${redactText(line)}`);
  if (removed.after.length > limit) summary.push(`+ … ${removed.after.length - limit} more line(s)`);
  return summary;
}

/** Lines present in one snapshot but not the other, order preserved. */
function symmetricOverage(before: readonly string[], after: readonly string[]): {
  before: string[];
  after: string[];
} {
  const afterCounts = new Map<string, number>();
  for (const line of after) afterCounts.set(line, (afterCounts.get(line) ?? 0) + 1);
  const onlyBefore = before.filter((line) => {
    const count = afterCounts.get(line) ?? 0;
    if (count > 0) {
      afterCounts.set(line, count - 1);
      return false;
    }
    return true;
  });
  const beforeCounts = new Map<string, number>();
  for (const line of before) beforeCounts.set(line, (beforeCounts.get(line) ?? 0) + 1);
  const onlyAfter = after.filter((line) => {
    const count = beforeCounts.get(line) ?? 0;
    if (count > 0) {
      beforeCounts.set(line, count - 1);
      return false;
    }
    return true;
  });
  return { before: onlyBefore, after: onlyAfter };
}
