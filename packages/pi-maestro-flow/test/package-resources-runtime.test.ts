import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  configureTeammateAgentsDiscovery,
  loadBundledAgentsInstructions,
  registerMaestroPackageResources,
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

for (const relative of [".pi/SYSTEM.md", "AGENTS.md"]) {
  test(`injects an explicit instruction directory for ${relative}`, () => {
    const root = join(tmpdir(), `pi-maestro-instruction-directory-${process.pid}-${Date.now()}`);
    const packageJson = join(root, "package.json");
    const sourcePath = join(root, relative);
    const directory = dirname(sourcePath);
    const instructions = "# Instructions\n\nRead [Architecture](instructions/architecture.md).";
    mkdirSync(join(directory, "instructions"), { recursive: true });
    writeFileSync(packageJson, "{}\n", "utf8");
    writeFileSync(sourcePath, instructions, "utf8");
    writeFileSync(join(directory, "instructions", "architecture.md"), "# Deferred architecture content\n", "utf8");
    let beforeAgentStart: ((event: { systemPrompt: string }) => { systemPrompt: string }) | undefined;
    const pi = {
      on(event: string, handler: typeof beforeAgentStart) {
        assert.equal(event, "before_agent_start");
        beforeAgentStart = handler;
      },
    } as unknown as ExtensionAPI;

    try {
      registerMaestroPackageResources(pi, packageJson);
      assert.ok(beforeAgentStart);
      const { systemPrompt } = beforeAgentStart({ systemPrompt: "Existing system prompt" });
      assert.equal(systemPrompt, `Existing system prompt\n\n<project_instructions path="${sourcePath.replaceAll("\\", "/")}" directory="${directory.replaceAll("\\", "/")}">\n${instructions}\n</project_instructions>`);
      assert.notEqual(directory, process.cwd(), "package references must not use the consumer's cwd");
      assert.doesNotMatch(systemPrompt, /Deferred architecture content/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
}

test("canonical SYSTEM delegates knowledge closeout without granting implicit publication", () => {
  const sourcePath = fileURLToPath(new URL("../../../.pi/SYSTEM.md", import.meta.url));
  const instructions = loadBundledAgentsInstructions(sourcePath);
  assert.ok(instructions);
  assert.match(instructions, /Before capture.*load \[Knowledge instructions\]\(instructions\/knowledge\.md\)/);
  const reference = loadBundledAgentsInstructions(join(dirname(sourcePath), "instructions", "knowledge.md"));
  const knowledge = reference?.split("## Run Knowledge")[1];
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

test("canonical SYSTEM keeps specialized instructions discoverable without eager injection", () => {
  const sourcePath = fileURLToPath(new URL("../../../.pi/SYSTEM.md", import.meta.url));
  const instructions = loadBundledAgentsInstructions(sourcePath)!;
  assert.ok(Buffer.byteLength(instructions, "utf8") < 24_000, "routine instructions must not regain the full specialized workflows");
  assert.equal(instructions.match(/^# Project Knowledge Gate$/gm)?.length, 1);
  assert.match(instructions, /Read the matching reference before its first relevant operation; do not preload unrelated modules/);
  assert.match(instructions, /Paths are relative to this SYSTEM\.md/);
  assert.match(instructions, /never the current working directory/);
  assert.match(instructions, /<project_instructions directory="…">/);
  assert.match(instructions, /<project_instructions path="…">.*parent directory is the base/);
  assert.match(instructions, /Markdown links do not load it automatically/);
  assert.match(instructions, /Only a live human Plan-auto grant can bypass confirmation/);
  assert.match(instructions, /Plan mode is read-only/);
  assert.match(instructions, /do not create a gate|does not create a gate/);
  assert.match(instructions, /Goal\/Todo mechanics.*tool contracts/);
  assert.match(instructions, /teammate tool owns model selection\/precedence/);
  for (const name of ["plan", "review", "knowledge", "architecture"]) {
    const relative = `instructions/${name}.md`;
    const label = `${name[0].toUpperCase()}${name.slice(1)} instructions`;
    assert.ok(instructions.includes(`[${label}](${relative})`), `${name} must have a linked load trigger`);
    assert.equal(instructions.includes(`\`${relative}\``), false, `${name} references must use Markdown links`);
    const reference = loadBundledAgentsInstructions(join(dirname(sourcePath), relative));
    assert.ok(reference, `${name} must resolve alongside SYSTEM.md`);
    assert.equal(instructions.includes(reference), false, `${name} must not be eagerly embedded`);
  }
  assert.doesNotMatch(instructions, /--transcript-quote|maestro arch-kb show|plan-enter` -> research|Soft limit: when the same subsystem/);
  const plan = loadBundledAgentsInstructions(join(dirname(sourcePath), "instructions", "plan.md"))!;
  assert.match(plan, /Plan-auto defaults off and is host-memory-only/);
  assert.match(plan, /Machine ask `decisions`.*never human `answers` or approvals/);
  const review = loadBundledAgentsInstructions(join(dirname(sourcePath), "instructions", "review.md"))!;
  assert.match(review, /same subsystem reaches 2 correction gates/);
  assert.match(review, /reaches 3 review rounds without convergence/);
  const knowledge = loadBundledAgentsInstructions(join(dirname(sourcePath), "instructions", "knowledge.md"))!;
  assert.match(knowledge, /untrusted snapshot evidence only/);
  assert.match(knowledge, /Never bypass the gate by editing evidence refs/);
});

test("canonical SYSTEM requires post-change review and governed low-hit knowledge follow-up", () => {
  const sourcePath = fileURLToPath(new URL("../../../.pi/SYSTEM.md", import.meta.url));
  const instructions = loadBundledAgentsInstructions(sourcePath);
  assert.ok(instructions);
  assert.match(instructions, /after every bug fix or feature implementation.*review the original design and change rationale, trace root causes, search for similar issues/);
  assert.match(instructions, /present findings and proposed actions for the user to decide/);
  assert.match(instructions, /knowledgeCaptureHint.*fewer than 3, respecting `--limit`.*gap signal, not a measured relevance\/hit rate/);
  assert.match(instructions, /empty, sparse, or largely irrelevant.*refine the 1-3 keyword query and resolve index\/recovery hints/);
  assert.match(instructions, /after completing the related task.*validated, reusable findings.*maestro knowledge stage.*\[Knowledge instructions\]\(instructions\/knowledge\.md\).*evidence and the exact Run\/Session identity/);
  assert.match(instructions, /Review before promotion; never direct-write or auto-promote knowledge/);
  assert.match(instructions, /never manufacture candidates just to improve search coverage\. Zero candidates remains valid/);
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
