import assert from "node:assert/strict";
import test from "node:test";
import {
  dedupBlocks,
  isPrefixMonotonic,
  type DedupBlock,
} from "../src/compaction/dedup.ts";

const LINES_A = [
  "def render(data):",
  "    return [x for x in data if x]",
  "    return [y for y in data if y]",
  "    return [z for z in data if z]",
].join("\n");

test("dedupBlocks folds a later verbatim span into a pointer", () => {
  const blocks: DedupBlock[] = [
    { text: LINES_A, callId: "call-a" },
    { text: `${LINES_A}\nmore lines\nhere`, callId: "call-b" },
  ];
  const result = dedupBlocks(blocks);
  assert.equal(result.stats.spansFolded, 1);
  assert.ok(result.refs.get("call-b")?.has("call-a"));
  assert.ok(result.blocks[1].text.includes(`same as msg call-a`));
  assert.ok(result.blocks[1].text.length < blocks[1].text.length);
});

test("dedupBlocks keeps the earliest occurrence verbatim", () => {
  const blocks: DedupBlock[] = [
    { text: LINES_A, callId: "call-a" },
    { text: LINES_A, callId: "call-b" },
    { text: LINES_A, callId: "call-c" },
  ];
  const result = dedupBlocks(blocks);
  assert.equal(result.blocks[0].text, LINES_A, "first occurrence never rewritten");
  assert.ok(result.blocks[1].text.includes("same as msg call-a"));
  assert.ok(result.blocks[2].text.includes("same as msg call-a"));
});

test("dedupBlocks allows a uniform line-number shift (renumbered re-read)", () => {
  const renumbered = LINES_A
    .split("\n")
    .map((line, i) => `${i + 100}:${line}`)
    .join("\n");
  const original = LINES_A
    .split("\n")
    .map((line, i) => `${i + 1}:${line}`)
    .join("\n");
  const blocks: DedupBlock[] = [
    { text: original, callId: "call-a" },
    { text: renumbered, callId: "call-b" },
  ];
  const result = dedupBlocks(blocks);
  assert.equal(result.stats.spansFolded, 1);
  assert.ok(result.blocks[1].text.includes("+99L"), "the shift is carried in the pointer");
});

test("dedupBlocks respects min_lines and min_chars floors", () => {
  const small = ["alpha one", "beta two", "gamma three"].join("\n");
  const blocks: DedupBlock[] = [
    { text: small, callId: "call-a" },
    { text: small, callId: "call-b" },
  ];
  assert.equal(dedupBlocks(blocks, { minLines: 5 }).stats.spansFolded, 0);
  assert.equal(dedupBlocks(blocks, { minChars: 100 }).stats.spansFolded, 0);
  assert.equal(dedupBlocks(blocks, { minLines: 2, minChars: 1 }).stats.spansFolded, 1);
});

test("dedupBlocks is prefix-monotonic (cache-safe)", () => {
  const blocks: DedupBlock[] = [
    { text: LINES_A, callId: "call-a" },
    { text: `${LINES_A}\ntail-1`, callId: "call-b" },
    { text: `${LINES_A}\ntail-2`, callId: "call-c" },
  ];
  assert.equal(isPrefixMonotonic(blocks), true);
});

test("dedupBlocks never raises and returns input on pathological data", () => {
  const blocks: DedupBlock[] = [{ text: "x", callId: "a" }, { text: "y", callId: "b" }];
  const result = dedupBlocks(blocks, { minLines: 0, minChars: 0 } as never);
  assert.equal(result.blocks.length, 2);
});

test("dedupBlocks refuses a second reference target inside one block", () => {
  const spanA = ["alpha one", "beta two", "gamma three"].join("\n");
  const spanB = ["delta four", "epsilon five", "zeta six"].join("\n");
  const blocks: DedupBlock[] = [
    { text: spanA, callId: "call-a" },
    { text: spanB, callId: "call-b" },
    { text: `${spanA}\n${spanB}`, callId: "call-mix" },
  ];
  const result = dedupBlocks(blocks, { minLines: 2, minChars: 1 });
  // Only the first target may be referenced; the second span stays verbatim.
  assert.equal(result.refs.get("call-mix")?.size, 1);
  assert.ok(result.refs.get("call-mix")?.has("call-a"));
  assert.ok(result.blocks[2].text.includes(spanB), "second-target span is left verbatim");
});

test("dedupBlocks treats unsafe line numbers as plain text (no wrong deltas)", () => {
  const unsafeA = "9007199254740992:alpha one\n9007199254740992:beta two\n9007199254740992:gamma three";
  const unsafeB = "9007199254740993:alpha one\n9007199254740993:beta two\n9007199254740993:gamma three";
  const blocks: DedupBlock[] = [
    { text: unsafeA, callId: "call-a" },
    { text: unsafeB, callId: "call-b" },
  ];
  const result = dedupBlocks(blocks, { minLines: 2, minChars: 1 });
  assert.equal(result.stats.spansFolded, 0, "unsafe prefixes must not fold under a mis-reconstructing delta");
});

test("protected blocks are never rewritten but stay reference targets", () => {
  const blocks: DedupBlock[] = [
    { text: LINES_A, callId: "call-a", protected: true },
    { text: LINES_A, callId: "call-b" },
  ];
  const result = dedupBlocks(blocks);
  assert.equal(result.blocks[0].text, LINES_A);
  assert.ok(result.blocks[1].text.includes("same as msg call-a"));
});
