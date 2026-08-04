import assert from "node:assert/strict";
import test from "node:test";
import { convertToLlm, serializeConversation } from "@earendil-works/pi-coding-agent";
import {
  estimateSummaryRequestTokens,
  fitSummaryInputToWindow,
  MAESTRO_COMPACTION_SYSTEM_PROMPT,
  stripImagesFromMessagesForSummary,
} from "../src/compaction/maestro-compaction.ts";
import { estimateMessageTokens } from "../src/compaction/auto-compaction.ts";

const imageBlock = (data = "A".repeat(5000)) => ({ type: "image", data, mimeType: "image/png" });

// --- P0-1: summary input image placeholders ---

test("stripImagesFromMessagesForSummary replaces top-level image blocks with [image] text", () => {
  const messages = [{
    role: "user",
    content: [{ type: "text", text: "Look at this" }, imageBlock()],
    timestamp: 1,
  }] as never;
  const stripped = stripImagesFromMessagesForSummary(messages);
  assert.equal(stripped.length, 1);
  const content = (stripped[0] as { content: Array<{ type: string; text?: string }> }).content;
  assert.deepEqual(content.map((b) => b.type), ["text", "text"]);
  assert.equal(content[1].text, "[image]");
});

test("stripImagesFromMessagesForSummary replaces nested toolResult image blocks", () => {
  const messages = [{
    role: "toolResult",
    toolCallId: "t1",
    toolName: "read",
    content: [{ type: "text", text: "here" }, imageBlock()],
    isError: false,
    timestamp: 1,
  }] as never;
  const stripped = stripImagesFromMessagesForSummary(messages);
  const content = (stripped[0] as { content: Array<{ type: string; text?: string }> }).content;
  assert.equal(content.length, 2);
  assert.equal(content[1].type, "text");
  assert.equal((content[1] as { text?: string }).text, "[image]");
});

test("stripImagesFromMessagesForSummary replaces document blocks with [document]", () => {
  const messages = [{
    role: "user",
    content: [{ type: "document", title: "spec.pdf", source: { type: "base64", data: "JVBERi0xLjQ=" } }],
    timestamp: 1,
  }] as never;
  const stripped = stripImagesFromMessagesForSummary(messages);
  const content = (stripped[0] as { content: Array<{ type: string; text?: string }> }).content;
  assert.equal(content.length, 1);
  assert.equal(content[0].type, "text");
  assert.equal(content[0].text, "[document]");
});

test("stripImagesFromMessagesForSummary leaves text-only and string-content messages untouched", () => {
  const textOnly = [{ role: "user", content: [{ type: "text", text: "hi" }], timestamp: 1 }] as never;
  assert.deepEqual(stripImagesFromMessagesForSummary(textOnly), textOnly);
  const stringContent = [{ role: "user", content: "plain string", timestamp: 1 }] as never;
  assert.deepEqual(stripImagesFromMessagesForSummary(stringContent), stringContent);
});

test("stripped summary serialization keeps placeholders and drops image pixels", () => {
  const messages = [{
    role: "user",
    content: [{ type: "text", text: "prefix" }, imageBlock("B".repeat(200_000))],
    timestamp: 1,
  }] as never;
  const serialized = serializeConversation(convertToLlm(stripImagesFromMessagesForSummary(messages)));
  assert.match(serialized, /\[image\]/);
  assert.ok(!serialized.includes("BBBB"), "image pixels must not reach the summary prompt");
});

// --- P0-2: summary capacity stays text-only (027: eliminate image-inflated estimates) ---

// The compaction API request is pure text (image pixels never reach it), so the
// capacity estimate must not add per-image cost — otherwise media-dense
// sessions get over-pruned. Image-inclusive tokensBefore remains fallback only.
test("summary capacity estimate ignores image blocks (027 semantics)", () => {
  const textPrompt = "hello world";
  const base = estimateSummaryRequestTokens(MAESTRO_COMPACTION_SYSTEM_PROMPT, textPrompt);
  // The serialized prompt carries placeholders, not pixels; the estimate input
  // is the same text regardless of how many images were in the history.
  const withPlaceholders = estimateSummaryRequestTokens(
    MAESTRO_COMPACTION_SYSTEM_PROMPT,
    `${textPrompt} [image] [image] [image]`,
  );
  assert.ok(withPlaceholders < base + 200, "placeholders are tiny text, not per-image token cost");
});

// --- P1-1: document blocks charged fixed tokens, not base64 text ---

test("estimateMessageTokens charges documents a fixed cost, not base64 text size", () => {
  const bigBase64 = "A".repeat(1_000_000); // 1MB PDF → ~1.33M base64 chars → ~325K tokens if counted as text
  const documentMessage = {
    role: "user",
    content: [{ type: "document", title: "spec.pdf", source: { type: "base64", data: bigBase64 } }],
    timestamp: 1,
  } as never;
  const tokens = estimateMessageTokens(documentMessage);
  assert.ok(tokens < 10_000, `document tokens ${tokens} must not blow up with base64 size`);
  assert.ok(tokens >= 2000, `document must include the fixed ~2000 per-document estimate`);
});

test("estimateMessageTokens keeps image estimate unchanged at ~1200 per image", () => {
  const oneImage = estimateMessageTokens({
    role: "user",
    content: [imageBlock()],
    timestamp: 1,
  } as never);
  assert.ok(oneImage >= 1200 && oneImage < 1300, `single image ~1200, got ${oneImage}`);
});

test("estimateMessageTokens charges image and document blocks independently in one message", () => {
  const mixed = {
    role: "user",
    content: [
      { type: "text", text: "attachments" },
      imageBlock(),
      { type: "document", title: "spec.pdf", source: { type: "base64", data: "A".repeat(100_000) } },
      imageBlock(),
    ],
    timestamp: 1,
  } as never;
  const tokens = estimateMessageTokens(mixed);
  // 2 images × 1200 + 1 document × 2000 + tiny text overhead
  assert.ok(tokens >= 1200 * 2 + 2000, `must include 2×1200 image + 2000 document, got ${tokens}`);
  assert.ok(tokens < 1200 * 2 + 2000 + 200, `must not count base64 as text, got ${tokens}`);
});

test("estimateMessageTokens and stripping tolerate empty/undefined content", () => {
  const empty = { role: "user", content: [], timestamp: 1 } as never;
  const tokens = estimateMessageTokens(empty);
  assert.ok(tokens > 0 && tokens < 500, `empty content stays tiny, got ${tokens}`);
  assert.deepEqual(stripImagesFromMessagesForSummary([empty]), [empty], "empty content passes through");
  const missing = { role: "user", timestamp: 1 } as never;
  assert.deepEqual(stripImagesFromMessagesForSummary([missing]), [missing], "undefined content passes through");
});

test("document placeholder is text, so summary capacity is not inflated by documents (027)", () => {
  const base = estimateSummaryRequestTokens(MAESTRO_COMPACTION_SYSTEM_PROMPT, "hello");
  const withDocs = estimateSummaryRequestTokens(
    MAESTRO_COMPACTION_SYSTEM_PROMPT,
    "hello [document] [document]",
  );
  assert.ok(withDocs < base + 200, "document placeholders are tiny text, not per-document token cost");
});

// --- P1-2: vision description text survives compaction independently ---

test("maestro-vision-analysis custom message becomes text and survives summary serialization", () => {
  const description = "### Attached image 1 (gpt-5.6-sol)\nThe screenshot shows a red error dialog";
  const messages = [{
    role: "custom",
    customType: "maestro-vision-analysis",
    content: description,
    display: false,
    timestamp: 1,
  }] as never;
  // convertToLlm custom branch → text block
  const llm = convertToLlm(messages);
  const user = llm[0] as { role: "user"; content: Array<{ type: string; text?: string }> };
  assert.equal(user.role, "user");
  assert.equal(user.content[0].type, "text");
  // stripImages (P0-1) must not remove it
  const stripped = stripImagesFromMessagesForSummary(llm);
  // serializeConversation keeps the description text in the summary input
  const serialized = serializeConversation(stripped);
  assert.match(serialized, /The screenshot shows a red error dialog/);
  assert.ok(!serialized.includes("[image]"), "pure text description needs no placeholder");
});

test("image + vision description pair: placeholder marks position, description keeps content", () => {
  const messages = [
    {
      role: "user",
      content: [{ type: "text", text: "here is the screenshot" }, imageBlock()],
      timestamp: 1,
    },
    {
      role: "custom",
      customType: "maestro-vision-analysis",
      content: "The screenshot shows a red error dialog",
      display: false,
      timestamp: 2,
    },
  ] as never;
  const serialized = serializeConversation(convertToLlm(stripImagesFromMessagesForSummary(messages)));
  assert.match(serialized, /\[image\]/, "placeholder keeps position semantics");
  assert.match(serialized, /red error dialog/, "description text is independently preserved");
});

// --- Integration: media-dense input does not inflate summary capacity ---

test("fitSummaryInputToWindow drops the same rounds with or without images in history", () => {
  const textRound = (index: number) => ([
    { role: "assistant", content: [{ type: "toolCall", id: `call-${index}`, name: "read", arguments: {} }] },
    { role: "toolResult", toolCallId: `call-${index}`, toolName: "read", content: [{ type: "text", text: "x".repeat(1_000) }], isError: false },
  ]);
  const imageRound = (index: number) => ([
    { role: "assistant", content: [{ type: "toolCall", id: `call-${index}`, name: "read", arguments: {} }] },
    { role: "toolResult", toolCallId: `call-${index}`, toolName: "read", content: [{ type: "text", text: "x".repeat(1_000) }, imageBlock()], isError: false },
  ]);
  const mk = (rounds: Array<Array<unknown>>) => rounds.flat();
  const manyRounds: Array<Array<unknown>> = [];
  for (let index = 0; index < 120; index++) manyRounds.push(textRound(index));
  const withImages: Array<Array<unknown>> = [];
  for (let index = 0; index < 120; index++) withImages.push(imageRound(index));

  const buildPrompt = (messages: unknown[]) => JSON.stringify({
    conversationText: serializeConversation(convertToLlm(messages as never)),
    previousSummary: null,
    runtimeState: {},
    operatorFocus: null,
  }, null, 2);

  // Same conversation shape with images added must NOT require more dropped
  // rounds: the summary request is pure text (pixels stripped), so per-image
  // cost must not shrink the retained window (027 semantics).
  const baseFit = fitSummaryInputToWindow({
    source: { messages: mk(manyRounds) as never, buildPrompt },
    tokensBefore: 400_000,
    reserveTokens: 16_384,
    contextWindow: 200_000,
    modelMaxTokens: 32_768,
  });
  const imageFit = fitSummaryInputToWindow({
    source: { messages: mk(withImages) as never, buildPrompt },
    tokensBefore: 400_000,
    reserveTokens: 16_384,
    contextWindow: 200_000,
    modelMaxTokens: 32_768,
  });
  assert.equal(imageFit.droppedRounds, baseFit.droppedRounds,
    `images must not inflate summary capacity: base ${baseFit.droppedRounds} vs images ${imageFit.droppedRounds}`);
  assert.equal(imageFit.maxTokens, baseFit.maxTokens,
    `output budget must not shrink for media-dense history: base ${baseFit.maxTokens} vs images ${imageFit.maxTokens}`);
});
