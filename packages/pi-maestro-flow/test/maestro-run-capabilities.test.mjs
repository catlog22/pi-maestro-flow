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
      return { status: 0, stdout: `Usage: maestro run ${args[2]} [options]` };
    },
  });
  assert.deepEqual(result.commands, REQUIRED_RUN_COMMANDS);
  assert.deepEqual(calls.map((args) => args.slice(-3)), [
    ["run", "next", "--help"],
    ["run", "create", "--help"],
    ["run", "complete", "--help"],
  ]);
});

test("reports a precise failure for an unsupported Run command", () => {
  assert.throws(
    () => verifyMaestroRunCapabilities({
      packageRoot: fixture(),
      runner(_command, args) {
        return args.includes("complete") ? { status: 1, stderr: "unknown command: complete" } : { status: 0, stdout: `Usage: maestro run ${args[2]} [options]` };
      },
    }),
    /maestro run complete.*unknown command: complete.*Update maestro-flow/i,
  );
});

test("rejects parent help when a required Run subcommand is missing", () => {
  assert.throws(
    () => verifyMaestroRunCapabilities({
      packageRoot: fixture(),
      runner() {
        return { status: 0, stdout: "Usage: maestro run [options] [command]" };
      },
    }),
    /maestro run next.*Usage: maestro run \[options\] \[command\].*Update maestro-flow/i,
  );
});
