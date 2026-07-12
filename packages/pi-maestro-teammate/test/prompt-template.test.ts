import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
  buildTeammateToolDescription,
  notifyBackgroundFailure,
} from "../src/extension/index.ts";
import {
  discoverPromptTemplates,
  resolvePromptTask,
  substitutePromptArgs,
} from "../src/prompts/prompts.ts";
import { normalizeChainToTasks } from "../src/runs/execution.ts";

const DETAILED_PROMPT_NAMES = [
  "analysis-trace-code-execution",
  "analysis-diagnose-bug-root-cause",
  "analysis-analyze-code-patterns",
  "analysis-analyze-technical-document",
  "analysis-review-architecture",
  "analysis-review-code-quality",
  "analysis-analyze-performance",
  "analysis-assess-security-risks",
  "planning-plan-architecture-design",
  "planning-breakdown-task-steps",
  "planning-design-component-spec",
  "planning-plan-migration-strategy",
  "development-implement-feature",
  "development-refactor-codebase",
  "development-generate-tests",
  "development-implement-component-ui",
  "development-debug-runtime-issues",
] as const;

test("prompt substitution matches Pi positional argument semantics", () => {
  const rendered = substitutePromptArgs(
    "$1|$2|$@|$ARGUMENTS|${3:-fallback}|${@:2}|${@:2:2}",
    ["goal", "scope", "expected", "extra"],
  );
  assert.equal(rendered, "goal|scope|goal scope expected extra|goal scope expected extra|expected|scope expected extra|scope expected");
});

test("project prompts override bundled prompts and task is the first argument", () => {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), "pi-teammate-prompt-"));
  const promptsDir = path.join(project, ".pi", "prompts");
  fs.mkdirSync(promptsDir, { recursive: true });
  fs.writeFileSync(path.join(promptsDir, "analysis.md"), `---
description: Project analysis prompt
argument-hint: "<goal> [scope]"
---
PURPOSE: $1
CONTEXT: $2
EXPECTED: $3
`);

  try {
    const prompts = discoverPromptTemplates(project);
    const analysis = prompts.find((prompt) => prompt.name === "analysis");
    assert.equal(analysis?.source, "project");

    const resolved = resolvePromptTask(project, "/analysis", "Inspect auth", ["@src/auth", "file:line proof"]);
    assert.equal(resolved.error, undefined);
    assert.match(resolved.task ?? "", /PURPOSE: Inspect auth/);
    assert.match(resolved.task ?? "", /CONTEXT: @src\/auth/);
    assert.match(resolved.task ?? "", /EXPECTED: file:line proof/);
  } finally {
    fs.rmSync(project, { recursive: true, force: true });
  }
});

test("bundled prompts are listed in teammate tool metadata", () => {
  const description = buildTeammateToolDescription(process.cwd());
  assert.match(description, /Available teammate prompts/);
  assert.match(description, /analysis .*\[builtin\]/);
  assert.match(description, /review .*\[builtin\]/);
  assert.match(description, /write .*\[builtin\]/);

  const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const pkg = JSON.parse(fs.readFileSync(path.join(packageRoot, "package.json"), "utf8"));
  assert.ok(pkg.files.includes("prompts/"));

  const bundled = discoverPromptTemplates(process.cwd()).filter((prompt) => prompt.source === "builtin");
  const bundledNames = new Set(bundled.map((prompt) => prompt.name));
  for (const name of DETAILED_PROMPT_NAMES) {
    assert.equal(bundledNames.has(name), true, `${name} should be discoverable as a bundled prompt`);
    assert.match(description, new RegExp(`${name} .*\\[builtin\\]`));
    assert.equal(fs.existsSync(path.join(packageRoot, "prompts", `${name}.md`)), true);
  }
});

test("detailed Analysis, Planning, and Development prompts expand invocation arguments", () => {
  const cases = [
    "analysis-trace-code-execution",
    "planning-plan-architecture-design",
    "development-implement-feature",
  ];

  for (const name of cases) {
    const resolved = resolvePromptTask(process.cwd(), name, "Primary objective", ["@src/**/*.ts", "focused proof"]);
    assert.equal(resolved.error, undefined);
    assert.match(resolved.task ?? "", /Primary task:\s+Primary objective/);
    assert.match(resolved.task ?? "", /Additional context and arguments:\s+@src\/\*\*\/\*\.ts focused proof/);
    assert.equal(resolved.template?.source, "builtin");
  }
});

test("missing prompt templates fail explicitly", () => {
  const resolved = resolvePromptTask(process.cwd(), "does-not-exist", "task", []);
  assert.match(resolved.error ?? "", /was not found/);
});

test("legacy chain normalization preserves prompt selection and arguments", () => {
  const tasks = normalizeChainToTasks([
    { agent: "delegate", prompt: "analysis", promptArgs: ["@src"] },
    { agent: "reviewer", task: "Review {previous}", prompt: "review", promptArgs: ["strict"] },
  ], "Inspect auth");
  assert.equal(tasks[0].prompt, "analysis");
  assert.deepEqual(tasks[0].promptArgs, ["@src"]);
  assert.equal(tasks[1].prompt, "review");
  assert.deepEqual(tasks[1].promptArgs, ["strict"]);
});

test("background promise failures emit completion and trigger a turn", () => {
  const emitted: unknown[] = [];
  const sent: Array<{ message: Record<string, unknown>; options: Record<string, unknown> }> = [];
  const pi = {
    events: { emit: (...args: unknown[]) => emitted.push(args) },
    sendMessage: (message: Record<string, unknown>, options: Record<string, unknown>) => sent.push({ message, options }),
  };

  notifyBackgroundFailure(pi as never, "tool-id", "delegate", "cid", new Error("boom"));
  assert.equal(emitted.length, 1);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].message.customType, "teammate-complete");
  assert.match(String(sent[0].message.content), /boom/);
  assert.equal(sent[0].options.triggerTurn, true);
});
