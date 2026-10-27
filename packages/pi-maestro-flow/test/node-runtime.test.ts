import assert from "node:assert/strict";
import test from "node:test";
import { isJavaScriptRuntime, resolveJavaScriptRuntime } from "../src/process/node-runtime.ts";

const PATH_NODE = process.platform === "win32" ? "node.exe" : "node";

test("reuses a Node runtime so Node deployments keep their behavior", () => {
  assert.equal(resolveJavaScriptRuntime("/usr/local/bin/node"), "/usr/local/bin/node");
  assert.equal(resolveJavaScriptRuntime("C:\\Program Files\\nodejs\\node.exe"), "C:\\Program Files\\nodejs\\node.exe");
});

test("reuses a Bun runtime", () => {
  assert.equal(resolveJavaScriptRuntime("/Users/dev/.bun/bin/bun"), "/Users/dev/.bun/bin/bun");
});

test("falls back to PATH node for a bundled application executable", () => {
  // Pi-Bolt runs Pi itself from `pi-bin`; forking that path would start another
  // agent session instead of the worker script.
  assert.equal(resolveJavaScriptRuntime("/Users/dev/.pi-bolt/pi-bolt-darwin-arm64/pi-bin"), PATH_NODE);
  assert.equal(resolveJavaScriptRuntime("/Users/dev/.pi-bolt/pi-bolt-darwin-arm64/pi"), PATH_NODE);
});

test("classifies runtime names only", () => {
  assert.equal(isJavaScriptRuntime("node"), true);
  assert.equal(isJavaScriptRuntime("C:\\Program Files\\nodejs\\node.exe"), true);
  assert.equal(isJavaScriptRuntime("/usr/bin/bun"), true);
  assert.equal(isJavaScriptRuntime("/Users/dev/.pi-bolt/pi-bolt-darwin-arm64/pi-bin"), false);
  assert.equal(isJavaScriptRuntime(""), false);
});
