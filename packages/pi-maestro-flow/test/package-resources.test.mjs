import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

test("package manifest publishes the extension and canonical Pi skills", () => {
  const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  assert.equal(pkg.files.includes(".pi/skills/"), true);
  assert.equal(pkg.files.includes("workflows/"), false);
  assert.equal(pkg.files.includes("AGENTS.md"), true);
  assert.deepEqual(pkg.pi.skills, ["./.pi/skills"]);
  assert.match(pkg.scripts.postinstall, /install-workflows\.mjs/);
  assert.ok(pkg.files.includes("!.pi/skills/**/__pycache__/**"));
  assert.ok(pkg.files.includes("!.pi/skills/**/*.pyc"));
  assert.equal(pkg.dependencies["maestro-flow"], "0.5.49");
  assert.equal(pkg.dependencies["pi-maestro-teammate"], "^0.4.3");
  assert.equal(pkg.dependencies["puppeteer-core"], "24.31.0");
  assert.equal(pkg.dependencies["cross-spawn"], "7.0.6");
  assert.equal(pkg.devDependencies.typescript, "5.7.3");
  assert.equal(pkg.engines.node, ">=20.6.0");
  assert.equal(pkg.files.includes("tsconfig.intelligence.json"), true);
  assert.equal(pkg.peerDependencies?.["pi-maestro-teammate"], undefined);
  assert.equal(pkg.peerDependenciesMeta?.["pi-maestro-teammate"], undefined);
  assert.doesNotMatch(JSON.stringify(pkg), /file:D:|D:\\\\maestro2/i);
});

test("package contains the canonical workflow skill set", () => {
  const skillPath = join(root, ".pi", "skills", "workflow-skill-designer", "SKILL.md");
  assert.match(readFileSync(skillPath, "utf8"), /workflow skills/i);
});
