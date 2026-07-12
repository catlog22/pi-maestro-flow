import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

test("package manifest publishes the extension without a duplicate package skill", () => {
  const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  assert.equal(pkg.files.includes("skills/"), false);
  assert.equal(pkg.files.includes("workflows/"), false);
  assert.equal("skills" in pkg.pi, false);
  assert.match(pkg.scripts.postinstall, /install-workflows\.mjs/);
  assert.equal(pkg.dependencies["maestro-flow"], "0.5.49");
  assert.doesNotMatch(JSON.stringify(pkg), /file:D:|D:\\\\maestro2/i);
});
