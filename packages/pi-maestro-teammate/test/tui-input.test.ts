import assert from "node:assert/strict";
import test from "node:test";
import { AttachOverlay } from "../src/tui/attach-overlay.ts";
import { BracketedPasteDecoder } from "../src/tui/input-text.ts";

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
    status: "running" as const, sleepMs: 0,
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
    status: "running" as const, sleepMs: 0,
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
    status: "running" as const, sleepMs: 0,
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
    status: "running" as const, sleepMs: 0,
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
