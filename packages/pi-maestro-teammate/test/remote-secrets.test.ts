import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { sanitizeChildEnv, isSecretEnvName } from "../src/remote/child-env.ts";
import { AcpDriver } from "../src/remote/acp-driver.ts";
import { PiRpcDriver } from "../src/remote/pi-rpc-driver.ts";
import type { RemoteDriverContext } from "../src/remote/driver.ts";
import { REMOTE_PROTOCOL_VERSION, type ResolvedRemoteTarget } from "../src/remote/types.ts";

const HOST_KEY = "SHA256:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

test("sanitizeChildEnv strips secret-looking variables", () => {
  const source = {
    PATH: "/usr/bin",
    HOME: "/home/dev",
    OPENAI_API_KEY: "sk-secret-123",
    ANTHROPIC_AUTH_TOKEN: "tok-secret",
    AWS_ACCESS_KEY_ID: "AKIA-SECRET",
    DATABASE_PASSWORD: "pwd",
    GITHUB_TOKEN: "ghp_x",
    NORMAL_VAR: "keep",
  };
  const cleaned = sanitizeChildEnv(source);
  assert.equal(cleaned.NORMAL_VAR, "keep");
  assert.equal(cleaned.PATH, "/usr/bin");
  assert.equal(cleaned.HOME, "/home/dev");
  for (const secret of ["OPENAI_API_KEY", "ANTHROPIC_AUTH_TOKEN", "AWS_ACCESS_KEY_ID", "DATABASE_PASSWORD", "GITHUB_TOKEN"]) {
    assert.equal(Object.hasOwn(cleaned, secret), false, `${secret} must be removed`);
  }
  assert.equal(isSecretEnvName("OPENAI_API_KEY"), true);
  assert.equal(isSecretEnvName("NORMAL_VAR"), false);
});

test("sanitizeChildEnv honors an explicit allowlist", () => {
  const source = { PATH: "/usr/bin", HOME: "/home", FOO: "bar", OPENAI_API_KEY: "sk-x" };
  const allow = sanitizeChildEnv(source, ["PATH", "HOME"]);
  assert.equal(allow.PATH, "/usr/bin");
  assert.equal(allow.HOME, "/home");
  assert.equal(Object.hasOwn(allow, "FOO"), false);
  assert.equal(Object.hasOwn(allow, "OPENAI_API_KEY"), false);
});
