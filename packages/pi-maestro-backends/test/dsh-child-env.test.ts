import assert from "node:assert/strict";
import test from "node:test";
import { childEnv } from "pi-maestro-backends/dsh/driver";

/**
 * What the dsh runtime subprocess is allowed to see.
 *
 * The SDK inherits the parent environment verbatim when given nothing, and this
 * child runs model-directed shell commands. Everything the host holds for its
 * own providers and services would otherwise be readable by a `env` call the
 * model decides to make.
 */

const ESSENTIAL = process.platform === "win32" ? "SystemRoot" : "PATH";

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
