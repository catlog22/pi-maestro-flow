import assert from "node:assert/strict";
import test from "node:test";
import {
  buildWindowsTaskkillCommand,
  captureProcessTree,
  redactRemoteError,
  sanitizedChildEnvironment,
  targetChildEnvironment,
  terminateProcessTree,
  truncateUtf8,
  utf8ByteLength,
  type WindowsTaskkillCommand,
} from "../src/remote/child-security.ts";

test("sanitized child environments exclude secrets and deny PATH replacement", () => {
  const marker = "todo-five-secret-marker";
  const environment = sanitizedChildEnvironment({
    source: {
      HOME: "/home/remote",
      PATH: "/trusted/bin",
      LANG: "en_US.UTF-8",
      OPENAI_API_KEY: marker,
      AWS_ACCESS_KEY_ID: marker,
      UNRELATED_DAEMON_STATE: "do-not-inherit",
    },
    additions: { REMOTE_RUN_ID: "run-1" },
  });

  assert.deepEqual(environment, {
    HOME: "/home/remote",
    PATH: "/trusted/bin",
    LANG: "en_US.UTF-8",
    REMOTE_RUN_ID: "run-1",
  });
  assert.equal(JSON.stringify(environment).includes(marker), false);
  assert.throws(
    () => sanitizedChildEnvironment({ source: { PATH: "/trusted/bin" }, additions: { PATH: "/attacker" } }),
    /cannot replace launch policy/,
  );
});

test("target child environments forward only declared names and allow explicit secrets", () => {
  const previous = process.env.PROBE_FORWARDED_KEY;
  const previousSecret = process.env.CODEX_API_KEY;
  process.env.PROBE_FORWARDED_KEY = "visible";
  process.env.CODEX_API_KEY = "sk-probe";
  try {
    const environment = targetChildEnvironment(["PROBE_FORWARDED_KEY", "CODEX_API_KEY", "MISSING_VAR"]);
    assert.equal(environment.PROBE_FORWARDED_KEY, "visible");
    assert.equal(environment.CODEX_API_KEY, "sk-probe");
    assert.equal(environment.MISSING_VAR, undefined);
    // Launch-policy variables still rejected even when declared.
    assert.throws(
      () => targetChildEnvironment(["PATH"]),
      /cannot replace launch policy/,
    );
    // Undeclared secrets stay out.
    const environment2 = targetChildEnvironment([]);
    assert.equal(environment2.CODEX_API_KEY, undefined);
  } finally {
    if (previous === undefined) delete process.env.PROBE_FORWARDED_KEY;
    else process.env.PROBE_FORWARDED_KEY = previous;
    if (previousSecret === undefined) delete process.env.CODEX_API_KEY;
    else process.env.CODEX_API_KEY = previousSecret;
  }
});

test("a caller may narrow the base allowlist for its own child", () => {
  const previous = process.env.TERM;
  process.env.TERM = "xterm-lock";
  try {
    assert.equal(Object.keys(targetChildEnvironment([], {}, ["PATH"])).includes("TERM"), false);
  } finally {
    if (previous === undefined) delete process.env.TERM;
    else process.env.TERM = previous;
  }
});

test("the remote drivers keep the default allowlist when they name no allow list", () => {
  const previous = process.env.TERM;
  process.env.TERM = "xterm-lock";
  try {
    assert.equal(Object.keys(targetChildEnvironment(undefined)).includes("TERM"), true);
  } finally {
    if (previous === undefined) delete process.env.TERM;
    else process.env.TERM = previous;
  }
});

test("remote errors redact secret markers and inline credentials", () => {
  const marker = "todo-five-secret-marker";
  const redacted = redactRemoteError(
    new Error(`failed token=${marker} Authorization: Bearer abc.def https://user:${marker}@host/path`),
    { environment: { REMOTE_AUTH_TOKEN: marker } },
  );

  assert.equal(redacted.includes(marker), false);
  assert.equal(redacted.includes("abc.def"), false);
  assert.match(redacted, /\[REDACTED\]/);
});

test("UTF-8 truncation stays byte bounded without replacement characters", () => {
  const value = truncateUtf8("alpha-你好-world", 17);
  assert.ok(utf8ByteLength(value) <= 17);
  assert.equal(value.includes("�"), false);
  assert.match(value, /\[truncated\]$/);
});

test("POSIX escalation retains the process group after the leader exits", async () => {
  const identity = captureProcessTree(4312);
  const signals: Array<[number, NodeJS.Signals]> = [];
  let leaderExited = false;

  await terminateProcessTree(identity, 1, {
    platform: "linux",
    kill: (pid, signal) => {
      signals.push([pid, signal]);
      if (signal === "SIGTERM") leaderExited = true;
      if (signal === "SIGKILL") assert.equal(leaderExited, true);
    },
  });

  assert.deepEqual(signals, [
    [-4312, "SIGTERM"],
    [-4312, "SIGKILL"],
  ]);
});

test("Windows termination uses taskkill tree mode and forced escalation", async () => {
  const identity = captureProcessTree(9021);
  assert.ok(identity);
  assert.deepEqual(
    buildWindowsTaskkillCommand(identity, true, { SystemRoot: "C:\\Windows" }),
    {
      executable: "C:\\Windows\\System32\\taskkill.exe",
      args: ["/PID", "9021", "/T", "/F"],
    },
  );

  const commands: WindowsTaskkillCommand[] = [];
  await terminateProcessTree(identity, 1, {
    platform: "win32",
    environment: { SystemRoot: "C:\\Windows" },
    runTaskkill: (command) => {
      commands.push(command);
      return { status: 0 };
    },
  });

  assert.deepEqual(commands.map((command) => command.args), [
    ["/PID", "9021", "/T"],
    ["/PID", "9021", "/T", "/F"],
  ]);
});
