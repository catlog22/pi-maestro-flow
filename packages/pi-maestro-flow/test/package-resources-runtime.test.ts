import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
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

test("canonical SYSTEM delegates knowledge closeout without granting implicit publication", () => {
  const sourcePath = fileURLToPath(new URL("../../../.pi/SYSTEM.md", import.meta.url));
  const instructions = loadBundledAgentsInstructions(sourcePath);
  assert.ok(instructions);
  const knowledge = instructions.split("## Run Knowledge")[1]?.split("# Execution Order")[0];
  assert.ok(knowledge);
  assert.match(knowledge, /Read @~\/\.maestro\/ref\/knowledge-closeout\.md explicitly before closeout/);
  assert.match(knowledge, /completion owner/);
  assert.match(knowledge, /workers return candidate IDs\/warnings without repeating approval questions/);
  assert.match(knowledge, /ask-user-question.*matching prior explicit authorization/);
  assert.match(knowledge, /are not publication approval/);
  assert.match(knowledge, /Read execution results and re-read review/);
  assert.match(knowledge, /Only repair missing\/stale receipts/);
  assert.match(knowledge, /fresh session receipt.*not Session completion/);
  assert.match(knowledge, /do not block otherwise valid completion/);
  assert.doesNotMatch(knowledge, /-y.*auto-adjudication is allowed|sealed Session \+ fresh session receipt/);
});

test("canonical SYSTEM keeps delivery gates justified and correction budgets cumulative", () => {
  const sourcePath = fileURLToPath(new URL("../../../.pi/SYSTEM.md", import.meta.url));
  const instructions = loadBundledAgentsInstructions(sourcePath);
  assert.ok(instructions);
  assert.match(instructions, /user-required outcomes and human-locked safety\/compatibility constraints from agent-selected implementation means/);
  assert.match(instructions, /risk enumeration alone does not create a gate/);
  assert.match(instructions, /Measure progress by user-visible acceptance evidence/);
  assert.match(instructions, /across task names, workers, approaches, and context resets/);
  assert.match(instructions, /A fresh investigation.*does not reset this budget/);
  assert.match(instructions, /Changes to approved scope, explicit locked decisions, or safety boundaries require renewed approval/);
  assert.match(instructions, /In Monitor mode.*reuse an existing execution worker or ask the user to exit Monitor/);
});

test("planner role mirrors distinguish locked requirements from revisable implementation means", () => {
  const project = loadBundledAgentsInstructions(fileURLToPath(new URL("../../../.pi/agents/planner.md", import.meta.url)));
  const bundled = loadBundledAgentsInstructions(fileURLToPath(new URL("../../pi-maestro-teammate/agents/planner.md", import.meta.url)));
  assert.ok(project);
  assert.equal(project, bundled);
  assert.match(project, /select the smallest end-to-end path using existing authorities/);
  assert.match(project, /without treating those means as immutable human requirements/);
  assert.match(project, /justify each blocking dependency with its requirement or confirmed defect/);
  assert.match(project, /first end-to-end acceptance milestone, cumulative correction budget/);
  assert.match(project, /Risks are not automatically acceptance gates/);
  assert.match(project, /across workers, task names, approaches, and resets/);
  assert.match(project, /after three unsuccessful attempts, stop the correction chain/);
  assert.match(project, /require renewed approval, never silent gate removal/);
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
