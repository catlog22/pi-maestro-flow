import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { resolveMaestroPackageSkillPath } from "../src/resources/maestro-package.ts";

test("resolves the installed maestro-flow .agents skill directory", () => {
  const root = join(tmpdir(), `pi-maestro-package-${process.pid}-${Date.now()}`);
  const packageJson = join(root, "package.json");
  const skills = join(root, ".agents", "skills");
  mkdirSync(skills, { recursive: true });
  writeFileSync(packageJson, "{}\n", "utf8");

  try {
    assert.equal(resolveMaestroPackageSkillPath(packageJson), skills);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("returns undefined when the associated package has no Pi skills", () => {
  const root = join(tmpdir(), `pi-maestro-package-empty-${process.pid}-${Date.now()}`);
  const packageJson = join(root, "package.json");
  mkdirSync(root, { recursive: true });
  writeFileSync(packageJson, "{}\n", "utf8");

  try {
    assert.equal(resolveMaestroPackageSkillPath(packageJson), undefined);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
