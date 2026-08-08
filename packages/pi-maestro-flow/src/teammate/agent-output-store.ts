/**
 * agent-output-store — teammate 结构化输出持久化（agent:// 数据源）
 *
 * teammate 子代理的 structured output 是临时的（完成即清理临时文件），本模块由
 * flow 的前台 tool_result 钩子和后台 teammate:complete 事件共同驱动，把输出按
 * correlationId 持久化到 <cwd>/.pi/agents/<correlationId>.json，供 resource 工具的
 * agent:// scheme 按 id 或任务 name 读取，支持 JSON 路径取值。
 *
 * 只读消费方：src/tools/resource.ts；写入方：src/teammate/agent-output-capture.ts。
 */

import { constants as fsConstants } from "node:fs";
import { randomUUID } from "node:crypto";
import {
  chmod,
  lstat,
  mkdir,
  open,
  readdir,
  realpath,
  rename,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";

const AGENT_OUTPUT_DIR_NAME = ".pi/agents";
const MAX_AGENT_FILES = 100;
const MAX_STORED_OUTPUT_CHARS = 512_000;
const MAX_PATH_DEPTH = 10;
const pendingWrites = new Map<string, Promise<void>>();

export interface AgentOutputRecord {
  correlationId: string;
  name?: string;
  agent?: string;
  capturedAt: string;
  output: unknown;
}

function agentsDir(cwd: string): string {
  return resolve(cwd, AGENT_OUTPUT_DIR_NAME);
}

function recordFile(cwd: string, correlationId: string): string {
  return join(agentsDir(cwd), `${correlationId}.json`);
}

function isRecordId(id: string): boolean {
  return /^[a-zA-Z0-9-]+$/.test(id);
}

function safeStringify(output: unknown): string | null {
  try {
    const text = JSON.stringify(output);
    if (text === undefined) return null;
    if (text.length > MAX_STORED_OUTPUT_CHARS) return null;
    return text;
  } catch {
    return null;
  }
}

function fileErrorCode(error: unknown): string | undefined {
  return error instanceof Error && "code" in error
    ? String((error as NodeJS.ErrnoException).code)
    : undefined;
}

async function assertDirectoryNotLinked(path: string, label: string): Promise<void> {
  const info = await lstat(path);
  if (info.isSymbolicLink() || !info.isDirectory()) {
    throw new Error(`${label} must be a real directory: ${path}`);
  }
}

async function assertContainedAgentsDir(cwd: string): Promise<string> {
  const root = resolve(cwd);
  const piDir = join(root, ".pi");
  const dir = agentsDir(root);
  await assertDirectoryNotLinked(piDir, ".pi");
  await assertDirectoryNotLinked(dir, ".pi/agents");
  const [resolvedRoot, resolvedDir] = await Promise.all([realpath(root), realpath(dir)]);
  const contained = relative(resolvedRoot, resolvedDir);
  if (contained.startsWith("..") || isAbsolute(contained)) {
    throw new Error(`Agent output directory escapes workspace: ${resolvedDir}`);
  }
  return dir;
}

async function prepareAgentsDir(cwd: string): Promise<string> {
  const root = resolve(cwd);
  const piDir = join(root, ".pi");
  const dir = agentsDir(root);
  await mkdir(piDir, { recursive: true, mode: 0o700 });
  await assertDirectoryNotLinked(piDir, ".pi");
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await assertContainedAgentsDir(root);
  if (process.platform !== "win32") await chmod(dir, 0o700);
  return dir;
}

/** Write a private temp file, then replace the record without following it. */
async function writePrivateFile(filePath: string, content: string, cwd: string): Promise<void> {
  const dir = await prepareAgentsDir(cwd);
  const tempPath = join(dir, `.${randomUUID()}.tmp`);
  await writeFile(tempPath, content, { encoding: "utf8", flag: "wx", mode: 0o600 });
  try {
    const existing = await lstat(filePath).catch((error) => {
      if (fileErrorCode(error) === "ENOENT") return undefined;
      throw error;
    });
    if (existing && (existing.isSymbolicLink() || !existing.isFile())) {
      throw new Error(`Agent output path must be a regular file: ${filePath}`);
    }
    try {
      await rename(tempPath, filePath);
    } catch (error) {
      // Windows does not reliably replace an existing file with rename().
      if (fileErrorCode(error) !== "EEXIST" && fileErrorCode(error) !== "EPERM") throw error;
      const current = await lstat(filePath);
      if (current.isSymbolicLink() || !current.isFile()) {
        throw new Error(`Agent output path must be a regular file: ${filePath}`);
      }
      await unlink(filePath);
      await rename(tempPath, filePath);
    }
  } finally {
    await unlink(tempPath).catch(() => undefined);
  }
}

/** 保持目录内文件数不超过上限：删除最旧的（按 mtime）。 */
async function pruneAgentsDir(cwd: string): Promise<void> {
  const dir = agentsDir(cwd);
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  const files = entries
    .filter((e) => e.isFile() && e.name.endsWith(".json"))
    .map((e) => e.name);
  if (files.length <= MAX_AGENT_FILES) return;

  const withMtime = await Promise.all(files.map(async (name) => {
    try {
      const s = await stat(join(dir, name));
      return { name, mtime: s.mtimeMs };
    } catch {
      return { name, mtime: 0 };
    }
  }));
  withMtime.sort((a, b) => a.mtime - b.mtime);
  for (const stale of withMtime.slice(0, withMtime.length - MAX_AGENT_FILES)) {
    try {
      await unlink(join(dir, stale.name));
    } catch {
      // best effort
    }
  }
}

async function persistAgentOutputNow(
  correlationId: string,
  name: string | undefined,
  agent: string | undefined,
  output: unknown,
  cwd: string,
): Promise<void> {
  const filePath = recordFile(cwd, correlationId);
  await writePrivateFile(filePath, JSON.stringify({
    correlationId,
    ...(name ? { name } : {}),
    ...(agent ? { agent } : {}),
    capturedAt: new Date().toISOString(),
    output,
  }), cwd);
  await pruneAgentsDir(cwd);
}

/** Queue one validated record write and report whether it was accepted. */
function enqueueAgentOutput(
  correlationId: string,
  name: string | undefined,
  agent: string | undefined,
  output: unknown,
  cwd: string,
): Promise<boolean> {
  if (!isRecordId(correlationId) || output === undefined) return Promise.resolve(false);
  if (safeStringify(output) === null) return Promise.resolve(false);

  const key = recordFile(cwd, correlationId);
  const previous = pendingWrites.get(key) ?? Promise.resolve();
  const current = previous.catch(() => undefined).then(() =>
    persistAgentOutputNow(correlationId, name, agent, output, cwd)
  );
  let tracked: Promise<void>;
  tracked = current.finally(() => {
    if (pendingWrites.get(key) === tracked) pendingWrites.delete(key);
  });
  pendingWrites.set(key, tracked);
  return tracked.then(() => true);
}

/**
 * Persist one teammate result. Calls for the same record are serialized in
 * invocation order, so a later warm turn atomically replaces the prior value.
 */
export async function persistAgentOutput(
  correlationId: string,
  name: string | undefined,
  agent: string | undefined,
  output: unknown,
  cwd: string,
): Promise<void> {
  await enqueueAgentOutput(correlationId, name, agent, output, cwd);
}

/** Persist one result and expose validation skips to reliability-sensitive callers. */
export function persistAgentOutputChecked(
  correlationId: string,
  name: string | undefined,
  agent: string | undefined,
  output: unknown,
  cwd: string,
): Promise<boolean> {
  return enqueueAgentOutput(correlationId, name, agent, output, cwd);
}

function parseRecord(text: string): AgentOutputRecord | null {
  try {
    const parsed = JSON.parse(text) as Partial<AgentOutputRecord>;
    if (typeof parsed.correlationId === "string" && "output" in parsed) {
      return parsed as AgentOutputRecord;
    }
    return null;
  } catch {
    return null;
  }
}

async function loadRecord(filePath: string): Promise<AgentOutputRecord | null> {
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    const info = await lstat(filePath);
    if (info.isSymbolicLink() || !info.isFile()) return null;
    handle = await open(filePath, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
    if (!(await handle.stat()).isFile()) return null;
    return parseRecord(await handle.readFile("utf8"));
  } catch {
    return null;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

/** 按 correlationId 或任务 name 读取已持久化的输出记录；name 有歧义时取最新（capturedAt）。 */
export async function readAgentOutput(id: string, cwd: string): Promise<AgentOutputRecord> {
  let dir: string | undefined;
  try {
    dir = await assertContainedAgentsDir(cwd);
  } catch (error) {
    if (fileErrorCode(error) !== "ENOENT") throw error;
  }
  if (dir && isRecordId(id)) {
    const direct = await loadRecord(join(dir, `${id}.json`));
    if (direct) return direct;
  }

  let names: string[];
  try {
    names = dir ? await readdir(dir) : [];
  } catch {
    names = [];
  }
  const byName: AgentOutputRecord[] = [];
  if (dir) {
    for (const name of names.filter((n) => n.endsWith(".json"))) {
      const record = await loadRecord(join(dir, name));
      if (record?.name === id) byName.push(record);
    }
  }
  if (byName.length > 0) {
    byName.sort((a, b) => String(b.capturedAt).localeCompare(String(a.capturedAt))
      || String(b.correlationId).localeCompare(String(a.correlationId)));
    return byName[0]!;
  }

  const available = names.filter((n) => n.endsWith(".json")).map((n) => n.replace(/\.json$/, ""));
  throw new Error(
    `No persisted teammate output for "${id}". ` +
    `Available agent ids: ${available.slice(0, 20).join(", ") || "(none)"}. ` +
    "Outputs are captured when a teammate task finishes (its final answer, or the validated outputSchema value).",
  );
}

export interface PathHit {
  hit: true;
  value: unknown;
}

export interface PathMiss {
  hit: false;
  reason: string;
}

function describeKey(obj: Record<string, unknown> | unknown[]): string {
  if (Array.isArray(obj)) return `array with ${obj.length} item(s)`;
  return `keys: ${Object.keys(obj).slice(0, 20).join(", ") || "(none)"}`;
}

/**
 * JSON 路径取值：segments 为 key 或数字下标（findings.0.path → obj.findings[0].path）。
 * 仅允许普通对象/数组/原始值，hasOwnProperty 防原型链，深度受限。
 */
export function getAgentOutputPath(output: unknown, segments: string[]): PathHit | PathMiss {
  if (segments.length === 0) return { hit: true, value: output };
  if (segments.length > MAX_PATH_DEPTH) {
    return { hit: false, reason: `path too deep (max ${MAX_PATH_DEPTH} segments)` };
  }

  let current: unknown = output;
  for (const segment of segments) {
    if (current === null || current === undefined) {
      return { hit: false, reason: `"${segment}" reached a null value` };
    }
    if (Array.isArray(current)) {
      if (!/^\d+$/.test(segment)) {
        return { hit: false, reason: `"${segment}" is not a numeric index into ${describeKey(current)}` };
      }
      const index = Number(segment);
      if (!Object.prototype.hasOwnProperty.call(current, index)) {
        return { hit: false, reason: `index ${index} out of bounds (${describeKey(current)})` };
      }
      current = current[index];
      continue;
    }
    if (typeof current === "object") {
      const obj = current as Record<string, unknown>;
      if (!Object.prototype.hasOwnProperty.call(obj, segment)) {
        return { hit: false, reason: `key "${segment}" not found (${describeKey(obj)})` };
      }
      current = obj[segment];
      continue;
    }
    return { hit: false, reason: `"${segment}" attempted to descend into a ${typeof current} value` };
  }
  return { hit: true, value: current };
}
