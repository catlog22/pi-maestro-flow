import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test, { after, before } from "node:test";
import ts from "typescript";
import {
  cleanPackagedSkills,
  preparePackagedSkills,
} from "../scripts/prepare-package-skills.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const teammateRoot = join(root, "..", "pi-maestro-teammate");
const exactSemver = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
const teammatePublicExports = {
  ".": ["./types/index.d.ts", "./src/index.ts"],
  "./v1": ["./types/public/v1/index.d.ts", "./src/public/v1/index.ts"],
  "./v1/agents": ["./types/public/v1/agents.d.ts", "./src/public/v1/agents.ts"],
  "./v1/child-extensions": ["./types/public/v1/child-extensions.d.ts", "./src/public/v1/child-extensions.ts"],
  "./v1/events": ["./types/public/v1/events.d.ts", "./src/public/v1/events.ts"],
  "./v1/execution": ["./types/public/v1/execution.d.ts", "./src/public/v1/execution.ts"],
  "./v1/extension": ["./types/public/v1/extension.d.ts", "./src/public/v1/extension.ts"],
  "./v1/model-routing": ["./types/public/v1/model-routing.d.ts", "./src/public/v1/model-routing.ts"],
  "./v1/prompts": ["./types/public/v1/prompts.d.ts", "./src/public/v1/prompts.ts"],
  "./v1/progress-tree": ["./types/public/v1/progress-tree.d.ts", "./src/public/v1/progress-tree.ts"],
  "./v1/retry": ["./types/public/v1/retry.d.ts", "./src/public/v1/retry.ts"],
  "./v1/types": ["./types/public/v1/types.d.ts", "./src/public/v1/types.ts"],
};

before(() => preparePackagedSkills());
after(() => cleanPackagedSkills());

test("package manifest publishes the extension and canonical Pi skills", () => {
  const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  const teammatePkg = JSON.parse(readFileSync(join(teammateRoot, "package.json"), "utf8"));
  assert.match(pkg.version, exactSemver);
  assert.equal(pkg.files.includes(".pi/skills/"), true);
  assert.equal(pkg.files.includes("workflows/"), false);
  assert.equal(pkg.files.includes("AGENTS.md"), true);
  assert.deepEqual(pkg.pi.skills, ["./.pi/skills"]);
  assert.match(pkg.scripts.postinstall, /install-workflows\.mjs/);
  assert.ok(pkg.files.includes("!.pi/skills/**/__pycache__/**"));
  assert.ok(pkg.files.includes("!.pi/skills/**/*.pyc"));
  assert.match(pkg.dependencies["maestro-flow"], exactSemver);
  assert.equal(pkg.dependencies["pi-maestro-teammate"], teammatePkg.version);
  assert.equal(
    pkg.dependencies["@konbakuyomu/smart-search"],
    "https://codeload.github.com/konbakuyomu/smartsearch/tar.gz/667c465d0f6ea16a423f03c434f94e21505d3595",
  );
  assert.equal(pkg.dependencies["puppeteer-core"], "24.31.0");
  assert.equal(pkg.dependencies["cross-spawn"], "7.0.6");
  assert.equal(pkg.devDependencies.typescript, "5.7.3");
  assert.equal(pkg.engines.node, ">=22.19.0");
  assert.equal(pkg.files.includes("tsconfig.intelligence.json"), true);
  assert.equal(
    existsSync(join(root, "schemas", "swarm-run.schema.json")),
    false,
    "native swarm runtime schema must not be packaged",
  );
  assert.equal(pkg.peerDependencies?.["pi-maestro-teammate"], undefined);
  assert.equal(pkg.peerDependenciesMeta?.["pi-maestro-teammate"], undefined);
  assert.doesNotMatch(JSON.stringify(pkg), /file:D:|D:\\\\maestro2|link:/i);
});

test("teammate package publishes a versioned API with a real root entry", () => {
  const pkg = JSON.parse(readFileSync(join(teammateRoot, "package.json"), "utf8"));
  assert.match(pkg.version, exactSemver);
  assert.equal(pkg.main, "./src/index.ts");
  assert.equal(pkg.types, "./types/index.d.ts");
  assert.equal(pkg.files.includes("types/**/*.d.ts"), true);
  assert.equal(pkg.dependencies["cross-spawn"], "7.0.6");
  assert.equal(pkg.exports["./src/*"], "./src/*");
  assert.match(pkg.deprecatedSubpaths["./src/*"], /Compatibility only/);

  for (const [subpath, [types, defaultTarget]] of Object.entries(teammatePublicExports)) {
    assert.deepEqual(pkg.exports[subpath], { types, default: defaultTarget });
    for (const target of [types, defaultTarget]) {
      assert.equal(
        existsSync(join(teammateRoot, target)),
        true,
        `${subpath} must target a packaged file: ${target}`,
      );
    }
  }
});

test("Flow production imports use the versioned teammate API", () => {
  const privateImports = collectTypeScriptFiles(join(root, "src"))
    .flatMap((filePath) => {
      const source = readFileSync(filePath, "utf8");
      return collectModuleSpecifiers(source)
        .some((specifier) => specifier.startsWith("pi-maestro-teammate/src/"))
        ? [filePath]
        : [];
    });
  assert.deepEqual(privateImports, []);
});

test("production import scan ignores comments and detects private teammate imports", () => {
  const commentOnly = `
    /**
     * See pi-maestro-teammate/src/shared/types.ts for the runtime contract.
     */
    export const publicSpecifier = "pi-maestro-teammate/v1/types";
  `;
  assert.deepEqual(collectModuleSpecifiers(commentOnly), []);

  const privateSpecifier = "pi-maestro-teammate/src/shared/types.ts";
  const realImports = `
    import "${privateSpecifier}";
    export { value } from "${privateSpecifier}";
    void import("${privateSpecifier}");
  `;
  assert.deepEqual(collectModuleSpecifiers(realImports), [
    privateSpecifier,
    privateSpecifier,
    privateSpecifier,
  ]);
});

test("package contains the canonical workflow skill set", () => {
  const skillPath = join(root, ".pi", "skills", "workflow-skill-designer", "SKILL.md");
  assert.match(readFileSync(skillPath, "utf8"), /workflow skills/i);
  const swarmSkillPath = join(root, ".pi", "skills", "team-swarm", "SKILL.md");
  assert.equal(
    existsSync(swarmSkillPath),
    true,
    "team-swarm must be packaged as the sole swarm execution owner",
  );
  const swarmSkill = readFileSync(swarmSkillPath, "utf8");
  assert.match(
    swarmSkill,
    /Hybrid coordinator/,
    "team-swarm must retain the Python ACO execution contract",
  );
  assert.equal(existsSync(join(root, ".pi", "skills", "swarm", "SKILL.md")), false, "native swarm Skill must not be packaged");
});

function collectTypeScriptFiles(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const filePath = join(directory, entry.name);
    if (entry.isDirectory()) return collectTypeScriptFiles(filePath);
    return entry.isFile() && entry.name.endsWith(".ts") ? [filePath] : [];
  });
}

function collectModuleSpecifiers(source) {
  return ts.preProcessFile(source, true, true).importedFiles
    .map((reference) => reference.fileName);
}
