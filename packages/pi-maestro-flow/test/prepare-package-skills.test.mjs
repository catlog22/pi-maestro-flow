import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  cleanPackagedSkills,
  preparePackagedSkills,
} from "../scripts/prepare-package-skills.mjs";

test("package skill preparation copies canonical skills and removes generated output", () => {
  const root = join(tmpdir(), `pi-maestro-pack-skills-${process.pid}-${Date.now()}`);
  const sourceDir = join(root, "source");
  const targetDir = join(root, "package", ".pi", "skills");
  const skillPath = join(sourceDir, "workflow-skill-designer", "SKILL.md");
  mkdirSync(join(sourceDir, "workflow-skill-designer"), { recursive: true });
  writeFileSync(skillPath, "# Workflow skills\n", "utf8");

  try {
    preparePackagedSkills({ sourceDir, targetDir });
    assert.equal(readFileSync(join(targetDir, "workflow-skill-designer", "SKILL.md"), "utf8"), "# Workflow skills\n");
    cleanPackagedSkills({ targetDir });
    assert.equal(existsSync(targetDir), false);
  } finally {
    cleanPackagedSkills({ targetDir });
    cleanPackagedSkills({ targetDir: root });
  }
});
