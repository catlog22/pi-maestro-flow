import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";
import type { ChildProcess } from "node:child_process";
import { runTeammate } from "../src/runs/execution.ts";

type SpawnSeam = NonNullable<Parameters<typeof runTeammate>[1]["spawnChildProcess"]>;

function createFakeChild(): ChildProcess {
  const child = new EventEmitter() as ChildProcess;
  Object.assign(child, {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    connected: false,
    exitCode: null,
    signalCode: null,
    pid: undefined,
    kill() {
      return true;
    },
  });
  return child;
}

interface SpawnCapture {
  args: string[];
  sessionDir?: string;
  spawnEnv: Record<string, string | undefined>;
}

/**
 * Runs one attempt against a child that exits immediately and reports what the
 * session/fork resolution produced: the pi argv, the private session directory
 * handed to onChildSpawned, and the child environment.
 */
async function runWithCapture(
  params: Parameters<typeof runTeammate>[0],
  parentSessionFile: string | undefined,
): Promise<{ capture: SpawnCapture; messages: Array<{ role: string; content: string }> }> {
  const capture: SpawnCapture = { args: [], spawnEnv: {} };
  const spawnChildProcess = ((
    _command: string,
    args: readonly string[],
    options: { env?: Record<string, string | undefined> },
  ) => {
    capture.args = [...args];
    capture.spawnEnv = options.env ?? {};
    const child = createFakeChild();
    queueMicrotask(() => {
      (child as { exitCode: number | null }).exitCode = 0;
      child.emit("exit", 0, null);
      child.emit("close", 0, null);
    });
    return child;
  }) as unknown as SpawnSeam;

  const result = await runTeammate(params, {
    baseCwd: process.cwd(),
    spawnChildProcess,
    parentSessionFile,
    onChildSpawned: (_stdin, _send, sessionDir) => {
      capture.sessionDir = sessionDir;
    },
  });
  return { capture, messages: result.messages };
}

function withTempSession<T>(fn: (parentSessionFile: string) => Promise<T>): Promise<T> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "teammate-session-ctx-"));
  const parentSessionFile = path.join(root, "parent.jsonl");
  fs.writeFileSync(parentSessionFile, "");
  return fn(parentSessionFile).finally(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });
}

// The ambient variable is a fallback for the explicit option; a leaked value
// from the surrounding process would silently satisfy the "missing" cases.
function withoutAmbientParentSession<T>(fn: () => Promise<T>): Promise<T> {
  const previous = process.env.PI_TEAMMATE_PARENT_SESSION;
  delete process.env.PI_TEAMMATE_PARENT_SESSION;
  return fn().finally(() => {
    if (previous === undefined) delete process.env.PI_TEAMMATE_PARENT_SESSION;
    else process.env.PI_TEAMMATE_PARENT_SESSION = previous;
  });
}

test("a fork with an available parent session reaches the child as --fork", async () => {
  await withoutAmbientParentSession(() =>
    withTempSession(async (parentSessionFile) => {
      const { capture, messages } = await runWithCapture(
        { agent: "delegate", task: "continue the parent thread", context: "fork" },
        parentSessionFile,
      );

      const forkIndex = capture.args.indexOf("--fork");
      assert.notEqual(forkIndex, -1, "an available parent session must be forked");
      assert.equal(capture.args[forkIndex + 1], parentSessionFile);
      assert.equal(
        messages.some((m) => /Fork requested but parent session file not available/.test(m.content)),
        false,
        "an honoured fork must not be annotated as degraded",
      );
    })
  );
});

test("a fork without a parent session degrades to fresh context with a transcript note", async () => {
  await withoutAmbientParentSession(async () => {
    const missing = path.join(os.tmpdir(), "teammate-session-ctx-absent", "parent.jsonl");
    const { capture, messages } = await runWithCapture(
      { agent: "delegate", task: "continue the parent thread", context: "fork" },
      missing,
    );

    assert.equal(capture.args.includes("--fork"), false);
    assert.equal(
      messages.some((m) =>
        m.role === "system" && /Fork requested but parent session file not available/.test(m.content)
      ),
      true,
      "an unhonoured explicit fork must be recorded in the transcript",
    );
  });
});

test("a non-fork context never forks even when a parent session exists", async () => {
  await withoutAmbientParentSession(() =>
    withTempSession(async (parentSessionFile) => {
      const { capture, messages } = await runWithCapture(
        { agent: "delegate", task: "start clean", context: "fresh" },
        parentSessionFile,
      );

      assert.equal(capture.args.includes("--fork"), false);
      assert.equal(
        messages.some((m) => /Fork requested but parent session file not available/.test(m.content)),
        false,
        "a fresh context was never a fork request, so it cannot degrade",
      );
    })
  );
});

test("an available parent session yields a private per-correlation session directory", async () => {
  await withoutAmbientParentSession(() =>
    withTempSession(async (parentSessionFile) => {
      const { capture } = await runWithCapture(
        { agent: "delegate", task: "start clean", context: "fresh" },
        parentSessionFile,
      );

      const expectedRoot = path.join(path.dirname(parentSessionFile), "parent");
      assert.ok(capture.sessionDir, "a session directory must be derived from the parent session");
      assert.equal(path.dirname(capture.sessionDir), expectedRoot);
      assert.equal(fs.existsSync(capture.sessionDir), true, "the directory must exist before spawn");
      assert.equal(capture.spawnEnv.PI_TEAMMATE_PARENT_SESSION, parentSessionFile);
    })
  );
});

test("no parent session means no session directory and no fork", async () => {
  await withoutAmbientParentSession(async () => {
    const { capture } = await runWithCapture(
      { agent: "delegate", task: "start clean", context: "fresh" },
      undefined,
    );

    assert.equal(capture.sessionDir, undefined);
    assert.equal(capture.args.includes("--fork"), false);
    assert.equal(capture.spawnEnv.PI_TEAMMATE_PARENT_SESSION, undefined);
  });
});

// ---------------------------------------------------------------------------
// Turn-scoped buffers must not leak into the next turn of a wakeable agent
// ---------------------------------------------------------------------------

test("a settled turn does not leak its assistant text into the next turn", async () => {
  const line = (event: Record<string, unknown>): string => `${JSON.stringify(event)}\n`;
  const completions: Array<{ messages: Array<{ role: string; content: string }> }> = [];
  const stdout = new PassThrough();
  const spawnChildProcess = (() => {
    const child = createFakeChild();
    Object.assign(child, { stdout });
    queueMicrotask(() => {
      stdout.write(line({
        type: "message_end",
        message: { role: "assistant", content: [{ type: "text", text: "first answer" }] },
      }));
      stdout.write(line({ type: "agent_end" }));
      // A second loop that produces no assistant text at all.
      setTimeout(() => {
        stdout.write(line({ type: "turn_start" }));
        stdout.write(line({ type: "agent_end" }));
      }, 20);
    });
    return child;
  }) as unknown as SpawnSeam;

  const result = await runTeammate(
    { agent: "delegate", task: "answer, then stay awake", context: "fresh" },
    {
      baseCwd: process.cwd(),
      spawnChildProcess,
      onTurnComplete: (entry) => completions.push({ messages: [...entry.messages] }),
    },
  );

  assert.equal(result.messages.at(-1)?.content, "first answer");
  await new Promise((r) => setTimeout(r, 120));

  assert.equal(completions.length, 2, "a wakeable agent must settle both turns");
  assert.equal(completions[0].messages.at(-1)?.content, "first answer");
  assert.equal(
    completions[1].messages.some((m) => m.content === "first answer"),
    false,
    "the previous turn's assistant text must not be replayed as this turn's result",
  );
});

// ---------------------------------------------------------------------------
// The event dispatch table is data, not a prototype-bearing object
// ---------------------------------------------------------------------------

test("prototype-shaped event types stay inert instead of dispatching", async () => {
  const line = (event: Record<string, unknown>): string => `${JSON.stringify(event)}\n`;
  const stdout = new PassThrough();
  const spawnChildProcess = (() => {
    const child = createFakeChild();
    Object.assign(child, { stdout });
    queueMicrotask(() => {
      // A child controls `type`. Looking these up on a prototype-bearing object
      // resolves Object.prototype members: `__proto__` is not callable and the
      // resulting TypeError is absorbed by the JSON-parse catch, which then
      // records the raw line as if it were the agent's answer.
      for (const type of ["__proto__", "constructor", "toString", "hasOwnProperty"]) {
        stdout.write(line({ type, marker: "poisoned" }));
      }
      // No assistant output at all: whatever the odd events left behind becomes
      // the turn's content.
      stdout.write(line({ type: "agent_end" }));
      setTimeout(() => {
        (child as { exitCode: number | null }).exitCode = 0;
        child.emit("exit", 0, null);
        child.emit("close", 0, null);
      }, 20);
    });
    return child;
  }) as unknown as SpawnSeam;

  const result = await runTeammate(
    { agent: "delegate", task: "emit odd event types", context: "fresh" },
    { baseCwd: process.cwd(), spawnChildProcess },
  );

  assert.equal(result.exitCode, 0);
  assert.equal(
    result.messages.some((m) => /poisoned|__proto__/.test(m.content)),
    false,
    "unrecognised event types must not reach a prototype method",
  );
});
