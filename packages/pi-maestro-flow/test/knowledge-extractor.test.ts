import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import test from "node:test";
import { KnowledgeCliAdapter } from "../src/knowledge/cli-adapter.ts";
import {
  bindTranscriptEvidence,
  DEFAULT_TRANSCRIPT_QUOTE_MAX_BYTES,
  extractTranscriptQuote,
  stageWindowKnowledgeCandidate,
  type TranscriptContextLike,
} from "../src/knowledge/extractor.ts";
import type { RunCliResult } from "../src/session/cli-adapter.ts";

interface EntryLike {
  type: string;
  id: string;
  summary?: string;
  details?: unknown;
  data?: unknown;
  content?: unknown;
  message?: { content?: unknown };
}

function ctxWith(branch: EntryLike[] | unknown, sessionId?: string): TranscriptContextLike {
  return {
    sessionManager: {
      getBranch: () => branch,
      getSessionId: () => sessionId,
    },
  };
}

function captureReasons(): { reasons: string[]; onReason: (reason: string) => void } {
  const reasons: string[] = [];
  return { reasons, onReason: (reason) => reasons.push(reason) };
}

function parseQuote(json: string | null): { host_kind: string; host_session_id: string; entry_id: string; quote: string } {
  assert.ok(json !== null, "expected a transcript quote JSON string");
  return JSON.parse(json) as { host_kind: string; host_session_id: string; entry_id: string; quote: string };
}

test("extractor prefers an available original message over derived compaction", () => {
  const branch: EntryLike[] = [
    { type: "message", id: "msg-1", message: { content: "plain recent message" } },
    { type: "compaction", id: "cp-1", details: { kind: "maestro-session-checkpoint", text: "compaction quote text" } },
  ];
  const json = extractTranscriptQuote(ctxWith(branch, "host-session-1"), "canonical-1");
  assert.deepEqual(parseQuote(json), {
    host_kind: "pi",
    host_session_id: "host-session-1",
    entry_id: "msg-1",
    quote: "plain recent message",
  });
});

test("extractor selects the newest original message instead of older compaction", () => {
  // 分支时间正序：最后一条 = 最近。
  const branch: EntryLike[] = [
    { type: "compaction", id: "cp-old", details: { summary: "compaction text" } },
    { type: "message", id: "msg-new", message: { content: "newest plain message" } },
  ];
  const parsed = parseQuote(extractTranscriptQuote(ctxWith(branch, "host-1")));
  assert.equal(parsed.entry_id, "msg-new");
  assert.equal(parsed.quote, "newest plain message");
});

test("extractor falls back to the most recent text entry (minimal viable)", () => {
  const branch: EntryLike[] = [
    { type: "label", id: "label-1" },
    { type: "message", id: "msg-2", message: { content: [{ type: "text", text: "recent answer" }] } },
    { type: "custom_message", id: "cm-1", content: "custom note" },
  ];
  const parsed = parseQuote(extractTranscriptQuote(ctxWith(branch, "host-1")));
  assert.equal(parsed.entry_id, "cm-1");
  assert.equal(parsed.quote, "custom note");
});

test("extractor falls back to compaction summary when details carry no text", () => {
  const branch: EntryLike[] = [
    { type: "compaction", id: "cp-1", summary: "summary text", details: { kind: "maestro-session-checkpoint" } },
  ];
  const parsed = parseQuote(extractTranscriptQuote(ctxWith(branch, "host-1")));
  assert.equal(parsed.entry_id, "cp-1");
  assert.equal(parsed.quote, "summary text");
});

test("extractor uses 'unknown' when the host session id is unavailable", () => {
  const branch: EntryLike[] = [{ type: "message", id: "m-1", message: { content: "some text" } }];
  const parsed = parseQuote(extractTranscriptQuote(ctxWith(branch, undefined)));
  assert.equal(parsed.host_session_id, "unknown");
});

test("extractor returns null and records a reason for an empty branch", () => {
  const { reasons, onReason } = captureReasons();
  const result = extractTranscriptQuote(ctxWith([], "host-1"), "canonical-1", { onReason });
  assert.equal(result, null);
  assert.ok(reasons.some((reason) => reason.includes("no branch entries")), reasons.join(" | "));
});

test("extractor returns null and records a reason when getBranch throws", () => {
  const { reasons, onReason } = captureReasons();
  const ctx: TranscriptContextLike = {
    sessionManager: {
      getBranch: () => {
        throw new Error("branch exploded");
      },
      getSessionId: () => "host-1",
    },
  };
  const result = extractTranscriptQuote(ctx, undefined, { onReason });
  assert.equal(result, null);
  assert.ok(reasons.some((reason) => reason.includes("getBranch() threw") && reason.includes("branch exploded")), reasons.join(" | "));
});

test("extractor returns null and records a reason when no entry has readable text", () => {
  const { reasons, onReason } = captureReasons();
  const branch: EntryLike[] = [
    { type: "custom", id: "c-1", data: { enabled: true } },
    { type: "label", id: "l-1" },
  ];
  const result = extractTranscriptQuote(ctxWith(branch, "host-1"), undefined, { onReason });
  assert.equal(result, null);
  assert.ok(reasons.some((reason) => reason.includes("no readable text")), reasons.join(" | "));
});

test("extractor truncates the quote to 32 KiB by default", () => {
  const longQuote = "x".repeat(DEFAULT_TRANSCRIPT_QUOTE_MAX_BYTES + 8 * 1024);
  const branch: EntryLike[] = [{ type: "compaction", id: "cp-1", details: { text: longQuote } }];
  const parsed = parseQuote(extractTranscriptQuote(ctxWith(branch, "host-1")));
  assert.equal(parsed.entry_id, "cp-1");
  assert.ok(Buffer.byteLength(parsed.quote, "utf8") <= DEFAULT_TRANSCRIPT_QUOTE_MAX_BYTES);
  assert.equal(parsed.quote, "x".repeat(DEFAULT_TRANSCRIPT_QUOTE_MAX_BYTES));
});

test("extractor honors a custom quote byte cap without splitting multi-byte characters", () => {
  const branch: EntryLike[] = [{ type: "compaction", id: "cp-1", details: { text: "中文quote-text" } }];
  const parsed = parseQuote(extractTranscriptQuote(ctxWith(branch, "host-1"), undefined, { maxQuoteBytes: 6 }));
  assert.equal(parsed.quote, "中文"); // 6 字节恰好容纳两个 3 字节汉字；"q" 会超限被丢弃
  assert.ok(Buffer.byteLength(parsed.quote, "utf8") <= 6);
});

test("extractor dedups identical content across calls via the shared fingerprint set", () => {
  const { reasons, onReason } = captureReasons();
  const branch: EntryLike[] = [{ type: "compaction", id: "cp-1", details: { text: "same quote" } }];
  const dedupFingerprints = new Set<string>();
  const first = parseQuote(extractTranscriptQuote(ctxWith(branch, "host-1"), undefined, { dedupFingerprints, onReason }));
  assert.equal(first.entry_id, "cp-1");
  const second = extractTranscriptQuote(ctxWith(branch, "host-1"), undefined, { dedupFingerprints, onReason });
  assert.equal(second, null);
  assert.ok(reasons.some((reason) => reason.includes("dedup")), reasons.join(" | "));
});

test("extractor dedup skips a repeated quote and picks the next older entry", () => {
  // 分支时间正序：cp-new 在最后 = 最近。
  const branch: EntryLike[] = [
    { type: "compaction", id: "cp-old", details: { text: "quote-B" } },
    { type: "compaction", id: "cp-new", details: { text: "quote-A" } },
  ];
  const dedupFingerprints = new Set<string>();
  const first = parseQuote(extractTranscriptQuote(ctxWith(branch, "host-1"), undefined, { dedupFingerprints }));
  assert.equal(first.entry_id, "cp-new");
  const second = parseQuote(extractTranscriptQuote(ctxWith(branch, "host-1"), undefined, { dedupFingerprints }));
  assert.equal(second.entry_id, "cp-old");
  assert.equal(second.quote, "quote-B");
});

// === adapter 透传 ===

const TRANSCRIPT_QUOTE_JSON = JSON.stringify({
  host_kind: "pi",
  host_session_id: "host-session-1",
  entry_id: "cp-1",
  quote: "compaction quote text",
});

// === 正文/证据分离（生产 handler 同一 helper）===

test("bindTranscriptEvidence keeps distilled content separate from raw quote", () => {
  const bound = bindTranscriptEvidence("human distilled rule", TRANSCRIPT_QUOTE_JSON);
  assert.equal(bound.content, "human distilled rule");
  assert.equal(bound.transcriptQuote, TRANSCRIPT_QUOTE_JSON);
  assert.equal(bound.content.includes("compaction quote text"), false);
});

test("bindTranscriptEvidence rejects empty content and invalid descriptors", () => {
  assert.throws(() => bindTranscriptEvidence("   ", TRANSCRIPT_QUOTE_JSON), /content is required/);
  assert.throws(() => bindTranscriptEvidence("rule", "{}"), /descriptor is invalid/);
});

test("stageWindowKnowledgeCandidate executes the production composition without quote leakage", async () => {
  const ctx = ctxWith([
    { type: "message", id: "msg-9", message: { content: "raw window secret" } },
  ], "host-9");
  let captured: Parameters<KnowledgeCliAdapter["stage"]>[0] | undefined;
  const outcome = await stageWindowKnowledgeCandidate(
    ctx,
    "canonical-9",
    { target: "knowhow", title: "Distilled title", content: "distilled safe content" },
    async options => {
      captured = options;
      return { candidate_id: "KDC-1" };
    },
  );
  assert.equal(outcome.result?.candidate_id, "KDC-1");
  assert.equal(captured?.content, "distilled safe content");
  assert.equal(captured?.content.includes("raw window secret"), false);
  assert.match(captured?.transcriptQuote ?? "", /raw window secret/);
});

test("stageWindowKnowledgeCandidate does not call stage when no readable entry exists", async () => {
  let called = false;
  const outcome = await stageWindowKnowledgeCandidate(
    ctxWith([], "host-empty"),
    "canonical-empty",
    { target: "spec", title: "Nothing", content: "safe content" },
    async () => {
      called = true;
      return { candidate_id: "unexpected" };
    },
  );
  assert.equal(outcome.result, null);
  assert.match(outcome.reason ?? "", /no branch entries/i);
  assert.equal(called, false);
});

test("adapter stage passes --transcript-quote via a temp file (stdin unsupported by the runner)", async () => {
  let capturedQuotePath: string | undefined;
  let capturedArgs: string[] = [];
  const adapter = new KnowledgeCliAdapter("/proj", fakeRunner((args) => {
    capturedArgs = args;
    const quoteIndex = args.indexOf("--transcript-quote");
    assert.ok(quoteIndex !== -1, "argv must contain --transcript-quote");
    capturedQuotePath = args[quoteIndex + 1];
    assert.ok(capturedQuotePath.startsWith(tmpdir()), "quote JSON goes to a temp file under the OS tmpdir");
    // 子进程 argv 里只有路径，quote 原文在文件里
    assert.equal(args.some((argument) => argument.includes("compaction quote text")), false);
    const fileContent = readFileSync(capturedQuotePath, "utf8");
    assert.equal(fileContent, TRANSCRIPT_QUOTE_JSON);
    return jsonResult(args, {
      session_id: "session-1", run_id: "run-9", candidate_id: "KDC-0123456789abcdef", signal_recorded: 0,
    });
  }));

  const result = await adapter.stage({
    target: "spec",
    title: "Decision: use the fence",
    content: "fence before mutation",
    sessionId: "session-1",
    transcriptQuote: TRANSCRIPT_QUOTE_JSON,
  });
  assert.equal(result.candidate_id, "KDC-0123456789abcdef");

  // 其余 argv 与既有风格一致；--transcript-quote 插在 --json 之前
  const quoteIndex = capturedArgs.indexOf("--transcript-quote");
  assert.deepEqual([...capturedArgs.slice(0, quoteIndex), ...capturedArgs.slice(quoteIndex + 2)], [
    "knowledge", "stage", "spec", "Decision: use the fence", "fence before mutation",
    "--session", "session-1",
    "--json",
    "--workflow-root", "/proj",
  ]);
  // 临时文件在 stage 返回前已清理
  assert.ok(capturedQuotePath !== undefined && !existsSync(capturedQuotePath), "temp quote file must be cleaned up");
});

test("adapter stage passes --transcript-quote with an existing file path verbatim", async () => {
  const adapter = new KnowledgeCliAdapter("/proj", fakeRunner((args) => {
    const quoteIndex = args.indexOf("--transcript-quote");
    assert.ok(quoteIndex !== -1);
    assert.equal(args[quoteIndex + 1], "/tmp/existing-quote.json");
    assert.deepEqual([...args.slice(0, quoteIndex), ...args.slice(quoteIndex + 2)], [
      "knowledge", "stage", "knowhow", "Reusable recipe", "content text",
      "--json",
      "--workflow-root", "/proj",
    ]);
    return jsonResult(args, {
      session_id: "s", run_id: "r", candidate_id: "KDC-aaaabbbbccccdddd", signal_recorded: 0,
    });
  }));

  const result = await adapter.stage({
    target: "knowhow",
    title: "Reusable recipe",
    content: "content text",
    transcriptQuoteFile: "/tmp/existing-quote.json",
  });
  assert.equal(result.candidate_id, "KDC-aaaabbbbccccdddd");
});

test("adapter stage cleans up the temp quote file even when the CLI fails", async () => {
  let capturedQuotePath: string | undefined;
  const adapter = new KnowledgeCliAdapter(
    "/proj",
    fakeRunner((args) => {
      const quoteIndex = args.indexOf("--transcript-quote");
      capturedQuotePath = args[quoteIndex + 1];
      return { exitCode: 1, argv: args, stdout: "", stderr: "Error: quote rejected" };
    }),
  );
  await assert.rejects(
    adapter.stage({ target: "spec", title: "t", content: "c", transcriptQuote: TRANSCRIPT_QUOTE_JSON }),
    /failed \(1\): Error: quote rejected/,
  );
  assert.ok(capturedQuotePath !== undefined && !existsSync(capturedQuotePath), "temp quote file must be cleaned up on failure");
});

type FakeRunner = (args: string[]) => Promise<RunCliResult>;

function fakeRunner(handler: (args: string[]) => RunCliResult): FakeRunner {
  return async (args) => handler(args);
}

function jsonResult(args: string[], value: unknown): RunCliResult {
  return { exitCode: 0, argv: args, stdout: JSON.stringify(value), stderr: "" };
}
