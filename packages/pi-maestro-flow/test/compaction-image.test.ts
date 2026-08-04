import assert from "node:assert/strict";
import test from "node:test";
import { convertToLlm, serializeConversation } from "@earendil-works/pi-coding-agent";
import {
  countImageBlocks,
  estimateSummaryInputTokensWithImages,
  estimateSummaryRequestTokens,
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

// --- P0-2: summary capacity estimation includes image cost ---

test("countImageBlocks counts top-level and nested images, ignores text/string content", () => {
  const messages = [
    { role: "user", content: [{ type: "text", text: "a" }, imageBlock()], timestamp: 1 },
    { role: "toolResult", toolCallId: "t", toolName: "read", content: [imageBlock(), imageBlock()], isError: false, timestamp: 2 },
    { role: "user", content: "no blocks", timestamp: 3 },
  ] as never;
  assert.equal(countImageBlocks(messages), 3);
});

test("estimateSummaryInputTokensWithImages adds per-image cost over the text estimate", () => {
  const textPrompt = "hello world";
  const textTokens = estimateSummaryRequestTokens(MAESTRO_COMPACTION_SYSTEM_PROMPT, textPrompt);
  const messages = [
    { role: "user", content: [{ type: "text", text: "a" }, imageBlock()], timestamp: 1 },
    { role: "user", content: [imageBlock(), imageBlock()], timestamp: 2 },
  ] as never;
  const withImages = estimateSummaryInputTokensWithImages(messages, MAESTRO_COMPACTION_SYSTEM_PROMPT, textPrompt);
  // 3 images × 1200 fixed cost + unchanged text estimate
  assert.equal(withImages, textTokens + 3 * 1200);
  const noImages = estimateSummaryInputTokensWithImages([], MAESTRO_COMPACTION_SYSTEM_PROMPT, textPrompt);
  assert.equal(noImages, textTokens, "no-image input must be unchanged");
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
