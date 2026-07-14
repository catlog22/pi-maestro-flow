import * as fs from "node:fs/promises";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type { Position, TextEdit, WorkspaceEdit } from "./types.ts";

export interface AppliedWorkspaceEdit {
  files: string[];
  operations: string[];
}

export async function applyWorkspaceEdit(edit: WorkspaceEdit, allowedRoot?: string): Promise<AppliedWorkspaceEdit> {
  if (edit.changes && edit.documentChanges) {
    throw new Error("WorkspaceEdit must not contain both changes and documentChanges.");
  }

  const initial = new Map<string, FileState>();
  const current = new Map<string, FileState>();
  const operations: string[] = [];

  const load = async (file: string): Promise<FileState> => {
    await assertAllowedPath(file, allowedRoot);
    const cached = current.get(file);
    if (cached) return cached;
    let state: FileState;
    try {
      const stat = await fs.lstat(file);
      if (!stat.isFile()) throw new Error(`WorkspaceEdit only supports regular files: ${file}`);
      state = { exists: true, content: await fs.readFile(file, "utf8"), mode: stat.mode };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      state = { exists: false, content: "" };
    }
    initial.set(file, { ...state });
    current.set(file, { ...state });
    return current.get(file)!;
  };

  for (const [uri, edits] of Object.entries(edit.changes ?? {})) {
    const file = uriToFile(uri);
    const state = await load(file);
    if (!state.exists) throw new Error(`WorkspaceEdit target does not exist: ${file}`);
    state.content = applyTextEdits(state.content, edits);
    operations.push(`edit ${file}`);
  }

  for (const change of edit.documentChanges ?? []) {
    if ("textDocument" in change) {
      if (typeof change.textDocument.version === "number") {
        throw new Error(`Versioned WorkspaceEdit is not supported safely for ${uriToFile(change.textDocument.uri)}.`);
      }
      const file = uriToFile(change.textDocument.uri);
      const state = await load(file);
      if (!state.exists) throw new Error(`WorkspaceEdit target does not exist: ${file}`);
      state.content = applyTextEdits(state.content, change.edits);
      operations.push(`edit ${file}`);
    } else if (change.kind === "create") {
      const file = uriToFile(change.uri);
      const state = await load(file);
      if (state.exists) throw new Error(`WorkspaceEdit create target already exists: ${file}`);
      state.exists = true;
      state.content = "";
      operations.push(`create ${file}`);
    } else if (change.kind === "rename") {
      const source = uriToFile(change.oldUri);
      const destination = uriToFile(change.newUri);
      const sourceState = await load(source);
      const destinationState = await load(destination);
      if (!sourceState.exists) throw new Error(`WorkspaceEdit rename source does not exist: ${source}`);
      if (destinationState.exists) throw new Error(`WorkspaceEdit rename destination exists: ${destination}`);
      current.set(destination, { ...sourceState });
      current.set(source, { exists: false, content: "" });
      operations.push(`rename ${source} -> ${destination}`);
    } else if (change.kind === "delete") {
      if (change.options?.recursive) throw new Error("Recursive directory deletion is not supported by WorkspaceEdit.");
      const file = uriToFile(change.uri);
      const state = await load(file);
      if (!state.exists) throw new Error(`WorkspaceEdit delete target does not exist: ${file}`);
      current.set(file, { exists: false, content: "" });
      operations.push(`delete ${file}`);
    }
  }

  const touched = [...current.keys()];
  try {
    for (const file of touched) {
      const before = initial.get(file)!;
      const after = current.get(file)!;
      if (after.exists && (!before.exists || before.content !== after.content)) {
        await writeAtomic(file, after.content, after.mode);
      }
    }
    for (const file of touched) {
      const before = initial.get(file)!;
      const after = current.get(file)!;
      if (before.exists && !after.exists) await fs.rm(file, { force: false });
    }
  } catch (error) {
    await Promise.allSettled([...initial].map(async ([file, state]) => {
      if (state.exists) await writeAtomic(file, state.content, state.mode);
      else await fs.rm(file, { force: true });
    }));
    throw new Error(`WorkspaceEdit failed and rollback was attempted: ${error instanceof Error ? error.message : String(error)}`);
  }

  return { files: touched, operations };
}

interface FileState {
  exists: boolean;
  content: string;
  mode?: number;
}

async function writeAtomic(file: string, content: string, mode?: number): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const temp = `${file}.maestro-lsp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.tmp`;
  try {
    await fs.writeFile(temp, content, { encoding: "utf8", ...(mode === undefined ? {} : { mode }) });
    await fs.rename(temp, file);
  } finally {
    await fs.rm(temp, { force: true }).catch(() => {});
  }
}

async function assertAllowedPath(file: string, allowedRoot?: string): Promise<void> {
  if (!allowedRoot) return;
  const root = await fs.realpath(allowedRoot);
  let resolved: string;
  try {
    resolved = await fs.realpath(file);
  } catch {
    let parent = path.dirname(file);
    while (true) {
      try {
        const realParent = await fs.realpath(parent);
        resolved = path.join(realParent, path.relative(parent, file));
        break;
      } catch {
        const next = path.dirname(parent);
        if (next === parent) throw new Error(`Unable to resolve workspace path: ${file}`);
        parent = next;
      }
    }
  }
  const relative = path.relative(root, resolved);
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`WorkspaceEdit path is outside the workspace: ${file}`);
  }
}

export function previewWorkspaceEdit(edit: WorkspaceEdit): string {
  const lines: string[] = [];
  for (const [uri, edits] of Object.entries(edit.changes ?? {})) {
    lines.push(`${uriToFile(uri)}: ${edits.length} edit(s)`);
  }
  for (const change of edit.documentChanges ?? []) {
    if ("textDocument" in change) lines.push(`${uriToFile(change.textDocument.uri)}: ${change.edits.length} edit(s)`);
    else if (change.kind === "create") lines.push(`create ${uriToFile(change.uri)}`);
    else if (change.kind === "rename") lines.push(`rename ${uriToFile(change.oldUri)} -> ${uriToFile(change.newUri)}`);
    else lines.push(`delete ${uriToFile(change.uri)}`);
  }
  return lines.length > 0 ? lines.join("\n") : "No edits";
}

export function applyTextEdits(content: string, edits: TextEdit[]): string {
  const offsets = lineOffsets(content);
  const normalized = edits.map((edit) => ({
    start: positionToOffset(content, offsets, edit.range.start),
    end: positionToOffset(content, offsets, edit.range.end),
    newText: edit.newText,
  })).sort((left, right) => right.start - left.start || right.end - left.end);

  let lastStart = content.length + 1;
  let output = content;
  for (const edit of normalized) {
    if (edit.start > edit.end) throw new Error("WorkspaceEdit contains a reversed text range.");
    if (edit.end > lastStart) throw new Error("WorkspaceEdit contains overlapping text edits.");
    output = output.slice(0, edit.start) + edit.newText + output.slice(edit.end);
    lastStart = edit.start;
  }
  return output;
}

export function uriToFile(uri: string): string {
  if (uri.startsWith("file:")) return fileURLToPath(uri);
  if (/^[A-Za-z]:[\\/]/.test(uri) || path.isAbsolute(uri)) return path.resolve(uri);
  if (/^[A-Za-z][A-Za-z\d+.-]*:/.test(uri)) throw new Error(`Unsupported WorkspaceEdit URI: ${uri}`);
  return path.resolve(uri);
}

function lineOffsets(content: string): number[] {
  const offsets = [0];
  for (let index = 0; index < content.length; index += 1) {
    if (content[index] === "\n") offsets.push(index + 1);
  }
  return offsets;
}

function positionToOffset(content: string, offsets: number[], position: Position): number {
  if (!Number.isInteger(position.line) || position.line < 0 || !Number.isInteger(position.character) || position.character < 0) {
    throw new Error(`Invalid LSP edit position ${position.line}:${position.character}.`);
  }
  const lineStart = offsets[position.line];
  if (lineStart === undefined) throw new Error(`LSP edit line ${position.line + 1} is outside the file.`);
  let lineEnd = offsets[position.line + 1] ?? content.length;
  if (lineEnd > lineStart && content[lineEnd - 1] === "\n") lineEnd -= 1;
  if (lineEnd > lineStart && content[lineEnd - 1] === "\r") lineEnd -= 1;
  const offset = lineStart + position.character;
  if (offset > lineEnd) throw new Error(`LSP edit character ${position.character + 1} is outside line ${position.line + 1}.`);
  return offset;
}
