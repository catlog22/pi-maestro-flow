import assert from "node:assert/strict";
import test from "node:test";
import { SkillCliAdapter } from "../src/skills/skill-cli-adapter.ts";
import type { RunCliResult } from "../src/session/cli-adapter.ts";

type FakeRunner = (args: string[]) => Promise<RunCliResult>;

function fakeRunner(handler: (args: string[]) => RunCliResult): FakeRunner {
  return async (args) => handler(args);
}

test("skill cli adapter lists entries with platform and steps flags", async () => {
  const adapter = new SkillCliAdapter("/proj", fakeRunner((args) => {
    assert.deepEqual(args, ["skills", "--json", "--platform", "pi", "--steps"]);
    const lines = [
      JSON.stringify({
        type: "skill", scope: "global", platform: "pi",
        name: "maestro", path: "x/SKILL.md", hint: "", description: "intent-to-chain",
      }),
      JSON.stringify({
        type: "step", scope: "global", platform: "all",
        name: "analyze", path: "y/analyze.md", hint: "", description: "",
        source: "prepare",
      }),
      "WARNING: diagnostic line",
      "",
    ];
    return { exitCode: 0, argv: args, stdout: lines.join("\n"), stderr: "" };
  }));

  const entries = await adapter.list({ platform: "pi", steps: true });
  assert.equal(entries.length, 2);
  assert.equal(entries[0]?.type, "skill");
  assert.equal(entries[0]?.name, "maestro");
  assert.equal(entries[1]?.type, "step");
  assert.equal(entries[1]?.source, "prepare");
});

test("skill cli adapter defaults to pi platform without steps", async () => {
  const adapter = new SkillCliAdapter("/proj", fakeRunner((args) => {
    assert.deepEqual(args, ["skills", "--json", "--platform", "pi"]);
    return { exitCode: 0, argv: args, stdout: "", stderr: "" };
  }));
  const entries = await adapter.list();
  assert.deepEqual(entries, []);
});

test("skill cli adapter surfaces CLI failures", async () => {
  const adapter = new SkillCliAdapter(
    "/proj",
    fakeRunner((args) => ({
      exitCode: 1,
      argv: args,
      stdout: "",
      stderr: "Error: skills unavailable",
    })),
  );
  await assert.rejects(
    adapter.list({ platform: "pi" }),
    /failed \(1\): Error: skills unavailable/,
  );
});
