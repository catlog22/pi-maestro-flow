import { randomUUID } from "node:crypto";
import { chmod, link, lstat, mkdir, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import {
  generateDiffString,
  generateUnifiedPatch,
  type ExtensionAPI,
  type ExtensionContext,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";

const APPLY_PATCH_TOOL = "apply_patch";
const APPLY_PATCH_GRAMMAR = String.raw`start: begin_patch operation+ end_patch
begin_patch: "*** Begin Patch" NEWLINE
end_patch: "*** End Patch" NEWLINE?
operation: add_file | delete_file | update_file
add_file: "*** Add File: " path NEWLINE add_line+
add_line: /\+[^\n]*/ NEWLINE
delete_file: "*** Delete File: " path NEWLINE
update_file: "*** Update File: " path NEWLINE move_to? hunk+
move_to: "*** Move to: " path NEWLINE
hunk: "@@" hunk_label? NEWLINE change_line+ end_of_file?
hunk_label: /[^\n]+/
change_line: /[ +\-][^\n]*/ NEWLINE
end_of_file: "*** End of File" NEWLINE
path: /[^\n]+/
%import common.NEWLINE`;

const ApplyPatchParams = Type.Object({
  patch: Type.String({
    description: "A raw *** Begin Patch / *** End Patch patch. Do not wrap it in JSON or a Markdown code fence.",
  }),
});

type PatchOperation = AddOperation | DeleteOperation | UpdateOperation;
type AddOperation = { type: "add"; path: string; lines: string[] };
type DeleteOperation = { type: "delete"; path: string };
type UpdateOperation = { type: "update"; path: string; moveTo?: string; hunks: PatchHunk[] };
type PatchHunk = { section: string; lines: PatchLine[]; endOfFile: boolean };
type PatchLine = { type: "context" | "add" | "delete"; text: string };

type FileState = {
  absolutePath: string;
  displayPath: string;
  original: string | null;
  current: string | null;
  lineEnding: "\n" | "\r\n";
  unsupportedLineEndings: boolean;
  bom: string;
  mode?: number;
};

export interface ApplyPatchFileChange {
  path: string;
  action: "add" | "update" | "delete";
  diff: string;
  patch: string;
  firstChangedLine?: number;
}

export interface ApplyPatchDetails {
  diff: string;
  patch: string;
  firstChangedLine?: number;
  files: ApplyPatchFileChange[];
}

interface ModelLike {
  compat?: unknown;
}

interface ApplyPatchSettings {
  enabled: boolean;
}

export function createApplyPatchTool(): ToolDefinition<typeof ApplyPatchParams, ApplyPatchDetails> {
  return {
    name: APPLY_PATCH_TOOL,
    label: "apply_patch",
    description:
      "Apply a Codex-style patch to workspace files. The input must be raw patch text beginning with *** Begin Patch and ending with *** End Patch, not JSON or a Markdown code block. Supports adding, updating, moving, and deleting files, and returns a reviewable diff like Pi's edit tool.",
    promptSnippet: "Apply precise multi-file workspace changes with a raw Codex patch",
    promptGuidelines: [
      "Pass the patch as raw text without JSON or Markdown fences.",
      "Use *** Add File, *** Update File, *** Delete File, and optional *** Move to headers inside one Begin/End Patch envelope.",
      "Include enough unchanged context in each @@ hunk to locate the change reliably.",
    ],
    parameters: ApplyPatchParams,
    constrainedSampling: {
      type: "grammar",
      variants: { openai_lark: APPLY_PATCH_GRAMMAR },
    },
    renderShell: "self",
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const settings = await loadApplyPatchSettings(ctx);
      if (!settings.enabled) throw new Error("apply_patch is disabled. Enable it with /apply-patch on.");
      if (!supportsRawPatchTool(ctx.model)) throw new Error("apply_patch is unavailable for the current model.");
      return executeApplyPatch(params.patch, ctx.cwd, signal);
    },
    renderCall(_args, theme) {
      return new Text(theme.fg("toolTitle", theme.bold("apply_patch")), 0, 0);
    },
    renderResult(result, { expanded, isPartial }, theme, context) {
      if (isPartial) return new Text(theme.fg("warning", "Applying patch..."), 0, 0);
      const firstText = result.content.find((item) => item.type === "text");
      const message = firstText?.type === "text" ? firstText.text : "Patch failed";
      if (context.isError || !result.details?.diff) return new Text(theme.fg("error", message), 0, 0);

      const lines = result.details.diff.split("\n");
      const additions = lines.filter((line) => line.startsWith("+") && !line.startsWith("+++")).length;
      const removals = lines.filter((line) => line.startsWith("-") && !line.startsWith("---")).length;
      let text = `${theme.fg("success", `+${additions}`)}${theme.fg("dim", " / ")}${theme.fg("error", `-${removals}`)}`;
      if (result.details.files.length > 1) text += theme.fg("dim", ` (${result.details.files.length} files)`);
      if (expanded) {
        for (const line of lines) {
          if (line.startsWith("+") && !line.startsWith("+++")) text += `\n${theme.fg("success", line)}`;
          else if (line.startsWith("-") && !line.startsWith("---")) text += `\n${theme.fg("error", line)}`;
          else text += `\n${theme.fg("dim", line)}`;
        }
      }
      return new Text(text, 0, 0);
    },
  };
}

export function registerApplyPatch(pi: ExtensionAPI): void {
  pi.registerTool(createApplyPatchTool());

  let syncGeneration = 0;
  const sync = async (ctx: ExtensionContext, model: ModelLike | undefined = ctx.model): Promise<boolean> => {
    const generation = ++syncGeneration;
    const settings = await loadApplyPatchSettings(ctx);
    const active = settings.enabled && supportsRawPatchTool(model);
    if (generation === syncGeneration) setToolActive(pi, active);
    return active;
  };

  pi.on("session_start", async (_event, ctx) => { await sync(ctx); });
  pi.on("model_select", async (event, ctx) => { await sync(ctx, event.model); });
  pi.registerCommand("apply-patch", {
    description: "Control the platform-specific apply_patch tool: /apply-patch on|off|status",
    handler: async (args, ctx) => {
      const action = args.trim().toLowerCase() || "status";
      if (action !== "on" && action !== "off" && action !== "status") {
        ctx.ui.notify("Usage: /apply-patch on|off|status", "warning");
        return;
      }
      if (action !== "status") await persistApplyPatchSetting(ctx, action === "on");
      const settings = await loadApplyPatchSettings(ctx);
      const active = await sync(ctx);
      const platform = supportsRawPatchTool(ctx.model) ? "supported" : "unsupported by the current model";
      ctx.ui.notify(
        `apply_patch is ${settings.enabled ? "enabled" : "disabled"}; tool is ${active ? "active" : "inactive"} (${platform}).`,
        "info",
      );
    },
  });
}

export function parseApplyPatch(patch: string): PatchOperation[] {
  if (patch.includes("\r")) patch = patch.replace(/\r\n?/g, "\n");
  const lines = patch.split("\n");
  if (lines[0] !== "*** Begin Patch") throw new Error("Patch must begin with *** Begin Patch.");
  const endIndex = lines.length - 1 - (lines.at(-1) === "" ? 1 : 0);
  if (lines[endIndex] !== "*** End Patch") throw new Error("Patch must end with *** End Patch.");

  const operations: PatchOperation[] = [];
  let index = 1;
  while (index < endIndex) {
    const header = lines[index++];
    if (header.startsWith("*** Add File: ")) {
      const path = parseHeaderPath(header, "*** Add File: ");
      const content: string[] = [];
      while (index < endIndex && !isOperationHeader(lines[index])) {
        const line = lines[index++];
        if (!line.startsWith("+")) throw new Error(`Add File lines must start with +: ${line}`);
        content.push(line.slice(1));
      }
      if (content.length === 0) throw new Error(`Add File requires content: ${path}`);
      operations.push({ type: "add", path, lines: content });
      continue;
    }
    if (header.startsWith("*** Delete File: ")) {
      operations.push({ type: "delete", path: parseHeaderPath(header, "*** Delete File: ") });
      continue;
    }
    if (header.startsWith("*** Update File: ")) {
      const path = parseHeaderPath(header, "*** Update File: ");
      let moveTo: string | undefined;
      if (lines[index]?.startsWith("*** Move to: ")) moveTo = parseHeaderPath(lines[index++], "*** Move to: ");
      const hunks: PatchHunk[] = [];
      while (index < endIndex && !isOperationHeader(lines[index])) {
        const hunkHeader = lines[index++];
        if (!hunkHeader.startsWith("@@")) throw new Error(`Expected @@ hunk in ${path}, got: ${hunkHeader}`);
        const section = hunkHeader.slice(2).replace(/^\s+|\s+@@$/g, "").trim();
        const hunkLines: PatchLine[] = [];
        let endOfFile = false;
        while (index < endIndex && !lines[index].startsWith("@@") && !isOperationHeader(lines[index])) {
          const line = lines[index++];
          if (line === "*** End of File") {
            endOfFile = true;
            break;
          }
          const prefix = line[0];
          if (prefix !== " " && prefix !== "+" && prefix !== "-") {
            throw new Error(`Hunk lines must start with space, +, or -: ${line}`);
          }
          hunkLines.push({ type: prefix === " " ? "context" : prefix === "+" ? "add" : "delete", text: line.slice(1) });
        }
        if (hunkLines.length === 0) throw new Error(`Empty hunk in ${path}.`);
        hunks.push({ section, lines: hunkLines, endOfFile });
      }
      if (hunks.length === 0) throw new Error(`Update File requires at least one @@ hunk: ${path}`);
      operations.push({ type: "update", path, moveTo, hunks });
      continue;
    }
    throw new Error(`Unknown patch operation: ${header}`);
  }
  if (operations.length === 0) throw new Error("Patch must contain at least one file operation.");
  return operations;
}

export async function executeApplyPatch(patch: string, cwd: string, signal?: AbortSignal): Promise<{
  content: Array<{ type: "text"; text: string }>;
  details: ApplyPatchDetails;
}> {
  throwIfAborted(signal);
  const operations = parseApplyPatch(patch);
  const workspace = await realpath(cwd);
  const states = new Map<string, FileState>();

  const getState = async (path: string): Promise<FileState> => {
    const absolutePath = resolveWorkspacePath(workspace, path);
    const existing = states.get(absolutePath);
    if (existing) return existing;
    await assertSafeWorkspacePath(workspace, absolutePath);
    let raw: string | null = null;
    let mode: number | undefined;
    try {
      const stat = await lstat(absolutePath);
      if (stat.isSymbolicLink()) throw new Error(`Symbolic links cannot be patched: ${path}`);
      if (!stat.isFile()) throw new Error(`Patch target is not a file: ${path}`);
      mode = stat.mode;
      raw = await readFile(absolutePath, "utf8");
    } catch (error) {
      if (!isErrno(error, "ENOENT")) throw error;
    }
    const bom = raw?.startsWith("\uFEFF") ? "\uFEFF" : "";
    const withoutBom = bom ? raw!.slice(1) : raw;
    const hasCrLf = withoutBom?.includes("\r\n") ?? false;
    const withoutCrLf = withoutBom?.replace(/\r\n/g, "") ?? "";
    const hasBareLf = withoutCrLf.includes("\n");
    const hasBareCr = withoutCrLf.includes("\r");
    const lineEnding = hasCrLf ? "\r\n" : "\n";
    const normalized = withoutBom?.replace(/\r\n?/g, "\n") ?? null;
    const state = {
      absolutePath,
      displayPath: path,
      original: normalized,
      current: normalized,
      lineEnding,
      unsupportedLineEndings: hasBareCr || (hasCrLf && hasBareLf),
      bom,
      mode,
    } satisfies FileState;
    states.set(absolutePath, state);
    return state;
  };

  for (const operation of operations) {
    throwIfAborted(signal);
    if (operation.type === "add") {
      const state = await getState(operation.path);
      if (state.current !== null) throw new Error(`Cannot add an existing file: ${operation.path}`);
      state.current = `${operation.lines.join("\n")}\n`;
      continue;
    }
    if (operation.type === "delete") {
      const state = await getState(operation.path);
      if (state.current === null) throw new Error(`Cannot delete a missing file: ${operation.path}`);
      state.current = null;
      continue;
    }

    const state = await getState(operation.path);
    if (state.current === null) throw new Error(`Cannot update a missing file: ${operation.path}`);
    if (state.unsupportedLineEndings) throw new Error(`Cannot update a file with mixed or bare-CR line endings: ${operation.path}`);
    const updated = applyHunks(state.current, operation.hunks, operation.path);
    if (operation.moveTo) {
      const destination = await getState(operation.moveTo);
      if (destination.current !== null) throw new Error(`Move destination already exists: ${operation.moveTo}`);
      destination.current = updated;
      destination.lineEnding = state.lineEnding;
      destination.unsupportedLineEndings = false;
      destination.bom = state.bom;
      destination.mode = state.mode;
      state.current = null;
    } else {
      state.current = updated;
    }
  }

  const changed = [...states.values()].filter((state) => state.original !== state.current);
  if (changed.length === 0) throw new Error("Patch produced no changes.");
  await commitFileStates(changed, workspace, signal);

  const files = changed.map(buildFileChange);
  const diff = files.map((file) => `--- ${file.path}\n+++ ${file.path}\n${file.diff}`).join("\n");
  return {
    content: [{ type: "text", text: `Applied patch to ${files.length} file(s).` }],
    details: {
      diff,
      patch: files.map((file) => file.patch).join("\n"),
      firstChangedLine: files[0]?.firstChangedLine,
      files,
    },
  };
}

function applyHunks(content: string, hunks: PatchHunk[], path: string): string {
  let lines = content.split("\n");
  let cursor = 0;
  for (const hunk of hunks) {
    if (hunk.section) {
      const sectionIndex = lines.findIndex((line, index) => index >= cursor && line.includes(hunk.section));
      if (sectionIndex < 0) throw new Error(`Could not find hunk section in ${path}: ${hunk.section}`);
      cursor = sectionIndex;
    }
    const oldLines = hunk.lines.filter((line) => line.type !== "add").map((line) => line.text);
    const newLines = hunk.lines.filter((line) => line.type !== "delete").map((line) => line.text);
    const matchIndex = hunk.endOfFile
      ? findLineSequenceAtEnd(lines, oldLines)
      : findLineSequence(lines, oldLines, cursor);
    if (matchIndex < 0) throw new Error(`Could not find hunk context in ${path}.`);
    lines.splice(matchIndex, oldLines.length, ...newLines);
    cursor = matchIndex + newLines.length;
  }
  return lines.join("\n");
}

function findLineSequenceAtEnd(lines: string[], expected: string[]): number {
  const logicalEnd = lines.at(-1) === "" ? lines.length - 1 : lines.length;
  const index = logicalEnd - expected.length;
  if (index < 0) return -1;
  if (expected.every((line, offset) => lines[index + offset] === line)) return index;
  if (expected.every((line, offset) => lines[index + offset].trimEnd() === line.trimEnd())) return index;
  return -1;
}

function findLineSequence(lines: string[], expected: string[], start: number): number {
  if (expected.length === 0) return start;
  for (let index = start; index <= lines.length - expected.length; index++) {
    if (expected.every((line, offset) => lines[index + offset] === line)) return index;
  }
  for (let index = start; index <= lines.length - expected.length; index++) {
    if (expected.every((line, offset) => lines[index + offset].trimEnd() === line.trimEnd())) return index;
  }
  return -1;
}

async function commitFileStates(states: FileState[], workspace: string, signal?: AbortSignal): Promise<void> {
  type TransactionEntry = {
    state: FileState;
    tempPath?: string;
    backupPath?: string;
    originalMoved: boolean;
    replacementMoved: boolean;
    createdDirectories: string[];
  };
  const entries: TransactionEntry[] = [];
  let preserveBackups = false;
  try {
    for (const state of states) {
      throwIfAborted(signal);
      const createdDirectories = await ensureWorkspaceParent(workspace, dirname(state.absolutePath));
      const entry: TransactionEntry = { state, originalMoved: false, replacementMoved: false, createdDirectories };
      entries.push(entry);
      await assertSafeWorkspacePath(workspace, state.absolutePath);
      if (state.current !== null) {
        entry.tempPath = join(dirname(state.absolutePath), `.${randomUUID()}.apply-patch.tmp`);
        const restored = state.lineEnding === "\r\n" ? state.current.replace(/\n/g, "\r\n") : state.current;
        await writeFile(entry.tempPath, `${state.bom}${restored}`, "utf8");
        if (state.mode !== undefined) await chmod(entry.tempPath, state.mode & 0o777);
      }
      if (state.original !== null) entry.backupPath = join(dirname(state.absolutePath), `.${randomUUID()}.apply-patch.bak`);
    }

    for (const entry of entries) {
      throwIfAborted(signal);
      await assertSafeWorkspacePath(workspace, entry.state.absolutePath);
      if (entry.backupPath) {
        await rename(entry.state.absolutePath, entry.backupPath);
        entry.originalMoved = true;
      }
      if (entry.tempPath) {
        if (entry.state.original === null) {
          await link(entry.tempPath, entry.state.absolutePath);
          await rm(entry.tempPath, { force: true });
          entry.tempPath = undefined;
        } else {
          await rename(entry.tempPath, entry.state.absolutePath);
        }
        entry.replacementMoved = true;
      }
    }
    await Promise.all(entries.map((entry) => entry.backupPath
      ? rm(entry.backupPath, { force: true }).catch(() => undefined)
      : undefined));
  } catch (error) {
    const rollbackErrors: string[] = [];
    for (const entry of [...entries].reverse()) {
      try {
        if (entry.replacementMoved) await rm(entry.state.absolutePath, { force: true });
        if (entry.originalMoved && entry.backupPath) await rename(entry.backupPath, entry.state.absolutePath);
        for (const directory of [...entry.createdDirectories].reverse()) await rm(directory).catch(() => undefined);
      } catch (rollbackError) {
        rollbackErrors.push(errorMessage(rollbackError));
      }
    }
    if (rollbackErrors.length > 0) {
      preserveBackups = true;
      throw new Error(`${errorMessage(error)} Rollback failed: ${rollbackErrors.join("; ")}`);
    }
    throw error;
  } finally {
    await Promise.all(entries.flatMap((entry) => [entry.tempPath, preserveBackups ? undefined : entry.backupPath]
      .filter((path): path is string => path !== undefined)
      .map((path) => rm(path, { force: true }).catch(() => undefined))));
  }
}

async function replaceFile(tempPath: string, targetPath: string): Promise<void> {
  try {
    await rename(tempPath, targetPath);
  } catch (error) {
    if (!isErrno(error, "EEXIST") && !isErrno(error, "EPERM")) throw error;
    await rm(targetPath, { force: true });
    await rename(tempPath, targetPath);
  }
}

async function ensureWorkspaceParent(workspace: string, parent: string): Promise<string[]> {
  const missing: string[] = [];
  let current = parent;
  while (true) {
    try {
      const resolved = await realpath(current);
      if (!isInside(workspace, resolved)) throw new Error(`Patch path escapes the workspace through a symbolic link: ${parent}`);
      break;
    } catch (error) {
      if (!isErrno(error, "ENOENT")) throw error;
      if (!isInside(workspace, current)) throw new Error(`Patch path is outside the workspace: ${parent}`);
      missing.push(current);
      const next = dirname(current);
      if (next === current) throw new Error(`Patch path is outside the workspace: ${parent}`);
      current = next;
    }
  }

  const created: string[] = [];
  try {
    for (const directory of missing.reverse()) {
      await mkdir(directory);
      created.push(directory);
      const stat = await lstat(directory);
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`Unsafe patch directory: ${directory}`);
      const resolved = await realpath(directory);
      if (!isInside(workspace, resolved)) throw new Error(`Patch directory escapes the workspace: ${directory}`);
    }
    return created;
  } catch (error) {
    for (const directory of [...created].reverse()) await rm(directory).catch(() => undefined);
    throw error;
  }
}

function buildFileChange(state: FileState): ApplyPatchFileChange {
  const before = state.original ?? "";
  const after = state.current ?? "";
  const display = generateDiffString(before, after);
  return {
    path: state.displayPath,
    action: state.original === null ? "add" : state.current === null ? "delete" : "update",
    diff: display.diff,
    patch: generateUnifiedPatch(state.displayPath, before, after),
    firstChangedLine: display.firstChangedLine,
  };
}

function resolveWorkspacePath(workspace: string, path: string): string {
  const absolutePath = isAbsolute(path) ? resolve(path) : resolve(workspace, path);
  if (!isInside(workspace, absolutePath)) throw new Error(`Patch path is outside the workspace: ${path}`);
  return absolutePath;
}

async function assertSafeWorkspacePath(workspace: string, path: string): Promise<void> {
  let parent = dirname(path);
  while (isInside(workspace, parent)) {
    try {
      const resolvedParent = await realpath(parent);
      if (!isInside(workspace, resolvedParent)) throw new Error(`Patch path escapes the workspace through a symbolic link: ${path}`);
      return;
    } catch (error) {
      if (!isErrno(error, "ENOENT")) throw error;
      const next = dirname(parent);
      if (next === parent) break;
      parent = next;
    }
  }
  throw new Error(`Patch path is outside the workspace: ${path}`);
}

function isInside(workspace: string, path: string): boolean {
  const rel = relative(workspace, path);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function parseHeaderPath(header: string, prefix: string): string {
  const path = header.slice(prefix.length).trim();
  if (!path) throw new Error(`Missing path in header: ${header}`);
  return path;
}

function isOperationHeader(line: string): boolean {
  return line.startsWith("*** Add File: ") || line.startsWith("*** Delete File: ") || line.startsWith("*** Update File: ");
}

function supportsRawPatchTool(model: ModelLike | undefined): boolean {
  return asRecord(model?.compat)?.supportsOpenAIGrammarTools === true;
}

function setToolActive(pi: Pick<ExtensionAPI, "getActiveTools" | "setActiveTools">, active: boolean): void {
  const tools = pi.getActiveTools();
  const hasTool = tools.includes(APPLY_PATCH_TOOL);
  if (active && !hasTool) pi.setActiveTools([...tools, APPLY_PATCH_TOOL]);
  if (!active && hasTool) pi.setActiveTools(tools.filter((name) => name !== APPLY_PATCH_TOOL));
}

async function loadApplyPatchSettings(ctx: Pick<ExtensionContext, "cwd" | "isProjectTrusted">): Promise<ApplyPatchSettings> {
  let enabled = false;
  const paths = [join(getAgentDir(), "settings.json")];
  if (ctx.isProjectTrusted()) paths.push(join(ctx.cwd, ".pi", "settings.json"));
  for (const path of paths) {
    const root = await readJsonObject(path);
    const platformTools = asRecord(root.platformTools);
    const applyPatch = asRecord(platformTools?.applyPatch);
    if (typeof applyPatch?.enabled === "boolean") enabled = applyPatch.enabled;
  }
  return { enabled };
}

async function persistApplyPatchSetting(ctx: Pick<ExtensionContext, "cwd" | "isProjectTrusted">, enabled: boolean): Promise<void> {
  const path = ctx.isProjectTrusted() ? join(ctx.cwd, ".pi", "settings.json") : join(getAgentDir(), "settings.json");
  const root = await readJsonObject(path);
  const platformTools = asRecord(root.platformTools) ?? {};
  const applyPatch = asRecord(platformTools.applyPatch) ?? {};
  applyPatch.enabled = enabled;
  platformTools.applyPatch = applyPatch;
  root.platformTools = platformTools;
  await mkdir(dirname(path), { recursive: true });
  const tempPath = `${path}.${randomUUID()}.tmp`;
  await writeFile(tempPath, `${JSON.stringify(root, null, 2)}\n`, "utf8");
  await replaceFile(tempPath, path);
}

async function readJsonObject(path: string): Promise<Record<string, unknown>> {
  try {
    const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
    if (!asRecord(parsed)) throw new Error(`Settings root must be an object: ${path}`);
    return parsed as Record<string, unknown>;
  } catch (error) {
    if (isErrno(error, "ENOENT")) return {};
    throw error;
  }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function getAgentDir(): string {
  return process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new Error("Operation aborted");
}

function isErrno(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
