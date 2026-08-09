import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  configureTeammateAgentsDiscovery,
  loadBundledAgentsInstructions,
  resolveBundledAgentsPath,
  resolvePackageOrWorkspaceResource,
} from "../src/resources/maestro-package.ts";

test("package resources prefer the installed npm package and configure teammate agents", () => {
  const root = join(tmpdir(), `pi-maestro-package-resources-${process.pid}-${Date.now()}`);
  const packageJson = join(root, "package.json");
  const agentsDir = join(root, ".pi", "agents");
  mkdirSync(agentsDir, { recursive: true });
  writeFileSync(packageJson, JSON.stringify({ name: "pi-maestro-flow" }));

  try {
    assert.equal(resolvePackageOrWorkspaceResource([".pi", "agents"], packageJson), agentsDir);
    const env: NodeJS.ProcessEnv = {};
    assert.equal(configureTeammateAgentsDiscovery(packageJson, env), agentsDir);
    assert.equal(env.PI_TEAMMATE_PACKAGE_AGENTS_DIR, agentsDir);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("package resources fall back to the workspace only for local development", () => {
  const root = join(tmpdir(), `pi-maestro-workspace-resources-${process.pid}-${Date.now()}`);
  const packageRoot = join(root, "packages", "pi-maestro-flow");
  const packageJson = join(packageRoot, "package.json");
  const agentsDir = join(root, ".pi", "agents");
  mkdirSync(packageRoot, { recursive: true });
  mkdirSync(agentsDir, { recursive: true });
  writeFileSync(join(root, "package.json"), JSON.stringify({ workspaces: ["packages/*"] }));
  writeFileSync(packageJson, JSON.stringify({ name: "pi-maestro-flow" }));

  try {
    assert.equal(resolvePackageOrWorkspaceResource([".pi", "agents"], packageJson), agentsDir);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

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

test("prefers .pi/SYSTEM.md over AGENTS.md when both exist", () => {
  const root = join(tmpdir(), `pi-maestro-system-md-${process.pid}-${Date.now()}`);
  const packageJson = join(root, "package.json");
  const piDir = join(root, ".pi");
  const systemMd = join(piDir, "SYSTEM.md");
  const agents = join(root, "AGENTS.md");
  mkdirSync(piDir, { recursive: true });
  writeFileSync(packageJson, "{}\n", "utf8");
  writeFileSync(systemMd, "# Custom system prompt\n", "utf8");
  writeFileSync(agents, "# Legacy agents\n", "utf8");

  try {
    assert.equal(resolveBundledAgentsPath(packageJson), systemMd);
    assert.equal(loadBundledAgentsInstructions(systemMd), "# Custom system prompt");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("resolves .pi/SYSTEM.md when AGENTS.md is absent", () => {
  const root = join(tmpdir(), `pi-maestro-system-only-${process.pid}-${Date.now()}`);
  const packageJson = join(root, "package.json");
  const piDir = join(root, ".pi");
  const systemMd = join(piDir, "SYSTEM.md");
  mkdirSync(piDir, { recursive: true });
  writeFileSync(packageJson, "{}\n", "utf8");
  writeFileSync(systemMd, "# System prompt only\n", "utf8");

  try {
    assert.equal(resolveBundledAgentsPath(packageJson), systemMd);
    assert.equal(loadBundledAgentsInstructions(systemMd), "# System prompt only");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
