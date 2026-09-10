import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import {
  GatewayControlClient,
  locateGatewayBinary,
  resetGatewayBinaryCache,
} from "../src/gateway/control-client.ts";

test("control client defaults to the native PI_CODING_AGENT_DIR config", (t) => {
  const previous = process.env.PI_CODING_AGENT_DIR;
  const override = join(tmpdir(), "gateway-control-agent");
  process.env.PI_CODING_AGENT_DIR = override;
  t.after(() => {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
  });

  const client = new GatewayControlClient();
  assert.equal(client.configPath, join(resolve(override), "gateway", "config.yaml"));
});

test("binary discovery ignores MCPX_BIN and contains no legacy alias branch", async (t) => {
  const previousOfficial = process.env.PI_MAESTRO_GATEWAY_BIN;
  const previousLegacy = process.env.MCPX_BIN;
  delete process.env.PI_MAESTRO_GATEWAY_BIN;
  process.env.MCPX_BIN = join(tmpdir(), "untrusted-mcpx-binary");
  resetGatewayBinaryCache();
  t.after(() => {
    if (previousOfficial === undefined) delete process.env.PI_MAESTRO_GATEWAY_BIN;
    else process.env.PI_MAESTRO_GATEWAY_BIN = previousOfficial;
    if (previousLegacy === undefined) delete process.env.MCPX_BIN;
    else process.env.MCPX_BIN = previousLegacy;
    resetGatewayBinaryCache();
  });

  assert.notEqual(locateGatewayBinary()?.source, "override");
  const source = await readFile(new URL("../src/gateway/control-client.ts", import.meta.url), "utf8");
  assert.doesNotMatch(source, /MCPX_BIN|legacy-alias/u);
});
