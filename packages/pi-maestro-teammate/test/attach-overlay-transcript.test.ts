import assert from "node:assert/strict";
import test from "node:test";
import { AttachOverlay } from "../src/tui/attach-overlay.ts";
import type { ActiveAgent } from "../src/shared/types.ts";
import type { TranscriptLoad } from "../src/shared/transcript.ts";

function fakeAgent(overrides: Partial<ActiveAgent> = {}): ActiveAgent {
  const now = Date.now();
  return {
    agent: "worker",
    name: "agent-1",
    correlationId: "agent-1",
    startedAt: now,
    abortController: new AbortController(),
    inbox: [],
    outputLog: [],
    lastActivityAt: now,
    status: "running",
    depth: 0,
    sleepMs: 0,
    ...overrides,
  };
}

function transcript(rows: TranscriptLoad["rows"]): TranscriptLoad {
  return { rows, anchorId: "last", source: "session", compacted: false };
}

function tick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 5));
}

test("t toggles transcript view; rows render with kind prefixes", async () => {
  const agent = fakeAgent();
  const runs = new Map([[agent.correlationId, agent]]);
  const overlay = new AttachOverlay(
    agent,
    () => {},
    () => runs,
    undefined,
    () =>
      Promise.resolve(
        transcript([
          { kind: "user", role: "user", text: "hello world", timestamp: 1 },
          { kind: "assistant", role: "assistant", text: "hi there", timestamp: 2 },
          { kind: "tool", role: "assistant", text: "{}", toolName: "Read", timestamp: 3 },
          { kind: "thinking", role: "assistant", text: "deep thought\nmore", timestamp: 4 },
          { kind: "meta", role: "system", text: "Model · p/m", timestamp: 5 },
        ]),
      ),
  );
  try {
    // Activity view by default — footer offers the transcript toggle.
    assert.match(overlay.render(80, 24).join("\n"), /t transcript/);
    assert.doesNotMatch(overlay.render(80, 24).join("\n"), /hello world/);

    overlay.handleInput("t");
    await tick();
    const lines = overlay.render(80, 24).join("\n");
    assert.match(lines, /hello world/);
    assert.match(lines, /hi there/);
    assert.match(lines, /Read/);
    assert.match(lines, /deep thought/);
    assert.match(lines, /Model · p\/m/);
    // Footer flips to the activity hint while in transcript mode.
    assert.match(lines, /t activity/);

    // t again returns to the activity log.
    overlay.handleInput("t");
    assert.doesNotMatch(overlay.render(80, 24).join("\n"), /hello world/);
  } finally {
    overlay.dispose();
  }
});

test("v enters transcript and jumps to the tail", async () => {
  const agent = fakeAgent();
  const runs = new Map([[agent.correlationId, agent]]);
  const overlay = new AttachOverlay(
    agent,
    () => {},
    () => runs,
    undefined,
    () => Promise.resolve(transcript([{ kind: "assistant", role: "assistant", text: "tail content", timestamp: 1 }])),
  );
  try {
    overlay.handleInput("v");
    await tick();
    assert.match(overlay.render(80, 24).join("\n"), /tail content/);
  } finally {
    overlay.dispose();
  }
});

test("transcript without a loader is a no-op", () => {
  const agent = fakeAgent();
  const runs = new Map([[agent.correlationId, agent]]);
  const overlay = new AttachOverlay(agent, () => {}, () => runs);
  try {
    overlay.handleInput("t");
    const lines = overlay.render(80, 24).join("\n");
    assert.doesNotMatch(lines, /No transcript available/);
    assert.doesNotMatch(lines, /t transcript/);
  } finally {
    overlay.dispose();
  }
});

test("live events refresh an open transcript (debounced)", async () => {
  let calls = 0;
  const agent = fakeAgent();
  const runs = new Map([[agent.correlationId, agent]]);
  const overlay = new AttachOverlay(
    agent,
    () => {},
    () => runs,
    undefined,
    () => {
      calls += 1;
      return Promise.resolve(
        transcript(
          calls === 1
            ? [{ kind: "user", role: "user", text: "first", timestamp: 1 }]
            : [{ kind: "user", role: "user", text: "first", timestamp: 1 }, { kind: "assistant", role: "assistant", text: "second", timestamp: 2 }],
        ),
      );
    },
  );
  try {
    overlay.handleInput("t");
    await tick();
    assert.doesNotMatch(overlay.render(80, 24).join("\n"), /second/);
    assert.equal(calls, 1);

    overlay.noteLiveEvent(agent.correlationId);
    await new Promise((resolve) => setTimeout(resolve, 400));
    assert.match(overlay.render(80, 24).join("\n"), /second/);
    assert.equal(calls, 2);
  } finally {
    overlay.dispose();
  }
});

test("initialTranscript opens straight into the transcript view", async () => {
  const agent = fakeAgent();
  const runs = new Map([[agent.correlationId, agent]]);
  const overlay = new AttachOverlay(
    agent,
    () => {},
    () => runs,
    undefined,
    () => Promise.resolve(transcript([{ kind: "user", role: "user", text: "history content", timestamp: 1 }])),
    true,
  );
  try {
    await tick();
    assert.match(overlay.render(80, 24).join("\n"), /history content/);
    assert.match(overlay.render(80, 24).join("\n"), /t activity/);
  } finally {
    overlay.dispose();
  }
});

test("composer works in transcript mode (view-and-steer)", async () => {
  const agent = fakeAgent();
  const runs = new Map([[agent.correlationId, agent]]);
  const sent: string[] = [];
  const overlay = new AttachOverlay(
    agent,
    () => {},
    () => runs,
    async (cid, message) => {
      sent.push(`${cid}:${message}`);
      return { ok: true, message: "Queued" };
    },
    () => Promise.resolve(transcript([{ kind: "user", role: "user", text: "old turn", timestamp: 1 }])),
  );
  try {
    overlay.handleInput("t");
    await tick();
    assert.match(overlay.render(80, 24).join("\n"), /old turn/);

    // Enter composes, text is typed, Enter sends — the same onSend the
    // extension routes to follow_up/prompt+restart.
    overlay.handleInput("\r");
    overlay.handleInput("continue work");
    overlay.handleInput("\r");
    await new Promise((resolve) => setTimeout(resolve, 25));
    assert.deepEqual(sent, [`${agent.correlationId}:continue work`]);
  } finally {
    overlay.dispose();
  }
});

test("switchAgent preloads transcript for a tab left in transcript mode", async () => {
  const now = Date.now();
  const a = fakeAgent({ name: "alpha", correlationId: "a" });
  const b = fakeAgent({ name: "beta", correlationId: "b" });
  const runs = new Map([
    [a.correlationId, a],
    [b.correlationId, b],
  ]);
  const overlay = new AttachOverlay(
    a,
    () => {},
    () => runs,
    undefined,
    (targetAgent) =>
      Promise.resolve(
        transcript([
          { kind: "user", role: "user", text: `content for ${targetAgent.correlationId}`, timestamp: now },
        ]),
      ),
  );
  try {
    // Enter transcript mode on tab a.
    overlay.handleInput("t");
    await tick();
    // Switch to b, back to a, then to b: b stays on activity; a keeps transcript.
    overlay.handleInput("\x1b[C"); // tab b
    overlay.handleInput("\x1b[D"); // tab a
    overlay.handleInput("\x1b[C"); // tab b
    assert.doesNotMatch(overlay.render(80, 24).join("\n"), /content for a/);
    overlay.handleInput("\x1b[D"); // back to a
    assert.match(overlay.render(80, 24).join("\n"), /content for a/);
  } finally {
    overlay.dispose();
  }
});

// ---------------------------------------------------------------------------
// cross-review fixes: docked height, narrow composer, row cap, read-only
// ---------------------------------------------------------------------------

test("docked height renders transcript content (height <= 12)", async () => {
  const agent = fakeAgent();
  const runs = new Map([[agent.correlationId, agent]]);
  const overlay = new AttachOverlay(
    agent,
    () => {},
    () => runs,
    undefined,
    () => Promise.resolve(transcript([{ kind: "user", role: "user", text: "docked transcript line", timestamp: 1 }])),
  );
  try {
    overlay.handleInput("t");
    await tick();
    const lines = overlay.render(80, 10).join("\n");
    assert.match(lines, /docked transcript line/);
  } finally {
    overlay.dispose();
  }
});

test("narrow width blocks composing but Esc cancels an existing draft", () => {
  let closed = false;
  const agent = fakeAgent();
  const runs = new Map([[agent.correlationId, agent]]);
  const sent: string[] = [];
  const overlay = new AttachOverlay(
    agent,
    () => { closed = true; },
    () => runs,
    async (cid, message) => { sent.push(`${cid}:${message}`); return { ok: true, message: "Queued" }; },
  );
  try {
    // Ultra-narrow: Enter does not compose, typing goes nowhere, nothing sends.
    overlay.render(19, 10);
    overlay.handleInput("\r");
    overlay.handleInput("hidden draft");
    overlay.handleInput("\r");
    assert.deepEqual(sent, []);

    // A draft started wide survives a shrink: Esc cancels it, not the overlay.
    overlay.render(80, 24);
    overlay.handleInput("\r");
    overlay.handleInput("wide draft");
    overlay.render(19, 10);
    overlay.handleInput("\x1b");
    assert.equal(closed, false);
    assert.doesNotMatch(overlay.render(80, 24).join("\n"), /wide draft/);
  } finally {
    overlay.dispose();
  }
});

test("rows beyond the transcript cap are truncated (last kept, first dropped)", async () => {
  const agent = fakeAgent();
  const runs = new Map([[agent.correlationId, agent]]);
  const rows = Array.from({ length: 2001 }, (_, i) => ({
    kind: "user" as const,
    role: "user" as const,
    text: `message ${i}`,
    timestamp: i,
  }));
  const overlay = new AttachOverlay(
    agent,
    () => {},
    () => runs,
    undefined,
    () => Promise.resolve(transcript(rows)),
  );
  try {
    overlay.handleInput("t");
    await tick();
    const lines = overlay.render(80, 24).join("\n");
    // The cap keeps the newest 2000 rows: the last message renders, the
    // dropped first message never appears (the hidden marker sits above the
    // followTail viewport).
    assert.match(lines, /message 2000/);
    assert.doesNotMatch(lines, /message 0(?![0-9])/);
  } finally {
    overlay.dispose();
  }
});

test("no onSend → Enter never composes (read-only history view)", async () => {
  const agent = fakeAgent();
  const runs = new Map([[agent.correlationId, agent]]);
  const overlay = new AttachOverlay(
    agent,
    () => {},
    () => runs,
    undefined, // read-only
    () => Promise.resolve(transcript([{ kind: "user", role: "user", text: "old", timestamp: 1 }])),
    true, // initialTranscript
  );
  try {
    await tick();
    overlay.handleInput("\r");
    overlay.handleInput("should not compose");
    const lines = overlay.render(80, 24).join("\n");
    assert.doesNotMatch(lines, /should not compose/);
    assert.doesNotMatch(lines, /Message ·/);
  } finally {
    overlay.dispose();
  }
});

// ---------------------------------------------------------------------------
// main tab: the main conversation is a switching target (claude-code style)
// ---------------------------------------------------------------------------

test("main tab appears in the switch list; Enter returns to the main agent", () => {
  let closed = false;
  const agent = fakeAgent();
  const runs = new Map([[agent.correlationId, agent]]);
  const overlay = new AttachOverlay(
    agent,
    () => { closed = true; },
    () => runs,
  );
  try {
    // Entering an agent view lists main first: ← from the agent goes to main.
    const before = overlay.render(80, 24).join("\n");
    assert.match(before, /● main/);
    assert.doesNotMatch(before, /▸.*● main/);

    overlay.handleInput("\x1b[D"); // ← → main tab
    const mainView = overlay.render(80, 24).join("\n");
    assert.match(mainView, /▸.*● main/);
    assert.match(mainView, /main conversation/);
    assert.match(mainView, /Enter return/);

    overlay.handleInput("\r"); // Enter → return to main agent
    assert.equal(closed, true);
  } finally {
    overlay.dispose();
  }
});

test("Esc from the main tab also returns", async () => {
  let closed = false;
  const agent = fakeAgent();
  const runs = new Map([[agent.correlationId, agent]]);
  const overlay = new AttachOverlay(
    agent,
    () => { closed = true; },
    () => runs,
  );
  try {
    overlay.handleInput("\x1b[D"); // ← → main
    overlay.handleInput("\x1b"); // Esc (flushed by the bracketed-paste decoder)
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(closed, true);
  } finally {
    overlay.dispose();
  }
});

test("switching from main returns to the first agent", () => {
  const now = Date.now();
  const a = fakeAgent({ correlationId: "a", name: "alpha" });
  const b = fakeAgent({ correlationId: "b", name: "beta" });
  const runs = new Map([
    [a.correlationId, a],
    [b.correlationId, b],
  ]);
  const overlay = new AttachOverlay(a, () => {}, () => runs);
  try {
    overlay.handleInput("\x1b[D"); // ← → main
    assert.match(overlay.render(80, 24).join("\n"), /▸.*● main/);
    overlay.handleInput("\x1b[C"); // → back to alpha
    assert.match(overlay.render(80, 24).join("\n"), /▸.*■ @alpha/);
  } finally {
    overlay.dispose();
  }
});

test("main tab in docked and narrow render paths", () => {
  const agent = fakeAgent();
  const runs = new Map([[agent.correlationId, agent]]);
  const overlay = new AttachOverlay(agent, () => {}, () => runs);
  try {
    overlay.handleInput("\x1b[D"); // → main
    assert.match(overlay.render(80, 10).join("\n"), /main conversation · Enter return/);
    assert.match(overlay.render(19, 10).join("\n"), /● main/);
  } finally {
    overlay.dispose();
  }
});
