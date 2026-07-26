import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import test from "node:test";

const packageRoot = fileURLToPath(new URL("../", import.meta.url));
const require = createRequire(import.meta.url);

test("typecheck config covers real source and tests without alias shims", () => {
  const tsc = require.resolve("typescript/bin/tsc");
  const result = spawnSync(process.execPath, [tsc, "-p", "tsconfig.build.json", "--showConfig"], {
    cwd: packageRoot,
    encoding: "utf8",
    windowsHide: true,
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);

  const config = JSON.parse(result.stdout);
  assert.equal(config.compilerOptions?.paths, undefined);
  assert.deepEqual(config.include, ["src/**/*.ts", "test/**/*.ts"]);

  const files = (config.files ?? []).map((file) => String(file).replaceAll("\\", "/"));
  assert.ok(files.some((file) => file.endsWith("/src/extension/index.ts")));
  assert.ok(files.some((file) => file.endsWith("/test/public-api-surface.test.ts")));
  assert.ok(files.some((file) => file.endsWith("/test/tui-input.test.ts")));
  assert.equal(files.some((file) => file.includes("/test/shims/")), false);
  assert.equal(files.some((file) => /(?:^|\/)ambient(?:\/|\.d\.ts$)/.test(file)), false);
});
