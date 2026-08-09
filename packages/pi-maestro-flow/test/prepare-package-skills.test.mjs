import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  cleanPackagedOptionalSkills,
  cleanPackagedSkills,
  preparePackagedOptionalSkills,
  preparePackagedSkills,
} from "../scripts/prepare-package-skills.mjs";

test("package preparation copies optional skills into the package root", () => {
  const root = join(tmpdir(), `pi-maestro-pack-optional-${process.pid}-${Date.now()}`);
  const sourceDir = join(root, "source", "optional");
  const targetDir = join(root, "package", "optional");
  const skillPath = join(sourceDir, "skills", "scholar-writing", "SKILL.md");
  mkdirSync(join(sourceDir, "skills", "scholar-writing"), { recursive: true });
  writeFileSync(skillPath, "# Optional skill\n", "utf8");

  try {
    preparePackagedOptionalSkills({ sourceDir, targetDir });
    assert.equal(
      readFileSync(join(targetDir, "skills", "scholar-writing", "SKILL.md"), "utf8"),
      "# Optional skill\n",
    );
    cleanPackagedOptionalSkills({ targetDir });
    assert.equal(existsSync(targetDir), false);
  } finally {
    cleanPackagedOptionalSkills({ targetDir });
    cleanPackagedSkills({ targetDir: root });
  }
});

test("package skill preparation copies canonical skills and removes generated output", () => {
  const root = join(tmpdir(), `pi-maestro-pack-skills-${process.pid}-${Date.now()}`);
  const sourceDir = join(root, "source");
  const targetDir = join(root, "package", ".pi", "skills");
  const skillPath = join(sourceDir, "workflow-skill-designer", "SKILL.md");
  const teamSwarmPath = join(sourceDir, "team-swarm", "SKILL.md");
  mkdirSync(join(sourceDir, "workflow-skill-designer"), { recursive: true });
  mkdirSync(join(sourceDir, "team-swarm"), { recursive: true });
  mkdirSync(join(sourceDir, "scratch"), { recursive: true });
  writeFileSync(skillPath, "# Workflow skills\n", "utf8");
  writeFileSync(teamSwarmPath, "# Team Swarm\n", "utf8");
  writeFileSync(join(sourceDir, "SYSTEM.md"), "# System\n", "utf8");
  writeFileSync(join(sourceDir, "settings.local.json"), "{}\n", "utf8");
  writeFileSync(join(sourceDir, "model-failover.json"), "{}\n", "utf8");
  writeFileSync(join(sourceDir, "scratch", "dbg.log"), "log\n", "utf8");

  try {
    preparePackagedSkills({ sourceDir, targetDir });
    assert.equal(readFileSync(join(targetDir, "workflow-skill-designer", "SKILL.md"), "utf8"), "# Workflow skills\n");
    assert.equal(readFileSync(join(targetDir, "team-swarm", "SKILL.md"), "utf8"), "# Team Swarm\n");
    assert.equal(readFileSync(join(targetDir, "SYSTEM.md"), "utf8"), "# System\n");
    assert.equal(existsSync(join(targetDir, "settings.local.json")), false, "settings.local.json is local-only");
    assert.equal(existsSync(join(targetDir, "model-failover.json")), false, "model-failover.json is local-only");
    assert.equal(existsSync(join(targetDir, "scratch")), false, "scratch is local-only");
    cleanPackagedSkills({ targetDir });
    assert.equal(existsSync(targetDir), false);
  } finally {
    cleanPackagedSkills({ targetDir });
    cleanPackagedSkills({ targetDir: root });
  }
});
