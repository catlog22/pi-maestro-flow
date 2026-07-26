import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
const tscPath = require.resolve("typescript/bin/tsc");

test("Flow typecheck consumes Teammate declarations without compiling Teammate source", () => {
  const result = spawnSync(
    process.execPath,
    [tscPath, "-p", "tsconfig.build.json", "--noEmit", "--listFilesOnly", "--pretty", "false"],
    {
      cwd: packageRoot,
      encoding: "utf8",
      windowsHide: true,
      shell: false,
    },
  );
  assert.equal(
    result.status,
    0,
    `Flow typecheck file listing failed\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
  );

  const files = result.stdout
    .split(/\r?\n/)
    .filter(Boolean)
    .map((path) => path.replaceAll("\\", "/").toLowerCase());
  assert.equal(
    files.some((path) => path.includes("/packages/pi-maestro-teammate/src/")),
    false,
    "Flow typecheck must not cross into Teammate source",
  );
  assert.equal(
    files.some((path) => path.includes("/packages/pi-maestro-teammate/types/")),
    true,
    "Flow typecheck must consume Teammate published declarations",
  );
});
