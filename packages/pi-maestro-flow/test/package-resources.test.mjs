import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test, { after, before } from "node:test";
import {
  cleanPackagedSkills,
  preparePackagedSkills,
} from "../scripts/prepare-package-skills.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const teammateRoot = join(root, "..", "pi-maestro-teammate");

before(() => preparePackagedSkills());
after(() => cleanPackagedSkills());

test("package manifest publishes the extension and canonical Pi skills", () => {
  const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  assert.equal(pkg.version, "0.4.10");
  assert.equal(pkg.files.includes(".pi/skills/"), true);
  assert.equal(pkg.files.includes("workflows/"), false);
  assert.equal(pkg.files.includes("AGENTS.md"), true);
  assert.deepEqual(pkg.pi.skills, ["./.pi/skills"]);
  assert.match(pkg.scripts.postinstall, /install-workflows\.mjs/);
  assert.ok(pkg.files.includes("!.pi/skills/**/__pycache__/**"));
  assert.ok(pkg.files.includes("!.pi/skills/**/*.pyc"));
  assert.equal(
    pkg.dependencies["maestro-flow"],
    "https://codeload.github.com/catlog22/maestro-flow/tar.gz/84ae24f8ed9a12cac3b5c69ea3428840a0a58e1b",
  );
  assert.equal(pkg.dependencies["pi-maestro-teammate"], "0.4.5");
  assert.equal(
    pkg.dependencies["@konbakuyomu/smart-search"],
    "https://codeload.github.com/konbakuyomu/smartsearch/tar.gz/667c465d0f6ea16a423f03c434f94e21505d3595",
  );
  assert.equal(pkg.dependencies["puppeteer-core"], "24.31.0");
  assert.equal(pkg.dependencies["cross-spawn"], "7.0.6");
  assert.equal(pkg.devDependencies.typescript, "5.7.3");
  assert.equal(pkg.engines.node, ">=20.6.0");
  assert.equal(pkg.files.includes("tsconfig.intelligence.json"), true);
  assert.equal(pkg.peerDependencies?.["pi-maestro-teammate"], undefined);
  assert.equal(pkg.peerDependenciesMeta?.["pi-maestro-teammate"], undefined);
  assert.doesNotMatch(JSON.stringify(pkg), /file:D:|D:\\\\maestro2|link:/i);
});

test("teammate package publishes a versioned API with a real root entry", () => {
  const pkg = JSON.parse(readFileSync(join(teammateRoot, "package.json"), "utf8"));
  assert.equal(pkg.version, "0.4.5");
  assert.equal(pkg.main, "./src/index.ts");
  assert.equal(pkg.types, "./src/index.ts");
  assert.equal(pkg.exports["."], pkg.main);
  assert.equal(pkg.dependencies["cross-spawn"], "7.0.6");
  assert.equal(pkg.exports["./src/*"], "./src/*");
  assert.match(pkg.deprecatedSubpaths["./src/*"], /Compatibility only/);

  for (const [subpath, target] of Object.entries(pkg.exports)) {
    if (subpath.includes("*") || typeof target !== "string") continue;
    assert.equal(
      existsSync(join(teammateRoot, target)),
      true,
      `${subpath} must target a packaged source file: ${target}`,
    );
  }
});

test("Flow production imports use the versioned teammate API", () => {
  const privateImports = collectTypeScriptFiles(join(root, "src"))
    .flatMap((filePath) => {
      const source = readFileSync(filePath, "utf8");
      return source.includes("pi-maestro-teammate/src/") ? [filePath] : [];
    });
  assert.deepEqual(privateImports, []);
});

test("package contains the canonical workflow skill set", () => {
  const skillPath = join(root, ".pi", "skills", "workflow-skill-designer", "SKILL.md");
  assert.match(readFileSync(skillPath, "utf8"), /workflow skills/i);
});

function collectTypeScriptFiles(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const filePath = join(directory, entry.name);
    if (entry.isDirectory()) return collectTypeScriptFiles(filePath);
    return entry.isFile() && entry.name.endsWith(".ts") ? [filePath] : [];
  });
}
