/** Workspace-scoped file operations with canonical paths and bounded output. */
import { createHash, randomUUID } from "node:crypto";
import { lstat, open, readdir, readFile, rm } from "node:fs/promises";
import type { Dirent } from "node:fs";
import { basename, dirname, relative, resolve } from "node:path";
import type { GatewayFileSecurityConfig } from "../config.ts";
import { GATEWAY_HARD_LIMITS, type GatewayPrincipal, type GatewayResult } from "../contracts.ts";
import { createLocalGatewayPrincipal } from "../principal.ts";
import { GatewayPolicy, GatewayPolicyError } from "../policy.ts";
import { gatewayError, gatewayOk } from "../result.ts";
import { canonicalizeWorkspaceChild, canonicalizeWorkspacePath, isPathWithin, utf8Bytes, writeGatewayFileAtomic } from "../state-paths.ts";
import { parseGatewayPrincipal, parseGatewayResult } from "../validation.ts";

const DEFAULT_READ_BYTES = 1024 * 1024;
const DEFAULT_WRITE_BYTES = 1024 * 1024;
const DEFAULT_RESULTS = 256;
const MAX_DEPTH = 64;

class GatewayFileServiceError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "GatewayFileServiceError";
    this.code = code;
  }
}

export interface FileServiceOptions {
  policy?: GatewayPolicy;
  workspaceRoot?: string;
  principal?: GatewayPrincipal;
  security?: Partial<GatewayFileSecurityConfig>;
  maxResults?: number;
}

export interface FileRequest {
  workspace?: string;
  path?: string;
  principal?: GatewayPrincipal;
  requestId?: string;
}

export interface FileListInput extends FileRequest {
  path?: string;
  maxResults?: number;
}

export interface FileStatInput extends FileRequest {}

export interface FileReadInput extends FileRequest {
  encoding?: "utf8" | "base64";
}

export interface FileWriteInput extends FileRequest {
  content: string | Uint8Array;
  encoding?: "utf8" | "base64";
  overwrite?: boolean;
}

export interface FileEditOperation {
  oldText: string;
  newText: string;
  replaceAll?: boolean;
}

export interface FileEditInput extends FileRequest {
  expectedSha256?: string;
  expectedHash?: string;
  content?: string | Uint8Array;
  edits?: FileEditOperation[];
  oldText?: string;
  newText?: string;
  replaceAll?: boolean;
}

export interface FileFindInput extends FileRequest {
  pattern?: string;
  name?: string;
  maxResults?: number;
  maxDepth?: number;
  includeDirectories?: boolean;
}

export interface FileGrepInput extends FileRequest {
  query?: string;
  pattern?: string;
  regex?: boolean;
  maxResults?: number;
  maxBytes?: number;
}

export interface FileTransferInput extends FileRequest {
  source?: string;
  from?: string;
  destination?: string;
  to?: string;
  mode?: "copy" | "move";
  overwrite?: boolean;
}

export interface FileActionRequest extends FileRequest {
  action: "list" | "stat" | "read" | "write" | "edit" | "find" | "grep" | "transfer" | "realpath";
  content?: string | Uint8Array;
  encoding?: "utf8" | "base64";
  overwrite?: boolean;
  expectedSha256?: string;
  expectedHash?: string;
  edits?: FileEditOperation[];
  oldText?: string;
  newText?: string;
  replaceAll?: boolean;
  pattern?: string;
  name?: string;
  query?: string;
  regex?: boolean;
  maxResults?: number;
  maxDepth?: number;
  includeDirectories?: boolean;
  maxBytes?: number;
  source?: string;
  from?: string;
  destination?: string;
  to?: string;
  mode?: "copy" | "move";
}

export interface FileEntry {
  path: string;
  relativePath: string;
  name: string;
  type: "file" | "directory" | "symlink" | "other";
  size: number;
  modifiedAt: number;
}

export interface FileStat extends FileEntry {
  mode: number;
  sha256?: string;
}

export interface FileListData {
  path: string;
  entries: FileEntry[];
  truncated: boolean;
}

export interface FileReadData {
  path: string;
  bytes: number;
  sha256: string;
  encoding: "utf8" | "base64";
  content: string;
}

export interface FileWriteData {
  path: string;
  bytes: number;
  sha256: string;
}

export interface FileEditData extends FileWriteData {
  previousSha256: string;
  expectedSha256?: string;
  currentSha256?: string;
}

export interface FileFindData {
  root: string;
  matches: FileEntry[];
  truncated: boolean;
}

export interface FileGrepMatch {
  path: string;
  relativePath: string;
  line: number;
  text: string;
}

export interface FileGrepData {
  root: string;
  matches: FileGrepMatch[];
  truncated: boolean;
}

export interface FileTransferData extends FileWriteData {
  source: string;
  mode: "copy" | "move";
}

interface ResolvedPath {
  workspace: string;
  path: string;
  requestedPath: string;
}

function requestOptions(principal: GatewayPrincipal, requestId: string | undefined, startedAt: number) {
  return {
    requestId: requestId && requestId.trim() ? requestId : randomUUID(),
    principalId: principal.id,
    startedAt: new Date(startedAt).toISOString(),
    durationMs: Math.max(0, Date.now() - startedAt),
  };
}

function errorCode(error: unknown): string {
  if (error instanceof GatewayPolicyError) return error.code;
  if (error instanceof Error && error.name === "GatewayValidationError") return "invalid_principal";
  if (error instanceof Error && /escapes the registered workspace|outside the registered workspace/.test(error.message)) return "policy_denied";
  const code = error && typeof error === "object" ? (error as NodeJS.ErrnoException).code : undefined;
  if (code === "ENOENT") return "not_found";
  if (code === "EACCES" || code === "EPERM") return "permission_denied";
  if (code === "EISDIR") return "not_file";
  if (typeof code === "string" && /^[A-Za-z0-9._:-]{1,128}$/.test(code)) return code.toLowerCase();
  return "internal_error";
}

function errorResult<T>(
  error: unknown,
  principal: GatewayPrincipal,
  requestId: string | undefined,
  startedAt: number,
  data?: T,
): GatewayResult<T> {
  const base = gatewayError({ code: errorCode(error), message: error instanceof Error ? error.message : String(error) }, requestOptions(principal, requestId, startedAt));
  return data === undefined ? base as GatewayResult<T> : parseGatewayResult<T>({ ...base, data });
}

function typeFor(mode: { isFile(): boolean; isDirectory(): boolean; isSymbolicLink(): boolean }): FileEntry["type"] {
  if (mode.isFile()) return "file";
  if (mode.isDirectory()) return "directory";
  if (mode.isSymbolicLink()) return "symlink";
  return "other";
}

function sha256(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function globMatches(pattern: string, value: string): boolean {
  let expression = "^";
  for (const character of pattern) {
    if (character === "*") expression += ".*";
    else if (character === "?") expression += ".";
    else expression += character.replace(/[\\^$.*+()[\]{}|]/g, "\\$&");
  }
  try { return new RegExp(`${expression}$`, "s").test(value); }
  catch { return false; }
}

function patternMatches(pattern: string | undefined, value: string): boolean {
  if (pattern === undefined || pattern === "") return true;
  if (pattern === value) return true;
  if (pattern.includes("*") || pattern.includes("?")) return globMatches(pattern, value);
  try { return new RegExp(pattern, "s").test(value); }
  catch { return false; }
}

function payloadFor(content: string | Uint8Array, encoding: "utf8" | "base64" = "utf8"): Buffer {
  if (content instanceof Uint8Array) return Buffer.from(content);
  if (encoding === "base64") {
    const payload = Buffer.from(content, "base64");
    if (payload.toString("base64").replace(/=+$/, "") !== content.replace(/=+$/, "")) throw new GatewayFileServiceError("invalid_input", "content is not valid base64");
    return payload;
  }
  return Buffer.from(content, "utf8");
}

function relativePath(root: string, target: string): string {
  const value = relative(root, target);
  return value === "" ? "." : value;
}

function sameFileIdentity(left: { dev: number | bigint; ino: number | bigint }, right: { dev: number | bigint; ino: number | bigint }): boolean {
  return String(left.dev) === String(right.dev) && String(left.ino) === String(right.ino);
}

export class FileService {
  readonly policy?: GatewayPolicy;
  private readonly workspaceRoot?: string;
  private readonly defaultPrincipal: GatewayPrincipal;
  private readonly security: Partial<GatewayFileSecurityConfig>;
  private readonly defaultMaxResults: number;
  private mutationTail: Promise<void> = Promise.resolve();

  constructor(options: FileServiceOptions = {}) {
    this.policy = options.policy;
    this.workspaceRoot = options.workspaceRoot === undefined ? undefined : canonicalizeWorkspacePath(options.workspaceRoot);
    this.defaultPrincipal = options.principal === undefined
      ? createLocalGatewayPrincipal("gateway-file", this.workspaceRoot ? { workspacePath: this.workspaceRoot } : {})
      : parseGatewayPrincipal(options.principal);
    this.security = { ...(options.security ?? {}) };
    const defaultMax = options.maxResults ?? DEFAULT_RESULTS;
    if (!Number.isSafeInteger(defaultMax) || defaultMax < 1 || defaultMax > 4096) throw new Error("maxResults must be an integer in [1, 4096]");
    this.defaultMaxResults = defaultMax;
  }

  async realpath(input: FileRequest = {}): Promise<GatewayResult<{ path: string; relativePath: string }>> {
    const startedAt = Date.now();
    let principal = this.defaultPrincipal;
    try { principal = this.principal(input.principal); const resolved = await this.resolve(input, "read", principal); return gatewayOk({ path: resolved.path, relativePath: relativePath(resolved.workspace, resolved.path) }, requestOptions(principal, input.requestId, startedAt)); }
    catch (error) { return errorResult(error, principal, input.requestId, startedAt); }
  }

  async list(input: FileListInput = {}): Promise<GatewayResult<FileListData>> {
    const startedAt = Date.now();
    let principal = this.defaultPrincipal;
    try {
      principal = this.principal(input.principal);
      const resolved = await this.resolve(input, "read", principal);
      const metadata = await lstat(resolved.path);
      if (!metadata.isDirectory()) throw new GatewayFileServiceError("invalid_input", "file list path must be a directory");
      const entries = await readdir(resolved.path, { withFileTypes: true });
      const maxResults = this.resultLimit(input.maxResults);
      const sortedEntries = entries.sort((left, right) => left.name.localeCompare(right.name));
      const result: FileEntry[] = [];
      for (const entry of sortedEntries.slice(0, maxResults)) {
        const childRequested = relative(resolved.workspace, resolve(resolved.path, entry.name));
        const child = await this.resolve({ workspace: resolved.workspace, path: childRequested }, "read", principal);
        const childStat = await lstat(child.path);
        result.push(this.entry(child.workspace, child.path, childStat));
      }
      return gatewayOk({ path: resolved.path, entries: result, truncated: sortedEntries.length > result.length }, requestOptions(principal, input.requestId, startedAt));
    } catch (error) { return errorResult(error, principal, input.requestId, startedAt); }
  }

  async stat(input: FileStatInput): Promise<GatewayResult<FileStat>> {
    const startedAt = Date.now();
    let principal = this.defaultPrincipal;
    try {
      principal = this.principal(input.principal);
      const resolved = await this.resolve(input, "read", principal);
      const metadata = await lstat(resolved.path);
      const entry = this.entry(resolved.workspace, resolved.path, metadata) as FileStat;
      if (metadata.isFile() && metadata.size <= this.readLimit()) entry.sha256 = sha256(await readFile(resolved.path));
      return gatewayOk(entry, requestOptions(principal, input.requestId, startedAt));
    } catch (error) { return errorResult(error, principal, input.requestId, startedAt); }
  }

  async read(input: FileReadInput): Promise<GatewayResult<FileReadData>> {
    const startedAt = Date.now();
    let principal = this.defaultPrincipal;
    try {
      principal = this.principal(input.principal);
      const resolved = await this.resolve(input, "read", principal);
      const metadata = await lstat(resolved.path);
      if (!metadata.isFile()) throw new GatewayFileServiceError("invalid_input", "file read path must be a regular file");
      const maximum = this.readLimit();
      if (Number(metadata.size) > maximum) throw new GatewayPolicyError(`file read exceeds ${maximum} bytes`, "bounds_exceeded");
      const content = await readFile(resolved.path);
      if (content.byteLength > maximum) throw new GatewayPolicyError(`file read exceeds ${maximum} bytes`, "bounds_exceeded");
      const encoding = input.encoding ?? "utf8";
      const value = encoding === "base64" ? content.toString("base64") : content.toString("utf8");
      return gatewayOk({ path: resolved.path, bytes: content.byteLength, sha256: sha256(content), encoding, content: value }, requestOptions(principal, input.requestId, startedAt));
    } catch (error) { return errorResult(error, principal, input.requestId, startedAt); }
  }

  async write(input: FileWriteInput): Promise<GatewayResult<FileWriteData>> {
    const startedAt = Date.now();
    let principal = this.defaultPrincipal;
    let release: (() => void) | undefined;
    try {
      principal = this.principal(input.principal);
      release = await this.acquireMutation();
      const resolved = await this.resolve(input, "write", principal);
      const payload = payloadFor(input.content, input.encoding);
      const maximum = this.writeLimit();
      if (payload.byteLength > maximum) throw new GatewayPolicyError(`file write exceeds ${maximum} bytes`, "bounds_exceeded");
      let existing: Awaited<ReturnType<typeof lstat>> | undefined;
      try { existing = await lstat(resolved.path); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      if (existing && input.overwrite === false && existing.isFile()) throw new GatewayPolicyError("file exists and overwrite is false", "already_exists");
      if (existing && !existing.isFile()) throw new GatewayFileServiceError("invalid_input", "file write target must be a regular file");
      await this.assertParent(resolved, principal);
      if (existing) {
        const opened = await open(resolved.path, "r+");
        try {
          const openedStat = await opened.stat();
          if (!openedStat.isFile() || !sameFileIdentity(existing, openedStat)) throw new GatewayPolicyError("file identity changed during write", "path_changed");
          await opened.write(payload, 0, payload.byteLength, 0);
          await opened.truncate(payload.byteLength);
          await opened.sync();
        } finally { await opened.close(); }
      } else {
        await writeGatewayFileAtomic(resolved.path, payload, { mode: 0o600, maximumBytes: maximum });
      }
      return gatewayOk({ path: resolved.path, bytes: payload.byteLength, sha256: sha256(payload) }, requestOptions(principal, input.requestId, startedAt));
    } catch (error) { return errorResult(error, principal, input.requestId, startedAt); }
    finally { release?.(); }
  }

  async edit(input: FileEditInput): Promise<GatewayResult<FileEditData>> {
    const startedAt = Date.now();
    let principal = this.defaultPrincipal;
    let release: (() => void) | undefined;
    let opened: Awaited<ReturnType<typeof open>> | undefined;
    try {
      principal = this.principal(input.principal);
      release = await this.acquireMutation();
      const resolved = await this.resolve(input, "patch", principal);
      opened = await open(resolved.path, "r+");
      const metadata = await opened.stat();
      const before = await opened.readFile();
      if (!metadata.isFile()) throw new GatewayFileServiceError("invalid_input", "file edit target must be a regular file");
      if (Number(metadata.size) > this.readLimit()) throw new GatewayPolicyError(`file read exceeds ${this.readLimit()} bytes`, "bounds_exceeded");
      if (before.byteLength > this.readLimit()) throw new GatewayPolicyError(`file read exceeds ${this.readLimit()} bytes`, "bounds_exceeded");
      const previousSha256 = sha256(before);
      const expected = input.expectedSha256 ?? input.expectedHash;
      if (expected !== undefined && !/^[a-f0-9]{64}$/i.test(expected)) throw new GatewayFileServiceError("invalid_input", "expectedSha256 must be a SHA-256 hex digest");
      if (expected !== undefined && expected.toLowerCase() !== previousSha256) {
        return errorResult<FileEditData>(new GatewayPolicyError("file changed since expectedSha256 was computed", "hash_conflict"), principal, input.requestId, startedAt, {
          path: resolved.path,
          bytes: before.byteLength,
          sha256: previousSha256,
          previousSha256,
          expectedSha256: expected,
          currentSha256: previousSha256,
        });
      }
      const original = before.toString("utf8");
      let next = input.content;
      if (next === undefined) {
        const operations = input.edits ?? (input.oldText === undefined || input.newText === undefined ? [] : [{ oldText: input.oldText, newText: input.newText, replaceAll: input.replaceAll }]);
        if (operations.length === 0) throw new GatewayFileServiceError("invalid_input", "edit content or edits is required");
        if (this.policy) this.policy.checkPatchFiles(1);
        if (operations.length > this.patchLimit()) throw new GatewayPolicyError(`edit operation count exceeds ${this.patchLimit()}`, "bounds_exceeded");
        next = operations.reduce((value, operation) => {
          if (typeof operation.oldText !== "string" || typeof operation.newText !== "string") throw new GatewayFileServiceError("invalid_input", "edit oldText and newText must be strings");
          const occurrences = value.split(operation.oldText).length - 1;
          if (occurrences === 0) throw new GatewayFileServiceError("not_found", "edit oldText was not found");
          if (occurrences > 1 && operation.replaceAll !== true) throw new GatewayFileServiceError("ambiguous_edit", "edit oldText is ambiguous; set replaceAll to replace every match");
          return operation.replaceAll === true ? value.split(operation.oldText).join(operation.newText) : value.replace(operation.oldText, operation.newText);
        }, original);
      }
      const payload = payloadFor(next, "utf8");
      if (payload.byteLength > this.writeLimit()) throw new GatewayPolicyError(`file write exceeds ${this.writeLimit()} bytes`, "bounds_exceeded");
      const currentMetadata = await lstat(resolved.path);
      if (!currentMetadata.isFile() || !sameFileIdentity(metadata, currentMetadata)) throw new GatewayPolicyError("file identity changed during edit", "path_changed");
      const current = await readFile(resolved.path);
      if (sha256(current) !== previousSha256) {
        const currentSha256 = sha256(current);
        return errorResult<FileEditData>(new GatewayPolicyError("file changed during edit", "hash_conflict"), principal, input.requestId, startedAt, { path: resolved.path, bytes: current.byteLength, sha256: currentSha256, previousSha256, expectedSha256: previousSha256, currentSha256 });
      }
      await opened.write(payload, 0, payload.byteLength, 0);
      await opened.truncate(payload.byteLength);
      await opened.sync();
      return gatewayOk({ path: resolved.path, bytes: payload.byteLength, sha256: sha256(payload), previousSha256 }, requestOptions(principal, input.requestId, startedAt));
    } catch (error) { return errorResult(error, principal, input.requestId, startedAt); }
    finally { await opened?.close().catch(() => undefined); release?.(); }
  }

  async find(input: FileFindInput = {}): Promise<GatewayResult<FileFindData>> {
    const startedAt = Date.now();
    let principal = this.defaultPrincipal;
    try {
      principal = this.principal(input.principal);
      const resolved = await this.resolve({ ...input, path: input.path ?? "." }, "read", principal);
      const metadata = await lstat(resolved.path);
      if (!metadata.isDirectory()) throw new GatewayFileServiceError("invalid_input", "file find root must be a directory");
      const maxResults = this.resultLimit(input.maxResults);
      const maxDepth = input.maxDepth ?? MAX_DEPTH;
      if (!Number.isSafeInteger(maxDepth) || maxDepth < 0 || maxDepth > MAX_DEPTH) throw new GatewayFileServiceError("invalid_input", `maxDepth must be an integer in [0, ${MAX_DEPTH}]`);
      const matches: FileEntry[] = [];
      let truncated = false;
      await this.walk(resolved, 0, maxDepth, async (entry) => {
        const relativeName = entry.relativePath;
        const matched = patternMatches(input.pattern ?? input.name, relativeName) || patternMatches(input.pattern ?? input.name, entry.name);
        if (!matched || (!input.includeDirectories && entry.type !== "file" && entry.type !== "symlink")) return true;
        if (matches.length >= maxResults) { truncated = true; return false; }
        matches.push(entry);
        if (matches.length >= maxResults) truncated = true;
        return matches.length < maxResults;
      }, () => { if (matches.length >= maxResults) truncated = true; }, principal);
      return gatewayOk({ root: resolved.path, matches, truncated }, requestOptions(principal, input.requestId, startedAt));
    } catch (error) { return errorResult(error, principal, input.requestId, startedAt); }
  }

  async grep(input: FileGrepInput): Promise<GatewayResult<FileGrepData>> {
    const startedAt = Date.now();
    let principal = this.defaultPrincipal;
    try {
      principal = this.principal(input.principal);
      const resolved = await this.resolve({ ...input, path: input.path ?? "." }, "read", principal);
      const rootStat = await lstat(resolved.path);
      const maxResults = this.resultLimit(input.maxResults);
      const maximumBytes = input.maxBytes ?? Math.min(this.readLimit(), this.outputLimit());
      if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 1 || maximumBytes > Math.min(this.readLimit(), this.outputLimit())) throw new GatewayFileServiceError("bounds_exceeded", `maxBytes must be in [1, ${Math.min(this.readLimit(), this.outputLimit())}]`);
      const query = input.query ?? input.pattern;
      if (!query) throw new GatewayFileServiceError("invalid_input", "grep query is required");
      let matcher: RegExp | undefined;
      if (input.regex === true) {
        try { matcher = new RegExp(query, "g"); } catch (error) { throw new GatewayFileServiceError("invalid_input", `invalid grep regular expression: ${error instanceof Error ? error.message : String(error)}`); }
      }
      const matches: FileGrepMatch[] = [];
      let truncated = false;
      const inspect = async (entry: FileEntry): Promise<boolean> => {
        if (entry.type !== "file") return true;
        if (matches.length >= maxResults) { truncated = true; return false; }
        if (entry.size > this.readLimit()) throw new GatewayPolicyError(`file read exceeds ${this.readLimit()} bytes`, "bounds_exceeded");
        const bytes = await readFile(entry.path);
        if (bytes.byteLength > this.readLimit()) throw new GatewayPolicyError(`file read exceeds ${this.readLimit()} bytes`, "bounds_exceeded");
        const text = bytes.toString("utf8");
        const lines = text.split(/\r?\n/);
        for (let index = 0; index < lines.length; index += 1) {
          const line = lines[index] ?? "";
          if (matcher) { matcher.lastIndex = 0; if (!matcher.test(line)) continue; }
          else if (!line.includes(query)) continue;
          const projected = `${entry.relativePath}:${index + 1} ${line}`;
          if (utf8Bytes(JSON.stringify(matches)) + utf8Bytes(projected) > maximumBytes) { truncated = true; return false; }
          matches.push({ path: entry.path, relativePath: entry.relativePath, line: index + 1, text: line });
          if (matches.length >= maxResults) { truncated = true; return false; }
        }
        return true;
      };
      if (rootStat.isFile()) {
        await inspect(this.entry(resolved.workspace, resolved.path, rootStat));
      } else if (rootStat.isDirectory()) {
        await this.walk(resolved, 0, MAX_DEPTH, inspect, () => { if (matches.length >= maxResults) truncated = true; }, principal);
      } else throw new GatewayFileServiceError("invalid_input", "grep root must be a regular file or directory");
      return gatewayOk({ root: resolved.path, matches, truncated }, requestOptions(principal, input.requestId, startedAt));
    } catch (error) { return errorResult(error, principal, input.requestId, startedAt); }
  }

  async transfer(input: FileTransferInput): Promise<GatewayResult<FileTransferData>> {
    const startedAt = Date.now();
    let principal = this.defaultPrincipal;
    let release: (() => void) | undefined;
    try {
      principal = this.principal(input.principal);
      release = await this.acquireMutation();
      const sourceRequested = input.source ?? input.from;
      const destinationRequested = input.destination ?? input.to;
      const mode = input.mode ?? "copy";
      if (mode !== "copy" && mode !== "move") throw new GatewayFileServiceError("invalid_input", "transfer mode must be copy or move");
      if (!sourceRequested || !destinationRequested) throw new GatewayFileServiceError("invalid_input", "source and destination are required");
      const source = await this.resolve({ workspace: input.workspace, path: sourceRequested }, "read", principal);
      const destination = await this.resolve({ workspace: input.workspace, path: destinationRequested }, "write", principal);
      if (source.path === destination.path) throw new GatewayFileServiceError("invalid_input", "source and destination must differ");
      const sourceStat = await lstat(source.path);
      if (!sourceStat.isFile()) throw new GatewayFileServiceError("invalid_input", "transfer source must be a regular file");
      if (Number(sourceStat.size) > this.readLimit() || Number(sourceStat.size) > this.writeLimit()) throw new GatewayPolicyError("transfer exceeds file size limit", "bounds_exceeded");
      const content = await readFile(source.path);
      if (content.byteLength > this.readLimit() || content.byteLength > this.writeLimit()) throw new GatewayPolicyError("transfer exceeds file size limit", "bounds_exceeded");
      let existing: Awaited<ReturnType<typeof lstat>> | undefined;
      try { existing = await lstat(destination.path); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      if (existing && input.overwrite === false && existing.isFile()) throw new GatewayPolicyError("destination exists and overwrite is false", "already_exists");
      if (existing && !existing.isFile()) throw new GatewayFileServiceError("invalid_input", "transfer destination must be a regular file");
      await this.assertParent(destination, principal);
      await writeGatewayFileAtomic(destination.path, content, { mode: existing ? Number(existing.mode) & 0o777 : 0o600, maximumBytes: this.writeLimit() });
      if (mode === "move") await rm(source.path, { force: false });
      return gatewayOk({ path: destination.path, source: source.path, mode, bytes: content.byteLength, sha256: sha256(content) }, requestOptions(principal, input.requestId, startedAt));
    } catch (error) { return errorResult(error, principal, input.requestId, startedAt); }
    finally { release?.(); }
  }

  async handle(request: FileActionRequest): Promise<GatewayResult<unknown>> {
    if (request.action === "list") return this.list(request);
    if (request.action === "stat") return this.stat(request);
    if (request.action === "read") return this.read(request);
    if (request.action === "write") {
      if (request.content === undefined) return errorResult(new GatewayFileServiceError("invalid_input", "content is required"), this.defaultPrincipal, request.requestId, Date.now());
      return this.write(request as FileWriteInput);
    }
    if (request.action === "edit") return this.edit(request);
    if (request.action === "find") return this.find(request);
    if (request.action === "grep") return this.grep(request);
    if (request.action === "transfer") return this.transfer(request);
    if (request.action === "realpath") return this.realpath(request);
    return errorResult(new GatewayFileServiceError("invalid_action", `Unsupported file action: ${String(request.action)}`), this.defaultPrincipal, request.requestId, Date.now());
  }

  private principal(value: GatewayPrincipal | undefined): GatewayPrincipal {
    return value === undefined ? this.defaultPrincipal : parseGatewayPrincipal(value);
  }

  private async acquireMutation(): Promise<() => void> {
    let release!: () => void;
    const previous = this.mutationTail;
    this.mutationTail = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    let released = false;
    return () => { if (!released) { released = true; release(); } };
  }

  private workspace(input: FileRequest, principal: GatewayPrincipal): string {
    return input.workspace ?? this.workspaceRoot ?? principal.workspacePath ?? process.cwd();
  }

  private async resolve(input: FileRequest, operation: "read" | "write" | "patch", principal: GatewayPrincipal): Promise<ResolvedPath> {
    const workspace = this.workspace(input, principal);
    const requestedPath = input.path ?? ".";
    if (utf8Bytes(requestedPath) > 4096) throw new GatewayPolicyError("path exceeds 4096 UTF-8 bytes", "bounds_exceeded");
    const path = this.policy
      ? await this.policy.assertPath(principal, workspace, requestedPath, operation)
      : canonicalizeWorkspaceChild(workspace, requestedPath);
    const canonicalWorkspace = canonicalizeWorkspacePath(workspace);
    if (!isPathWithin(canonicalWorkspace, path)) throw new GatewayPolicyError("path escapes the registered workspace", "policy_denied");
    // Resolve once more immediately before I/O so a changed symlink cannot turn
    // a previously authorized path into an external path.
    const rechecked = canonicalizeWorkspaceChild(canonicalWorkspace, requestedPath);
    if (!isPathWithin(canonicalWorkspace, rechecked)) throw new GatewayPolicyError("path escapes the registered workspace", "policy_denied");
    if (rechecked !== path) throw new GatewayPolicyError("path changed during authorization", "path_changed");
    this.assertFilePolicy(relativePath(canonicalWorkspace, path), operation);
    return { workspace: canonicalWorkspace, path, requestedPath };
  }

  private async assertParent(resolved: ResolvedPath, principal: GatewayPrincipal): Promise<void> {
    const parent = dirname(resolved.path);
    const canonicalParent = this.policy
      ? await this.policy.assertPath(principal, resolved.workspace, relative(resolved.workspace, parent) || ".", "write")
      : canonicalizeWorkspaceChild(resolved.workspace, relative(resolved.workspace, parent) || ".");
    if (canonicalParent !== canonicalizeWorkspacePath(parent)) throw new GatewayPolicyError("file parent changed during authorization", "path_changed");
  }

  private assertFilePolicy(relativeName: string, operation: "read" | "write" | "patch"): void {
    const matches = (pattern: string): boolean => patternMatches(pattern, relativeName);
    if ((this.security.deny ?? []).some(matches)) throw new GatewayPolicyError(`file ${operation} is denied by Gateway policy`, "file_denied");
    if ((this.security.confirm ?? []).some(matches)) throw new GatewayPolicyError(`file ${operation} requires confirmation`, "confirmation_required");
    const allow = this.security.allow ?? [];
    if (allow.length > 0 && !allow.some(matches)) throw new GatewayPolicyError(`file ${operation} is not in the allow list`, "file_denied");
  }

  private readLimit(): number {
    return Math.min(
      this.policy?.limits.maxFileReadBytes ?? DEFAULT_READ_BYTES,
      this.security.maxReadBytes ?? Number.MAX_SAFE_INTEGER,
      GATEWAY_HARD_LIMITS.maxFileReadBytes,
    );
  }

  private writeLimit(): number {
    return Math.min(this.policy?.limits.maxFileWriteBytes ?? DEFAULT_WRITE_BYTES, GATEWAY_HARD_LIMITS.maxFileWriteBytes);
  }

  private patchLimit(): number {
    return Math.min(this.policy?.limits.maxPatchFiles ?? GATEWAY_HARD_LIMITS.maxPatchFiles, this.security.maxPatchFiles ?? GATEWAY_HARD_LIMITS.maxPatchFiles, GATEWAY_HARD_LIMITS.maxPatchFiles);
  }

  private outputLimit(): number {
    return this.policy?.limits.maxOutputBytes ?? DEFAULT_READ_BYTES;
  }

  private resultLimit(value: number | undefined): number {
    const result = value ?? this.defaultMaxResults;
    if (!Number.isSafeInteger(result) || result < 1 || result > this.defaultMaxResults) throw new GatewayFileServiceError("invalid_input", `maxResults must be an integer in [1, ${this.defaultMaxResults}]`);
    return result;
  }

  private entry(workspace: string, path: string, metadata: Awaited<ReturnType<typeof lstat>>): FileEntry {
    return {
      path,
      relativePath: relativePath(workspace, path),
      name: basename(path),
      type: typeFor(metadata),
      size: Number(metadata.size),
      modifiedAt: Number(metadata.mtimeMs),
    };
  }

  private async walk(
    root: ResolvedPath,
    depth: number,
    maxDepth: number,
    visitor: (entry: FileEntry) => Promise<boolean | void>,
    onLimit: () => void,
    principal: GatewayPrincipal,
    visited = new Set<string>(),
  ): Promise<boolean> {
    const canonicalDirectory = canonicalizeWorkspacePath(root.path);
    if (visited.has(canonicalDirectory)) return true;
    visited.add(canonicalDirectory);
    const entries: Dirent[] = await readdir(root.path, { withFileTypes: true });
    for (const directoryEntry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      const childRequested = relative(root.workspace, resolve(root.path, directoryEntry.name));
      const child = await this.resolve({ workspace: root.workspace, path: childRequested }, "read", principal);
      const metadata = await lstat(child.path);
      const item = this.entry(root.workspace, child.path, metadata);
      if ((await visitor(item)) === false) return false;
      if (metadata.isDirectory() && depth < maxDepth && !(await this.walk(child, depth + 1, maxDepth, visitor, onLimit, principal, visited))) return false;
      if (metadata.isDirectory() && depth >= maxDepth) onLimit();
    }
    return true;
  }
}

export const GatewayFileService = FileService;
export const createFileService = (options?: FileServiceOptions): FileService => new FileService(options);
export const createGatewayFileService = createFileService;
