/**
 * Context gathering for prompt enhancement.
 *
 * Collects a lightweight codebase + knowledge snapshot to ground the
 * enhancer rewrite: recent session messages, project tree, git log,
 * referenced file contents, and Maestro knowledge-base hits. Every
 * gatherer fails soft — a missing file, a git timeout, or an unreachable
 * knowledge CLI degrades to an empty/undefined slot rather than failing
 * the enhancement.
 */
import { execFile } from "node:child_process";
import { readdir } from "node:fs/promises";
import type { Dirent } from "node:fs";
import { join, relative } from "node:path";
import { promisify } from "node:util";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { defaultRunner, type RunCliResult } from "../session/cli-adapter.ts";
import { extractTurnContext } from "../next-suggest/engine.ts";
import type { EnhanceConfig } from "./config.ts";

const execFileAsync = promisify(execFile);

export interface KnowledgeHit {
  id: string;
  name: string;
  summary: string;
  category: string;
}

export interface EnhancerContext {
  recentMessages: string[];
  projectTree: string | undefined;
  gitLog: string | undefined;
  mentionedFiles: string[];
  knowledgeHits: KnowledgeHit[];
}

const TREE_MAX_DEPTH = 3;
const TREE_MAX_ENTRIES = 100;
const TREE_SKIP_DIRS = new Set([
  "node_modules", ".git", ".svn", ".hg", "dist", "build", "out", "coverage",
  ".next", ".nuxt", ".venv", "venv", "__pycache__", ".pytest_cache", ".cache",
  ".turbo", ".vercel", ".idea", ".vscode", "target",
]);
const GIT_TIMEOUT_MS = 3000;
const GIT_LOG_LIMIT = 8;
const FILE_MAX_LINES = 100;
const KNOWLEDGE_TIMEOUT_MS = 8000;

const FILE_EXT_RE = /([\w./-]+\.(?:ts|tsx|js|jsx|mjs|cjs|json|md|css|html|py|rs|go|java|sh))/g;
const STOPWORDS = new Set([
  "the", "and", "for", "with", "that", "this", "from", "into", "have", "has",
  "are", "was", "were", "will", "would", "can", "you", "please", "help",
  "make", "need", "want", "use", "using", "get", "set", "add", "new", "me", "my", "it",
  "的", "了", "在", "是", "和", "与", "或", "请", "帮我", "帮", "我", "把", "给",
]);

/** Extract 1-3 search keywords from a prompt for the Maestro knowledge CLI. */
export function extractKeywords(prompt: string, limit = 3): string[] {
  const tokens = prompt.split(/[^A-Za-z0-9\u4e00-\u9fff]+/).map((t) => t.trim()).filter((t) => t.length >= 2);
  const seen = new Set<string>();
  const out: string[] = [];
  for (const token of tokens) {
    const lower = token.toLowerCase();
    if (STOPWORDS.has(lower) || seen.has(lower)) continue;
    seen.add(lower);
    out.push(token);
    if (out.length >= limit) break;
  }
  return out;
}

/** Search the Maestro knowledge base; returns top-N hits, empty on any failure. */
export async function searchMaestroKnowledge(
  prompt: string,
  cwd: string,
  topN: number,
  runner: (args: readonly string[], cwd: string, options?: { timeoutMs?: number }) => Promise<RunCliResult> = defaultRunner,
): Promise<KnowledgeHit[]> {
  const keywords = extractKeywords(prompt);
  if (keywords.length === 0) return [];
  const query = keywords.join(" ");
  let result: RunCliResult;
  try {
    result = await runner(["search", query, "--json"], cwd, { timeoutMs: KNOWLEDGE_TIMEOUT_MS });
  } catch {
    return [];
  }
  if (result.exitCode !== 0) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(result.stdout);
  } catch {
    return [];
  }
  if (!parsed || typeof parsed !== "object") return [];
  const results = (parsed as { results?: unknown }).results;
  if (!Array.isArray(results)) return [];
  const hits: KnowledgeHit[] = [];
  for (const entry of results) {
    if (!entry || typeof entry !== "object") continue;
    const r = entry as Record<string, unknown>;
    const id = typeof r.id === "string" ? r.id : "";
    const name = typeof r.name === "string" ? r.name : "";
    const summary = typeof r.summary === "string" ? r.summary : "";
    const category = typeof r.category === "string" ? r.category : "";
    if (!id) continue;
    hits.push({ id, name, summary, category });
    if (hits.length >= topN) break;
  }
  return hits;
}

async function buildProjectTree(cwd: string, dir: string, depth: number, entries: string[]): Promise<void> {
  if (entries.length >= TREE_MAX_ENTRIES || depth > TREE_MAX_DEPTH) return;
  let names: Dirent[];
  try {
    names = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  names.sort((a, b) => a.name.localeCompare(b.name));
  for (const entry of names) {
    if (entries.length >= TREE_MAX_ENTRIES) return;
    const rel = relative(cwd, join(dir, entry.name));
    if (entry.isDirectory()) {
      if (TREE_SKIP_DIRS.has(entry.name)) continue;
      entries.push(`${rel}/`);
      if (depth < TREE_MAX_DEPTH) await buildProjectTree(cwd, join(dir, entry.name), depth + 1, entries);
    } else {
      entries.push(rel);
    }
  }
}

async function buildGitLog(cwd: string): Promise<string | undefined> {
  try {
    const { stdout } = await execFileAsync(
      "git",
      ["log", "--oneline", `-${GIT_LOG_LIMIT}`, "--no-decorate"],
      { cwd, timeout: GIT_TIMEOUT_MS },
    );
    return stdout.trim() || undefined;
  } catch {
    return undefined;
  }
}

async function readMentionedFile(cwd: string, path: string): Promise<string | undefined> {
  const { readFile, stat } = await import("node:fs/promises");
  let abs: string;
  try {
    abs = path.startsWith("/") || /^[A-Za-z]:[\\/]/.test(path) ? path : join(cwd, path);
    const s = await stat(abs);
    if (!s.isFile()) return undefined;
  } catch {
    return undefined;
  }
  try {
    const content = await readFile(abs, "utf8");
    return content.split("\n").slice(0, FILE_MAX_LINES).join("\n");
  } catch {
    return undefined;
  }
}

async function buildMentionedFiles(prompt: string, cwd: string, maxFiles: number): Promise<string[]> {
  if (maxFiles <= 0) return [];
  const matches = [...prompt.matchAll(FILE_EXT_RE)].map((m) => m[0]);
  const seen = new Set<string>();
  const out: string[] = [];
  for (const candidate of matches) {
    if (seen.has(candidate)) continue;
    seen.add(candidate);
    const content = await readMentionedFile(cwd, candidate);
    if (content === undefined) continue;
    out.push(`### ${candidate}\n\`\`\`\n${content}\n\`\`\``);
    if (out.length >= maxFiles) break;
  }
  return out;
}

export async function gatherEnhancerContext(
  prompt: string,
  cwd: string,
  config: EnhanceConfig,
  sessionManager: ExtensionContext["sessionManager"],
): Promise<EnhancerContext> {
  const depth = config.contextDepth;
  const recentMessages: string[] = [];
  if (depth !== "none") {
    const branch = (sessionManager.getBranch?.() ?? []) as Array<{ role?: string; content?: unknown }>;
    const turn = extractTurnContext(branch as Parameters<typeof extractTurnContext>[0]);
    if (turn.latestAssistantText) recentMessages.push(`assistant: ${turn.latestAssistantText}`);
    for (const p of turn.recentUserPrompts) recentMessages.push(`user: ${p}`);
  }

  let projectTree: string | undefined;
  let gitLog: string | undefined;
  let mentionedFiles: string[] = [];
  let knowledgeHits: KnowledgeHit[] = [];

  if (depth === "codebase") {
    const treeEntries: string[] = [];
    await buildProjectTree(cwd, cwd, 1, treeEntries);
    projectTree = treeEntries.length > 0 ? treeEntries.join("\n") : undefined;
    if (config.includeGit) gitLog = await buildGitLog(cwd);
    mentionedFiles = await buildMentionedFiles(prompt, cwd, config.maxFiles);
    if (config.knowledgeSearch) {
      knowledgeHits = await searchMaestroKnowledge(prompt, cwd, config.knowledgeTopN);
    }
  }

  return { recentMessages, projectTree, gitLog, mentionedFiles, knowledgeHits };
}
