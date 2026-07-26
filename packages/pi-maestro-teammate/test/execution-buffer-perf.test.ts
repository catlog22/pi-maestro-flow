import assert from "node:assert/strict";
import test from "node:test";
import {
  EXECUTION_BUFFER_LIMITS,
  appendBoundedTranscriptMessage,
  truncateUtf8Tail,
} from "../src/runs/execution.ts";

/** The pre-fix implementation, kept as the regression baseline to measure against. */
function legacyTruncateUtf8Tail(value: string, maxBytes: number): string {
  if (maxBytes <= 0) return "";
  const encoded = Buffer.from(value, "utf8");
  if (encoded.length <= maxBytes) return value;
  let start = encoded.length - maxBytes;
  while (start < encoded.length && (encoded[start] & 0xc0) === 0x80) start += 1;
  return encoded.subarray(start).toString("utf8");
}

function legacyAppendBoundedTranscriptMessage(
  messages: Array<{ role: string; content: string }>,
  message: { role: string; content: string },
): void {
  messages.push({
    ...message,
    content: legacyTruncateUtf8Tail(message.content, EXECUTION_BUFFER_LIMITS.transcriptMessageBytes),
  });
  let totalBytes = messages.reduce((total, entry) => total + Buffer.byteLength(entry.content, "utf8"), 0);
  while (
    messages.length > EXECUTION_BUFFER_LIMITS.transcriptMessages
    || totalBytes > EXECUTION_BUFFER_LIMITS.transcriptBytes
  ) {
    const removed = messages.shift();
    if (!removed) break;
    totalBytes -= Buffer.byteLength(removed.content, "utf8");
  }
}

function elapsedMs(run: () => void): number {
  const started = process.hrtime.bigint();
  run();
  return Number(process.hrtime.bigint() - started) / 1e6;
}

test("truncateUtf8Tail keeps the byte bound across ASCII, CJK and surrogate pairs", () => {
  const samples = ["abcdefghij", "界".repeat(12), "🙂".repeat(9), `a界🙂${"b".repeat(20)}`];
  for (const sample of samples) {
    const encodedLength = Buffer.byteLength(sample, "utf8");
    for (let maxBytes = 0; maxBytes <= encodedLength + 4; maxBytes += 1) {
      const truncated = truncateUtf8Tail(sample, maxBytes);
      assert.ok(
        Buffer.byteLength(truncated, "utf8") <= maxBytes,
        `bound violated for ${JSON.stringify(sample)} @ ${maxBytes}`,
      );
      assert.equal(
        truncated,
        legacyTruncateUtf8Tail(sample, maxBytes),
        `fast path diverged for ${JSON.stringify(sample)} @ ${maxBytes}`,
      );
      assert.ok(sample.endsWith(truncated), "truncation must keep the tail");
    }
  }
});

test("truncateUtf8Tail returns the value untouched exactly at the byte bound", () => {
  const cjk = "界".repeat(10);
  assert.equal(Buffer.byteLength(cjk, "utf8"), 30);
  assert.equal(truncateUtf8Tail(cjk, 30), cjk);
  assert.equal(Buffer.byteLength(truncateUtf8Tail(cjk, 29), "utf8"), 27);
});

test("streaming appends no longer re-encode the accumulated text on every delta", () => {
  const deltaCount = 20_000;
  const delta = "abcd";
  const maxBytes = EXECUTION_BUFFER_LIMITS.streamBytes;
  // Stays inside the cap for the whole run, which is the hot streaming case.
  assert.ok(deltaCount * delta.length * 3 <= maxBytes * 4);

  const drive = (truncate: (value: string, max: number) => string) => () => {
    let accumulated = "";
    for (let i = 0; i < deltaCount; i += 1) {
      accumulated = truncate(accumulated + delta, maxBytes);
    }
    assert.ok(accumulated.length > 0);
  };

  const legacyMs = elapsedMs(drive(legacyTruncateUtf8Tail));
  const currentMs = elapsedMs(drive(truncateUtf8Tail));

  assert.ok(
    currentMs * 5 < legacyMs,
    `streaming append is still quadratic: current=${currentMs.toFixed(1)}ms legacy=${legacyMs.toFixed(1)}ms`,
  );
});

test("line decoder buffering inherits the same bound-check fast path", () => {
  // PERF-11 shares truncateUtf8Tail with the streaming path: a partial line well
  // under the cap must not be re-encoded per chunk.
  const chunk = "x".repeat(4_096);
  const maxBytes = EXECUTION_BUFFER_LIMITS.lineBytes;
  const drive = (truncate: (value: string, max: number) => string) => () => {
    let buffered = "";
    for (let i = 0; i < 8_000; i += 1) {
      buffered = truncate(buffered + chunk, maxBytes);
      // A long JSON line arriving over many pipe chunks, flushed on newline.
      if (buffered.length > maxBytes / 4) buffered = "";
    }
  };

  const legacyMs = elapsedMs(drive(legacyTruncateUtf8Tail));
  const currentMs = elapsedMs(drive(truncateUtf8Tail));
  assert.ok(
    currentMs * 3 < legacyMs,
    `line buffer append is still re-encoding: current=${currentMs.toFixed(1)}ms legacy=${legacyMs.toFixed(1)}ms`,
  );
});

test("transcript appends stop rescanning retained history for byte totals", () => {
  const content = "y".repeat(16 * 1024);
  const drive = (append: typeof appendBoundedTranscriptMessage) => () => {
    const messages: Array<{ role: string; content: string }> = [];
    for (let i = 0; i < 4_000; i += 1) {
      append(messages, { role: "tool", content });
    }
    assert.ok(messages.length <= EXECUTION_BUFFER_LIMITS.transcriptMessages);
  };

  const legacyMs = elapsedMs(drive(legacyAppendBoundedTranscriptMessage));
  const currentMs = elapsedMs(drive(appendBoundedTranscriptMessage));
  assert.ok(
    currentMs * 3 < legacyMs,
    `transcript append still rescans: current=${currentMs.toFixed(1)}ms legacy=${legacyMs.toFixed(1)}ms`,
  );
});

test("incremental transcript byte accounting evicts identically to a full rescan", () => {
  const contents = [
    "a".repeat(100),
    "界".repeat(30_000),
    "b".repeat(64 * 1024 + 500),
    "🙂".repeat(20_000),
    "c",
    "d".repeat(200 * 1024),
  ];
  const current: Array<{ role: string; content: string }> = [];
  const legacy: Array<{ role: string; content: string }> = [];
  for (let i = 0; i < 400; i += 1) {
    const message = { role: i % 3 === 0 ? "tool" : "assistant", content: contents[i % contents.length] };
    appendBoundedTranscriptMessage(current, { ...message });
    legacyAppendBoundedTranscriptMessage(legacy, { ...message });
    assert.deepEqual(current, legacy, `divergence after append ${i}`);
  }
  const totalBytes = current.reduce((total, entry) => total + Buffer.byteLength(entry.content, "utf8"), 0);
  assert.ok(totalBytes <= EXECUTION_BUFFER_LIMITS.transcriptBytes);
  assert.ok(current.length <= EXECUTION_BUFFER_LIMITS.transcriptMessages);
});

test("transcript byte accounting recovers after the array is reset in place", () => {
  const messages: Array<{ role: string; content: string }> = [];
  for (let i = 0; i < 10; i += 1) {
    appendBoundedTranscriptMessage(messages, { role: "tool", content: "z".repeat(90 * 1024) });
  }
  // releasePublishedTurnHistory clears the same array in place.
  messages.length = 0;
  for (let i = 0; i < 20; i += 1) {
    appendBoundedTranscriptMessage(messages, { role: "tool", content: "z".repeat(90 * 1024) });
  }
  const totalBytes = messages.reduce((total, entry) => total + Buffer.byteLength(entry.content, "utf8"), 0);
  assert.ok(
    totalBytes <= EXECUTION_BUFFER_LIMITS.transcriptBytes,
    `stale total let the transcript grow to ${totalBytes} bytes`,
  );
});
