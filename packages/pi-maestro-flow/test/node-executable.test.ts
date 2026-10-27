import assert from "node:assert/strict";
import test from "node:test";
import { nodeExecutable } from "../src/tools/node-executable.ts";

test("selects Node for script execution without launching a compiled host", () => {
  for (const path of ["/usr/bin/node", "/usr/bin/nodejs", "C:\\node\\NODE.EXE"]) {
    assert.equal(nodeExecutable(path), path);
  }
  for (const path of ["/opt/pi-bin", "/usr/bin/bun", "C:\\pi\\pi.exe"]) {
    assert.equal(nodeExecutable(path), "node");
  }
});
