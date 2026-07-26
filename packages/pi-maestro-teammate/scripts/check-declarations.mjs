import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const committedRoot = join(packageRoot, "types");
const tempRoot = mkdtempSync(join(tmpdir(), "pi-teammate-declarations-"));
const generatedRoot = join(tempRoot, "types");
const require = createRequire(import.meta.url);
const tscPath = require.resolve("typescript/bin/tsc");

try {
  const result = spawnSync(
    process.execPath,
    [tscPath, "-p", "tsconfig.declarations.json", "--outDir", generatedRoot],
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
    `declaration generation failed\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
  );

  const committed = collectDeclarations(committedRoot);
  const generated = collectDeclarations(generatedRoot);
  assert.deepEqual(
    [...committed.keys()],
    [...generated.keys()],
    "committed declaration file set does not match generated output",
  );

  for (const [path, content] of generated) {
    assert.equal(
      committed.get(path),
      content,
      `committed declaration differs from generated output: ${path}`,
    );
  }
} finally {
  rmSync(tempRoot, { recursive: true, force: true });
}

function collectDeclarations(root) {
  const files = new Map();
  for (const filePath of walk(root)) {
    if (!filePath.endsWith(".d.ts")) continue;
    files.set(
      relative(root, filePath).replaceAll("\\", "/"),
      readFileSync(filePath, "utf8").replaceAll("\r\n", "\n"),
    );
  }
  return new Map([...files].sort(([left], [right]) => left.localeCompare(right)));
}

function walk(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? walk(path) : [path];
  });
}
