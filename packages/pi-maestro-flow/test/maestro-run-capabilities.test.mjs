import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  REQUIRED_RUN_COMMANDS,
  verifyMaestroRunCapabilities,
} from "../scripts/verify-maestro-run-capabilities.mjs";

function fixture() {
  const packageRoot = join(mkdtempSync(join(tmpdir(), "pi-maestro-run-cli-")), "maestro-flow");
  mkdirSync(join(packageRoot, "bin"), { recursive: true });
  mkdirSync(join(packageRoot, "dist", "src"), { recursive: true });
  writeFileSync(join(packageRoot, "bin", "maestro.js"), "// fixture\n");
  writeFileSync(join(packageRoot, "dist", "src", "cli.js"), "// fixture\n");
  return packageRoot;
}

test("checks every Pi-required Maestro Run command", () => {
  const calls = [];
  const result = verifyMaestroRunCapabilities({
    packageRoot: fixture(),
    runner(_command, args) {
      calls.push(args);
      return { status: 0 };
    },
  });
  assert.deepEqual(result.commands, REQUIRED_RUN_COMMANDS);
  assert.deepEqual(calls.map((args) => args.slice(-3)), [
    ["run", "start", "--help"],
    ["run", "done", "--help"],
    ["run", "edit", "--help"],
  ]);
});

test("reports a precise failure for an unsupported Run command", () => {
  assert.throws(
    () => verifyMaestroRunCapabilities({
      packageRoot: fixture(),
      runner(_command, args) {
        return args.includes("edit") ? { status: 1, stderr: "unknown command: edit" } : { status: 0 };
      },
    }),
    /maestro run edit.*unknown command: edit.*Update maestro-flow/i,
  );
});
