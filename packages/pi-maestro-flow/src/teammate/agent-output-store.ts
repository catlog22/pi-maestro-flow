/**
 * agent-output-store — teammate 结构化输出持久化（agent:// 数据源）
 *
 * teammate 子代理的 structured output 是临时的（完成即清理临时文件），本模块在
 * flow 的 tool_result 钩子捕获到结果时，把输出按 correlationId 持久化到
 * <cwd>/.pi/agents/<correlationId>.json，供 resource 工具的 agent:// scheme
 * 按 id 或任务 name 读取，支持 JSON 路径取值（agent://<id>/findings.0.path）。
 *
 * 只读消费方：src/tools/resource.ts；写入方：extension/index.ts tool_result 钩子。
 */

import { mkdir, readFile, readdir, stat, unlink, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

const AGENT_OUTPUT_DIR_NAME = ".pi/agents";
const MAX_AGENT_FILES = 100;
const MAX_STORED_OUTPUT_CHARS = 512_000;
const MAX_PATH_DEPTH = 10;

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

/** 新文件全部用私有权限创建（wx 防覆盖 + 0600）；目录 0700。 */
async function writePrivateFile(filePath: string, content: string): Promise<void> {
  await mkdir(resolve(filePath, ".."), { recursive: true, mode: 0o700 });
  await writeFile(filePath, content, { encoding: "utf8", flag: "wx", mode: 0o600 });
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

/**
 * 持久化一个 teammate 结果的结构化输出。输出过大或不可序列化时跳过（静默）。
 * 已存在同名文件（重跑）时跳过，保留先前的捕获。
 */
export async function persistAgentOutput(
  correlationId: string,
  name: string | undefined,
  agent: string | undefined,
  output: unknown,
  cwd: string,
): Promise<void> {
  if (!isRecordId(correlationId) || output === undefined || output === null) return;
  const text = safeStringify(output);
  if (text === null) return;

  const filePath = recordFile(cwd, correlationId);
  try {
    await writePrivateFile(filePath, JSON.stringify({
      correlationId,
      ...(name ? { name } : {}),
      ...(agent ? { agent } : {}),
      capturedAt: new Date().toISOString(),
      output,
    }));
  } catch {
    // wx 已存在 → 保留先前捕获；其它写入失败静默（捕获不得破坏工具执行）。
    return;
  }
  await pruneAgentsDir(cwd);
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

function loadRecord(filePath: string): Promise<AgentOutputRecord | null> {
  return readFile(filePath, "utf8")
    .then(parseRecord)
    .catch(() => null);
}

/** 按 correlationId 或任务 name 读取已持久化的输出记录；name 有歧义时取最新（capturedAt）。 */
export async function readAgentOutput(id: string, cwd: string): Promise<AgentOutputRecord> {
  if (isRecordId(id)) {
    const direct = await loadRecord(recordFile(cwd, id));
    if (direct) return direct;
  }

  const dir = agentsDir(cwd);
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    names = [];
  }
  const byName: AgentOutputRecord[] = [];
  for (const name of names.filter((n) => n.endsWith(".json"))) {
    const record = await loadRecord(join(dir, name));
    if (record?.name === id) byName.push(record);
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
    "Outputs are captured when a teammate task finishes with an outputSchema.",
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
