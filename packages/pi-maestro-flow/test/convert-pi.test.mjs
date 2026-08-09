import assert from "node:assert/strict";
import test from "node:test";
import { transformPiContent } from "../../../convert-pi.mjs";

const cases = [
  {
    name: "keeps tool remapping inside frontmatter and preserves fenced examples",
    file: "D:/fixture/skills/example/SKILL.md",
    input: `---
allowed-tools: Read Agent AskUserQuestion
---

AskUserQuestion is used for a required answer.

\`\`\`yaml
allowed-tools: Agent AskUserQuestion
\`\`\`
`,
    verify(output) {
      assert.match(output, /^allowed-tools: Read teammate observe maestro$/m);
      assert.match(output, /<teammate_contract>/);
      assert.match(output, /observe.*action: "wait"/);
      assert.match(output, /user prompt is used/);
      assert.match(output, /```yaml\nallowed-tools: Agent AskUserQuestion\n```/);
    },
  },
  {
    name: "adds an explicit default session mode to skill frontmatter",
    file: "D:/fixture/skills/example/SKILL.md",
    input: `---
name: example
description: Example skill
---

# Example
`,
    verify(output) {
      assert.match(output, /^session-mode: none$/m);
      assert.equal(output.match(/^session-mode:/gm)?.length, 1);
    },
  },
  {
    name: "rewrites the core coordinator toward simple chains and run edit",
    file: "D:/fixture/skills/maestro/SKILL.md",
    input: `<purpose>Coordinator</purpose>
5. required missing 依次尝试 known args、default、LLM 明确推断、AskUserQuestion；仍 missing 则 BLOCK。
- \`ReuseAssessment=fresh\`：通过 \`maestro session create ... --engine ralph --chain-file -\` 创建 Session。
`,
    verify(output) {
      assert.match(output, /maestro run start/);
      assert.match(output, /maestro run edit/);
      assert.match(output, /简单链使用/);
      assert.match(output, /高级链/);
    },
  },
  {
    name: "rewrites maestro-next legacy lifecycle examples",
    file: "D:/fixture/skills/maestro-next/SKILL.md",
    input: `1. \`maestro run prepare --platform pi <step> --workflow-root .\`。
2. 使用已解析的 \`argument_requirements\` 创建当前 step 的 Run；不得用路径扫描补 upstream。
3. 按 create result 的 \`brief.command\` 加载完整执行指南。
4. 执行 workflow，写正式 deliverables，运行 gates。
5. \`maestro run complete <run_id> --verdict done --workflow-root .\`。
`,
    verify(output) {
      assert.match(output, /maestro run start "<intent>" --cmd <step>/);
      assert.match(output, /maestro run done <run_id>/);
      assert.doesNotMatch(output, /maestro run prepare/);
      assert.doesNotMatch(output, /maestro run create/);
    },
  },
  {
    name: "rewrites current generated lifecycle leftovers",
    file: "D:/fixture/skills/maestro-next/SKILL.md",
    input: `- **Standard** (single run): recommend a step → confirm → execute via \`maestro run prepare\` + \`maestro run start\`
maestro run prepare   # check if prepare command works
`,
    verify(output) {
      assert.match(output, /maestro run start --platform pi --cmd/);
      assert.match(output, /maestro run status --workflow-root/);
      assert.doesNotMatch(output, /maestro run prepare/);
    },
  },
  {
    name: "rewrites the session-start compatibility alias",
    file: "D:/fixture/skills/maestro-odyssey/SKILL.md",
    input: "Compatibility: `maestro session start` is an alias for `maestro run create` (see companion.md). Both resolve the same lifecycle.",
    verify(output) {
      assert.equal(output, "Use `maestro run start --platform pi` as the only lifecycle entry; no compatibility alias is required.");
    },
  },
  {
    name: "binds Pi on every platform-aware Session and Run call",
    file: "D:/fixture/skills/example/SKILL.md",
    input: `maestro session create "topic" --id demo --chain analyze
maestro session start "topic" --chain analyze
maestro run start "goal" --cmd companion
maestro run create plan --session demo
maestro run prepare analyze --session demo
maestro run skill analyze
maestro run brief run-1 --session demo
maestro session next --session demo
maestro run check run-1 --session demo
`,
    verify(output) {
      assert.match(output, /maestro session create --platform pi "topic"/);
      assert.match(output, /maestro session start --platform pi "topic"/);
      assert.match(output, /maestro run start --platform pi "goal"/);
      assert.match(output, /maestro run create --platform pi plan/);
      assert.match(output, /maestro run prepare --platform pi analyze/);
      assert.match(output, /maestro run skill --platform pi analyze/);
      assert.match(output, /maestro run brief --platform pi run-1/);
      assert.match(output, /maestro session next --session demo/);
      assert.match(output, /maestro run check run-1 --session demo/);
      assert.doesNotMatch(output, /maestro session next --platform/);
      assert.doesNotMatch(output, /maestro run check --platform/);
    },
  },
  {
    name: "normalizes canonical placeholders and Claude bindings to Pi",
    file: "D:/fixture/skills/example/SKILL.md",
    input: `maestro skills --steps --json --platform {target_platform}
maestro session create "topic" --platform {target_platform} --chain analyze
maestro session start "topic" --platform claude --chain analyze
maestro run create plan --platform {target_platform} --session demo
maestro run brief run-1 --platform claude
`,
    verify(output) {
      assert.doesNotMatch(output, /\{target_platform\}/);
      assert.doesNotMatch(output, /--platform claude/);
      assert.equal(output.match(/--platform pi/g)?.length, 5);
    },
  },
  {
    name: "rewrites team coordinator creation and completion aliases",
    file: "D:/fixture/skills/team-review/roles/coordinator/role.md",
    input: `Otherwise: \`maestro run create team-review --session <slug> --intent "<task summary>"\`
maestro run complete <run_id>
`,
    verify(output) {
      assert.match(output, /maestro run start "<task summary>" --cmd team-review --session <slug>/);
      assert.match(output, /maestro run done <run_id>/);
      assert.doesNotMatch(output, /maestro run create/);
    },
  },
  {
    name: "converts JSON catalog text without frontmatter corruption",
    file: "D:/fixture/agents/catalog.json",
    input: '{"instruction":"Otherwise: `maestro run create execute --session <slug> --intent \\"<task summary>\\"`"}',
    verify(output) {
      assert.match(output, /maestro run start/);
      assert.doesNotMatch(output, /maestro run create/);
      assert.doesNotThrow(() => JSON.parse(output));
    },
  },
  {
    name: "injects the Pi host and read-only coordinator contracts into current core skills",
    file: "D:/fixture/skills/maestro/SKILL.md",
    input: `<required_reading>
~/.maestro/workflows/run-mode.md
</required_reading>
<purpose>Unified coordinator</purpose>
`,
    verify(output) {
      assert.match(output, /<host_mirror>/);
      assert.match(output, /Topic Session resolution/);
      assert.match(output, /ReuseAssessment/);
      assert.match(output, /same-Session sealed outputs/);
      assert.match(output, /brief\.command/);
      assert.match(output, /suggest_only=true/);
      assert.doesNotMatch(output, /maestro session create/);
    },
  },
  {
    name: "removes Claude-only todo activeForm fields",
    file: "D:/fixture/skills/example/SKILL.md",
    input: `todo({ action: "create", subject: "Phase 1", activeForm: "Running phase 1" })`,
    verify(output) {
      assert.equal(output, `todo({ action: "create", subject: "Phase 1" })`);
    },
  },
  {
    name: "rewrites multiline subagent calls into the current teammate contract",
    file: "D:/fixture/skills/example/SKILL.md",
    input: [
      "const result = await Agent({",
      "  subagent_type: 'universal-executor',",
      "  run_in_background: phaseConfig.background || false,",
      "  prompt: \\`",
      "[PHASE] \\${phaseId}",
      "\\`",
      "});",
    ].join("\r\n"),
    verify(output) {
      assert.match(output, /const result = await teammate\(\{ agent: "general"/);
      assert.match(output, /tasks: \[\{ prompt: \\`/);
      assert.match(output, /\[PHASE\] \\\${phaseId}/);
      assert.match(output, /background: phaseConfig\.background \|\| false/);
      assert.doesNotMatch(output, /subagent_type|run_in_background/);
    },
  },
  {
    name: "normalizes direct legacy teammate task fields",
    file: "D:/fixture/skills/example/SKILL.md",
    input: `teammate({ agent: "delegate", taskType: "analysis", task: "PURPOSE: inspect", prompt: "analysis-rule", name: "job-1" })`,
    verify(output) {
      assert.match(output, /agent: "general"/);
      assert.match(output, /tasks: \[\{ name: "job-1", prompt: "PURPOSE: inspect" \}\]/);
      assert.match(output, /\/\* --rule "analysis-rule" \*\//);
      assert.doesNotMatch(output, /agent: "delegate"|\btask: "/);
    },
  },
  {
    name: "injects a dynamic taskType placeholder into team-worker spawns without one",
    file: "D:/fixture/skills/example/SKILL.md",
    input: [
      "teammate({",
      "  subagent_type: 'team-worker',",
      "  name: 'ant-1-1',",
      "  prompt: \\`",
      "## Role Assignment",
      "role: ant",
      "\\`",
      "})",
    ].join("\n"),
    verify(output) {
      assert.match(output, /agent: "team-worker"/);
      assert.match(output, /tasks: \[\{ taskType: "<task_type>", name: 'ant-1-1'/);
      assert.match(output, /role: ant/);
    },
  },
  {
    name: "keeps an explicit taskType on team-worker spawns untouched",
    file: "D:/fixture/skills/example/SKILL.md",
    input: [
      "teammate({",
      "  subagent_type: 'team-worker',",
      "  taskType: 'explore',",
      "  name: 'ant-1-1',",
      "  prompt: \\`role: ant\\`",
      "})",
    ].join("\n"),
    verify(output) {
      assert.match(output, /agent: "team-worker"/);
      assert.match(output, /taskType: 'explore'/);
      assert.doesNotMatch(output, /<task_type>/);
    },
  },
  {
    name: "does not inject a taskType placeholder into general spawns",
    file: "D:/fixture/skills/example/SKILL.md",
    input: `teammate({ subagent_type: 'general-purpose', name: 'job', prompt: 'inspect' })`,
    verify(output) {
      assert.match(output, /agent: "general"/);
      assert.doesNotMatch(output, /taskType|<task_type>/);
    },
  },
  {
    name: "strips Bash wrappers around literal teammate calls",
    file: "D:/fixture/skills/example/SKILL.md",
    input: `Bash({ command: 'teammate({ agent: "delegate", taskType: "analysis", task: "inspect" })', background: true })`,
    verify(output) {
      assert.match(output, /^teammate\(\{ agent: "general"/);
      assert.match(output, /tasks: \[\{ prompt: "inspect" \}\]/);
      assert.match(output, /background: true/);
      assert.doesNotMatch(output, /Bash\(|agent: "delegate"|\btask: "/);
    },
  },
  {
    name: "rewrites legacy callback prose to teammate completion semantics",
    file: "D:/fixture/skills/example/SKILL.md",
    input: `teammate runs in background, wait for hook callback before proceeding
Worker callback -> handleCallback
SendMessage callback
On callback: consume result`,
    verify(output) {
      assert.match(output, /teammate-complete notification/);
      assert.match(output, /observe exactly once with action="wait"/);
      assert.doesNotMatch(output, /hook callback|SendMessage callback|Worker callback|On callback/);
    },
  },
];

for (const fixture of cases) {
  test(`convert-pi: ${fixture.name}`, () => {
    const output = transformPiContent(fixture.input, fixture.file);
    fixture.verify(output);
    assert.equal(
      transformPiContent(output, fixture.file),
      output,
      "conversion must be idempotent",
    );
  });
}

test("convert-pi: preserves every explicit session mode", () => {
  for (const mode of ["none", "brief", "run", "bootstrap"]) {
    const input = `---
name: example
session-mode: ${mode}
---

# Example
`;
    assert.equal(
      transformPiContent(input, "D:/fixture/skills/example/SKILL.md"),
      input,
    );
  }
});

test("convert-pi: does not duplicate generated blocks across CRLF input", () => {
  const file = "D:/fixture/skills/maestro/SKILL.md";
  const first = transformPiContent(
    `<required_reading>
~/.maestro/workflows/run-mode.md
</required_reading>
<purpose>Coordinator</purpose>
`,
    file,
  );
  const second = transformPiContent(first.replaceAll("\n", "\r\n"), file);
  assert.equal(second.match(/<host_mirror>/g)?.length, 1);
  assert.equal(second.match(/<pi_context_contract>/g)?.length, 1);
  assert.equal(second.match(/<cli_surface>/g)?.length, 1);
});
