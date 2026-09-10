import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import {
  createGatewayStatePaths,
  gatewayAgentDirectory,
  gatewayConfigPath,
  gatewayGlobalStateRoot,
  gatewayNativeRoot,
  gatewayOperationReceiptRoot,
  gatewayStateRoot,
} from "../src/gateway/state-paths.ts";

function preserveAgentDir(t: test.TestContext): void {
  const previous = process.env.PI_CODING_AGENT_DIR;
  t.after(() => {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
  });
}

test("Gateway uses the Pi agent native root while workspace state remains unchanged", (t) => {
  preserveAgentDir(t);
  delete process.env.PI_CODING_AGENT_DIR;
  const home = join(tmpdir(), "gateway-native-home");
  const cwd = join(tmpdir(), "gateway-native-workspace");
  const agentDir = join(home, ".pi", "agent");
  const nativeRoot = join(agentDir, "gateway");

  assert.equal(gatewayAgentDirectory(home), agentDir);
  assert.equal(gatewayNativeRoot(home), nativeRoot);
  assert.equal(gatewayConfigPath(home), join(nativeRoot, "config.yaml"));
  assert.equal(gatewayGlobalStateRoot(home), join(nativeRoot, "v1"));
  const canonicalCwd = process.platform === "win32" ? resolve(cwd).toLowerCase() : resolve(cwd);
  assert.equal(gatewayStateRoot(cwd), join(canonicalCwd, ".pi", "gateway", "v1"));

  const paths = createGatewayStatePaths(cwd, home);
  assert.equal(paths.configPath, join(nativeRoot, "config.yaml"));
  assert.equal(paths.globalRoot, join(nativeRoot, "v1"));
  assert.equal(paths.ownerPath, join(nativeRoot, "v1", "owner.json"));
  assert.equal(paths.workspaceRegistryPath, join(nativeRoot, "v1", "workspaces.json"));
  assert.equal(paths.workspaceRoot, gatewayStateRoot(cwd));
  assert.equal(paths.operationReceiptRoot, gatewayOperationReceiptRoot(cwd));
});

test("PI_CODING_AGENT_DIR overrides only the user-global Gateway root", (t) => {
  preserveAgentDir(t);
  const home = join(tmpdir(), "gateway-ignored-home");
  const cwd = join(tmpdir(), "gateway-override-workspace");
  const override = join(tmpdir(), "gateway-agent-override");
  process.env.PI_CODING_AGENT_DIR = override;

  assert.equal(gatewayAgentDirectory(home), resolve(override));
  assert.equal(gatewayConfigPath(home), join(resolve(override), "gateway", "config.yaml"));
  assert.equal(gatewayGlobalStateRoot(home), join(resolve(override), "gateway", "v1"));
  const canonicalCwd = process.platform === "win32" ? resolve(cwd).toLowerCase() : resolve(cwd);
  assert.equal(gatewayStateRoot(cwd), join(canonicalCwd, ".pi", "gateway", "v1"));
});
