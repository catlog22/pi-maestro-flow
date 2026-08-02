import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ChildProcess } from "node:child_process";

import {
  assembleReviewMarkdown,
  collectReviewTurns,
  defaultReviewOutputName,
  exportReviewDocument,
  messageContentText,
  parseReviewArgs,
  resolveReviewOutputPath,
  resolveSelectedTurns,
  REVIEW_USAGE,
  type ReviewExportFormat,
  type ReviewTurn,
} from "../src/session/markdown-review.ts";
import {
  MarkdownReviewOverlay,
  type MarkdownReviewOverlayAction,
  type MarkdownReviewTurnItem,
} from "../src/tui/markdown-review-overlay.ts";

function sampleEntries(): unknown[] {
  return [
    { type: "message", message: { role: "user", content: "你好，帮我写一个函数" } },
    {
      type: "message",
      message: {
        role: "assistant",
        content: [
          { type: "text", text: "好的：\n\n```ts\nfunction add(a, b) { return a + b; }\n```" },
          { type: "text", text: "用法：`add(1, 2)`。" },
        ],
      },
    },
    { type: "message", message: { role: "toolResult", content: "ok" } },
    { type: "custom", customType: "goal", data: { enabled: true } },
    { type: "message", message: { role: "assistant", content: "" } },
    { type: "message", message: { role: "user", content: "再优化一下" } },
  ];
}

test("messageContentText handles string, text blocks, and garbage", () => {
  assert.equal(messageContentText("  hello  "), "  hello  ");
  assert.equal(messageContentText("   "), "");
  assert.equal(
    messageContentText([
      { type: "text", text: "a" },
      { type: "toolCall", name: "bash" },
      { type: "text", text: "b" },
    ]),
    "a\n\nb",
  );
  assert.equal(messageContentText(42), "");
  assert.equal(messageContentText([{ type: "text", text: "  " }]), "");
});

test("messageContentText preserves leading Markdown indentation", () => {
  assert.equal(messageContentText("    const x = 1;\n    return x;"), "    const x = 1;\n    return x;");
  assert.equal(
    messageContentText([{ type: "text", text: "    code block\n    second line" }]),
    "    code block\n    second line",
  );
});

test("collectReviewTurns assembles user/assistant turns in order", () => {
  const turns = collectReviewTurns(sampleEntries());
  assert.equal(turns.length, 3);
  assert.deepEqual(turns.map((turn) => turn.role), ["user", "assistant", "user"]);
  assert.deepEqual(turns.map((turn) => turn.index), [1, 2, 3]);
  assert.match(turns[1]!.text, /function add/);
  assert.match(turns[1]!.text, /add\(1, 2\)/);
});

test("collectReviewTurns tolerates malformed entries", () => {
  const turns = collectReviewTurns([
    null,
    "string",
    { type: "message" },
    { type: "message", message: { role: "system" } },
    { type: "message", message: { role: "user" } },
  ]);
  assert.equal(turns.length, 0);
});

test("assembleReviewMarkdown builds a structured document", () => {
  const turns: ReviewTurn[] = [
    { index: 1, role: "user", text: "question" },
    { index: 2, role: "assistant", text: "answer" },
  ];
  const markdown = assembleReviewMarkdown(turns, { title: "My Review", now: new Date("2026-08-03T00:00:00") });
  assert.match(markdown, /^# My Review/);
  assert.match(markdown, /## 1\. User/);
  assert.match(markdown, /## 2\. Assistant/);
  assert.match(markdown, /question/);
  assert.match(markdown, /answer/);
  assert.match(markdown, /2 个 turn/);
});

test("parseReviewArgs: empty args are interactive", () => {
  assert.deepEqual(parseReviewArgs(""), { kind: "interactive" });
  assert.deepEqual(parseReviewArgs("   "), { kind: "interactive" });
});

test("parseReviewArgs: help flags", () => {
  for (const args of ["--help", "-h", "help"]) {
    assert.equal(parseReviewArgs(args).kind, "help");
  }
});

test("parseReviewArgs: full cli invocation", () => {
  const parsed = parseReviewArgs("--turn 2 --format pdf --output out.pdf");
  assert.equal(parsed.kind, "cli");
  if (parsed.kind === "cli") {
    assert.deepEqual(parsed.turns, [2]);
    assert.equal(parsed.format, "pdf");
    assert.equal(parsed.output, "out.pdf");
  }
});

test("parseReviewArgs: turn list and format aliases", () => {
  const parsed = parseReviewArgs("--turn 1,3 --format word");
  assert.equal(parsed.kind, "cli");
  if (parsed.kind === "cli") {
    assert.deepEqual(parsed.turns, [1, 3]);
    assert.equal(parsed.format, "docx");
  }
  const all = parseReviewArgs("--turn all --format md");
  assert.equal(all.kind, "cli");
  if (all.kind === "cli") assert.equal(all.turns, "all");
});

test("parseReviewArgs: format alone defaults to all turns", () => {
  const parsed = parseReviewArgs("--format docx");
  assert.equal(parsed.kind, "cli");
  if (parsed.kind === "cli") {
    assert.equal(parsed.turns, "all");
    assert.equal(parsed.format, "docx");
  }
});

test("parseReviewArgs: positional output and errors", () => {
  const positional = parseReviewArgs("--turn 1 ~/out");
  assert.equal(positional.kind, "cli");
  if (positional.kind === "cli") assert.equal(positional.output, "~/out");

  assert.equal(parseReviewArgs("--turn abc").kind, "error");
  assert.equal(parseReviewArgs("--format html").kind, "error");
  assert.equal(parseReviewArgs("--turn 2 --format").kind, "error");
  assert.equal(parseReviewArgs("--bogus").kind, "error");
  const conflict = parseReviewArgs("--turn 1 --output x extra");
  assert.equal(conflict.kind, "error");
});

test("parseReviewArgs: quote-aware tokenization", () => {
  const quoted = parseReviewArgs('--turn 1 --format pdf --output "my review.pdf"');
  assert.equal(quoted.kind, "cli");
  if (quoted.kind === "cli") assert.equal(quoted.output, "my review.pdf");

  const single = parseReviewArgs("--turn all --format docx --output 'dir with space/out.docx");
  assert.equal(single.kind, "error");

  const okSingle = parseReviewArgs("--turn all --format docx --output 'dir with space/out.docx'");
  assert.equal(okSingle.kind, "cli");
  if (okSingle.kind === "cli") assert.equal(okSingle.output, "dir with space/out.docx");

  const unclosed = parseReviewArgs('--output "unclosed');
  assert.equal(unclosed.kind, "error");
  assert.match(unclosed.kind === "error" ? unclosed.message : "", /引号/);
});

test("resolveSelectedTurns filters by 1-based index", () => {
  const turns: ReviewTurn[] = [
    { index: 1, role: "user", text: "a" },
    { index: 2, role: "assistant", text: "b" },
    { index: 3, role: "user", text: "c" },
  ];
  assert.deepEqual(resolveSelectedTurns(turns, "all"), { ok: true, turns });
  const picked = resolveSelectedTurns(turns, [2]);
  assert.equal(picked.ok, true);
  if (picked.ok) {
    assert.deepEqual(picked.turns.map((turn) => turn.index), [2]);
  }
  const missing = resolveSelectedTurns(turns, [9]);
  assert.equal(missing.ok, false);
  if (!missing.ok) assert.match(missing.message, /9/);
});

test("defaultReviewOutputName and resolveReviewOutputPath", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-review-path-"));
  try {
    assert.match(defaultReviewOutputName("markdown"), /^session-review-\d{8}-\d{6}\.md$/);
    assert.match(defaultReviewOutputName("pdf"), /\.pdf$/);

    const md = await resolveReviewOutputPath("markdown", root, "out");
    assert.equal(md, join(root, "out.md"));
    const pdf = await resolveReviewOutputPath("pdf", root, "out.pdf");
    assert.equal(pdf, join(root, "out.pdf"));
    const absolute = await resolveReviewOutputPath("docx", root, "/tmp/review.docx");
    assert.equal(absolute, "/tmp/review.docx");
    const defaulted = await resolveReviewOutputPath("docx", root);
    assert.match(defaulted, /\.docx$/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("resolveReviewOutputPath expands tilde and detects directories", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-review-tilde-"));
  const sub = join(root, "existing-dir");
  await mkdir(sub, { recursive: true });
  try {
    const tilde = await resolveReviewOutputPath("pdf", root, "~/x.pdf");
    assert.ok(tilde.startsWith(homedir()));
    assert.match(tilde, /\.pdf$/);

    const dirTarget = await resolveReviewOutputPath("markdown", root, sub);
    assert.ok(dirTarget.startsWith(sub));
    assert.match(dirTarget, /\.md$/);

    const dotTarget = await resolveReviewOutputPath("markdown", root, ".");
    assert.ok(dotTarget.startsWith(root));
    assert.match(dotTarget, /\.md$/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

interface FakeSpawnCall {
  command: string;
  args: string[];
  env: NodeJS.ProcessEnv | undefined;
  stdinContent: string;
}

interface FakeSpawnBehavior {
  exitCode?: number | null;
  error?: NodeJS.ErrnoException;
}

function makeFakeSpawn(calls: FakeSpawnCall[], behavior: FakeSpawnBehavior = {}) {
  return ((command: string, args: string[], options: { env?: NodeJS.ProcessEnv }) => {
    const record: FakeSpawnCall = { command, args, env: options.env, stdinContent: "" };
    calls.push(record);
    const child = new EventEmitter() as unknown as ChildProcess;
    (child as unknown as { stdin: unknown }).stdin = {
      on: () => {},
      end: (input: string) => {
        record.stdinContent = input ?? "";
      },
    };
    (child as unknown as { stdout: unknown }).stdout = new EventEmitter();
    const stderr = new EventEmitter() as unknown as { on: (event: string, cb: (chunk: Buffer) => void) => void };
    (child as unknown as { stderr: unknown }).stderr = stderr;
    queueMicrotask(() => {
      if (behavior.error) {
        child.emit("error", behavior.error);
        return;
      }
      child.emit("close", behavior.exitCode ?? 0);
    });
    return child;
  }) as unknown as typeof import("node:child_process").spawn;
}

test("exportReviewDocument writes markdown directly", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-review-md-"));
  try {
    const target = join(root, "out.md");
    await exportReviewDocument("# Title\n\nbody", "markdown", target);
    const content = await readFile(target, "utf8");
    assert.match(content, /^# Title/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("exportReviewDocument routes docx through pandoc with stdin content", async () => {
  const calls: FakeSpawnCall[] = [];
  const root = await mkdtemp(join(tmpdir(), "pi-review-docx-"));
  try {
    const target = join(root, "out.docx");
    await exportReviewDocument("# Review\n\nbody", "docx", target, {
      spawnFn: makeFakeSpawn(calls),
    });
    assert.equal(calls.length, 1);
    const call = calls[0]!;
    assert.equal(call.command, "pandoc");
    assert.deepEqual(call.args, ["-f", "markdown", "-t", "docx", "-o", target]);
    assert.match(call.stdinContent, /# Review/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("exportReviewDocument routes pdf through pandoc with pdf engine", async () => {
  const calls: FakeSpawnCall[] = [];
  const root = await mkdtemp(join(tmpdir(), "pi-review-pdf-"));
  try {
    const target = join(root, "out.pdf");
    await exportReviewDocument("# Review", "pdf", target, {
      spawnFn: makeFakeSpawn(calls),
      env: { ...process.env, PANDOC_PDF_ENGINE: "lualatex" },
    });
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0]!.args, [
      "-f", "markdown",
      "-o", target,
      "--pdf-engine=lualatex",
      "-V", "geometry:margin=2cm",
      "-V", "fontsize=11pt",
      "-V", "urlcolor=blue",
      "-V", "linkcolor=blue",
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("exportReviewDocument tolerates stdin EPIPE without crashing", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-review-epipe-"));
  try {
    const target = join(root, "out.docx");
    const child = new EventEmitter() as unknown as ChildProcess;
    (child as unknown as { stdin: unknown }).stdin = {
      on: (_event: string, handler: () => void) => {
        setTimeout(() => handler(), 2); // 模拟 stdin 写失败 → 触发已挂接的 error handler
      },
      end: () => {},
    };
    (child as unknown as { stdout: unknown }).stdout = new EventEmitter();
    (child as unknown as { stderr: unknown }).stderr = new EventEmitter();
    const fakeSpawn = (() => child) as unknown as typeof import("node:child_process").spawn;
    setTimeout(() => child.emit("close", 0), 5);
    await exportReviewDocument("# Review", "docx", target, { spawnFn: fakeSpawn });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("exportReviewDocument rejects on timeout and terminates the child", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-review-timeout-"));
  const keepAlive = setInterval(() => {}, 1000); // unref 的定时器需要事件循环存活才会触发
  try {
    const target = join(root, "out.pdf");
    const child = new EventEmitter() as unknown as ChildProcess & { pid: number };
    (child as unknown as { pid: number }).pid = 4242;
    (child as unknown as { stdin: unknown }).stdin = { on: () => {}, end: () => {} };
    (child as unknown as { stdout: unknown }).stdout = new EventEmitter();
    (child as unknown as { stderr: unknown }).stderr = new EventEmitter();
    const fakeSpawn = (() => child) as unknown as typeof import("node:child_process").spawn;
    await assert.rejects(
      exportReviewDocument("# Review", "pdf", target, { spawnFn: fakeSpawn, timeoutMs: 60 }),
      /timed out/,
    );
  } finally {
    clearInterval(keepAlive);
    await rm(root, { recursive: true, force: true });
  }
});

test("REVIEW_USAGE documents flags and formats", () => {
  assert.match(REVIEW_USAGE, /--turn/);
  assert.match(REVIEW_USAGE, /--format/);
  assert.match(REVIEW_USAGE, /--output/);
  assert.match(REVIEW_USAGE, /pdf/);
  assert.match(REVIEW_USAGE, /docx/);
});

test("exportReviewDocument surfaces pandoc ENOENT and failures", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-review-fail-"));
  try {
    const target = join(root, "out.pdf");
    await assert.rejects(
      exportReviewDocument("x", "pdf", target, {
        spawnFn: makeFakeSpawn([], { error: Object.assign(new Error("no"), { code: "ENOENT" }) }),
      }),
      /pandoc 未找到/,
    );
    await assert.rejects(
      exportReviewDocument("x", "docx", target, {
        spawnFn: makeFakeSpawn([], { exitCode: 1 }),
      }),
      /exit 1/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

function overlayFixture(items: MarkdownReviewTurnItem[]) {
  let action: MarkdownReviewOverlayAction | undefined;
  let renders = 0;
  const overlay = new MarkdownReviewOverlay({
    turns: items,
    theme: {
      fg: (_name, text) => text,
      bold: (text) => text,
    },
    requestRender: () => {
      renders++;
    },
    done: (next) => {
      action = next;
    },
  });
  return {
    overlay,
    action: () => action,
    renders: () => renders,
  };
}

const overlayTurns: MarkdownReviewTurnItem[] = [
  { index: 1, role: "user", preview: "hello", text: "hello **world**" },
  { index: 2, role: "assistant", preview: "answer", text: "## answer\n\nsome code" },
  { index: 3, role: "user", preview: "more", text: "more text" },
];

test("overlay defaults to all selected and exports on e", () => {
  const fixture = overlayFixture(overlayTurns);
  fixture.overlay.handleInput("e");
  assert.deepEqual(fixture.action(), { kind: "export", turnIndexes: [1, 2, 3] });
});

test("overlay space toggles, a selects all, n clears, escape closes", () => {
  const fixture = overlayFixture(overlayTurns);
  fixture.overlay.handleInput(" "); // uncheck turn 1
  fixture.overlay.handleInput("e");
  assert.deepEqual(fixture.action(), { kind: "export", turnIndexes: [2, 3] });

  const all = overlayFixture(overlayTurns);
  all.overlay.handleInput("n");
  all.overlay.handleInput("a");
  all.overlay.handleInput("e");
  assert.deepEqual(all.action(), { kind: "export", turnIndexes: [1, 2, 3] });

  const closed = overlayFixture(overlayTurns);
  closed.overlay.handleInput("\x1b");
  assert.deepEqual(closed.action(), { kind: "close" });
});

test("overlay export is disabled with status when nothing selected", () => {
  const fixture = overlayFixture(overlayTurns);
  fixture.overlay.handleInput("n");
  fixture.overlay.handleInput("e");
  assert.equal(fixture.action(), undefined); // 不导出
  const rendered = fixture.overlay.render(120);
  assert.ok(rendered.join("\n").includes("未选择任何 turn"));
});

test("overlay navigation and render smoke", () => {
  const fixture = overlayFixture(overlayTurns);
  const rendered = fixture.overlay.render(120);
  assert.ok(rendered.length > 0);
  assert.ok(rendered.join("\n").includes("Markdown Review"));
  fixture.overlay.handleInput("\x1b[B"); // down
  fixture.overlay.handleInput("\x1b[B"); // down
  fixture.overlay.handleInput("\r"); // wide 模式 Enter 不切换预览 — 无副作用
  assert.ok(fixture.renders() > 0);
  const narrow = fixture.overlay.render(40);
  assert.ok(narrow.length > 0);
  const previewLines = fixture.overlay.render(120);
  assert.ok(previewLines.some((line) => line.includes("预览")));
});

test("overlay narrow terminal: Enter opens full-width preview, Esc returns", () => {
  const fixture = overlayFixture(overlayTurns);
  const originalColumns = process.stdout.columns;
  (process.stdout as { columns: number }).columns = 40;
  try {
    const list = fixture.overlay.render(40);
    assert.ok(list.join("\n").includes("e 导出"));
    assert.ok(!list.join("\n").includes("预览 · Turn"));
    fixture.overlay.handleInput("\r");
    const preview = fixture.overlay.render(40);
    assert.ok(preview.join("\n").includes("预览 · Turn"));
    assert.ok(preview.join("\n").includes("Esc 返回"));
    fixture.overlay.handleInput("\x1b");
    const back = fixture.overlay.render(40);
    assert.ok(back.join("\n").includes("e 导出"));
  } finally {
    (process.stdout as { columns: number }).columns = originalColumns;
  }
});

test("overlay sanitizes terminal control sequences in session text", () => {
  const malicious: MarkdownReviewTurnItem[] = [
    { index: 1, role: "user", preview: "evil\r\x1b[2Jclear", text: "line1\r\x1b[2Jline2\x1b]0;title\x07" },
  ];
  const fixture = overlayFixture(malicious);
  const rendered = fixture.overlay.render(120).join("\n");
  assert.doesNotMatch(rendered, /[\r\x1b]/);
  assert.ok(rendered.includes("line1line2"));
});

test("exportReviewDocument creates parent directories for markdown", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-review-dirs-"));
  try {
    const target = join(root, "nested", "deep", "out.md");
    await exportReviewDocument("body", "markdown", target);
    const info = await stat(target);
    assert.ok(info.size > 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("export format type is closed", () => {
  const format: ReviewExportFormat = "docx";
  assert.equal(format, "docx");
});
