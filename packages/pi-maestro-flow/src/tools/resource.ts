/**
 * resource — 内部 URL scheme 读取工具（T1-1）
 *
 * 通过 URI scheme 读取协议资源，避免在宿主 `read`（纯本地文件）上做隐形拦截造成语义歧义：
 * - pr://owner/repo/N[/diff|/files] — GitHub PR（gh CLI，内存 TTL 缓存）
 * - issue://owner/repo/N — GitHub issue（gh CLI）
 * - skill://name — 已安装 skill 的 SKILL.md
 * - rule://name — 项目规则文件（AGENTS.md / RULES.md / .pi/rules/* / docs/*）
 * - agent://<correlationId>[/key[/index[/field]]] — 已完成 teammate 子代理的输出
 *   （correlationId 是统一查询 ID，解析到该 agent 的最新结果；publicationId 仅作为兼容入口；
 *   任务名重名时返回匹配列表（correlationId + 时间 + 内容预览），按 correlationId 精确查询；
 *   带 outputSchema 的任务记录其校验后的结构化输出，普通任务记录最终答案文本；裸 agent://<correlationId> 返回完整输出）
 * - session://<sessionId>/entry/<entryId> — 当前 host-authorized Pi session history 的可见 active-chain entry
 * - memory://… — 预留（返回明确的未实现提示，避免模型猜测）
 *
 * 只读工具：plan 白名单 + 权限 ALWAYS_ALLOWED + 系统提示引导同步注册
 * （见 extension/index.ts、tools/plan.ts、permissions/policy.ts）。
 */

import { execFile } from "node:child_process";
import { readFile, readdir, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import { homedir } from "node:os";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import type { ExtensionAPI, ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { Text } from "@earendil-works/pi-tui";
import { toolCallLine, toolResultLine, resultSummary } from "../quiet-render.ts";
import { checkGhAvailable, showGhHint } from "./web-access/github-api.ts";
import { getAgentOutputPath, formatAgentMatchListing, resolveAgentOutput } from "../teammate/agent-output-store.ts";
import { createSessionHistoryInventoryProvider } from "./session-history.ts";
import {
  SessionHistoryService,
  parseSessionHistoryUri,
  type SessionHistoryInventorySource,
} from "pi-maestro-teammate/v1/session-history";

export const ResourceParams = Type.Object({
  uri: Type.String({
    description:
      "Protocol resource URI: pr://owner/repo/N (or pr://N, optional /diff or /files), issue://owner/repo/N (or issue://N), skill://name, rule://name, agent://<correlationId>[/key[/index]], or session://<sessionId>/entry/<entryId>. See the tool description for scheme semantics.",
  }),
});

export interface ResourceResolveOptions {
  /** Fresh host-authorized session inventory used by session:// reads. */
  sessionHistory?: SessionHistoryInventorySource | SessionHistoryService;
}

export interface ResourceToolOptions {
  /** Optional session inventory override for focused hosts/tests. */
  sessionHistory?: SessionHistoryInventorySource | SessionHistoryService;
  /** Optional host-context inventory factory. */
  sessionHistoryFactory?: (ctx: ExtensionContext) => SessionHistoryInventorySource;
}

export interface ResourceDetails {
  uri: string;
  scheme: string;
  resource: string;
  cached: boolean;
  bytes: number;
}

interface CachedEntry {
  ts: number;
  value: string;
}

const CACHE_TTL_MS = 5 * 60 * 1000;
const MAX_CACHE_ENTRIES = 200;
const MAX_OUTPUT_CHARS = 200_000;

const ghCache = new Map<string, CachedEntry>();

function cacheGet(key: string, now = Date.now()): string | null {
  const entry = ghCache.get(key);
  if (!entry) return null;
  if (now - entry.ts > CACHE_TTL_MS) {
    ghCache.delete(key);
    return null;
  }
  return entry.value;
}

function cacheSet(key: string, value: string): void {
  if (ghCache.size >= MAX_CACHE_ENTRIES) {
    const oldest = ghCache.keys().next().value;
    if (oldest !== undefined) ghCache.delete(oldest);
  }
  ghCache.set(key, { ts: Date.now(), value });
}

function runGh(args: string[], cwd: string, signal?: AbortSignal, timeoutMs = 15_000): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  return new Promise((resolvePromise) => {
    execFile(
      "gh",
      args,
      { cwd, timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024, ...(signal ? { signal } : {}) },
      (err, stdout, stderr) => {
        if (err) {
          const message = (stderr || "").trim() || err.message;
          resolvePromise({ ok: false, stdout: "", stderr: message });
          return;
        }
        resolvePromise({ ok: true, stdout, stderr });
      },
    );
  });
}

/** 解析 pr:// issue:// 等协议 URI 为 { scheme, segments }。非协议字符串返回 null。 */
export function parseResourceUri(uri: string): { scheme: string; segments: string[] } | null {
  const match = uri.trim().match(/^([a-z][a-z0-9+.-]*):\/\/(.*)$/i);
  if (!match) return null;
  const scheme = match[1]!.toLowerCase();
  const rest = match[2] ?? "";
  const segments = rest.split("/").filter(Boolean);
  return { scheme, segments };
}

interface GhTarget {
  owner: string;
  repo: string;
  number: string;
}

/** pr://N 或 pr://owner/repo/N；sub 为 /diff /files 等。两段形式（owner/N）与未知子路径拒绝，避免静默误解析。 */
export function parseGhTarget(segments: string[]): { target: GhTarget; sub: string } | null {
  if (segments.length === 1) {
    if (!/^\d+$/.test(segments[0]!)) return null;
    return { target: { owner: "", repo: "", number: segments[0]! }, sub: "" };
  }
  if (segments.length >= 3 && /^\d+$/.test(segments[2]!)) {
    const sub = segments.slice(3).join("/");
    if (sub !== "" && sub !== "diff" && sub !== "files") return null;
    return {
      target: { owner: segments[0]!, repo: segments[1]!, number: segments[2]! },
      sub,
    };
  }
  return null;
}

function ghRepoArgs(target: GhTarget): string[] {
  return target.owner ? ["--repo", `${target.owner}/${target.repo}`] : [];
}

/** 缓存键：隐式仓库（pr://N / issue://N）纳入 cwd，避免跨仓库串数据。 */
function ghCacheKey(prefix: string, target: GhTarget, cwd: string): string {
  if (target.owner) return `${prefix}:${target.owner}/${target.repo}/${target.number}`;
  return `${prefix}:${cwd}/${target.number}`;
}

const PR_JSON_FIELDS =
  "title,body,url,state,author,createdAt,additions,deletions,changedFiles,headRefName,baseRefName,isDraft,mergeable,labels";

async function readPr(target: GhTarget, sub: string, cwd: string, signal?: AbortSignal): Promise<{ content: string; title: string; cached: boolean }> {
  const repoArg = ghRepoArgs(target);
  if (sub === "diff") {
    const key = ghCacheKey("pr-diff", target, cwd);
    const cached = cacheGet(key);
    if (cached !== null) return { content: cached, title: `PR #${target.number} diff`, cached: true };
    const result = await runGh(["pr", "diff", target.number, ...repoArg], cwd, signal);
    if (!result.ok) throw new Error(`gh pr diff failed: ${result.stderr}`);
    const content = trimOutput(`# PR #${target.number} diff\n\n${result.stdout}`);
    cacheSet(key, content);
    return { content, title: `PR #${target.number} diff`, cached: false };
  }
  if (sub === "files") {
    const result = await runGh(
      ["pr", "view", target.number, ...repoArg, "--json", "files"],
      cwd,
      signal,
    );
    if (!result.ok) throw new Error(`gh pr view --json files failed: ${result.stderr}`);
    const files = JSON.parse(result.stdout) as { files?: Array<{ path: string; additions: number; deletions: number }> };
    const lines = (files.files ?? []).map((f) => `- ${f.path} (+${f.additions} -${f.deletions})`);
    return {
      content: trimOutput(`# PR #${target.number} changed files (${lines.length})\n\n${lines.join("\n") || "(none)"}`),
      title: `PR #${target.number} files`,
      cached: false,
    };
  }

  const key = ghCacheKey("pr", target, cwd);
  const cached = cacheGet(key);
  if (cached !== null) return { content: cached, title: `PR #${target.number}`, cached: true };

  const result = await runGh(
    ["pr", "view", target.number, ...repoArg, "--json", PR_JSON_FIELDS],
    cwd,
    signal,
  );
  if (!result.ok) throw new Error(`gh pr view failed: ${result.stderr}`);
  const pr = JSON.parse(result.stdout) as {
    title?: string; body?: string; url?: string; state?: string;
    author?: { login?: string } | null; createdAt?: string;
    additions?: number; deletions?: number; changedFiles?: number;
    headRefName?: string; baseRefName?: string; isDraft?: boolean;
    mergeable?: string; labels?: Array<{ name?: string }>;
  };
  const lines: string[] = [
    `# ${pr.title ?? `PR #${target.number}`}`,
    "",
    `State: ${pr.state ?? "unknown"}${pr.isDraft ? " (draft)" : ""} · Mergeable: ${pr.mergeable ?? "unknown"}`,
    `Author: ${pr.author?.login ?? "unknown"} · Created: ${pr.createdAt ?? "unknown"}`,
    `Base: ${pr.baseRefName ?? "?"} → Head: ${pr.headRefName ?? "?"}`,
    `Changes: +${pr.additions ?? 0} -${pr.deletions ?? 0} (${pr.changedFiles ?? 0} files)`,
    `Labels: ${(pr.labels ?? []).map((l) => l.name).filter(Boolean).join(", ") || "(none)"}`,
    `URL: ${pr.url ?? ""}`,
    "",
    "## Body",
    "",
    pr.body?.trim() || "(no description)",
  ];
  const content = trimOutput(lines.join("\n"));
  cacheSet(key, content);
  return { content, title: pr.title ?? `PR #${target.number}`, cached: false };
}

async function readIssue(target: GhTarget, cwd: string, signal?: AbortSignal): Promise<{ content: string; title: string; cached: boolean }> {
  const repoArg = ghRepoArgs(target);
  const key = ghCacheKey("issue", target, cwd);
  const cached = cacheGet(key);
  if (cached !== null) return { content: cached, title: `Issue #${target.number}`, cached: true };

  const result = await runGh(
    ["issue", "view", target.number, ...repoArg, "--json", "title,body,url,state,author,createdAt,labels,comments"],
    cwd,
    signal,
  );
  if (!result.ok) throw new Error(`gh issue view failed: ${result.stderr}`);
  const issue = JSON.parse(result.stdout) as {
    title?: string; body?: string; url?: string; state?: string;
    author?: { login?: string } | null; createdAt?: string;
    labels?: Array<{ name?: string }>;
    comments?: Array<{ author?: { login?: string } | null; body?: string; createdAt?: string }>;
  };
  const lines: string[] = [
    `# ${issue.title ?? `Issue #${target.number}`}`,
    "",
    `State: ${issue.state ?? "unknown"} · Author: ${issue.author?.login ?? "unknown"} · Created: ${issue.createdAt ?? "unknown"}`,
    `Labels: ${(issue.labels ?? []).map((l) => l.name).filter(Boolean).join(", ") || "(none)"}`,
    `URL: ${issue.url ?? ""}`,
    "",
    "## Body",
    "",
    issue.body?.trim() || "(no description)",
  ];
  const comments = issue.comments ?? [];
  if (comments.length > 0) {
    lines.push("", `## Comments (${comments.length})`, "");
    for (const comment of comments) {
      lines.push(`**${comment.author?.login ?? "unknown"}** (${comment.createdAt ?? "?"}):`);
      lines.push(comment.body?.trim() || "(empty)");
      lines.push("");
    }
  }
  const content = trimOutput(lines.join("\n"));
  cacheSet(key, content);
  return { content, title: issue.title ?? `Issue #${target.number}`, cached: false };
}

async function skillDirCandidates(cwd: string): Promise<string[]> {
  const dirs = [
    resolve(cwd, ".pi", "skills"),
    resolve(cwd, ".agents", "skills"),
    resolve(homedir(), ".pi", "skills"),
    resolve(homedir(), ".agents", "skills"),
  ];
  const existing: string[] = [];
  for (const dir of dirs) {
    try {
      if ((await stat(dir)).isDirectory()) existing.push(dir);
    } catch {
      // skip missing dirs
    }
  }
  return existing;
}

/** 拒绝 . / .. 段，防 name 拼接逃逸预期目录。 */
function assertSafeNameSegments(name: string, scheme: string): void {
  for (const segment of name.split("/")) {
    if (segment === "" || segment === "." || segment === "..") {
      throw new Error(`Invalid ${scheme}:// name "${name}": segments must not be empty, ".", or "..".`);
    }
  }
}

/** 词法包含性检查：candidate 必须位于 root 之下（防 ../ 逃逸）。 */
function isWithin(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
}

async function readSkill(name: string, cwd: string): Promise<{ content: string; title: string }> {
  assertSafeNameSegments(name, "skill");
  const dirs = await skillDirCandidates(cwd);
  for (const dir of dirs) {
    const skillFile = resolve(dir, name, "SKILL.md");
    if (!isWithin(dir, skillFile)) continue;
    try {
      const content = await readFile(skillFile, "utf8");
      return { content: trimOutput(`# Skill: ${name}\n\n${content}`), title: `skill://${name}` };
    } catch {
      // continue searching
    }
  }
  // Fallback: list available skills so the model can pick a valid name.
  const available: string[] = [];
  for (const dir of dirs) {
    try {
      const entries = await readdir(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isDirectory()) available.push(entry.name);
      }
    } catch {
      // skip unreadable dirs
    }
  }
  const unique = [...new Set(available)].sort();
  throw new Error(
    `Skill "${name}" not found in ${dirs.join(", ") || "no skill directories"}.\n` +
    `Available skills: ${unique.join(", ") || "(none)"}`,
  );
}

const RULE_LOOKUP_TABLE: Record<string, string[]> = {
  agents: ["AGENTS.md"],
  rules: ["RULES.md"],
  cursor: [".cursorrules"],
  cline: [".clinerules"],
};

async function readRule(name: string, cwd: string): Promise<{ content: string; title: string }> {
  assertSafeNameSegments(name, "rule");
  const normalized = name.toLowerCase();
  const fixed = RULE_LOOKUP_TABLE[normalized] ?? [];
  const candidates = [
    ...fixed.map((file) => resolve(cwd, file)),
    resolve(cwd, ".pi", "rules", `${name}.md`),
    resolve(cwd, ".pi", "rules", `${name}`),
    resolve(cwd, "docs", `${name}.md`),
    resolve(cwd, `${name}.md`),
  ].filter((file) => isWithin(cwd, file));
  for (const file of candidates) {
    try {
      const content = await readFile(file, "utf8");
      return { content: trimOutput(`# Rule: ${name}\n\n${content}`), title: `rule://${name}` };
    } catch {
      // continue
    }
  }
  const existing: string[] = [];
  for (const file of [resolve(cwd, "AGENTS.md"), resolve(cwd, "RULES.md"), resolve(cwd, ".cursorrules"), resolve(cwd, ".clinerules")]) {
    try {
      if ((await stat(file)).isFile()) existing.push(file);
    } catch {
      // skip
    }
  }
  throw new Error(
    `Rule "${name}" not found.\n` +
    `Candidates tried: ${candidates.map((c) => c.replace(cwd, ".")).join(", ")}.\n` +
    `Existing rule files: ${existing.map((e) => e.replace(cwd, ".")).join(", ") || "(none)"}`,
  );
}

function trimOutput(text: string): string {
  const trimmed = text.trim();
  if (trimmed.length <= MAX_OUTPUT_CHARS) return trimmed;
  return `${trimmed.slice(0, MAX_OUTPUT_CHARS)}\n\n[Output truncated at ${MAX_OUTPUT_CHARS} chars]`;
}

/** Session IDs are opaque to the host but resource segments must never become
 * path-like selectors (including percent-encoded separators). */
function safeSessionResourceIdentifier(value: string): boolean {
  return value.length > 0
    && value.length <= 512
    && value !== "."
    && value !== ".."
    && !/[\\/]/.test(value)
    && !/[\u0000-\u001f\u007f]/.test(value);
}

export async function resolveResource(
  uri: string,
  cwd: string,
  signal?: AbortSignal,
  options: ResourceResolveOptions = {},
): Promise<{ content: string; title: string; cached: boolean }> {
  const parsed = parseResourceUri(uri);
  if (!parsed) {
    throw new Error(
      `Unsupported URI format: "${uri}". Supported schemes: pr://, issue://, skill://, rule://, agent://, session://. ` +
      "For local files use the read tool.",
    );
  }
  const { scheme, segments } = parsed;

  switch (scheme) {
    case "pr": {
      const ghTarget = parseGhTarget(segments);
      if (!ghTarget) throw new Error(`Invalid pr:// URI: "${uri}". Expected pr://owner/repo/N[/diff|/files] or pr://N.`);
      if (!(await checkGhAvailable())) {
        showGhHint();
        throw new Error("gh CLI is required for pr:// and issue:// URIs. Install it (https://cli.github.com) and authenticate with `gh auth login`.");
      }
      return readPr(ghTarget.target, ghTarget.sub, cwd, signal);
    }
    case "issue": {
      const ghTarget = parseGhTarget(segments);
      if (!ghTarget) throw new Error(`Invalid issue:// URI: "${uri}". Expected issue://owner/repo/N or issue://N (no sub-paths).`);
      if (ghTarget.sub !== "") throw new Error(`issue:// does not support sub-paths ("${ghTarget.sub}"). Expected issue://owner/repo/N or issue://N.`);
      if (!(await checkGhAvailable())) {
        showGhHint();
        throw new Error("gh CLI is required for pr:// and issue:// URIs. Install it (https://cli.github.com) and authenticate with `gh auth login`.");
      }
      return readIssue(ghTarget.target, cwd, signal);
    }
    case "skill": {
      const name = segments.join("/");
      if (!name) throw new Error('Invalid skill:// URI. Expected skill://<name>.');
      const skill = await readSkill(name, cwd);
      return { content: skill.content, title: skill.title, cached: false };
    }
    case "rule": {
      const name = segments.join("/");
      if (!name) throw new Error('Invalid rule:// URI. Expected rule://<name>.');
      const rule = await readRule(name, cwd);
      return { content: rule.content, title: rule.title, cached: false };
    }
    case "agent": {
      const [id, ...pathSegments] = segments;
      if (!id) throw new Error('Invalid agent:// URI. Expected agent://<correlationId>[/key[/index[/field]]].');
      const resolved = await resolveAgentOutput(id, cwd);
      if (resolved.kind === "ambiguous") {
        return {
          content: trimOutput(formatAgentMatchListing(resolved.name, resolved.matches)),
          title: `agent://${id}`,
          cached: false,
        };
      }
      const record = resolved.record;
      const value = pathSegments.length === 0
        ? record.output
        : (() => {
            const hit = getAgentOutputPath(record.output, pathSegments);
            if (!hit.hit) {
              throw new Error(
                `agent://${id} path miss: ${hit.reason}. `
                + `Tip: agent://${id} (no path) returns the whole output; path segments are object keys / array indices (e.g. /findings/0/path), not a /json prefix.`,
              );
            }
            return hit.value;
          })();
      const text = typeof value === "string" ? value : JSON.stringify(value, null, 2);
      return { content: trimOutput(text), title: `agent://${id}`, cached: false };
    }
    case "session": {
      const sessionUri = uri.trim().replace(/^session:\/\//i, "session://");
      const parsedSession = parseSessionHistoryUri(sessionUri);
      // Resource deliberately supports only an exact visible entry. A bare
      // session URI belongs to session_history discovery/read_turn and would
      // otherwise make it too easy to widen a resource read accidentally.
      if (!parsedSession || !parsedSession.entryId || !safeSessionResourceIdentifier(parsedSession.sessionId)
        || !safeSessionResourceIdentifier(parsedSession.entryId)) {
        throw new Error(
          `Invalid session:// URI: expected session://<sessionId>/entry/<entryId> with safe identifiers.`,
        );
      }
      const source = options.sessionHistory;
      if (!source) {
        throw new Error("session:// resources require an active host session context.");
      }
      let result;
      try {
        const service = source instanceof SessionHistoryService
          ? source
          : new SessionHistoryService(source);
        result = await service.readUri(sessionUri, {
          signal,
        });
      } catch (error) {
        if (signal?.aborted) throw signal.reason ?? error;
        // Inventory providers are host-owned. Do not pass provider errors (and
        // potentially embedded filesystem paths) through the model-visible
        // resource error surface.
        throw new Error("Session history read failed.");
      }
      if (!result.found || !result.selectedEntry) {
        throw new Error(`Session entry not found or not visible: ${sessionUri}`);
      }
      // The public service already strips thinking, hidden rows, abandoned
      // branches, and tool arguments. Serialize only the selected entry so a
      // resource read cannot accidentally widen into a transcript dump.
      return {
        content: trimOutput(JSON.stringify(result.selectedEntry, null, 2)),
        title: sessionUri,
        cached: false,
      };
    }
    case "memory":
      throw new Error(
        "The memory:// scheme is reserved for future persistent memory access. " +
        "Use the knowledge system (maestro knowledge) for memory today.",
      );
    default:
      throw new Error(`Unsupported scheme "${scheme}://" in "${uri}". Supported: pr://, issue://, skill://, rule://, agent://, session://.`);
  }
}

export function createResourceTool(
  options: ResourceToolOptions = {},
): ToolDefinition<typeof ResourceParams, ResourceDetails> {
  return {
    name: "resource",
    label: "Resource",
    description: `Read protocol resources by URI scheme — the same surface the agent already knows from URLs:

- \`pr://owner/repo/N\` — GitHub pull request (title, body, state, changes); \`pr://owner/repo/N/diff\` for the full diff; \`pr://owner/repo/N/files\` for the changed file list. \`pr://N\` uses the current repository.
- \`issue://owner/repo/N\` — GitHub issue (body + comments). \`issue://N\` uses the current repository.
- \`skill://name\` — installed skill's SKILL.md (project .pi/skills, .agents/skills, then home).
- \`rule://name\` — project rule files (agents → AGENTS.md, rules → RULES.md, cursor → .cursorrules, cline → .clinerules, plus .pi/rules/ and docs/).
- \`agent://<id>[/key[/index[/field]]]\` — published teammate output. Exact correlation and publication IDs resolve globally across workspace buckets; task-name discovery remains scoped to the caller's workspace/subtree and may return a disambiguation list. A correlation ID follows that task's latest publication, while a publication ID pins one immutable result; use task names only to discover candidates, then retain an exact ID. Bare \`agent://<id>\` returns the whole output; optional path segments load one nested field, e.g. \`agent://catalog-audit-correlation/findings/0/path\`. Do NOT append \`/json\`. Agent resources are not cached: reuse content already present in the current context instead of loading the same immutable URI again.
- \`session://<sessionId>/entry/<entryId>\` — one visible active-chain entry from the host-authorized session history. Obtain exact URIs from \`session_history\`; arbitrary transcript paths, hidden rows, thinking blocks, abandoned branches, and tool-call arguments are rejected or omitted. Session reads are never cached.

pr:// and issue:// require the gh CLI (https://cli.github.com). Results are cached in memory for 5 minutes — re-reads within the window return the cached copy, so refetch after state changes only when the window has expired.
Read local files with the built-in read tool — resource is for protocol resources only.`,
    promptSnippet: "Use resource for pr://, issue://, skill://, rule://, agent://, session:// protocol resources; use read for local files.",
    promptGuidelines: [
      "pr://, issue://, skill://, rule://, agent://, session:// protocol resources are read via the resource tool — do not pass them to the built-in read tool (read is for local files).",
      "For session:// entry resources, first obtain the exact URI from session_history; reads revalidate the host-authorized active chain and never expose paths, hidden rows, thinking, or tool arguments.",
      "For teammate results, use task names only to discover candidates; retain an exact correlation ID for that task's latest result or a publication ID for one immutable result. Exact IDs resolve globally; task-name lookup stays workspace-scoped.",
      "Load the smallest required agent://<exact-id>/key/index subtree, never append /json, and do not reload an unchanged immutable URI already present in the current context.",
    ],
    parameters: ResourceParams,
    async execute(_id, params, signal, _onUpdate, ctx): Promise<AgentToolResult<ResourceDetails>> {
      if (signal?.aborted) throw new Error("Tool execution aborted.");
      const uri = params.uri.trim();
      if (!uri) throw new Error("resource uri is required and must not be empty.");
      const cwd = ctx.cwd;
      const sessionHistory = options.sessionHistory
        ?? options.sessionHistoryFactory?.(ctx)
        ?? createSessionHistoryInventoryProvider(ctx, "all");
      const { content, title, cached } = await resolveResource(uri, cwd, signal, {
        sessionHistory,
      });
      if (signal?.aborted) throw new Error("Tool execution aborted.");
      return {
        content: [{ type: "text", text: content }],
        details: {
          uri,
          scheme: parseResourceUri(uri)?.scheme ?? "",
          resource: title,
          cached,
          bytes: content.length,
        },
      } as AgentToolResult<ResourceDetails>;
    },
    renderShell: "self",
    renderCall(args, theme, ctx) {
      if (ctx?.isPartial === false) return new Text("", 0, 0);
      return toolCallLine(theme, "resource", String(args.uri ?? ""));
    },
    renderResult(result, opts, theme, ctx) {
      if (opts.isPartial) return new Text("", 0, 0);
      const details = result.details as ResourceDetails | undefined;
      const block = result.content.find((item) => item.type === "text");
      const text = block && "text" in block ? block.text : "";
      const isError = (result as { isError?: boolean }).isError === true;
      return toolResultLine(theme, {
        name: "resource",
        ok: !isError,
        arg: ctx.args.uri ? String(ctx.args.uri) : "",
        summary: details?.resource || resultSummary({ content: [{ type: "text", text }] }, 220),
        expanded: opts.expanded,
        detail: text,
      });
    },
  };
}

export function registerResourceTool(
  pi: ExtensionAPI,
  options: ResourceToolOptions = {},
): void {
  pi.registerTool(createResourceTool(options) as never);
}
