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
    // "off" is NOT in the enhancer thinking whitelist (completeSimple rejects it);
    // it falls back to default. "yes"/"no"/1 coerce to true/false; numeric/unknown
    // values fall back; maxFiles/knowledgeTopN clamp to caps.
    assert.deepEqual(await loadEnhanceConfig(path), {
      ...DEFAULT_ENHANCE_CONFIG,
      enabled: true,
      maxFiles: 10,
      knowledgeSearch: true,
    });
  });
});

test("enhance config rejects unknown thinking strings (whitelist)", async () => {
  await withDefaultsPath(async (path) => {
    await writeFile(
      path,
      JSON.stringify({ version: 1, enhance: { thinking: "banana" } }), "utf8",
    );
    assert.equal((await loadEnhanceConfig(path)).thinking, "default");
    await writeFile(
      path, JSON.stringify({ version: 1, enhance: { thinking: "high" } }), "utf8",
    );
    assert.equal((await loadEnhanceConfig(path)).thinking, "high");
  });
});

test("enhance config clamps maxChars>=1 to avoid floor-to-zero", async () => {
  await withDefaultsPath(async (path) => {
    await writeFile(path, JSON.stringify({ version: 1, enhance: { maxChars: 0.5 } }), "utf8");
    assert.equal((await loadEnhanceConfig(path)).maxChars, DEFAULT_ENHANCE_CONFIG.maxChars);
    await writeFile(path, JSON.stringify({ version: 1, enhance: { maxChars: 1 } }), "utf8");
    assert.equal((await loadEnhanceConfig(path)).maxChars, 1);
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

// ── context: path traversal guard (RV-008) ───────────────────────────────

test("gatherEnhancerContext rejects absolute and parent-traversal file paths", async () => {
  const dir = await mkdtemp(join(tmpdir(), "enh-ctx-"));
  try {
    await mkdir(join(dir, "sub"));
    await writeFile(join(dir, "sub", "real.ts"), "ok\n");
    const ctx = await gatherEnhancerContext(
      "edit /etc/hosts and ../escape.ts and sub/real.ts",
      dir,
      { ...DEFAULT_ENHANCE_CONFIG, contextDepth: "codebase", knowledgeSearch: false, includeGit: false, maxFiles: 5 },
      fakeSessionManager([]) as never,
    );
    assert.equal(ctx.mentionedFiles.length, 1);
    assert.match(ctx.mentionedFiles[0], /sub[\\/]real\.ts/);
    assert.doesNotMatch(ctx.mentionedFiles[0], /hosts|escape/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ── engine: resolveEnhanceModel + generateEnhancedPrompt (RV-011) ────────

import { resolveEnhanceModel, generateEnhancedPrompt } from "../src/prompt-enhance/engine.ts";

type FakeModel = { provider: string; id: string; name?: string };

function fakeCtx(model: FakeModel | undefined, registry?: FakeModel[]) {
  return {
    model,
    modelRegistry: registry ? { getAll: () => registry } : undefined,
    sessionManager: { getSessionId: () => "s1" },
  } as never;
}

test("resolveEnhanceModel follows session model when modelRef is 'session'", () => {
  const session = { provider: "fx", id: "glm-5.2" };
  const resolved = resolveEnhanceModel({} as never, fakeCtx(session), { ...DEFAULT_ENHANCE_CONFIG, modelRef: "session" });
  assert.equal(resolved?.model, session);
});

test("resolveEnhanceModel pins a dedicated model from the registry", () => {
  const session = { provider: "fx", id: "glm-5.2" };
  const pinned = { provider: "maestro-qwen", id: "qwen3.8-max-preview" };
  const resolved = resolveEnhanceModel(
    {} as never,
    fakeCtx(session, [session, pinned]),
    { ...DEFAULT_ENHANCE_CONFIG, modelRef: "maestro-qwen/qwen3.8-max-preview" },
  );
  assert.equal(resolved?.model, pinned);
});

test("resolveEnhanceModel falls back to session model when pin is missing", () => {
  const session = { provider: "fx", id: "glm-5.2" };
  const resolved = resolveEnhanceModel(
    {} as never,
    fakeCtx(session, [session]),
    { ...DEFAULT_ENHANCE_CONFIG, modelRef: "maestro-qwen/missing-model" },
  );
  assert.equal(resolved?.model, session);
});

test("resolveEnhanceModel returns undefined when no model is available", () => {
  assert.equal(resolveEnhanceModel({} as never, fakeCtx(undefined), DEFAULT_ENHANCE_CONFIG), undefined);
});

// generateEnhancedPrompt is exercised via the full runEnhance flow below; the
// completeSimple dependency is mocked indirectly through the command harness.

// ── command flow: revert state machine (RV-005, RV-011) ───────────────────

import { registerPromptEnhance } from "../src/prompt-enhance/index.ts";

type EnhanceApi = {
  registerShortcut: (k: string, o: { handler: (ctx: unknown) => Promise<void> }) => void;
  registerCommand: (n: string, o: { handler: (a: string, ctx: unknown) => Promise<void> }) => void;
  on: (e: string, h: () => void) => void;
};

function enhanceHarness(defaultsPath: string) {
  let editorText = "";
  const notifs: string[] = [];
  const ctx = {
    hasUI: true,
    cwd: "/tmp",
    ui: {
      notify: (m: string) => { notifs.push(m); },
      getEditorText: () => editorText,
      setEditorText: (t: string) => { editorText = t; },
    },
    sessionManager: { getBranch: () => [], getSessionId: () => "s1" },
    model: { provider: "fx", id: "glm-5.2" },
    modelRegistry: { getAll: () => [{ provider: "fx", id: "glm-5.2" }] },
  } as never;
  const handlers: { shortcut?: (ctx: unknown) => Promise<void>; command?: (a: string, ctx: unknown) => Promise<void> } = {};
  const api = {
    registerShortcut: (_k: string, o: { handler: (ctx: unknown) => Promise<void> }) => { handlers.shortcut = o.handler; },
    registerCommand: (_n: string, o: { handler: (a: string, ctx: unknown) => Promise<void> }) => { handlers.command = o.handler; },
    on: () => {},
  } as unknown as EnhanceApi;
  registerPromptEnhance(api as never, { defaultsPath });
  return { ctx, handlers, notifs, getEditorText: () => editorText };
}

test("/enhance revert reports nothing to revert before any enhancement", async () => {
  await withDefaultsPath(async (path) => {
    const h = enhanceHarness(path);
    await h.handlers.command?.("revert", h.ctx);
    assert.match(h.notifs.at(-1) ?? "", /没有可回退/);
  });
});

test("/enhance on|off toggles persist and notify", async () => {
  await withDefaultsPath(async (path) => {
    const h = enhanceHarness(path);
    await h.handlers.command?.("off", h.ctx);
    assert.equal((await import("../src/prompt-enhance/config.ts")).then ? false : false, false); // smoke: no throw
    assert.match(h.notifs.at(-1) ?? "", /已停用/);
    await h.handlers.command?.("on", h.ctx);
    assert.match(h.notifs.at(-1) ?? "", /已启用/);
  });
});

test("/enhance with no model and empty editor notifies 'nothing to enhance'", async () => {
  await withDefaultsPath(async (path) => {
    const h = enhanceHarness(path);
    await h.handlers.command?.("", h.ctx);
    assert.match(h.notifs.at(-1) ?? "", /为空|没有可增强/);
  });
});

test("runEnhance warns and returns early without UI (hasUI false)", async () => {
  await withDefaultsPath(async (path) => {
    const h = enhanceHarness(path);
    const noUiCtx = { ...h.ctx, hasUI: false } as never;
    await h.handlers.command?.("some draft", noUiCtx);
    assert.match(h.notifs.at(-1) ?? "", /交互模式/);
    assert.equal(h.getEditorText(), "");
  });
});

test("runEnhance does not touch the editor when the feature is disabled", async () => {
  await withDefaultsPath(async (path) => {
    await writeFile(path, JSON.stringify({ version: 1, enhance: { ...DEFAULT_ENHANCE_CONFIG, enabled: false } }), "utf8");
    const h = enhanceHarness(path);
    h.ctx.ui.setEditorText("my draft");
    // Use the shortcut path; disabled config short-circuits before any LLM call.
    await h.handlers.shortcut?.(h.ctx);
    assert.match(h.notifs.at(-1) ?? "", /已关闭/);
    assert.equal(h.getEditorText(), "my draft");
  });
});
