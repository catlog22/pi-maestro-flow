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
      assert.match(output, /^allowed-tools: Read teammate maestro$/m);
      assert.match(output, /user prompt is used/);
      assert.match(output, /```yaml\nallowed-tools: Agent AskUserQuestion\n```/);
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
