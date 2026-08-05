import assert from "node:assert/strict";
import test from "node:test";
import { CURSOR_MARKER, visibleWidth } from "@earendil-works/pi-tui";
import { AttachOverlay } from "../src/tui/attach-overlay.ts";
import {
  BracketedPasteDecoder,
  cursorForColumn,
  layoutDraftCursor,
  sanitizeMultiLineInput,
  wrapDraftLines,
} from "../src/tui/input-text.ts";

test("bracketed paste markers survive every byte split", () => {
  const encoded = "\x1b[200~X\x1b[201~";
  for (let split = 1; split < encoded.length; split++) {
    const decoder = new BracketedPasteDecoder();
    const tokens = [...decoder.feed(encoded.slice(0, split)), ...decoder.feed(encoded.slice(split))];
    assert.deepEqual(tokens, [{ kind: "paste", text: "X" }], `split ${split}`);
  }
});

test("unterminated bracketed paste is bounded", () => {
  const decoder = new BracketedPasteDecoder();
  assert.deepEqual(decoder.feed(`\x1b[200~${"x".repeat(1_048_600)}`), []);
  const [token] = decoder.feed("\x1b[201~");
  assert.equal(token.kind, "paste");
  assert.equal(token.text.length, 1_048_576);
});

test("attach overlay dispatches decoded input without feeding it twice", async () => {
  const now = Date.now();
  const first = {
    agent: "worker", name: "agent-1", correlationId: "agent-1", startedAt: now,
    abortController: new AbortController(), inbox: [], outputLog: [], lastActivityAt: now,
    status: "running" as const, depth: 0, sleepMs: 0,
  };
  const sent: string[] = [];
  const overlay = new AttachOverlay(first, () => {}, () => new Map([[first.correlationId, first]]), async (_id, message) => {
    sent.push(message);
    return { ok: true, message: "Sent" };
  });
  try {
    overlay.render(80, 16);
    overlay.handleInput("\r");
    overlay.handleInput("A\x1b[200~B");
    overlay.handleInput("\x1b[201~");
    overlay.handleInput("\r");
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.deepEqual(sent, ["AB"]);
  } finally {
    overlay.dispose();
  }
});

test("attach overlay preserves a grapheme-safe draft when send fails", async () => {
  const now = Date.now();
  const first = {
    agent: "worker", name: "agent-1", correlationId: "agent-1", startedAt: now,
    abortController: new AbortController(), inbox: [], outputLog: [], lastActivityAt: now,
    status: "running" as const, depth: 0, sleepMs: 0,
  };
  const overlay = new AttachOverlay(
    first,
    () => {},
    () => new Map([[first.correlationId, first]]),
    async () => { throw new Error("offline"); },
  );
  try {
    overlay.handleInput("\r");
    overlay.handleInput("\x1b[20");
    overlay.handleInput("0~A👨‍👩‍👧‍👦\x1b[20");
    overlay.handleInput("1~");
    overlay.handleInput("\x1b[D");
    overlay.handleInput("\x7f");
    overlay.handleInput("\r");
    await new Promise((resolve) => setTimeout(resolve, 0));
    const rendered = overlay.render(80, 16).join("\n");
    assert.match(rendered, /Send failed.*Enter retry.*Esc cancel/);
    assert.match(rendered, /👨‍👩‍👧‍👦/);
    assert.doesNotMatch(rendered, /�/);
  } finally {
    overlay.dispose();
  }
});

test("attach overlay does not send the same draft twice while pending", async () => {
  const now = Date.now();
  const first = {
    agent: "worker", name: "agent-1", correlationId: "agent-1", startedAt: now,
    abortController: new AbortController(), inbox: [], outputLog: [], lastActivityAt: now,
    status: "running" as const, depth: 0, sleepMs: 0,
  };
  let calls = 0;
  let release: ((result: { ok: boolean; message: string }) => void) | undefined;
  const overlay = new AttachOverlay(first, () => {}, () => new Map([[first.correlationId, first]]), async () => {
    calls++;
    return new Promise((resolve) => { release = resolve; });
  });
  try {
    overlay.handleInput("\r");
    overlay.handleInput("important draft");
    overlay.handleInput("\r");
    overlay.handleInput("\r");
    assert.equal(calls, 1);
    release?.({ ok: true, message: "Sent" });
    await new Promise((resolve) => setTimeout(resolve, 0));
  } finally {
    overlay.dispose();
  }
});

test("attach overlay blocks invisible composing in ultra-narrow mode", () => {
  const now = Date.now();
  const first = {
    agent: "worker", name: "agent-1", correlationId: "agent-1", startedAt: now,
    abortController: new AbortController(), inbox: [], outputLog: [], lastActivityAt: now,
    status: "running" as const, depth: 0, sleepMs: 0,
  };
  const sent: string[] = [];
  const overlay = new AttachOverlay(first, () => {}, () => new Map([[first.correlationId, first]]), async (_id, message) => {
    sent.push(message);
    return { ok: true, message: "Sent" };
  });
  try {
    overlay.render(12, 8);
    overlay.handleInput("\r");
    overlay.handleInput("hidden draft");
    overlay.handleInput("\r");
    assert.deepEqual(sent, []);
    assert.doesNotMatch(overlay.render(80, 16).join("\n"), /hidden draft/);
  } finally {
    overlay.dispose();
  }
});

// ---------------------------------------------------------------------------
// multi-line composer: auto-wrap layout, cursor navigation, hard newlines
// ---------------------------------------------------------------------------

function fakeAgent() {
  const now = Date.now();
  return {
    agent: "worker", name: "agent-1", correlationId: "agent-1", startedAt: now,
    abortController: new AbortController(), inbox: [], outputLog: [], lastActivityAt: now,
    status: "running" as const, depth: 0, sleepMs: 0,
  };
}

function makeComposerOverlay(sent: string[]) {
  const agent = fakeAgent();
  const overlay = new AttachOverlay(
    agent,
    () => {},
    () => new Map([[agent.correlationId, agent]]),
    async (_id, message) => {
      sent.push(message);
      return { ok: true, message: "Sent" };
    },
  );
  overlay.focused = true;
  return overlay;
}

/** {rows from the composer's last visible row, contentCol} of the cursor marker. */
function cursorMarker(lines: string[]): { rowsUp: number; contentCol: number } {
  // The frame's bottom border (╰) is the last content line; the composer rows
  // are the content rows directly above it (footer is after the border).
  const bottom = lines.length - 2;
  for (let row = lines.length - 3; row >= 0; row--) {
    const index = lines[row].indexOf(CURSOR_MARKER);
    if (index !== -1) {
      // `│ ` frame prefix (2 cols) + `› `/indent (2 cols) precede the draft.
      return { rowsUp: bottom - 1 - row, contentCol: visibleWidth(lines[row].slice(0, index)) - 4 };
    }
  }
  throw new Error("no cursor marker in rendered output");
}

test("composer wraps a long draft across multiple visible rows without truncation", () => {
  const sent: string[] = [];
  const overlay = makeComposerOverlay(sent);
  try {
    overlay.handleInput("\r");
    overlay.handleInput("one two three four five six seven eight nine ten");
    const lines = overlay.render(40, 24);
    const plain = lines.map((line) => line.replace(/\x1b\[[0-9;]*m/g, "")).join("\n");
    // Full text is visible — nothing truncated by the composer's own width.
    assert.match(plain, /one two three four five six/);
    assert.match(plain, /nine ten/);
    // 48 chars at draftWidth 35 (w-5) → two rows; cursor ends on the last row.
    assert.deepEqual(cursorMarker(lines), { rowsUp: 0, contentCol: 48 % 35 });
  } finally {
    overlay.dispose();
  }
});

test("composer cursor moves between wrapped visual lines with ↑/↓ and Home/End", () => {
  const sent: string[] = [];
  const overlay = makeComposerOverlay(sent);
  try {
    overlay.handleInput("\r");
    overlay.handleInput("abcdefghijklmnopqrst"); // 20 chars at draftWidth 15 → two rows
    overlay.render(20, 24);
    overlay.handleInput("\x1b[D"); // ← to offset 19, row 1 col 4
    overlay.handleInput("\x1b[A"); // ↑ to row 0, keep col 4
    const up = overlay.render(20, 24);
    assert.deepEqual(cursorMarker(up), { rowsUp: 1, contentCol: 4 });
    overlay.handleInput("\x1b[B"); // ↓ back to row 1
    const down = overlay.render(20, 24);
    assert.deepEqual(cursorMarker(down), { rowsUp: 0, contentCol: 4 });
    overlay.handleInput("\x1b[1~"); // Home → row 1 col 0
    const home = overlay.render(20, 24);
    assert.deepEqual(cursorMarker(home), { rowsUp: 0, contentCol: 0 });
    overlay.handleInput("\x1b[4~"); // End → row 1 col 5
    const end = overlay.render(20, 24);
    assert.deepEqual(cursorMarker(end), { rowsUp: 0, contentCol: 5 });
  } finally {
    overlay.dispose();
  }
});

test("Shift+Enter inserts a hard newline and Enter sends the multi-line draft", async () => {
  const sent: string[] = [];
  const overlay = makeComposerOverlay(sent);
  try {
    overlay.handleInput("\r");
    overlay.handleInput("abc");
    overlay.handleInput("\x1b\r"); // Shift+Enter / Alt+Enter → newline
    overlay.handleInput("def");
    const lines = overlay.render(80, 24).map((line) => line.replace(/\x1b\[[0-9;]*m/g, ""));
    assert.match(lines.join("\n"), /› abc/);
    assert.match(lines.join("\n"), /  def/);
    overlay.handleInput("\r");
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.deepEqual(sent, ["abc\ndef"]);
  } finally {
    overlay.dispose();
  }
});

test("backspace across a hard newline joins the lines before sending", async () => {
  const sent: string[] = [];
  const overlay = makeComposerOverlay(sent);
  try {
    overlay.handleInput("\r");
    overlay.handleInput("abc");
    overlay.handleInput("\x1b\r");
    overlay.handleInput("def");
    overlay.handleInput("\x1b[D");
    overlay.handleInput("\x1b[D");
    overlay.handleInput("\x1b[D"); // to offset 4 (before “d”)
    overlay.handleInput("\x7f"); // delete the newline
    overlay.handleInput("\r");
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.deepEqual(sent, ["abcdef"]);
  } finally {
    overlay.dispose();
  }
});

test("multi-line paste keeps newlines and renders across rows", async () => {
  const sent: string[] = [];
  const overlay = makeComposerOverlay(sent);
  try {
    overlay.handleInput("\r");
    overlay.handleInput("\x1b[200~line1\nline2\x1b[201~");
    const lines = overlay.render(80, 24).join("\n");
    assert.match(lines, /line1/);
    assert.match(lines, /line2/);
    overlay.handleInput("\r");
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.deepEqual(sent, ["line1\nline2"]);
  } finally {
    overlay.dispose();
  }
});

test("single-line paste still flattens newlines for single-line consumers", () => {
  const decoder = new BracketedPasteDecoder();
  const [token] = decoder.feed("\x1b[200~a\nb\x1b[201~");
  assert.equal(token.kind, "paste");
  assert.equal(token.text, "a b");
});

test("long drafts scroll the composer window with a ⋯ marker", () => {
  const sent: string[] = [];
  const overlay = makeComposerOverlay(sent);
  try {
    overlay.handleInput("\r");
    // 14 × 7-char chunks = 98 chars → 7 wrapped rows at draftWidth 15 (> 5).
    const chunks = Array.from({ length: 14 }, (_, i) => `chunk${String(i + 1).padStart(2, "0")}`).join("");
    overlay.handleInput(chunks);
    const lines = overlay.render(20, 24);
    const plain = lines.map((line) => line.replace(/\x1b\[[0-9;]*m/g, "")).join("\n");
    assert.match(plain, /⋯/);
    // The first wrapped row is hidden, the last chunk and cursor stay visible.
    assert.doesNotMatch(plain, /chunk01/);
    assert.match(plain, /chunk14/);
    assert.deepEqual(cursorMarker(lines), { rowsUp: 0, contentCol: 98 - 90 });
  } finally {
    overlay.dispose();
  }
});

test("wrapDraftLines handles hard breaks and trailing newlines", () => {
  assert.deepEqual(wrapDraftLines("ab\ncd", 10), [
    { start: 0, end: 3, text: "ab", width: 2 },
    { start: 3, end: 5, text: "cd", width: 2 },
  ]);
  // A trailing newline leaves an empty final line (editors show a blank row).
  assert.deepEqual(wrapDraftLines("ab\n", 10), [
    { start: 0, end: 3, text: "ab", width: 2 },
    { start: 3, end: 3, text: "", width: 0 },
  ]);
  assert.deepEqual(wrapDraftLines("", 10), [{ start: 0, end: 0, text: "", width: 0 }]);
});

test("wrapDraftLines wraps wide text at grapheme boundaries", () => {
  const lines = wrapDraftLines("abcdefghij", 4);
  assert.deepEqual(lines.map((line) => line.text), ["abcd", "efgh", "ij"]);
  const layout = layoutDraftCursor("abcdefghij", 10, 4);
  assert.equal(layout.cursorRow, 2);
  assert.equal(layout.cursorCol, 2);
  assert.equal(cursorForColumn("abcdefghij", lines[1], 3), 7);
});

test("sanitizeMultiLineInput preserves newlines and expands tabs", () => {
  assert.equal(sanitizeMultiLineInput("a\r\nb\tc\x1b[31m"), "a\nb  c[31m");
});
