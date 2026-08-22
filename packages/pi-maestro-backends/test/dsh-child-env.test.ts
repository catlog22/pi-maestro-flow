import assert from "node:assert/strict";
import test from "node:test";
import { childEnv } from "pi-maestro-backends/dsh/driver";
import { TODO_ENDPOINT_ENV } from "pi-maestro-backends/dsh/todo-endpoint";

/**
 * What the dsh runtime subprocess is allowed to see.
 *
 * The SDK inherits the parent environment verbatim when given nothing, and this
 * child runs model-directed shell commands. Everything the host holds for its
 * own providers and services would otherwise be readable by a `env` call the
 * model decides to make.
 */

const ESSENTIAL = process.platform === "win32" ? "SystemRoot" : "PATH";

/**
 * The baseline the dsh child is entitled to, copied rather than imported.
 *
 * Deliberate duplication: it pins the source list, so a change there that no
 * one meant to make fails here instead of shipping.
 */
const DSH_ESSENTIALS = process.platform === "win32"
  ? [
    "APPDATA", "COMSPEC", "LOCALAPPDATA", "OS", "PATH", "PATHEXT", "ProgramData",
    "ProgramFiles", "ProgramFiles(x86)", "SSH_AUTH_SOCK", "SystemDrive", "SystemRoot",
    "TEMP", "TMP", "USERPROFILE", "windir",
  ]
  : ["HOME", "LANG", "LC_ALL", "LOGNAME", "PATH", "SHELL", "SSH_AUTH_SOCK", "TMPDIR", "TZ", "USER"];

test("a host credential the runtime never needs does not reach the child", () => {
  const before = process.env.OTHER_PROVIDER_TOKEN;
  process.env.OTHER_PROVIDER_TOKEN = "sk-host-only";
  try {
    const child = childEnv({});
    assert.equal(child.OTHER_PROVIDER_TOKEN, undefined);
    assert.equal(JSON.stringify(child).includes("sk-host-only"), false);
  } finally {
    if (before === undefined) delete process.env.OTHER_PROVIDER_TOKEN;
    else process.env.OTHER_PROVIDER_TOKEN = before;
  }
});

test("the child still gets what it needs to start", () => {
  const child = childEnv({});
  assert.equal(child[ESSENTIAL], process.env[ESSENTIAL]);
});

test("a deployment names the extra variables its runtime needs", () => {
  const before = process.env.HTTPS_PROXY;
  process.env.HTTPS_PROXY = "http://proxy.internal:3128";
  try {
    assert.equal(childEnv({}).HTTPS_PROXY, undefined);
    assert.equal(
      childEnv({ envPassthrough: ["HTTPS_PROXY"] }).HTTPS_PROXY,
      "http://proxy.internal:3128",
    );
  } finally {
    if (before === undefined) delete process.env.HTTPS_PROXY;
    else process.env.HTTPS_PROXY = before;
  }
});

test("a named variable the host does not set is omitted rather than blanked", () => {
  const child = childEnv({ envPassthrough: ["DEFINITELY_UNSET_FOR_THIS_TEST"] });
  assert.equal("DEFINITELY_UNSET_FOR_THIS_TEST" in child, false);
});

test("a per-run value is handed over by the caller, not looked up in this process", () => {
  const url = "http://127.0.0.1:1/mcp?token=a";
  assert.equal(process.env[TODO_ENDPOINT_ENV], undefined);
  const child = childEnv({}, { [TODO_ENDPOINT_ENV]: url });
  assert.equal(child[TODO_ENDPOINT_ENV], url);
  // The host's own environment is not a channel for this: two attempts running
  // at once would read each other's URL, and the URL names an actor.
  assert.equal(process.env[TODO_ENDPOINT_ENV], undefined);
});

test("two attempts handed different per-run values do not share one", () => {
  const first = childEnv({}, { [TODO_ENDPOINT_ENV]: "http://127.0.0.1:1/mcp?token=one" });
  const second = childEnv({}, { [TODO_ENDPOINT_ENV]: "http://127.0.0.1:2/mcp?token=two" });
  assert.notEqual(first[TODO_ENDPOINT_ENV], second[TODO_ENDPOINT_ENV]);
});

test("a per-run extra that names a launch-policy variable is refused", () => {
  assert.throws(
    () => childEnv({}, { NODE_OPTIONS: "--require ./evil.js" }),
    /cannot replace launch policy/,
  );
});

test("the todo endpoint URL survives the secret gate because the host handed it over", () => {
  // The name really is secret-shaped, so this run exercises the gate rather
  // than passing because nothing was gated.
  assert.match(TODO_ENDPOINT_ENV, /(?:^|_)SECRET(?:_|$)/);
  const url = "http://127.0.0.1:1/mcp?token=a";
  assert.equal(childEnv({}, { [TODO_ENDPOINT_ENV]: url })[TODO_ENDPOINT_ENV], url);
});

test("a per-run extra carrying a NUL byte is refused", () => {
  assert.throws(() => childEnv({}, { PI_X: "a\u0000b" }), /cannot contain NUL bytes/);
});

test("the dsh child sees exactly the dsh essentials and nothing the remote default allowlist adds", () => {
  // TERM belongs to the remote bridge's default allowlist and not to this
  // one, so borrowing that list would show up here as an extra key.
  const before = process.env.TERM;
  process.env.TERM = "xterm-lock";
  try {
    assert.deepEqual(
      Object.keys(childEnv({})).sort(),
      DSH_ESSENTIALS.filter((name) => process.env[name] !== undefined).sort(),
    );
  } finally {
    if (before === undefined) delete process.env.TERM;
    else process.env.TERM = before;
  }
});
