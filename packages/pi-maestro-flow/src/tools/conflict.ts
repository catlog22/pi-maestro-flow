/**
 * conflict — git 冲突解决工具（T2-3）
 *
 * 把每个合并冲突变成可寻址的 conflict://N 资源：
 * - list    — 扫描未合并文件（git diff --name-only --diff-filter=U）+ 冲突标记，编号冲突
 * - diff    — 展示单个冲突的三方内容（@ours / @theirs）
 * - resolve — 用 @ours / @theirs / 自定义内容解决单个（conflict://N）或全部（conflict://*）冲突
 *
 * 设计约束（docs/oh-my-pi-feature-extension-plan-20260803.md §T2-3）：
 * - 独立工具，不并入 resource（涉及写，resource 纯只读）
 * - resolve 是文件写操作：plan 模式阻止、权限按模式 ask/deny/acceptEdits 处理
 * - v1 不支持 @base（逐 hunk 的 base 定位不可靠，报错引导用 git show :1:<path>）
 */

import { readFile, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { resolve } from "node:path";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { Text } from "@earendil-works/pi-tui";
import { toolCallLine, toolResultLine, resultSummary } from "../quiet-render.ts";

export const ConflictParams = Type.Object({
  action: Type.Union([
    Type.Literal("list"),
    Type.Literal("diff"),
    Type.Literal("resolve"),
  ]),
  uri: Type.Optional(Type.String({ description: "Conflict URI. Required for diff/resolve; use conflict://N for one conflict or conflict://* for bulk resolve." })),
  content: Type.Optional(Type.String({ minLength: 1, description: "Resolution content. Required for resolve; accepts @ours, @theirs, or custom text." })),
}, {
  additionalProperties: false,
  allOf: [
    {
      if: { properties: { action: { const: "diff" } }, required: ["action"] },
      then: { required: ["uri"] },
    },
    {
      if: { properties: { action: { const: "resolve" } }, required: ["action"] },
      then: { required: ["uri", "content"] },
    },
  ],
});

export interface ConflictDetails {
  action: string;
  conflict_count: number;
  files: string[];
  resolved: number;
}

export interface GitRunResult {
  ok: boolean;
  stdout: string;
  stderr: string;
}

export interface GitRunner {
  run(args: string[], cwd: string): Promise<GitRunResult>;
}

const defaultGitRunner: GitRunner = {
  run(args, cwd): Promise<GitRunResult> {
    return new Promise((resolvePromise) => {
      execFile("git", args, { cwd, timeout: 15_000, maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => {
        if (err) {
          resolvePromise({ ok: false, stdout: "", stderr: (stderr || "").trim() || err.message });
          return;
        }
        resolvePromise({ ok: true, stdout, stderr });
      });
    });
  },
};

const HUNK_RE = /^<<<<<<<[^\r\n]*\r?\n([\s\S]*?)\r?\n?=======\r?\n?([\s\S]*?)\r?\n?>>>>>>>[^\r\n]*(?=\r?\n|$)/gm;

const OPEN_MARKER_RE = /^<<<<<<</;
const CLOSE_MARKER_RE = /^>>>>>>>/;
const BASE_MARKER_RE = /^\|\|\|\|\|\|\|/;

export interface ConflictHunk {
  /** 冲突块起始偏移（<<<<<<< 行首）。 */
  start: number;
  /** 冲突块总长度（含标记行，不含 >>>>>>> 行后的换行）。 */
  length: number;
  ours: string;
  theirs: string;
  /** 完整原始冲突块（含标记），供写入前一致性校验。 */
  raw: string;
}

export interface ConflictFile {
  path: string;
  hunks: ConflictHunk[];
  /** 文件级解析问题（不平衡标记 / diff3 / 不可读）；无问题为 null。 */
  parseIssue?: string | null;
}

/** 返回文件级解析问题（不平衡标记 / diff3），无问题返回 null。 */
export function conflictParseIssue(content: string): string | null {
  let open = 0;
  let close = 0;
  let base = 0;
  for (const line of content.split(/\r?\n/)) {
    if (OPEN_MARKER_RE.test(line)) open++;
    else if (CLOSE_MARKER_RE.test(line)) close++;
    else if (BASE_MARKER_RE.test(line)) base++;
  }
  if (base > 0) {
    return "diff3-style conflict markers (|||||||) are not supported — resolve manually";
  }
  if (open !== close) {
    return `unbalanced conflict markers (${open} open vs ${close} close) — resolve manually`;
  }
  return null;
}

/** 解析文件内容中的冲突标记为 hunks（含精确偏移，供替换）。CRLF / 空侧 / 无尾部换行均兼容；不平衡或 diff3 返回空。 */
export function parseConflictHunks(content: string): ConflictHunk[] {
  if (conflictParseIssue(content) !== null) return [];
  const hunks: ConflictHunk[] = [];
  HUNK_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = HUNK_RE.exec(content)) !== null) {
    hunks.push({
      start: match.index,
      length: match[0].length,
      ours: match[1]!,
      theirs: match[2]!,
      raw: match[0],
    });
  }
  return hunks;
}

/** 扫描未合并文件及其冲突 hunks。git 不可用或非仓库时 ok=false。 */
export async function scanConflicts(cwd: string, runner: GitRunner = defaultGitRunner): Promise<{ ok: boolean; error?: string; files: ConflictFile[] }> {
  const result = await runner.run(["diff", "--name-only", "--diff-filter=U", "-z"], cwd);
  if (!result.ok) {
    return { ok: false, error: result.stderr || "git diff failed", files: [] };
  }
  const paths = result.stdout.split("\0").filter(Boolean);
  const files: ConflictFile[] = [];
  for (const rawPath of paths) {
    const filePath = resolve(cwd, rawPath);
    let content: string;
    try {
      content = await readFile(filePath, "utf8");
    } catch {
      files.push({ path: rawPath, hunks: [], parseIssue: "unreadable file" });
      continue;
    }
    const parseIssue = conflictParseIssue(content);
    files.push({ path: rawPath, hunks: parseIssue === null ? parseConflictHunks(content) : [], parseIssue });
  }
  return { ok: true, files };
}

interface FlatConflict {
  uri: string;
  file: ConflictFile;
  hunkIndex: number;
}

function flattenConflicts(files: ConflictFile[]): FlatConflict[] {
  const flat: FlatConflict[] = [];
  for (const file of files) {
    for (let i = 0; i < file.hunks.length; i++) {
      flat.push({ uri: `conflict://${flat.length + 1}`, file, hunkIndex: i });
    }
  }
  return flat;
}

function renderList(files: ConflictFile[]): string {
  if (files.length === 0) return "No merge conflicts found.";
  const lines: string[] = [];
  let index = 0;
  for (const file of files) {
    if (file.hunks.length === 0) {
      const note = file.parseIssue ?? "unmerged, no parseable conflict markers";
      lines.push(`- ${file.path} (${note} — resolve manually)`);
      continue;
    }
    const uris = file.hunks.map(() => `conflict://${++index}`).join(", ");
    lines.push(`- ${file.path}: ${uris}`);
  }
  if (index === 0) {
    return `Unmerged paths without parseable conflicts:\n${lines.join("\n")}`;
  }
  return `Found ${index} conflict(s):\n${lines.join("\n")}`;
}

function renderDiff(conflict: FlatConflict, fileContent: string): string {
  const { file, hunkIndex } = conflict;
  const hunk = file.hunks[hunkIndex]!;
  const lineRange = lineRangeOf(fileContent, hunk.start, hunk.length);
  return [
    `## ${conflict.uri} · ${file.path}${lineRange ? ` (lines ${lineRange})` : ""} (hunk ${hunkIndex + 1} of ${file.hunks.length})`,
    "",
    "### @ours",
    "",
    hunk.ours || "(empty)",
    "",
    "### @theirs",
    "",
    hunk.theirs || "(empty)",
    "",
    "Resolve with @ours, @theirs, or custom content. @base is not supported in v1 — use `git show :1:<path>` via bash if needed.",
  ].join("\n");
}

function lineRangeOf(content: string, start: number, length: number): string | null {
  const before = content.slice(0, start);
  const startLine = before.split("\n").length;
  const block = content.slice(start, start + length);
  const endLine = startLine + block.split("\n").length - 1;
  return startLine === endLine ? String(startLine) : `${startLine}-${endLine}`;
}

function resolveHunkContent(hunk: ConflictHunk, content: string): string {
  const directive = content.trim();
  if (directive === "@ours") return hunk.ours;
  if (directive === "@theirs") return hunk.theirs;
  // 自定义内容按原值写入（保留首尾空白）
  return content;
}

async function applyResolution(
  cwd: string,
  targets: FlatConflict[],
  content: string,
  signal?: AbortSignal,
): Promise<{ files: string[]; resolved: number }> {
  if (signal?.aborted) throw new Error("Tool execution aborted.");

  const byFile = new Map<string, { file: ConflictFile; hunks: Array<{ hunk: ConflictHunk; replacement: string }> }>();
  for (const target of targets) {
    const hunk = target.file.hunks[target.hunkIndex]!;
    const entry = byFile.get(target.file.path) ?? { file: target.file, hunks: [] };
    entry.hunks.push({ hunk, replacement: resolveHunkContent(hunk, content) });
    byFile.set(target.file.path, entry);
  }

  // 阶段一：全量预读 + 预验证（任何一处失效都不写入任何文件）
  const prepared: Array<{
    path: string;
    filePath: string;
    replacements: Array<{ start: number; length: number; raw: string; replacement: string }>;
  }> = [];
  for (const [path, entry] of byFile) {
    const filePath = resolve(cwd, path);
    let text: string;
    try {
      text = await readFile(filePath, "utf8");
    } catch (err) {
      throw new Error(`Cannot read ${path}: ${err instanceof Error ? err.message : String(err)}`);
    }
    const replacements = entry.hunks
      .map(({ hunk, replacement }) => ({ start: hunk.start, length: hunk.length, raw: hunk.raw, replacement }))
      .sort((a, b) => b.start - a.start);
    for (const r of replacements) {
      if (r.start + r.length > text.length || text.slice(r.start, r.start + r.length) !== r.raw) {
        throw new Error(`Conflict at offset ${r.start} in ${path} changed since scan — re-run conflict list and retry.`);
      }
    }
    prepared.push({ path, filePath, replacements });
  }

  // 阶段二：写入（文件间检查 signal；中途取消则明确报告已写入部分）
  const changed: string[] = [];
  let resolved = 0;
  for (const { path, filePath, replacements } of prepared) {
    if (signal?.aborted) {
      throw new Error(`Tool execution aborted after ${changed.length} file(s) written (${changed.join(", ") || "none"}). Re-run conflict list before continuing.`);
    }
    let text: string;
    try {
      text = await readFile(filePath, "utf8");
    } catch (err) {
      throw new Error(`Cannot read ${path} during write: ${err instanceof Error ? err.message : String(err)}`);
    }
    for (const r of replacements) {
      if (text.slice(r.start, r.start + r.length) !== r.raw) {
        throw new Error(`Conflict at offset ${r.start} in ${path} changed during write — re-run conflict list and retry.`);
      }
      text = text.slice(0, r.start) + r.replacement + text.slice(r.start + r.length);
    }
    await writeFile(filePath, text, "utf8");
    changed.push(path);
    resolved += replacements.length;
  }
  return { files: changed, resolved };
}

function parseResolveTargets(uri: string, flat: FlatConflict[]): FlatConflict[] {
  if (uri === "conflict://*") return flat;
  const match = /^conflict:\/\/(\d+)$/.exec(uri);
  if (!match) {
    throw new Error(`Invalid conflict uri "${uri}". Expected conflict://<N> or conflict://*. Run conflict list to see the numbered conflicts.`);
  }
  const index = Number(match[1]!);
  const target = flat.find((c) => Number(c.uri.split("/")[2]) === index);
  if (!target) {
    throw new Error(`conflict://${index} not found. Run conflict list to refresh the conflict numbering.`);
  }
  return [target];
}

function trimOutput(text: string): string {
  const trimmed = text.trim();
  const MAX = 100_000;
  if (trimmed.length <= MAX) return trimmed;
  return `${trimmed.slice(0, MAX)}\n\n[Output truncated at ${MAX} chars]`;
}

export function createConflictTool(runner: GitRunner = defaultGitRunner): ToolDefinition<typeof ConflictParams, ConflictDetails> {
  return {
    name: "conflict",
    label: "Conflict",
    description: `Resolve git merge/rebase/pull conflicts. Each conflict is addressable as conflict://N:

- \`conflict({ action: "list" })\` — scan unmerged files (git diff --name-only --diff-filter=U) and number every conflict: conflict://1, conflict://2, …
- \`conflict({ action: "diff", uri: "conflict://1" })\` — show the conflict's two sides: @ours (current branch/HEAD) and @theirs (incoming branch).
- \`conflict({ action: "resolve", uri: "conflict://1", content: "@theirs" })\` — resolve one conflict with @ours, @theirs, or custom content.
- \`conflict({ action: "resolve", uri: "conflict://*", content: "@ours" })\` — resolve every conflict with the same choice.

@base is not supported in v1 (per-hunk base mapping is unreliable); use \`git show :1:<path>\` via bash if you need the common ancestor. Resolving writes files like edit/write and follows the same permission modes. Run \`git add\` after resolving.`,
    promptSnippet: "Use conflict to list, inspect, and resolve git merge conflicts via conflict://N.",
    promptGuidelines: [
      "When git reports merge conflicts, run conflict list first, inspect each conflict://N with diff, then resolve with @ours/@theirs/custom content.",
    ],
    parameters: ConflictParams,
    async execute(_id, params, signal, _onUpdate, ctx): Promise<AgentToolResult<ConflictDetails>> {
      if (signal?.aborted) throw new Error("Tool execution aborted.");
      const action = params.action;
      const cwd = ctx.cwd;

      const scan = await scanConflicts(cwd, runner);
      if (!scan.ok) {
        throw new Error(`conflict list failed: ${scan.error}. This tool works inside a git repository with unmerged files.`);
      }
      if (action === "list") {
        return {
          content: [{ type: "text", text: renderList(scan.files) }],
          details: {
            action,
            conflict_count: flattenConflicts(scan.files).length,
            files: scan.files.map((f) => f.path),
            resolved: 0,
          },
        } as AgentToolResult<ConflictDetails>;
      }

      if (!params.uri) {
        throw new Error(`conflict ${action} requires a uri (conflict://<N> or conflict://*).`);
      }
      const flat = flattenConflicts(scan.files);

      if (action === "diff") {
        if (params.uri === "conflict://*") {
          throw new Error('conflict diff does not support conflict://*; use a numbered uri (run conflict list first).');
        }
        const [target] = parseResolveTargets(params.uri, flat);
        const filePath = resolve(cwd, target.file.path);
        let fileContent = "";
        try {
          fileContent = await readFile(filePath, "utf8");
        } catch (err) {
          throw new Error(`Cannot read ${target.file.path}: ${err instanceof Error ? err.message : String(err)}`);
        }
        return {
          content: [{ type: "text", text: renderDiff(target, fileContent) }],
          details: { action, conflict_count: flat.length, files: [target.file.path], resolved: 0 },
        } as AgentToolResult<ConflictDetails>;
      }

      // resolve
      const content = params.content ?? "";
      if (!content.trim()) {
        throw new Error('conflict resolve requires content: "@ours", "@theirs", or custom text.');
      }
      const targets = parseResolveTargets(params.uri, flat);
      const result = await applyResolution(cwd, targets, content, signal);
      if (signal?.aborted) throw new Error("Tool execution aborted.");
      const summary = result.files.length > 0
        ? `Resolved ${result.resolved} conflict(s) in:\n${result.files.map((f) => `- ${f}`).join("\n")}\n\nRun git add and commit when ready.`
        : "No conflicts to resolve.";
      return {
        content: [{ type: "text", text: summary }],
        details: { action, conflict_count: flat.length, files: result.files, resolved: result.resolved },
      } as AgentToolResult<ConflictDetails>;
    },
    renderShell: "self",
    renderCall(args, theme, ctx) {
      if (ctx?.isPartial === false) return new Text("", 0, 0);
      const uri = args.uri ? ` ${String(args.uri)}` : "";
      return toolCallLine(theme, "conflict", `${String(args.action ?? "")}${uri}`);
    },
    renderResult(result, opts, theme, ctx) {
      if (opts.isPartial) return new Text("", 0, 0);
      const details = result.details as ConflictDetails | undefined;
      const block = result.content.find((item) => item.type === "text");
      const text = block && "text" in block ? block.text : "";
      const summary = details?.action === "resolve"
        ? `${details.resolved} resolved · ${details.files.length} file(s)`
        : `${details?.conflict_count ?? 0} conflict(s)`;
      return toolResultLine(theme, {
        name: "conflict",
        ok: true,
        arg: ctx.args.action ? String(ctx.args.action) : "",
        summary: resultSummary({ content: [{ type: "text", text }] }, 220) || summary,
        expanded: opts.expanded,
        detail: text,
      });
    },
  };
}

export function registerConflictTool(pi: ExtensionAPI, runner?: GitRunner): void {
  pi.registerTool(createConflictTool(runner) as never);
}
