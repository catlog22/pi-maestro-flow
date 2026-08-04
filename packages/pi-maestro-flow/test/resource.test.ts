import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after, before } from "node:test";

const { createResourceTool, parseResourceUri, parseGhTarget, resolveResource } = await import("../src/tools/resource.ts");
const { persistAgentOutput } = await import("../src/teammate/agent-output-store.ts");

const theme = {
	fg: (_name: string, text: string) => text,
	bold: (text: string) => text,
};

function lines(component: { render(width: number): string[] }): string[] {
	return component.render(200).map((line) => line.trimEnd());
}

let root: string;
let previousCwd: string;

before(async () => {
  root = await mkdtemp(join(tmpdir(), "pi-resource-"));
  previousCwd = process.cwd();
  await mkdir(join(root, ".pi", "skills", "demo-skill"), { recursive: true });
  await writeFile(join(root, ".pi", "skills", "demo-skill", "SKILL.md"), "# Demo Skill\n\nBody of the demo skill.\n", "utf-8");
  await writeFile(join(root, "AGENTS.md"), "# Project Agents\n\nWorktree conventions.\n", "utf-8");
  await writeFile(join(root, "RULES.md"), "# Rules\n\nNever touch the lockfile.\n", "utf-8");
  process.chdir(root);
});

after(async () => {
  process.chdir(previousCwd);
  await rm(root, { recursive: true, force: true });
});

test("parseResourceUri splits scheme and segments", () => {
  assert.deepEqual(parseResourceUri("pr://owner/repo/123"), { scheme: "pr", segments: ["owner", "repo", "123"] });
  assert.deepEqual(parseResourceUri("pr://owner/repo/123/diff"), { scheme: "pr", segments: ["owner", "repo", "123", "diff"] });
  assert.deepEqual(parseResourceUri("issue://123"), { scheme: "issue", segments: ["123"] });
  assert.deepEqual(parseResourceUri("skill://my-tool"), { scheme: "skill", segments: ["my-tool"] });
  assert.equal(parseResourceUri("not a uri"), null);
  assert.equal(parseResourceUri("relative/path"), null);
});

test("parseGhTarget handles owner/repo and bare number forms", () => {
  assert.deepEqual(parseGhTarget(["owner", "repo", "123"]), { target: { owner: "owner", repo: "repo", number: "123" }, sub: "" });
  assert.deepEqual(parseGhTarget(["owner", "repo", "123", "diff"]), { target: { owner: "owner", repo: "repo", number: "123" }, sub: "diff" });
  assert.deepEqual(parseGhTarget(["owner", "repo", "123", "files"]), { target: { owner: "owner", repo: "repo", number: "123" }, sub: "files" });
  assert.deepEqual(parseGhTarget(["123"]), { target: { owner: "", repo: "", number: "123" }, sub: "" });
  assert.equal(parseGhTarget(["owner", "repo", "abc"]), null);
  assert.equal(parseGhTarget([]), null);
  assert.equal(parseGhTarget(["owner", "repo"]), null);
  assert.equal(parseGhTarget(["owner", "123"]), null, "two-segment owner/N form is ambiguous and rejected");
  assert.equal(parseGhTarget(["owner", "repo", "123", "unknown"]), null, "unknown pr sub-path is rejected");
  assert.equal(parseGhTarget(["owner", "repo", "123", "diff", "extra"]), null);
});

test("resolveResource reads skill:// from the project .pi/skills directory", async () => {
  const result = await resolveResource("skill://demo-skill", root);
  assert.equal(result.cached, false);
  assert.match(result.content, /# Skill: demo-skill/);
  assert.match(result.content, /Body of the demo skill/);
});

test("resolveResource skill:// with unknown name lists available skills", async () => {
  await assert.rejects(
    () => resolveResource("skill://nope", root),
    (err: unknown) => err instanceof Error && err.message.includes("demo-skill") && err.message.includes("not found"),
  );
});

test("resolveResource reads rule://agents and rule://rules aliases", async () => {
  const agents = await resolveResource("rule://agents", root);
  assert.match(agents.content, /Worktree conventions/);
  const rules = await resolveResource("rule://rules", root);
  assert.match(rules.content, /Never touch the lockfile/);
});

test("resolveResource rule:// with unknown name reports candidates", async () => {
  await assert.rejects(
    () => resolveResource("rule://missing-rule", root),
    (err: unknown) => err instanceof Error && err.message.includes("not found") && err.message.includes("AGENTS.md"),
  );
});

test("resource tool renders through a self shell (no host box) with compact quiet rows", () => {
	const tool = createResourceTool();
	assert.equal(tool.renderShell, "self");
	assert.ok(tool.renderCall);
	assert.ok(tool.renderResult);
});

test("resource quiet call row shows the uri and settles empty once complete", () => {
	const tool = createResourceTool();
	const renderCall = tool.renderCall as unknown as (
		args: { uri: string },
		theme: typeof theme,
		context?: { isPartial?: boolean; args: { uri: string } },
	) => { render(width: number): string[] };
	assert.deepEqual(lines(renderCall({ uri: "skill://demo-skill" }, theme, { isPartial: true, args: { uri: "skill://demo-skill" } })), [
		"  … resource skill://demo-skill",
	]);
	assert.deepEqual(lines(renderCall({ uri: "skill://demo-skill" }, theme, { isPartial: false, args: { uri: "skill://demo-skill" } })), []);
});

test("resource quiet result row marks success and failure", () => {
	const tool = createResourceTool();
	const renderResult = tool.renderResult as unknown as (
		result: { content: Array<{ type: "text"; text: string }>; details?: unknown; isError?: boolean },
		options: { expanded: boolean; isPartial: boolean },
		theme: typeof theme,
		context: { args: { uri: string } },
	) => { render(width: number): string[] };

	assert.deepEqual(lines(renderResult(
		{
			content: [{ type: "text", text: "# Skill: demo-skill\n\nBody." }],
			details: { uri: "skill://demo-skill", scheme: "skill", resource: "skill://demo-skill", cached: false, bytes: 30 },
			isError: false,
		},
		{ expanded: false, isPartial: false },
		theme,
		{ args: { uri: "skill://demo-skill" } },
	)), ["  ✓ resource skill://demo-skill · skill://demo-skill"]);

	assert.deepEqual(lines(renderResult(
		{
			content: [{ type: "text", text: "boom" }],
			details: { uri: "skill://nope", scheme: "skill", resource: "skill://nope", cached: false, bytes: 4 },
			isError: true,
		},
		{ expanded: false, isPartial: false },
		theme,
		{ args: { uri: "skill://nope" } },
	)), ["  ✕ resource skill://nope · skill://nope"]);
});

test("resolveResource reads agent:// output by correlationId and json path", async () => {
  await persistAgentOutput(
    "run-agent-1",
    "reviewer",
    "analyst",
    { findings: [{ path: "src/a.ts", severity: "high" }], count: 1 },
    root,
  );

  const whole = await resolveResource("agent://run-agent-1", root);
  assert.match(whole.content, /\"findings\"/);

  const byName = await resolveResource("agent://reviewer/findings/0/path", root);
  assert.equal(byName.content.trim(), "src/a.ts");

  const byPath = await resolveResource("agent://run-agent-1/findings/0/severity", root);
  assert.equal(byPath.content.trim(), "high");
});

test("resolveResource agent:// path miss reports a precise reason and a usage tip", async () => {
  await persistAgentOutput("run-agent-2", "scanner", "explorer", { findings: [{ path: "a.ts" }] }, root);
  await assert.rejects(
    () => resolveResource("agent://run-agent-2/findings/9/path", root),
    (err: unknown) => err instanceof Error && err.message.includes("path miss") && err.message.includes("out of bounds"),
  );
  await assert.rejects(
    () => resolveResource("agent://run-agent-2/json", root),
    (err: unknown) => err instanceof Error
      && err.message.includes("key \"json\" not found")
      && err.message.includes("Tip: agent://run-agent-2 (no path) returns the whole output"),
  );
});

test("resolveResource rejects skill/rule name traversal", async () => {
  await assert.rejects(
    () => resolveResource("skill://../escape", root),
    (err: unknown) => err instanceof Error && err.message.includes("Invalid skill:// name"),
  );
  await assert.rejects(
    () => resolveResource("skill://a/../../escape", root),
    (err: unknown) => err instanceof Error && err.message.includes("Invalid skill:// name"),
  );
  await assert.rejects(
    () => resolveResource("rule://../../package.json", root),
    (err: unknown) => err instanceof Error && err.message.includes("Invalid rule:// name"),
  );
});

test("resolveResource rejects reserved and unsupported schemes", async () => {
  await assert.rejects(
    () => resolveResource("memory://xyz", root),
    (err: unknown) => err instanceof Error && err.message.includes("reserved"),
  );
  await assert.rejects(
    () => resolveResource("agent://ghost", root),
    (err: unknown) => err instanceof Error && err.message.includes("No persisted teammate output"),
  );
  await assert.rejects(
    () => resolveResource("ftp://example.com/x", root),
    (err: unknown) => err instanceof Error && err.message.includes("Unsupported scheme"),
  );
  await assert.rejects(
    () => resolveResource("plain text", root),
    (err: unknown) => err instanceof Error && err.message.includes("Unsupported URI format"),
  );
});
