/**
 * agent-output-store — teammate 输出持久化（agent:// 数据源）
 *
 * 每个已发布 turn 以不可变 publicationId 存入全局工作区分桶：
 * ~/.pi/teammate-output/<cwd-hash>-<workspace-name>/<publicationId>.json。
 * correlationId 只保留一个轻量 latest alias，供 agent://<correlationId> 兼容读取；
 * canonical agent://<publicationId> 始终指向发布时的原始结果。没有 publicationId 的
 * 旧调用继续使用 correlationId 直接记录。达到容量上限时拒绝新 publication，不淘汰
 * 已被会话引用的旧记录，使调用方可以保留内联全文而不是发布死链接。
 *
 * 任务 name 可能跨多次派发重名：resolveAgentOutput 返回匹配列表（id + 时间 + 内容预览），
 * readAgentOutput 在重名时抛歧义错误，不再静默取最新；精确 id / correlationId alias 不受影响。
 *
 * 分桶按工作区隔离；旧格式 <cwd>/.pi/agents/ 下的历史归档仍保留只读 fallback。
 * 只读消费方：src/tools/resource.ts；写入方：src/teammate/agent-output-capture.ts。
 * 测试可用环境变量 PI_AGENT_OUTPUT_ROOT 覆盖根目录。
 */

import { constants as fsConstants } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { homedir, tmpdir } from "node:os";
import {
  chmod,
  lstat,
  mkdir,
  open,
  readdir,
  realpath,
  rename,
  unlink,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { lockSettingsResource } from "../settings/resource-lock.ts";

const GLOBAL_OUTPUT_DIR_NAME = "teammate-output";
const LEGACY_AGENTS_DIR_NAME = ".pi/agents";
export const MAX_AGENT_FILES = 100;
const MAX_STORED_OUTPUT_CHARS = 512_000;
const MAX_PATH_DEPTH = 10;
const ALIAS_SUFFIX = ".alias.json";
const pendingWrites = new Map<string, Promise<void>>();

export interface AgentOutputRecord {
  correlationId: string;
  publicationId?: string;
  name?: string;
  agent?: string;
  capturedAt: string;
  output: unknown;
}

interface AgentOutputAlias {
  kind: "agent-output-alias";
  correlationId: string;
  publicationId: string;
  fallbackPublicationId?: string;
}

export interface AgentOutputMatch {
  /** 查询用稳定 id（publicationId ?? correlationId），可直接 agent://<id>。 */
  id: string;
  correlationId: string;
  publicationId?: string;
  capturedAt: string;
  /** 单行内容预览。 */
  preview: string;
}

export type AgentOutputResolution =
  | { kind: "record"; record: AgentOutputRecord }
  | { kind: "ambiguous"; name: string; matches: AgentOutputMatch[] };

function outputRootEnv(): string | undefined {
  const value = process.env.PI_AGENT_OUTPUT_ROOT;
  return value && value.length > 0 ? value : undefined;
}

function outputRootResolved(): string {
  return resolve(outputRootEnv() ?? join(homedir(), ".pi", GLOBAL_OUTPUT_DIR_NAME));
}

function workspaceBucketName(cwd: string): string {
  const root = resolve(cwd);
  const hash = createHash("sha256").update(root.toLowerCase()).digest("hex").slice(0, 12);
  const name = basename(root) || "root";
  const sanitized = name.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 40);
  return `${hash}-${sanitized}`;
}

function legacyAgentsDir(cwd: string): string {
  return resolve(cwd, LEGACY_AGENTS_DIR_NAME);
}

function recordFile(dir: string, recordId: string): string {
  return join(dir, `${recordId}.json`);
}

function aliasFile(dir: string, correlationId: string): string {
  return join(dir, `${correlationId}${ALIAS_SUFFIX}`);
}

function isCanonicalRecordName(name: string): boolean {
  return name.endsWith(".json") && !name.endsWith(ALIAS_SUFFIX);
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

async function assertContainedLegacyDir(cwd: string): Promise<string> {
  const root = resolve(cwd);
  const piDir = join(root, ".pi");
  const dir = legacyAgentsDir(root);
  await assertDirectoryNotLinked(piDir, ".pi");
  await assertDirectoryNotLinked(dir, ".pi/agents");
  const [resolvedRoot, resolvedDir] = await Promise.all([realpath(root), realpath(dir)]);
  const contained = relative(resolvedRoot, resolvedDir);
  if (contained.startsWith("..") || isAbsolute(contained)) {
    throw new Error(`Agent output directory escapes workspace: ${resolvedDir}`);
  }
  return dir;
}

/** 准备全局输出根目录；默认路径必须真实位于 homedir 内，且逐层防软链。 */
async function prepareOutputRoot(): Promise<string> {
  const root = outputRootResolved();
  await mkdir(dirname(root), { recursive: true });
  await mkdir(root, { recursive: true, mode: 0o700 }).catch((error) => {
    if (fileErrorCode(error) !== "EEXIST") throw error;
  });
  await assertDirectoryNotLinked(root, GLOBAL_OUTPUT_DIR_NAME);
  if (outputRootEnv() === undefined) {
    const home = resolve(homedir());
    const piDir = join(home, ".pi");
    await assertDirectoryNotLinked(piDir, ".pi");
    const resolvedRoot = await realpath(root);
    const contained = relative(resolve(home), resolvedRoot);
    if (contained.startsWith("..") || isAbsolute(contained)) {
      throw new Error(`Agent output root escapes home directory: ${resolvedRoot}`);
    }
  }
  await mkdir(root, { recursive: true, mode: 0o700 });
  return root;
}

/** 当前工作区对应的全局分桶目录（准备就绪）。 */
async function prepareBucketDir(cwd: string): Promise<string> {
  const root = await prepareOutputRoot();
  const bucket = join(root, workspaceBucketName(cwd));
  await mkdir(bucket, { recursive: true, mode: 0o700 });
  await assertDirectoryNotLinked(bucket, "bucket");
  return bucket;
}

/** Write a private temp file, then replace the record without following it. */
async function writePrivateFile(filePath: string, content: string): Promise<void> {
  const dir = dirname(filePath);
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

/** Read one private regular file without following a symlink. */
async function readPrivateText(filePath: string): Promise<string | undefined> {
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    const info = await lstat(filePath);
    if (info.isSymbolicLink() || !info.isFile()) {
      throw new Error(`Agent output path must be a regular file: ${filePath}`);
    }
    handle = await open(filePath, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
    if (!(await handle.stat()).isFile()) {
      throw new Error(`Agent output path must be a regular file: ${filePath}`);
    }
    return await handle.readFile("utf8");
  } catch (error) {
    if (fileErrorCode(error) === "ENOENT") return undefined;
    throw error;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

/** Create an immutable private record, accepting only byte-identical retries. */
async function writeImmutablePrivateFile(filePath: string, content: string): Promise<void> {
  try {
    await writeFile(filePath, content, { encoding: "utf8", flag: "wx", mode: 0o600 });
    await chmod(filePath, 0o600);
    return;
  } catch (error) {
    if (fileErrorCode(error) !== "EEXIST") throw error;
  }
  const existing = await readPrivateText(filePath);
  if (existing !== content) {
    throw new Error(`Immutable agent output already exists with different content: ${filePath}`);
  }
}

async function canonicalRecordCount(dir: string): Promise<number> {
  const entries = await readdir(dir, { withFileTypes: true });
  return entries.filter((entry) => entry.isFile() && isCanonicalRecordName(entry.name)).length;
}

async function persistAgentOutputNow(
  correlationId: string,
  name: string | undefined,
  agent: string | undefined,
  output: unknown,
  cwd: string,
  publicationId?: string,
): Promise<boolean> {
  const dir = await prepareBucketDir(cwd);
  const release = await lockSettingsResource(join(dir, ".agent-output-store"));
  try {
    const recordId = publicationId ?? correlationId;
    const filePath = recordFile(dir, recordId);
    const existing = await readPrivateText(filePath);
    if (publicationId && existing !== undefined) {
      if (!samePublishedRecord(existing, { correlationId, publicationId, name, agent, output })) {
        throw new Error(`Immutable agent output already exists with different content: ${filePath}`);
      }
      if (!await loadAlias(aliasFile(dir, correlationId), correlationId)) {
        await writePrivateFile(aliasFile(dir, correlationId), JSON.stringify({
          kind: "agent-output-alias",
          correlationId,
          publicationId,
        } satisfies AgentOutputAlias));
      }
      return true;
    }
    if (existing === undefined && await canonicalRecordCount(dir) >= MAX_AGENT_FILES) {
      return false;
    }

    const content = JSON.stringify({
      correlationId,
      ...(publicationId ? { publicationId } : {}),
      ...(name ? { name } : {}),
      ...(agent ? { agent } : {}),
      capturedAt: new Date().toISOString(),
      output,
    });
    if (publicationId) {
      const currentAlias = await loadAlias(aliasFile(dir, correlationId), correlationId);
      const fallbackPublicationId = currentAlias
        ? (await resolveAliasedRecord(dir, correlationId, currentAlias))?.publicationId
        : undefined;
      await writePrivateFile(aliasFile(dir, correlationId), JSON.stringify({
        kind: "agent-output-alias",
        correlationId,
        publicationId,
        ...(fallbackPublicationId ? { fallbackPublicationId } : {}),
      } satisfies AgentOutputAlias));
      await writeImmutablePrivateFile(filePath, content);
    } else {
      await writePrivateFile(filePath, content);
    }
    return true;
  } finally {
    await release();
  }
}

/** Queue one validated record write and report whether it was accepted. */
function enqueueAgentOutput(
  correlationId: string,
  name: string | undefined,
  agent: string | undefined,
  output: unknown,
  cwd: string,
  publicationId?: string,
): Promise<boolean> {
  if (!isRecordId(correlationId) || output === undefined) return Promise.resolve(false);
  if (publicationId !== undefined && !isRecordId(publicationId)) return Promise.resolve(false);
  if (safeStringify(output) === null) return Promise.resolve(false);

  const key = resolve(cwd);
  const previous = pendingWrites.get(key) ?? Promise.resolve();
  const current = previous.catch(() => undefined).then(() =>
    persistAgentOutputNow(correlationId, name, agent, output, cwd, publicationId)
  );
  let tracked: Promise<void>;
  tracked = current.then(() => undefined, () => undefined).finally(() => {
    if (pendingWrites.get(key) === tracked) pendingWrites.delete(key);
  });
  pendingWrites.set(key, tracked);
  return current;
}

/** Persist a latest-value compatibility record when no publication id is available. */
export async function persistAgentOutput(
  correlationId: string,
  name: string | undefined,
  agent: string | undefined,
  output: unknown,
  cwd: string,
): Promise<void> {
  await enqueueAgentOutput(correlationId, name, agent, output, cwd);
}

/** Persist one result and expose validation/capacity skips to acknowledgement callers. */
export function persistAgentOutputChecked(
  correlationId: string,
  name: string | undefined,
  agent: string | undefined,
  output: unknown,
  cwd: string,
  publicationId?: string,
): Promise<boolean> {
  return enqueueAgentOutput(correlationId, name, agent, output, cwd, publicationId);
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

function samePublishedRecord(
  text: string,
  expected: {
    correlationId: string;
    publicationId: string;
    name: string | undefined;
    agent: string | undefined;
    output: unknown;
  },
): boolean {
  const record = parseRecord(text);
  return record?.correlationId === expected.correlationId
    && record.publicationId === expected.publicationId
    && record.name === expected.name
    && record.agent === expected.agent
    && safeStringify(record.output) === safeStringify(expected.output);
}

function parseAlias(text: string): AgentOutputAlias | null {
  try {
    const parsed = JSON.parse(text) as Partial<AgentOutputAlias>;
    const fallbackValid = parsed.fallbackPublicationId === undefined
      || isRecordId(parsed.fallbackPublicationId);
    return parsed.kind === "agent-output-alias"
      && typeof parsed.correlationId === "string"
      && isRecordId(parsed.correlationId)
      && typeof parsed.publicationId === "string"
      && isRecordId(parsed.publicationId)
      && fallbackValid
      ? parsed as AgentOutputAlias
      : null;
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

async function loadAlias(
  filePath: string,
  expectedCorrelationId: string,
): Promise<AgentOutputAlias | null> {
  try {
    const text = await readPrivateText(filePath);
    if (text === undefined) return null;
    const alias = parseAlias(text);
    return alias?.correlationId === expectedCorrelationId ? alias : null;
  } catch {
    return null;
  }
}

async function resolveAliasedRecord(
  dir: string,
  correlationId: string,
  alias: AgentOutputAlias,
): Promise<AgentOutputRecord | null> {
  const target = await loadRecord(recordFile(dir, alias.publicationId));
  if (target?.publicationId === alias.publicationId && target.correlationId === correlationId) {
    return target;
  }
  if (!alias.fallbackPublicationId) return null;
  const fallback = await loadRecord(recordFile(dir, alias.fallbackPublicationId));
  return fallback?.publicationId === alias.fallbackPublicationId
    && fallback.correlationId === correlationId
    ? fallback
    : null;
}

/** 列表项内容预览：字符串压缩空白截断，结构化输出 JSON 序列化后截断。 */
function outputPreview(output: unknown, maxChars = 140): string {
  let text: string;
  if (typeof output === "string") text = output;
  else {
    try {
      text = JSON.stringify(output) ?? String(output);
    } catch {
      text = String(output);
    }
  }
  const single = text.replace(/\s+/g, " ").trim();
  return single.length <= maxChars ? single : `${single.slice(0, maxChars - 1)}…`;
}

/** 重名匹配列表：id（可 agent://<id> 直接查询）+ 捕获时间 + 内容预览，新在前。 */
export function formatAgentMatchListing(name: string, matches: AgentOutputMatch[]): string {
  return [
    `Multiple outputs match agent name "${name}" (${matches.length}) — query by id to select one:`,
    "",
    ...matches.map((match) => `- agent://${match.id} — ${match.capturedAt} — ${match.preview}`),
    "",
    "Newest first. A publicationId is immutable; a correlationId always resolves to the latest result of that task.",
  ].join("\n");
}

/** 扫描桶内 name 匹配的记录（capturedAt 降序、平手按 correlationId 降序），并收集可用记录 id。 */
async function scanByName(
  id: string,
  dirs: Array<{ path: string; aliases: boolean }>,
): Promise<{ records: AgentOutputRecord[]; available: string[] }> {
  const records: AgentOutputRecord[] = [];
  const available: string[] = [];
  for (const entry of dirs) {
    let names: string[];
    try {
      names = await readdir(entry.path);
    } catch {
      continue;
    }
    for (const name of names.filter(isCanonicalRecordName)) {
      available.push(name.replace(/\.json$/, ""));
      const record = await loadRecord(join(entry.path, name));
      if (record?.name === id) records.push(record);
    }
  }
  records.sort((a, b) => String(b.capturedAt).localeCompare(String(a.capturedAt))
    || String(b.correlationId).localeCompare(String(a.correlationId)));
  return { records, available };
}

/**
 * 按 publicationId、correlationId latest alias 或任务 name 解析持久化输出。
 * 任务 name 命中多条记录时返回歧义列表（id + 时间 + 预览），不静默取最新。
 * 仅受控全局桶解析 alias；旧工作区目录只支持精确 legacy 记录和 name 扫描。
 */
export async function resolveAgentOutput(id: string, cwd: string): Promise<AgentOutputResolution> {
  const dirs: Array<{ path: string; aliases: boolean }> = [];
  try {
    dirs.push({ path: await prepareBucketDir(cwd), aliases: true });
  } catch (error) {
    if (fileErrorCode(error) !== "ENOENT") throw error;
  }
  try {
    dirs.push({ path: await assertContainedLegacyDir(cwd), aliases: false });
  } catch (error) {
    if (fileErrorCode(error) !== "ENOENT") throw error;
  }

  if (isRecordId(id)) {
    for (const entry of dirs) {
      if (entry.aliases) {
        const alias = await loadAlias(aliasFile(entry.path, id), id);
        if (alias) {
          const target = await resolveAliasedRecord(entry.path, id, alias);
          if (target) return { kind: "record", record: target };
        }
      }
      const direct = await loadRecord(recordFile(entry.path, id));
      if (direct && (direct.publicationId === undefined || direct.publicationId === id)) {
        return { kind: "record", record: direct };
      }
    }
  }

  const { records, available } = await scanByName(id, dirs);
  if (records.length === 1) return { kind: "record", record: records[0]! };
  if (records.length > 1) {
    return {
      kind: "ambiguous",
      name: id,
      matches: records.map((record) => ({
        id: record.publicationId ?? record.correlationId,
        correlationId: record.correlationId,
        ...(record.publicationId ? { publicationId: record.publicationId } : {}),
        capturedAt: record.capturedAt,
        preview: outputPreview(record.output),
      })),
    };
  }

  throw new Error(
    `No persisted teammate output for "${id}". ` +
    `Available agent ids: ${available.slice(0, 20).join(", ") || "(none)"}. ` +
    "Outputs are captured when a teammate task finishes (its final answer, or the validated outputSchema value).",
  );
}

/**
 * 按 publicationId、correlationId latest alias 或任务 name 读取持久化输出。
 * 任务 name 命中多条记录时抛出含匹配列表（id + 时间 + 预览）的歧义错误；
 * 需要区分处理时使用 resolveAgentOutput。
 */
export async function readAgentOutput(id: string, cwd: string): Promise<AgentOutputRecord> {
  const resolved = await resolveAgentOutput(id, cwd);
  if (resolved.kind === "ambiguous") {
    throw new Error(formatAgentMatchListing(resolved.name, resolved.matches));
  }
  return resolved.record;
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
