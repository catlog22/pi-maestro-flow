import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  DEFAULT_ENHANCE_CONFIG,
  loadEnhanceConfig,
  saveEnhanceConfig,
} from "../src/prompt-enhance/config.ts";
import {
  extractKeywords,
  gatherEnhancerContext,
  searchMaestroKnowledge,
} from "../src/prompt-enhance/context.ts";
import { cleanEnhancedText, renderEnhancePrompt } from "../src/prompt-enhance/template.ts";
import type { RunCliResult } from "../src/session/cli-adapter.ts";

async function withDefaultsPath(run: (path: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "prompt-enhance-"));
  const path = join(dir, "api-manager.json");
  try {
    await run(path);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

// ── config ──────────────────────────────────────────────────────────────

test("enhance config falls back to defaults when the file is missing", async () => {
  await withDefaultsPath(async (path) => {
    assert.deepEqual(await loadEnhanceConfig(path), DEFAULT_ENHANCE_CONFIG);
  });
});

test("enhance config round-trips through api-manager.json", async () => {
  await withDefaultsPath(async (path) => {
    await saveEnhanceConfig(
      {
        enabled: false,
        modelRef: "maestro-qwen/qwen3.8-max-preview",
        thinking: "high",
        maxChars: 1500,
        contextDepth: "session",
        includeGit: false,
        maxFiles: 2,
        knowledgeSearch: false,
        knowledgeTopN: 3,
      },
      path,
    );
    assert.deepEqual(await loadEnhanceConfig(path), {
      enabled: false,
      modelRef: "maestro-qwen/qwen3.8-max-preview",
      thinking: "high",
      maxChars: 1500,
      contextDepth: "session",
      includeGit: false,
      maxFiles: 2,
      knowledgeSearch: false,
      knowledgeTopN: 3,
    });
  });
});

test("enhance config normalizes malformed entries", async () => {
  await withDefaultsPath(async (path) => {
    await writeFile(
      path,
      JSON.stringify({
        version: 1,
        enhance: {
          enabled: "yes",
          modelRef: 42,
          thinking: "off",
          maxChars: -5,
          contextDepth: "bogus",
          includeGit: "no",
          maxFiles: 99,
          knowledgeSearch: 1,
          knowledgeTopN: -1,
        },
      }),
      "utf8",
    );
    assert.deepEqual(await loadEnhanceConfig(path), {
      ...DEFAULT_ENHANCE_CONFIG,
      enabled: true,
      thinking: "off",
      maxFiles: 10,
      knowledgeSearch: true,
    });
  });
});

// ── template ─────────────────────────────────────────────────────────────

test("renderEnhancePrompt includes all context sections and the prompt", () => {
  const out = renderEnhancePrompt({
    recentMessages: ["user: fix the bug"],
    projectTree: "src/index.ts",
    gitLog: "abc123 feat: x",
    mentionedFiles: ["### a.ts\n```\ncode\n```"],
    knowledgeHits: [{ id: "spec:1", name: "Rule A", summary: "do X", category: "review" }],
    prompt: "fix it",
  });
  assert.match(out, /RecentMessages:/);
  assert.match(out, /ProjectTree:/);
  assert.match(out, /GitLog:/);
  assert.match(out, /MentionedFiles:/);
  assert.match(out, /KnowledgeHits:/);
  assert.match(out, /PromptToEnhance:/);
  assert.match(out, /fix it/);
  assert.match(out, /\[review\] Rule A: do X/);
});

test("renderEnhancePrompt renders (none) for empty slots", () => {
  const out = renderEnhancePrompt({
    recentMessages: [],
    projectTree: undefined,
    gitLog: undefined,
    mentionedFiles: [],
    knowledgeHits: [],
    prompt: "hi",
  });
  assert.match(out, /RecentMessages:\n\(none\)/);
  assert.match(out, /KnowledgeHits:\n\(none\)/);
});

test("cleanEnhancedText strips fences, headings, and surrounding quotes", () => {
  assert.equal(cleanEnhancedText("```\nenhanced\n```"), "enhanced");
  assert.equal(cleanEnhancedText("# Heading\nbody"), "body");
  assert.equal(cleanEnhancedText('"wrapped"'), "wrapped");
  assert.equal(cleanEnhancedText("  plain  "), "plain");
});

// ── context: keywords ────────────────────────────────────────────────────

test("extractKeywords filters stopwords and short tokens", () => {
  assert.deepEqual(extractKeywords("please help me fix the login bug"), ["fix", "login", "bug"]);
  assert.deepEqual(extractKeywords("帮我 提示词增强"), ["提示词增强"]);
  assert.deepEqual(extractKeywords(""), []);
});

// ── context: knowledge search ────────────────────────────────────────────

type RunnerFn = (args: readonly string[], cwd: string, opts?: { timeoutMs?: number }) => Promise<RunCliResult>;

function mockRunner(stdout: string, exitCode = 0): RunnerFn {
  return async () => ({ argv: [], stdout, stderr: "", exitCode });
}

test("searchMaestroKnowledge parses hits and respects topN", async () => {
  const stdout = JSON.stringify({
    results: [
      { id: "spec:1", name: "A", summary: "sa", category: "review" },
      { id: "spec:2", name: "B", summary: "sb", category: "coding" },
      { id: "spec:3", name: "C", summary: "sc", category: "arch" },
    ],
  });
  const hits = await searchMaestroKnowledge("fix login bug", "/tmp", 2, mockRunner(stdout));
  assert.equal(hits.length, 2);
  assert.equal(hits[0].id, "spec:1");
  assert.equal(hits[1].id, "spec:2");
});

test("searchMaestroKnowledge returns empty on non-zero exit, bad JSON, or no keywords", async () => {
  assert.deepEqual(await searchMaestroKnowledge("the and", "/tmp", 5, mockRunner("{}")), []);
  assert.deepEqual(await searchMaestroKnowledge("fix", "/tmp", 5, mockRunner("not json", 1)), []);
  assert.deepEqual(await searchMaestroKnowledge("fix", "/tmp", 5, mockRunner("not json", 0)), []);
  assert.deepEqual(await searchMaestroKnowledge("fix", "/tmp", 5, mockRunner(JSON.stringify({ results: "nope" }))), []);
});

test("searchMaestroKnowledge passes the query as 'search <kw> --json'", async () => {
  let captured: string[] = [];
  const runner = (async (args: readonly string[]) => {
    captured = [...args];
    return { argv: [...args], stdout: JSON.stringify({ results: [] }), stderr: "", exitCode: 0 } as RunCliResult;
  }) as never;
  await searchMaestroKnowledge("fix login", "/tmp", 5, runner);
  assert.deepEqual(captured, ["search", "fix login", "--json"]);
});

// ── context: gather ──────────────────────────────────────────────────────

function fakeSessionManager(branch: unknown): { getBranch: () => unknown; getSessionId: () => string } {
  return {
    getBranch: () => branch,
    getSessionId: () => "sess-test",
  };
}

test("gatherEnhancerContext with depth=none returns only empties", async () => {
  const dir = await mkdtemp(join(tmpdir(), "enh-ctx-"));
  try {
    const ctx = await gatherEnhancerContext(
      "fix it",
      dir,
      { ...DEFAULT_ENHANCE_CONFIG, contextDepth: "none" },
      fakeSessionManager([]) as never,
    );
    assert.deepEqual(ctx.recentMessages, []);
    assert.equal(ctx.projectTree, undefined);
    assert.equal(ctx.gitLog, undefined);
    assert.deepEqual(ctx.mentionedFiles, []);
    assert.deepEqual(ctx.knowledgeHits, []);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("gatherEnhancerContext reads mentioned files and skips missing ones", async () => {
  const dir = await mkdtemp(join(tmpdir(), "enh-ctx-"));
  try {
    await writeFile(join(dir, "real.ts"), "line1\nline2\n");
    const ctx = await gatherEnhancerContext(
      "edit real.ts and missing.ts please",
      dir,
      { ...DEFAULT_ENHANCE_CONFIG, contextDepth: "codebase", knowledgeSearch: false, includeGit: false },
      fakeSessionManager([]) as never,
    );
    assert.equal(ctx.mentionedFiles.length, 1);
    assert.match(ctx.mentionedFiles[0], /real\.ts/);
    assert.match(ctx.mentionedFiles[0], /line1/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("gatherEnhancerContext builds a project tree under codebase depth", async () => {
  const dir = await mkdtemp(join(tmpdir(), "enh-ctx-"));
  try {
    await mkdir(join(dir, "src"));
    await writeFile(join(dir, "src", "a.ts"), "x");
    await writeFile(join(dir, "b.md"), "y");
    const ctx = await gatherEnhancerContext(
      "nothing",
      dir,
      { ...DEFAULT_ENHANCE_CONFIG, contextDepth: "codebase", knowledgeSearch: false, includeGit: false, maxFiles: 0 },
      fakeSessionManager([]) as never,
    );
    assert.ok(ctx.projectTree !== undefined);
    assert.match(ctx.projectTree!, /src\//);
    assert.match(ctx.projectTree!, /b\.md/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
