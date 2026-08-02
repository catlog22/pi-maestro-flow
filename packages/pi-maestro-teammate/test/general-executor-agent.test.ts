import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { resolveAgent } from "../src/agents/agents.ts";
import { parseFrontmatter } from "../src/agents/frontmatter.ts";
import { findStructuredOutputSchemaHazard } from "../src/runs/execution-infra.ts";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

test("general-executor agent definition exists in flow and .pi and stays mirrored", () => {
  const source = path.join(REPO_ROOT, "flow", "agents", "general-executor.md");
  const deployed = path.join(REPO_ROOT, ".pi", "agents", "general-executor.md");
  assert.ok(fs.existsSync(source), "flow/agents/general-executor.md must exist");
  assert.ok(fs.existsSync(deployed), ".pi/agents/general-executor.md must exist");
  assert.equal(
    fs.readFileSync(source, "utf8"),
    fs.readFileSync(deployed, "utf8"),
    "flow/ and .pi/ copies must stay byte-identical",
  );

  const { frontmatter, body } = parseFrontmatter(fs.readFileSync(deployed, "utf8"));
  assert.equal(frontmatter.name, "general-executor");
  assert.ok(frontmatter.description && frontmatter.description.length > 0);
  assert.ok((frontmatter.tools ?? "").includes("Bash"), "a generic executor needs Bash");
  assert.ok(
    body.includes("general-executor-report.schema.json"),
    "agent body must reference its dedicated output schema",
  );
  assert.ok(body.includes("structured_output"), "agent body must document the structured_output path");
});

test("general-executor dedicated report schema is valid, complete, and dispatch-safe", () => {
  for (const dir of ["flow", ".pi"]) {
    const schemaPath = path.join(REPO_ROOT, dir, "agents", "general-executor-report.schema.json");
    assert.ok(fs.existsSync(schemaPath), `${dir}/agents/general-executor-report.schema.json must exist`);
    const schema = JSON.parse(fs.readFileSync(schemaPath, "utf8")) as Record<string, unknown>;
    assert.equal(schema.type, "object");
    assert.deepEqual(schema.required, ["status", "summary"]);
    const props = (schema.properties ?? {}) as Record<string, unknown>;
    assert.equal((props.status as { enum?: unknown[] }).enum?.length, 4);
    assert.ok(props.changes && props.verification && props.tests);
    assert.equal(
      findStructuredOutputSchemaHazard(schema),
      undefined,
      "schema must pass dispatch-time hazard checks (size/depth/regex)",
    );
  }
});

test("general-executor resolves as a project agent with an execution toolset", () => {
  const agent = resolveAgent(REPO_ROOT, "general-executor");
  assert.ok(agent, "general-executor must resolve via resolveAgent");
  assert.equal(agent.source, "project");
  assert.equal(agent.systemPromptMode, "replace");
  for (const tool of ["read", "write", "edit", "bash"]) {
    assert.ok(agent.tools?.includes(tool), `tool ${tool} must be granted`);
  }
});
