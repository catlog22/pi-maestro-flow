import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { convertPiDirectory, transformPiContent } from "../../../convert-pi.mjs";

test("convert-pi: missing destination roots produce an empty conversion result", () => {
  const root = mkdtempSync(join(tmpdir(), "pi-convert-empty-"));
  try {
    assert.deepEqual(convertPiDirectory(join(root, "missing")), {
      processed: 0,
      modified: 0,
      errors: [],
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

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
    name: "preserves the canonical receipt-chained coordinator source",
    file: "D:/fixture/skills/maestro/SKILL.md",
    input: `---
name: maestro
allowed-tools: Read Bash Agent
---
<required_reading>
~/.maestro/workflows/run-mode.md
</required_reading>
<purpose>Coordinator</purpose>
\`\`\`bash
maestro session open "<intent>" --id <slug> --participant {actor_id} --actor {actor_id} --request-id {open_request_id} --reason "open Session" --json
maestro session chain insert --session {session_id} --step-id {step_id} --command analyze --arg "<intent>" --participant {actor_id} --actor {actor_id} --request-id {insert_request_id} --reason "add step" --expected-orchestration-revision {open_revision} --json
maestro session chain update --session {session_id} --step-id {step_id} --stage analysis --arg "<scope>" --participant {actor_id} --actor {actor_id} --request-id {update_request_id} --reason "update step" --expected-orchestration-revision {insert_revision} --json
maestro run next --session {session_id} --participant {actor_id} --actor {actor_id} --request-id {next_request_id} --reason "dispatch step" --expected-orchestration-revision {update_revision} --json
\`\`\`
`,
    verify(output) {
      assert.match(output, /^allowed-tools: Read Bash teammate observe maestro run-control$/m);
      assert.match(output, /<pi_run_control>/);
      assert.match(output, /Never execute lifecycle mutation through Bash/);
      assert.match(output, /maestro session open "<intent>"/);
      assert.match(output, /session chain insert[^\n]*--arg "<intent>"/);
      assert.match(output, /session chain update[^\n]*--arg "<scope>"/);
      assert.match(output, /maestro run next --session/);
      assert.match(output, /--participant \{actor_id\} --actor \{actor_id\}/);
      assert.doesNotMatch(output, /maestro run start|maestro run edit|maestro run prepare|session open[^\n]*--chain-file/);
    },
  },
  {
    name: "stabilizes the Pi maestro dry-run interface across source drift",
    file: "D:/fixture/skills/maestro/SKILL.md",
    input: `---
name: maestro
description: "Coordinator Arguments: <intent> [-y] [-c] [--amend]"
---
<interface>
- \`--amend\` — amend that Session's goal; remaining text is the change request.
</interface>
<transitions>
S_PARSE:
  → S_AMEND WHEN: \`--amend\`
</transitions>
<actions>
</actions>
<success_criteria>
- Public flags are \`-y\`, \`-c\`, \`--amend\`.
</success_criteria>
`,
    verify(output) {
      assert.match(output, /Arguments: <intent> \[-y\] \[-c\] \[--amend\] \[--dry-run\]/);
      assert.match(output, /A_DRY_RUN/);
      assert.match(output, /Do not call any Session\/Run mutation command/);
      assert.match(output, /performs no Session\/Run mutation or executor dispatch/);
    },
  },
  {
    name: "keeps v3 run next / run complete lifecycle examples intact",
    file: "D:/fixture/skills/maestro-next/SKILL.md",
    input: `1. \`maestro run next --session {session_id} --participant {p} --actor {a} --request-id {r} --reason "<reason>" --expected-orchestration-revision {rev} --workflow-root .\`。
2. 使用已解析的 \`argument_requirements\` 创建当前 step 的 Run；不得用路径扫描补 upstream。
3. 按 birth packet 的 \`brief.command\` 加载完整执行指南。
4. 执行 workflow，写正式 deliverables，运行 gates。
5. \`maestro run complete <run_id> --session {session_id} --verdict done --advance --expected-run-revision {run_rev} --expected-orchestration-revision {rev} --workflow-root .\`。
`,
    verify(output) {
      assert.match(output, /maestro run next --session/);
      assert.match(output, /maestro run complete <run_id> --session/);
      assert.doesNotMatch(output, /maestro run prepare/);
      assert.doesNotMatch(output, /maestro run done/);
    },
  },
  {
    name: "preserves corrected maestro-next lifecycle text without synthesizing a dispatcher",
    file: "D:/fixture/skills/maestro-next/SKILL.md",
    input: `---
name: maestro-next
allowed-tools: Read Bash
---
<required_reading>
~/.maestro/workflows/run-mode.md
</required_reading>
<purpose>Router</purpose>
maestro session open "goal" --id demo --participant actor-1 --actor actor-1 --request-id req-open --reason "open" --json
maestro session chain insert --session demo --step-id companion --command companion --arg "goal" --participant actor-1 --actor actor-1 --request-id req-insert --reason "insert" --expected-orchestration-revision 0 --json
maestro run next --session demo --participant actor-1 --actor actor-1 --request-id req-next --reason "next" --expected-orchestration-revision 1 --json
`,
    verify(output) {
      assert.match(output, /^allowed-tools: Read Bash maestro run-control$/m);
      assert.match(output, /maestro session open "goal"/);
      assert.match(output, /session chain insert[^\n]*--arg "goal"/);
      assert.match(output, /maestro run next --session demo/);
      assert.doesNotMatch(output, /maestro run prepare|maestro run start|maestro run edit/);
    },
  },
  {
    name: "keeps v3 run create invocations intact",
    file: "D:/fixture/skills/maestro-fork/SKILL.md",
    input: 'step `analyze` (`maestro run create analyze "{goal}" --session YYYYMMDD-analyze-{topic} --goal "{goal}"`)',
    verify(output) {
      assert.match(output, /maestro run create analyze "\{goal\}" --session YYYYMMDD-analyze-\{topic\} --goal "\{goal\}"/);
      assert.doesNotMatch(output, /maestro run prepare|maestro run start/);
    },
  },
  {
    name: "does not synthesize prepare assets in v3",
    file: "D:/fixture/skills/maestro/SKILL.md",
    input: 'Fetch execution guidance via the birth packet `brief.command` before executing a step.',
    verify(output) {
      assert.match(output, /brief\.command/);
      assert.doesNotMatch(output, /maestro run prepare|~\/\.maestro\/prepare/);
    },
  },
  {
    name: "keeps residual generic create prose as-is in v3",
    file: "D:/fixture/skills/skill-generator/SKILL.md",
    input: 'then create `skill-generator` with the complete fenced `maestro run create` option set.',
    verify(output) {
      assert.match(output, /maestro run create/);
      assert.doesNotMatch(output, /maestro run start/);
    },
  },
  {
    name: "passes v3 odyssey lifecycle text through unchanged",
    file: "D:/fixture/skills/maestro-odyssey/SKILL.md",
    input: "Dispatch the mode step with fenced `maestro run next --session {session_id} ... --json` or self-start with `maestro run create odyssey-<mode> [args...] --session {session_id} ... --json`.",
    verify(output) {
      assert.match(output, /maestro run next --session/);
      assert.match(output, /maestro run create odyssey-<mode>/);
      assert.doesNotMatch(output, /session start|run start/);
    },
  },
  {
    name: "binds Pi on platform-aware Skills calls and leaves v3 lifecycle calls untouched",
    file: "D:/fixture/skills/example/SKILL.md",
    input: `maestro skills --steps --json --platform claude
maestro run create plan --session demo
maestro run brief run-1 --session demo
maestro run next --session demo --expected-orchestration-revision 3
maestro run check run-1 --session demo
maestro run complete run-1 --session demo --advance
maestro session open "topic" --id demo --chain analyze
`,
    verify(output) {
      assert.match(output, /maestro skills --steps --json --platform pi/);
      assert.match(output, /maestro run create plan --session demo/);
      assert.match(output, /maestro run brief run-1 --session demo/);
      assert.match(output, /maestro run next --session demo/);
      assert.match(output, /maestro run check run-1 --session demo/);
      assert.match(output, /maestro run complete run-1 --session demo --advance/);
      assert.match(output, /maestro session open "topic" --id demo --chain analyze/);
      assert.doesNotMatch(output, /maestro run brief --platform/);
      assert.doesNotMatch(output, /maestro run next --platform/);
      assert.doesNotMatch(output, /maestro run complete --platform/);
      assert.doesNotMatch(output, /maestro session open --platform/);
    },
  },
  {
    name: "normalizes Skills platform placeholders and Claude bindings to Pi only",
    file: "D:/fixture/skills/example/SKILL.md",
    input: `maestro skills --steps --json --platform {target_platform}
maestro skills --steps --json --platform claude
maestro run create plan --platform {target_platform} --session demo
maestro run brief run-1 --platform claude
`,
    verify(output) {
      // v3 binds the platform only on Skills catalog calls; lifecycle calls
      // (run create/brief/...) keep their source text untouched.
      assert.equal(output.match(/maestro skills --steps --json --platform pi/g)?.length, 2);
      assert.equal(output.match(/maestro run create plan --platform \{target_platform\} --session demo/g)?.length, 1);
      assert.equal(output.match(/maestro run brief run-1 --platform claude/g)?.length, 1);
    },
  },
  {
    name: "keeps v3 coordinator creation and completion commands intact",
    file: "D:/fixture/skills/team-review/roles/coordinator/role.md",
    input: `Otherwise: \`maestro run create team-review "<task summary>" --session <slug> --goal "<task summary>"\`
maestro run complete <run_id> --session <slug> --advance
`,
    verify(output) {
      assert.match(output, /maestro run create team-review "<task summary>" --session <slug> --goal "<task summary>"/);
      assert.match(output, /maestro run complete <run_id> --session <slug> --advance/);
      assert.doesNotMatch(output, /maestro run start|maestro run done/);
    },
  },
  {
    name: "converts JSON catalog text without frontmatter corruption",
    file: "D:/fixture/agents/catalog.json",
    input: '{"instruction":"Otherwise: `maestro run create execute \\"<task summary>\\" --session <slug> --goal \\"<task summary>\\"`"}',
    verify(output) {
      assert.match(output, /maestro run create execute \\"<task summary>\\" --session <slug> --goal/);
      assert.doesNotMatch(output, /maestro run start/);
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
      assert.match(output, /<pi_run_control>/);
      assert.match(output, /run-control/);
      assert.match(output, /human syntax references/);
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
  assert.equal(second.match(/<pi_run_control>/g)?.length, 1);
  assert.equal(second.match(/<pi_context_contract>/g)?.length, 1);
  assert.equal(second.match(/<cli_surface>/g)?.length ?? 0, 0);
});
