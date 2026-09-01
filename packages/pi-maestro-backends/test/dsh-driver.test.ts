import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";
import type { DshDriverOptions } from "pi-maestro-backends/dsh";
import {
  childEnv,
  composeDshLaunch,
  createDshDriver,
  pinHostKey,
  type HostKeyPin,
  type KeyscanResult,
} from "pi-maestro-backends/dsh/driver";

const roots: string[] = [];
after(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

function fingerprint(blob: string): string {
  return `SHA256:${createHash("sha256").update(Buffer.from(blob, "base64")).digest("base64").replace(/=+$/, "")}`;
}

function keyRecord(host: string, algorithm: string, bytes: string): { line: string; fingerprint: string } {
  const blob = Buffer.from(bytes).toString("base64");
  return { line: `${host} ${algorithm} ${blob}`, fingerprint: fingerprint(blob) };
}

const LOCAL_CONFIG = {
  command: "dsh-jsonrpc-agent",
  cordisConfig: "/srv/dsh/cordis.yml",
  cwd: "/srv/dsh",
  requestTimeoutMs: 17_000,
};

test("local composition preserves the established command, argv, cwd, env, and timeout", () => {
  const launch = composeDshLaunch(LOCAL_CONFIG, "/run/base");
  assert.deepEqual(launch, {
    command: LOCAL_CONFIG.command,
    args: [LOCAL_CONFIG.cordisConfig],
    cwd: LOCAL_CONFIG.cwd,
    env: childEnv(LOCAL_CONFIG),
    requestTimeoutMs: LOCAL_CONFIG.requestTimeoutMs,
  });

  const inheritedCwd = composeDshLaunch({ ...LOCAL_CONFIG, cwd: undefined }, "/run/base");
  assert.equal(inheritedCwd.cwd, "/run/base");
});

test("ssh composition has the exact ordered argv and quotes hostile remote tokens", () => {
  const before = process.env.DSH_DRIVER_TEST_VALUE;
  process.env.DSH_DRIVER_TEST_VALUE = "value with $ and 'quotes'";
  try {
    const cwd = "/remote/dir with $dollar\nnext'part";
    const command = "agent $HOME 'quoted'\ncommand";
    const cordis = "/remote/cordis file.yml\nsecond";
    const pin: HostKeyPin = { knownHostsFile: "/tmp/pinned-known-hosts", dispose() {} };
    const launch = composeDshLaunch({
      mode: "ssh",
      host: "build-host",
      user: "runner-user",
      port: 2207,
      identityFile: "/keys/id with space",
      envPassthrough: ["DSH_DRIVER_TEST_VALUE", "DSH_DRIVER_TEST_UNSET"],
      cwd,
      command,
      cordisConfig: cordis,
      requestTimeoutMs: 42_000,
    }, "/unused", pin);

    assert.equal(launch.command, "ssh");
    assert.deepEqual(launch.args, [
      "-p", "2207",
      "-i", "/keys/id with space",
      "-o", "BatchMode=yes",
      "-o", "IdentitiesOnly=yes",
      "-o", "StrictHostKeyChecking=yes",
      "-o", "UserKnownHostsFile=/tmp/pinned-known-hosts",
      "-o", "ConnectTimeout=10",
      "-o", "SendEnv=DSH_DRIVER_TEST_VALUE",
      "--",
      "runner-user@build-host",
      "cd '/remote/dir with $dollar\nnext'\\''part' && exec 'agent $HOME '\\''quoted'\\''\ncommand' '/remote/cordis file.yml\nsecond'",
    ]);
    assert.equal(launch.env?.DSH_DRIVER_TEST_VALUE, "value with $ and 'quotes'");
    assert.equal(launch.args?.some((argument) => argument.includes("value with $")), false);
    assert.equal(launch.cwd, "/unused");
    assert.equal(launch.requestTimeoutMs, 42_000);
  } finally {
    if (before === undefined) delete process.env.DSH_DRIVER_TEST_VALUE;
    else process.env.DSH_DRIVER_TEST_VALUE = before;
  }
});

test("ssh composition rejects a missing or token-splitting host or user before launch", () => {
  assert.throws(
    () => composeDshLaunch({ mode: "ssh", user: "runner", cordisConfig: "c.yml" }),
    /"host" is required/,
  );
  assert.throws(
    () => composeDshLaunch({ mode: "ssh", host: "build", cordisConfig: "c.yml" }),
    /"user" is required/,
  );
  assert.throws(
    () => composeDshLaunch({ mode: "ssh", host: "build host", user: "runner", cordisConfig: "c.yml" }),
    /must not contain whitespace or control characters/,
  );
  assert.throws(
    () => composeDshLaunch({ mode: "ssh", host: "build", user: "runner user", cordisConfig: "c.yml" }),
    /must not contain whitespace or control characters/,
  );
});

test("a matching host key is pinned verbatim and the temporary file is removed", async () => {
  const record = keyRecord("[build.example]:2222", "ssh-ed25519", "ed25519-test-key");
  let seenArgv: readonly string[] | undefined;
  const pin = await pinHostKey({
    host: "build.example",
    port: 2222,
    fingerprint: record.fingerprint,
    runScan: async (argv) => {
      seenArgv = argv;
      return { code: 0, stdout: `# comment\n${record.line}\n` };
    },
  });
  assert.deepEqual(seenArgv, ["ssh-keyscan", "-p", "2222", "build.example"]);
  assert.equal(existsSync(pin.knownHostsFile), true);
  assert.equal(readFileSync(pin.knownHostsFile, "utf8"), `${record.line}\n`);
  pin.dispose();
  assert.equal(existsSync(pin.knownHostsFile), false);
});

test("host-key pinning fails closed for scan errors, nonzero, empty, malformed, and mismatch output", async () => {
  const valid = keyRecord("build.example", "ssh-ed25519", "valid-key");
  const cases: { name: string; scan: () => Promise<KeyscanResult>; error: RegExp }[] = [
    { name: "scan failure", scan: async () => { throw new Error("network unavailable"); }, error: /network unavailable/ },
    { name: "nonzero", scan: async () => ({ code: 1, stdout: valid.line }), error: /exited 1/ },
    { name: "empty", scan: async () => ({ code: 0, stdout: "\n# no records\n" }), error: /no parseable host keys/ },
    { name: "malformed", scan: async () => ({ code: 0, stdout: `${valid.line}\nnot a keyscan record` }), error: /unparseable record/ },
    { name: "mismatch", scan: async () => ({ code: 0, stdout: valid.line }), error: /presented matches/ },
  ];
  for (const item of cases) {
    await assert.rejects(
      pinHostKey({ host: "build.example", fingerprint: fingerprint(Buffer.from("other-key").toString("base64")), runScan: item.scan }),
      item.error,
      item.name,
    );
  }
});

test("all keyscan records are parsed and only the matching ed25519 or RSA record is pinned", async () => {
  const ed = keyRecord("build.example", "ssh-ed25519", "ed25519-key");
  const rsa = keyRecord("build.example", "ssh-rsa", "rsa-key");
  const pin = await pinHostKey({
    host: "build.example",
    fingerprint: rsa.fingerprint,
    runScan: async () => ({ code: 0, stdout: `${ed.line}\n${rsa.line}\n` }),
  });
  try {
    assert.equal(readFileSync(pin.knownHostsFile, "utf8"), `${rsa.line}\n`);
  } finally {
    pin.dispose();
  }
});

const STUB_RUNTIME = String.raw`
let input = "";
let output = Promise.resolve();
const scenario = process.env.DSH_STUB_SCENARIO || "normal";
const delayed = scenario === "blocked-stdin";

function writeChunked(text) {
  return new Promise((resolve, reject) => {
    let offset = 0;
    function next() {
      if (offset >= text.length) { resolve(); return; }
      const end = Math.min(offset + (scenario === "chunked" ? 2 : text.length), text.length);
      const chunk = text.slice(offset, end);
      offset = end;
      process.stdout.write(chunk, (error) => error ? reject(error) : setImmediate(next));
    }
    next();
  });
}
function send(value) {
  const text = JSON.stringify({ jsonrpc: "2.0", ...value }) + "\n";
  output = output.then(() => writeChunked(text));
  return output;
}
function stderr(text) {
  return new Promise((resolve, reject) => process.stderr.write(text, (error) => error ? reject(error) : resolve()));
}
async function handle(message) {
  if (message.method === "initialize") {
    await send({ id: message.id, result: { serverInfo: { name: "stub", version: "1" } } });
    return;
  }
  if (message.method === "shutdown") {
    if (scenario === "teardown") return;
    await send({ id: message.id, result: {} });
    process.exit(0);
    return;
  }
  if (message.method !== "session/prompt") return;
  if (scenario === "stderr") {
    await stderr("stub diagnostic marker\n" + "x".repeat(600000) + "\nstderr-tail-marker\n");
    process.exit(17);
    return;
  }
  if (scenario === "teardown") return;
  const sessionId = message.params.sessionId;
  const messageId = "stub-message-" + Date.now();
  await send({ id: message.id, result: { messageId } });
  await send({ method: "session.event", params: { sessionId, event: { type: "agent/inbox/spliced", data: { inserted: [{ id: messageId }] } } } });
  if (scenario === "stdout-backpressure") {
    for (let index = 0; index < 180; index += 1) {
      await send({ method: "session.event", params: { sessionId, event: { type: "runtime/chunk", data: { payload: "payload-" + String(index) + "-" + "x".repeat(32768) } } } });
    }
  }
  await send({ method: "session.event", params: { sessionId, event: { type: "assistant/message", data: { message: { content: [{ type: "text", text: "STUB-OK" }] } } } } });
  await send({ method: "session.status", params: { sessionId, status: "idle" } });
}
function attach() {
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => {
    input += chunk;
    for (;;) {
      const newline = input.indexOf("\n");
      if (newline < 0) break;
      const line = input.slice(0, newline).trim();
      input = input.slice(newline + 1);
      if (!line) continue;
      handle(JSON.parse(line)).catch(async (error) => { await stderr(String(error)); process.exit(2); });
    }
  });
  process.stdin.on("end", () => { if (scenario !== "teardown") process.exit(0); });
}
if (scenario === "teardown") {
  process.on("SIGTERM", () => { process.stderr.write("SIGTERM-IGNORED\n"); });
}
if (delayed) setTimeout(attach, 250); else attach();
`;

function makeRuntime(scenario: string): { root: string; script: string } {
  const root = mkdtempSync(join(tmpdir(), "dsh-driver-test-"));
  roots.push(root);
  const script = join(root, "stub-runtime.mjs");
  writeFileSync(script, STUB_RUNTIME, "utf8");
  return { root, script };
}

async function makeDriver(scenario: string) {
  const runtime = makeRuntime(scenario);
  const config = {
    command: process.execPath,
    cordisConfig: runtime.script,
    cwd: runtime.root,
    requestTimeoutMs: 5_000,
  };
  const options = {
    correlationId: `dsh-driver-test-${scenario}`,
    baseCwd: runtime.root,
    host: {},
    config,
    envExtras: { DSH_STUB_SCENARIO: scenario },
  } as DshDriverOptions;
  return createDshDriver(config, options);
}

test("stream lifecycle reassembles JSON-RPC frames split across byte boundaries", async () => {
  const driver = await makeDriver("chunked");
  try {
    const result = await driver.run("probe", { sessionId: "chunked-session" });
    assert.equal(result.finalResponse, "STUB-OK");
    assert.ok(result.events.some((event) => event.type === "agent/inbox/spliced"));
  } finally {
    await driver.close();
  }
});

test("stream lifecycle keeps frames intact when stdin is initially blocked", async () => {
  const driver = await makeDriver("blocked-stdin");
  try {
    const result = await driver.run("probe", { sessionId: "blocked-session" });
    assert.equal(result.finalResponse, "STUB-OK");
    assert.ok(result.events.length >= 2);
  } finally {
    await driver.close();
  }
});

test("stream lifecycle drains multi-megabyte stdout without losing the final frame", async () => {
  const driver = await makeDriver("stdout-backpressure");
  try {
    const result = await driver.run("probe", { sessionId: "backpressure-session" });
    assert.equal(result.finalResponse, "STUB-OK");
    assert.ok(result.events.filter((event) => event.type === "runtime/chunk").length >= 180);
  } finally {
    await driver.close();
  }
});

test("stream lifecycle drains concurrent stderr and surfaces its diagnostic tail", async () => {
  const driver = await makeDriver("stderr");
  try {
    await assert.rejects(
      driver.run("probe", { sessionId: "stderr-session" }),
      /stderr tail:[\s\S]*stderr-tail-marker/,
    );
  } finally {
    await driver.close();
  }
});

test("stream lifecycle escalates teardown on POSIX from SIGTERM to SIGKILL", { skip: process.platform === "win32" }, async () => {
  const driver = await makeDriver("teardown");
  const run = driver.run("probe", { sessionId: "teardown-session" });
  const runRejection = assert.rejects(run, /SIGTERM-IGNORED|runtime exited|runtime closed|input closed/);
  try {
    await new Promise((resolve) => setTimeout(resolve, 300));
    await driver.close();
    await runRejection;
  } finally {
    await driver.close();
  }
});

test("stream lifecycle uses the Windows forced tree teardown", { skip: process.platform !== "win32" }, async () => {
  // The SDK owns the child process and maps SIGKILL to TerminateProcess on
  // Windows. The same harness close path is exercised here; POSIX signal
  // escalation is covered by the platform-specific case above.
  const driver = await makeDriver("teardown");
  const run = driver.run("probe", { sessionId: "windows-teardown-session" });
  const runRejection = assert.rejects(run, /runtime exited|runtime closed|SIGTERM-IGNORED|input closed/);
  try {
    await new Promise((resolve) => setTimeout(resolve, 300));
    await driver.close();
    await runRejection;
  } finally {
    await driver.close();
  }
});
