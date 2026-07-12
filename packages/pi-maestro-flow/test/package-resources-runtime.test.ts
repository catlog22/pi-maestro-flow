import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  loadBundledAgentsInstructions,
  resolveBundledAgentsPath,
} from "../src/resources/maestro-package.ts";

test("resolves and loads the bundled Pi AGENTS.md", () => {
  const root = join(tmpdir(), `pi-maestro-agents-${process.pid}-${Date.now()}`);
  const packageJson = join(root, "package.json");
  const agents = join(root, "AGENTS.md");
  mkdirSync(root, { recursive: true });
  writeFileSync(packageJson, "{}\n", "utf8");
  writeFileSync(agents, "# Pi instructions\n\nUse teammate.\n", "utf8");

  try {
    assert.equal(resolveBundledAgentsPath(packageJson), agents);
    assert.equal(loadBundledAgentsInstructions(agents), "# Pi instructions\n\nUse teammate.");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
