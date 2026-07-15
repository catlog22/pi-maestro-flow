import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { installMaestroWorkflows } from "../scripts/install-workflows.mjs";

function fixture({ withRuntime = true } = {}) {
  const root = mkdtempSync(join(tmpdir(), "pi-maestro-workflows-"));
  const packageRoot = join(root, "maestro-flow");
  const maestroHome = join(root, ".maestro");
  mkdirSync(join(packageRoot, "workflows", "nested"), { recursive: true });
  mkdirSync(join(packageRoot, "bin"), { recursive: true });
  writeFileSync(join(packageRoot, "bin", "maestro.js"), "// fixture");
  if (withRuntime) {
    mkdirSync(join(packageRoot, "dist", "src"), { recursive: true });
    writeFileSync(join(packageRoot, "dist", "src", "cli.js"), "// fixture");
  }
  writeFileSync(join(packageRoot, "workflows", "analyze.md"), "analyze");
  writeFileSync(join(packageRoot, "workflows", "nested", "review.md"), "review");
  return { packageRoot, maestroHome };
}

test("uses maestro-flow workflows-only command when supported", () => {
  const { packageRoot, maestroHome } = fixture();
  let args;
  const result = installMaestroWorkflows({
    packageRoot,
    maestroHome,
    stdio: "pipe",
    runner(_command, nextArgs) {
      args = nextArgs;
      return { status: 0 };
    },
  });
  assert.deepEqual(args.slice(-2), ["install", "workflows"]);
  assert.equal(result.mode, "maestro-cli");
});

test("falls back to package workflows for older maestro-flow releases", () => {
  const { packageRoot, maestroHome } = fixture();
  const result = installMaestroWorkflows({
    packageRoot,
    maestroHome,
    stdio: "pipe",
    runner() { return { status: 1 }; },
  });
  assert.equal(result.mode, "package-fallback");
  assert.equal(readFileSync(join(maestroHome, "workflows", "analyze.md"), "utf8"), "analyze");
  assert.equal(existsSync(join(maestroHome, "workflows", "nested", "review.md")), true);
});

test("source-locked maestro-flow tarballs skip an unrunnable bin and copy workflows", () => {
  const { packageRoot, maestroHome } = fixture({ withRuntime: false });
  const result = installMaestroWorkflows({
    packageRoot,
    maestroHome,
    stdio: "pipe",
    runner() { throw new Error("source tarball bin must not run without dist"); },
  });
  assert.equal(result.mode, "package-fallback");
  assert.equal(readFileSync(join(maestroHome, "workflows", "analyze.md"), "utf8"), "analyze");
});
