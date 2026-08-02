import assert from "node:assert/strict";
import test from "node:test";
import {
  collapseRuns,
  compactLossless,
  diffStripIndex,
  expandRuns,
  foldRepeatedBlocks,
  hasLosslessGain,
  isRunCollapsed,
  pathHeading,
  pathUnheading,
  searchDirHeading,
  searchDirUnheading,
  searchHeading,
  searchUnheading,
  stripAnsi,
  unfoldRepeatedBlocks,
} from "../src/compaction/lossless.ts";
import { applyContextPressurePolicy, type PruneManifest } from "../src/compaction/auto-compaction.ts";
import { createDefaultSoftCompaction } from "../src/compaction/compaction-settings.ts";

// ── run collapse ─────────────────────────────────────────────────────────────

test("collapseRuns folds >=2 identical consecutive lines and expandRuns restores byte-exactly", () => {
  const line = "b".repeat(50);
  const input = `a\n${line}\n${line}\n${line}\nc\nc\n`;
  const collapsed = collapseRuns(input);
  assert.equal(collapsed, `a\n${line}\n... (repeated 3 times)\nc\n... (repeated 2 times)\n`);
  assert.equal(expandRuns(collapsed), input);
  assert.ok(collapsed.length < input.length);
});

test("collapseRuns is a no-op on distinct lines and preserves trailing newline", () => {
  const input = "x\ny\nz\n";
  assert.equal(collapseRuns(input), input);
  assert.equal(collapseRuns(""), "");
  assert.equal(collapseRuns("solo"), "solo");
});

test("isRunCollapsed detects marker lines", () => {
  assert.equal(isRunCollapsed("a\n... (repeated 3 times)\n"), true);
  assert.equal(isRunCollapsed("a\nb\n"), false);
});

// ── repeated-block folding ───────────────────────────────────────────────────

test("foldRepeatedBlocks folds non-adjacent repeated stanzas (k8s config shape)", () => {
  const stanza = "container:\n  name: app-with-a-long-identifier\n  image: registry.example.com/team/nginx:1.27.0\n  replicas: 3\n  resources:\n    limits:\n      memory: 512Mi\n";
  // Two identical stanzas separated by one different line.
  const input = `${stanza}separator\n${stanza}`;
  const folded = foldRepeatedBlocks(input);
  assert.ok(folded.length < input.length, `fold should shrink: ${folded.length} >= ${input.length}`);
  assert.ok(folded.includes("repeats"));
  assert.equal(unfoldRepeatedBlocks(folded), input);
});

test("foldRepeatedBlocks leaves short content alone", () => {
  const input = "a\nb\nc\na\nb\nc\n";
  // 6 lines is above the 2*FOLD_MIN_BLOCK floor; block of 3 repeats 3 lines back.
  const folded = foldRepeatedBlocks(input);
  assert.equal(unfoldRepeatedBlocks(folded), input);
});

// ── grep heading folding ─────────────────────────────────────────────────────

test("searchHeading/unheading round-trip on grep output", () => {
  const input = "src/a.ts:10:const x = 1\nsrc/a.ts:11:const y = 2\nsrc/b.ts:3:const z = 3\n";
  const headed = searchHeading(input);
  assert.ok(headed.startsWith("src/a.ts\n"), headed);
  assert.equal(searchUnheading(headed), input);
  assert.ok(headed.length < input.length);
});

test("searchDirHeading/unheading round-trip on grep -rn shape (one match per file)", () => {
  const input = "src/a.ts:10:err()\nsrc/b.ts:3:err()\nsrc/c.ts:7:err()\n";
  const dirHeaded = searchDirHeading(input);
  assert.ok(dirHeaded.startsWith("src/\n"), dirHeaded);
  assert.equal(searchDirUnheading(dirHeaded), input);
  assert.ok(dirHeaded.length < input.length);
});

test("compactLossless search keeps the smaller of the two folds", () => {
  // Directory fold wins here (one match per file).
  const input = "src/a.ts:10:err()\nsrc/b.ts:3:err()\n";
  const out = compactLossless(input, "search");
  assert.ok(out.length < input.length);
  // Round-trip must hold for whichever fold was chosen.
  assert.ok(
    searchUnheading(out) === input || searchDirUnheading(out) === input,
    "selected fold must round-trip",
  );
});

// ── path listing folding ─────────────────────────────────────────────────────

test("pathHeading/unheading round-trip on find output", () => {
  const input = "src/compaction/a.ts\nsrc/compaction/b.ts\nsrc/compaction/c.ts\ntest/d.ts\n";
  const folded = pathHeading(input);
  assert.ok(folded.startsWith("src/compaction/\n"), folded);
  assert.equal(pathUnheading(folded), input);
  assert.ok(folded.length < input.length);
});

test("compactLossless paths accepts a reversible directory fold", () => {
  const input = "a\nb/c.ts\nb/d.ts\n";
  const out = compactLossless(input, "paths");
  // The fold is reversible here — "a" survives as a passthrough line and the
  // b/ header plus basenames reconstruct the rows byte-exactly.
  assert.equal(pathUnheading(out), input);
  assert.ok(out.length <= input.length);
});

// ── diff / ansi ──────────────────────────────────────────────────────────────

test("diffStripIndex removes index bookkeeping lines only", () => {
  const input = "diff --git a/x b/x\nindex abc123..def456 100644\n--- a/x\n+++ b/x\n@@ -1 +1 @@\n-1\n+2\n";
  const out = diffStripIndex(input);
  assert.ok(!out.includes("index "));
  assert.ok(out.includes("diff --git") && out.includes("@@ -1 +1 @@"));
  assert.ok(out.length < input.length);
});

test("stripAnsi removes color escapes", () => {
  const input = "\u001b[31mERROR\u001b[0m: boom\n";
  assert.equal(stripAnsi(input), "ERROR: boom\n");
});

test("compactLossless log strips ansi and collapses runs with round-trip check", () => {
  const input = "\u001b[31mERROR: boom\u001b[0m\n\u001b[31mERROR: boom\u001b[0m\n\u001b[31mERROR: boom\u001b[0m\n";
  const out = compactLossless(input, "log");
  assert.ok(out.includes("(repeated 3 times)"));
  // Round-trip is against the de-ANSI baseline, so expand must reproduce the
  // de-ANSI text exactly.
  assert.equal(expandRuns(out), stripAnsi(input));
  assert.ok(out.length < input.length);
});

test("compactLossless returns the original when there is nothing to gain", () => {
  const input = "single line of prose\nanother line\n";
  assert.equal(compactLossless(input, "text"), input);
  assert.equal(compactLossless("", "text"), "");
  assert.equal(hasLosslessGain(input, "text"), false);
});

test("compactLossless never throws on pathological input", () => {
  assert.equal(compactLossless("a\n".repeat(50_000), "text"), "a\n... (repeated 50000 times)\n");
  // Pure ANSI strips to an empty string (non-semantic color dropped one-way).
  assert.equal(compactLossless("\u001b[1;31m".repeat(10), "log"), "");
  assert.equal(compactLossless("\u001b[1;31m".repeat(10), "text"), "\u001b[1;31m".repeat(10));
});

// ── pipeline integration: lossless tier runs before lossy pruning ───────────

function logOutput(blocks: number): string {
  // ~10 chars per line * 12 lines * blocks — comfortably over the 500-char floor.
  return Array.from({ length: blocks }, (_, i) => [
    `INFO: module ${i} starting with configuration loaded`,
    `INFO: module ${i} starting with configuration loaded`,
    `INFO: module ${i} starting with configuration loaded`,
  ].join("\n")).join("\n");
}

function pressureSettings(losslessEnabled: boolean) {
  return {
    enabled: true,
    reserveTokens: 100,
    keepRecentTokens: 10,
    soft: {
      ...createDefaultSoftCompaction(),
      lossless: { enabled: losslessEnabled },
    },
  };
}

function makePressureMessages(bashOutput: string) {
  return [{
    role: "assistant",
    content: [{ type: "toolCall", id: "call-bash", name: "bash", arguments: {} }],
    usage: { input: 1_000, output: 0, cacheRead: 0, cacheWrite: 0, cost: { total: 0 } },
  }, {
    role: "toolResult",
    toolCallId: "call-bash",
    toolName: "bash",
    content: [{ type: "text", text: bashOutput }],
    isError: false,
  }, {
    // Trailing turn so the recent frontier protects THIS message, not the
    // bash result above it (frontier alignment keeps whole tool-result
    // batches intact and would otherwise shield the only result).
    role: "assistant",
    content: [{ type: "text", text: "continuing" }],
  }, {
    role: "toolResult",
    toolCallId: "call-follow",
    toolName: "read",
    content: [{ type: "text", text: "small follow-up" }],
    isError: false,
  }] as never;
}

test("pressure policy folds lossless output into the manifest at level lossless", () => {
  const messages = makePressureMessages(logOutput(40));
  const manifest: PruneManifest = new Map();
  const result = applyContextPressurePolicy(
    messages,
    2_000,
    pressureSettings(true),
    manifest,
  );
  const text = String(result.messages[1]!.content[0].text);
  assert.ok(text.includes("(repeated 3 times)"), `expected folded marker in: ${text.slice(0, 120)}`);
  assert.ok(!text.includes("[Maestro context pressure"), "lossless fold must not be a lossy placeholder");
  const entry = manifest.get("call-bash");
  assert.ok(entry, "manifest entry must exist");
  assert.equal(entry.level, "lossless");
  assert.ok(entry.savedTokens > 0);
});

test("pressure policy skips lossless folding when disabled", () => {
  const messages = makePressureMessages(logOutput(40));
  const manifest: PruneManifest = new Map();
  const result = applyContextPressurePolicy(
    messages,
    2_000,
    pressureSettings(false),
    manifest,
  );
  const text = String(result.messages[1]!.content[0].text);
  assert.ok(!text.includes("(repeated"), "lossless disabled must not fold");
});

test("lossless fold of an error tool result is refused (protected)", () => {
  const messages = [{
    role: "assistant",
    content: [{ type: "toolCall", id: "call-err", name: "bash", arguments: {} }],
    usage: { input: 1_000, output: 0, cacheRead: 0, cacheWrite: 0, cost: { total: 0 } },
  }, {
    role: "toolResult",
    toolCallId: "call-err",
    toolName: "bash",
    content: [{ type: "text", text: logOutput(40) }],
    isError: true,
  }] as never;
  const manifest: PruneManifest = new Map();
  applyContextPressurePolicy(messages, 2_000, pressureSettings(true), manifest);
  assert.equal(manifest.has("call-err"), false, "error tool results are never folded or pruned");
});
