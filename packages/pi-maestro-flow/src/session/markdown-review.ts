import { spawn as defaultSpawn, spawnSync, type ChildProcess } from "node:child_process";
import { mkdir, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, extname, isAbsolute, join, resolve } from "node:path";

/**
 * Session Markdown Review — 从当前会话 branch 组装 user/assistant turns，
 * 渲染预览并导出 Markdown / Word(DOCX) / PDF。
 *
 * 参考 G:/github_lib/pi-markdown-preview 的概念（assistant 消息提取、pandoc PDF
 * 链路、参数化命令分发），但针对本插件的 branch 结构与多 turn 场景重新实现：
 * 提取层保留 user 消息，导出层复用 pandoc 完成 md/docx/pdf 转换。
 */

export interface ReviewTurn {
  /** 1-based 序号，按 branch 中出现的顺序递增。 */
  index: number;
  role: "user" | "assistant";
  text: string;
}

export type ReviewExportFormat = "markdown" | "docx" | "pdf";

export const REVIEW_EXPORT_EXTENSION: Record<ReviewExportFormat, string> = {
  markdown: "md",
  docx: "docx",
  pdf: "pdf",
};

export const REVIEW_EXPORT_FORMAT_LABELS: Record<ReviewExportFormat, string> = {
  markdown: "Markdown (.md)",
  docx: "Word (.docx)",
  pdf: "PDF (.pdf)",
};

/**
 * 从 message content 提取文本块，字符串与 {type:"text"} 数组均支持。
 * 只做空判定，保留原始文本（Markdown 前导缩进有语义，不能被 trim 改变）。
 */
export function messageContentText(content: unknown): string {
  if (typeof content === "string") return content.trim() ? content : "";
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const block of content) {
    if (!block || typeof block !== "object") continue;
    const record = block as { type?: unknown; text?: unknown };
    if (record.type !== "text") continue;
    const text = typeof record.text === "string" ? record.text : "";
    if (text.trim()) parts.push(text);
  }
  return parts.join("\n\n");
}

/**
 * 从 session branch entries 组装 user/assistant turns。
 * 只接受 `entry.type === "message"` 且 `entry.message.role` 为 user/assistant
 * 的条目；toolResult / custom / 空文本被跳过（与 goal-verification 的提取一致）。
 */
export function collectReviewTurns(entries: unknown[]): ReviewTurn[] {
  const turns: ReviewTurn[] = [];
  for (const rawEntry of entries) {
    if (!rawEntry || typeof rawEntry !== "object") continue;
    const entry = rawEntry as { type?: unknown; message?: unknown };
    if (entry.type !== "message") continue;
    const rawMessage = entry.message;
    if (!rawMessage || typeof rawMessage !== "object") continue;
    const message = rawMessage as { role?: unknown; content?: unknown };
    if (message.role !== "user" && message.role !== "assistant") continue;
    const text = messageContentText(message.content);
    if (!text) continue;
    turns.push({ index: turns.length + 1, role: message.role, text });
  }
  return turns;
}

export interface ReviewAssemblyOptions {
  title?: string;
  now?: Date;
}

const DEFAULT_REVIEW_TITLE = "Session Review";

/** 将选中的 turns 组装为完整 Markdown 文档（标题 + 元信息 + 分 turn 段落）。 */
export function assembleReviewMarkdown(
  turns: readonly ReviewTurn[],
  options: ReviewAssemblyOptions = {},
): string {
  const title = options.title?.trim() ? options.title.trim() : DEFAULT_REVIEW_TITLE;
  const now = options.now ?? new Date();
  const stamp = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")} ${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;
  const lines: string[] = [
    `# ${title}`,
    "",
    `> ${turns.length} 个 turn · 导出时间 ${stamp}`,
    "",
  ];
  for (const turn of turns) {
    lines.push(`## ${turn.index}. ${turn.role === "user" ? "User" : "Assistant"}`);
    lines.push("");
    lines.push(turn.text);
    lines.push("");
    lines.push("---");
    lines.push("");
  }
  return lines.join("\n");
}

export type ReviewCliParse =
  | { kind: "interactive" }
  | { kind: "help" }
  | { kind: "error"; message: string }
  | { kind: "cli"; turns: number[] | "all"; format: ReviewExportFormat; output?: string };

const FORMAT_ALIASES: Record<string, ReviewExportFormat> = {
  md: "markdown",
  markdown: "markdown",
  docx: "docx",
  word: "docx",
  pdf: "pdf",
};

/**
 * 引号感知的分词：支持双引号/单引号包裹含空格的路径。
 * 未闭合引号抛错（由 parseReviewArgs 转成 error 结果）。
 */
export function tokenizeArgs(args: string): string[] {
  const tokens: string[] = [];
  const input = args.trim();
  let current = "";
  let inToken = false;
  let quote: '"' | "'" | undefined;
  for (let index = 0; index < input.length; index++) {
    const ch = input[index]!;
    if (quote) {
      if (ch === quote) {
        quote = undefined;
        inToken = true;
      } else {
        current += ch;
      }
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      inToken = true;
      continue;
    }
    if (/\s/.test(ch)) {
      if (inToken) {
        tokens.push(current);
        current = "";
        inToken = false;
      }
      continue;
    }
    current += ch;
    inToken = true;
  }
  if (quote) throw new Error("未闭合的引号");
  if (inToken) tokens.push(current);
  return tokens;
}

function parseTurnList(value: string): number[] | "all" | undefined {
  const normalized = value.trim().toLowerCase();
  if (normalized === "all") return "all";
  if (!/^\d+(,\d+)*$/.test(normalized)) return undefined;
  const indexes = normalized.split(",").map((part) => Number(part));
  if (indexes.some((index) => !Number.isInteger(index) || index < 1)) return undefined;
  return [...new Set(indexes)];
}

/**
 * 解析 `/markdown-review` 参数。没有任何 `--turn/--format/--output` 时进入
 * 交互模式；`--format` 单独出现时默认导出全部 turns。
 */
export function parseReviewArgs(args: string): ReviewCliParse {
  let tokens: string[];
  try {
    tokens = tokenizeArgs(args);
  } catch {
    return { kind: "error", message: "参数中存在未闭合的引号。" };
  }
  if (tokens.length === 0) return { kind: "interactive" };
  if (tokens.includes("--help") || tokens.includes("-h") || tokens.includes("help")) {
    return { kind: "help" };
  }

  let turnValue: string | undefined;
  let formatValue: string | undefined;
  let output: string | undefined;
  const positionals: string[] = [];

  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index]!;
    if (token === "--turn") {
      const value = tokens[index + 1];
      if (!value || value.startsWith("-")) return { kind: "error", message: "Missing value after --turn. Use --turn <N|all>." };
      turnValue = value;
      index++;
      continue;
    }
    if (token === "--format") {
      const value = tokens[index + 1];
      if (!value || value.startsWith("-")) return { kind: "error", message: "Missing value after --format. Use --format <md|docx|pdf>." };
      formatValue = value;
      index++;
      continue;
    }
    if (token === "--output") {
      const value = tokens[index + 1];
      if (!value || value.startsWith("-")) return { kind: "error", message: "Missing value after --output <path>." };
      output = value;
      index++;
      continue;
    }
    if (token.startsWith("-")) {
      return { kind: "error", message: `Unknown argument "${token}". See /markdown-review --help.` };
    }
    positionals.push(token);
  }

  if (turnValue === undefined && formatValue === undefined && output === undefined) {
    return { kind: "interactive" };
  }

  let turns: number[] | "all" = "all";
  if (turnValue !== undefined) {
    const parsed = parseTurnList(turnValue);
    if (parsed === undefined) {
      return { kind: "error", message: `Invalid --turn "${turnValue}". Use a 1-based turn number, a comma list, or "all".` };
    }
    turns = parsed;
  }

  let format: ReviewExportFormat = "markdown";
  if (formatValue !== undefined) {
    const resolved = FORMAT_ALIASES[formatValue.trim().toLowerCase()];
    if (!resolved) {
      return { kind: "error", message: `Invalid --format "${formatValue}". Use md|markdown|docx|word|pdf.` };
    }
    format = resolved;
  }

  if (positionals.length > 0) {
    if (output !== undefined) {
      return { kind: "error", message: `Unexpected positional "${positionals[0]}". Use --output <path> for the destination.` };
    }
    output = positionals.join(" ");
  }

  return { kind: "cli", turns, format, output };
}

/** 按 --turn 选择过滤 turns；越界索引返回错误信息。 */
export function resolveSelectedTurns(
  turns: readonly ReviewTurn[],
  selection: number[] | "all",
): { ok: true; turns: ReviewTurn[] } | { ok: false; message: string } {
  if (selection === "all") return { ok: true, turns: [...turns] };
  const byIndex = new Map(turns.map((turn) => [turn.index, turn]));
  const missing = selection.filter((index) => !byIndex.has(index));
  if (missing.length > 0) {
    return { ok: false, message: `Turn 不存在: ${missing.join(", ")}（共 ${turns.length} 个 turn）` };
  }
  return { ok: true, turns: selection.map((index) => byIndex.get(index)!).filter(Boolean) };
}

/** 默认导出文件名：session-review-YYYYMMDD-HHmmss.<ext>。 */
export function defaultReviewOutputName(format: ReviewExportFormat, now: Date = new Date()): string {
  const pad = (value: number): string => String(value).padStart(2, "0");
  const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  return `session-review-${stamp}.${REVIEW_EXPORT_EXTENSION[format]}`;
}

/**
 * 解析用户输出路径：
 * - `~` / `~/...` 展开为 homedir；
 * - 已存在目录 → 生成默认文件名放入该目录；
 * - 无对应扩展名 → 追加 `.md/.docx/.pdf`。
 */
export async function resolveReviewOutputPath(
  format: ReviewExportFormat,
  cwd: string,
  output?: string,
): Promise<string> {
  if (!output?.trim()) return join(cwd, defaultReviewOutputName(format));
  let trimmed = output.trim();
  if (trimmed === "~") {
    trimmed = homedir();
  } else if (trimmed.startsWith("~/") || trimmed.startsWith("~\\")) {
    trimmed = join(homedir(), trimmed.slice(2));
  }
  const resolved = isAbsolute(trimmed) ? trimmed : resolve(cwd, trimmed);
  try {
    const info = await stat(resolved);
    if (info.isDirectory()) return join(resolved, defaultReviewOutputName(format));
  } catch {
    // 目标不存在 — 按文件路径处理
  }
  const hasKnownExtension = extname(resolved).toLowerCase() === `.${REVIEW_EXPORT_EXTENSION[format]}`;
  if (hasKnownExtension) return resolved;
  return `${resolved}.${REVIEW_EXPORT_EXTENSION[format]}`;
}

export interface ReviewExportOptions {
  /** 可注入的 spawn 实现（测试用）；默认使用 node:child_process 的 spawn。 */
  spawnFn?: typeof defaultSpawn;
  /** 传给子进程的环境变量；默认 process.env。 */
  env?: NodeJS.ProcessEnv;
  /** PDF/转换超时（毫秒），默认 120000。 */
  timeoutMs?: number;
}

const DEFAULT_EXPORT_TIMEOUT_MS = 120_000;
/** stderr 只保留有界尾部，避免嘈杂转换器无界累积内存。 */
const MAX_STDERR_TAIL = 8_000;

/** 将已组装的 Markdown 写入 .md 文件。 */
export async function writeMarkdownFile(markdown: string, outputPath: string): Promise<void> {
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, markdown, "utf8");
}

function pandocCommand(env: NodeJS.ProcessEnv): string {
  return env.PANDOC_PATH?.trim() || "pandoc";
}

function pdfEngine(env: NodeJS.ProcessEnv): string {
  return env.PANDOC_PDF_ENGINE?.trim() || "xelatex";
}

interface PandocInvocation {
  args: string[];
  command: string;
}

function buildPandocArgs(format: ReviewExportFormat, outputPath: string, env: NodeJS.ProcessEnv): PandocInvocation {
  const command = pandocCommand(env);
  if (format === "docx") {
    return { command, args: ["-f", "markdown", "-t", "docx", "-o", outputPath] };
  }
  if (format === "pdf") {
    return {
      command,
      args: [
        "-f", "markdown",
        "-o", outputPath,
        `--pdf-engine=${pdfEngine(env)}`,
        "-V", "geometry:margin=2cm",
        "-V", "fontsize=11pt",
        "-V", "urlcolor=blue",
        "-V", "linkcolor=blue",
      ],
    };
  }
  throw new Error(`Unsupported export format: ${format}`);
}

/** Windows 用 taskkill /T /F 终止整棵进程树；POSIX 用负 pid 进程组。 */
function terminateProcessTree(child: ChildProcess): void {
  if (!child.pid) return;
  try {
    if (process.platform === "win32") {
      spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], {
        stdio: "ignore",
        windowsHide: true,
      });
    } else {
      process.kill(-child.pid, "SIGTERM");
    }
  } catch {
    try {
      child.kill("SIGTERM");
    } catch {
      // 已退出或无权终止 — 忽略
    }
  }
}

function runPandoc(
  spawnFn: typeof defaultSpawn,
  command: string,
  args: string[],
  markdown: string,
  env: NodeJS.ProcessEnv,
  timeoutMs: number,
): Promise<void> {
  return new Promise<void>((resolvePromise, reject) => {
    let child: ChildProcess;
    try {
      // stdout 使用 -o 时无输出，直接 ignore；stderr 保留有界尾部。
      child = spawnFn(command, args, { stdio: ["pipe", "ignore", "pipe"], env });
    } catch (error) {
      reject(error instanceof Error ? error : new Error(String(error)));
      return;
    }
    let stderrTail = "";
    let settled = false;
    const timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      terminateProcessTree(child);
      reject(new Error(`pandoc export timed out after ${Math.round(timeoutMs / 1000)}s.`));
    }, timeoutMs);
    timeout.unref?.();

    child.stderr?.on("data", (chunk: Buffer | string) => {
      stderrTail = (stderrTail + (typeof chunk === "string" ? chunk : chunk.toString("utf8"))).slice(-MAX_STDERR_TAIL);
    });
    // stdin 可能在转换器提前退出时收到 EPIPE — 挂接有界处理器，避免未处理 error 终止进程。
    child.stdin?.on("error", () => {});

    child.once("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      const errno = error as NodeJS.ErrnoException;
      if (errno.code === "ENOENT") {
        reject(new Error("pandoc 未找到。请安装 pandoc 或设置 PANDOC_PATH 环境变量。"));
        return;
      }
      reject(error);
    });

    child.once("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (code === 0) {
        resolvePromise();
        return;
      }
      reject(new Error(`pandoc 导出失败（exit ${code}）${stderrTail ? `: ${stderrTail.slice(-500)}` : ""}`));
    });

    child.stdin?.end(markdown);
  });
}

/**
 * 导出 Review 文档：markdown 直接写盘；docx/pdf 走 pandoc 转换链路
 * （docx: markdown→docx；pdf: markdown→pdf，默认 xelatex 引擎）。
 */
export async function exportReviewDocument(
  markdown: string,
  format: ReviewExportFormat,
  outputPath: string,
  options: ReviewExportOptions = {},
): Promise<void> {
  const spawnFn = options.spawnFn ?? defaultSpawn;
  const env = options.env ?? process.env;
  const timeoutMs = options.timeoutMs ?? DEFAULT_EXPORT_TIMEOUT_MS;
  await mkdir(dirname(outputPath), { recursive: true });
  if (format === "markdown") {
    await writeMarkdownFile(markdown, outputPath);
    return;
  }
  const { command, args } = buildPandocArgs(format, outputPath, env);
  await runPandoc(spawnFn, command, args, markdown, env, timeoutMs);
}

export const REVIEW_USAGE = `用法：/markdown-review [--turn <N|all>] [--format <md|docx|pdf>] [--output <path>] [--help]

无参数时进入交互模式：
  ↑↓ 选择 · Space 勾选 turn · a 全选 · n 清空 · Enter 预览（窄屏）· e 导出 · Esc 关闭

示例：
  /markdown-review
  /markdown-review --turn all --format pdf --output ~/review.pdf
  /markdown-review --turn 1,3 --format docx`;
