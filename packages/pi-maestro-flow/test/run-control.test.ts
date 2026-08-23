import assert from "node:assert/strict";
import test from "node:test";
import {
  classifyRunControlArgv,
  isRunControlReadArgv,
  type RunControlClassification,
} from "../src/tools/run-control.ts";

test("run-control classifies session/3.0-only commands", () => {
  const cases: Array<{
    argv: string[];
    expected: RunControlClassification;
  }> = [
    // Session family: v3-only mutations (no v2 counterpart on the maestro CLI).
    { argv: ["session", "open", "migrate to session/3.0"], expected: writeClassification("session", "none", true) },
    // Session family: v3 orchestration mutations carry no legacy lease semantics.
    { argv: ["session", "migrate"], expected: writeClassification("session", "none") },
    { argv: ["session", "complete"], expected: writeClassification("session", "none") },
    { argv: ["session", "archive"], expected: writeClassification("session", "none") },
    { argv: ["session", "unarchive"], expected: writeClassification("session", "none") },
    { argv: ["session", "chain", "insert", "--step-id", "s1", "--command", "execute"], expected: writeClassification("session", "none") },
    { argv: ["session", "chain", "skip", "--step-id", "s1"], expected: writeClassification("session", "none") },
    { argv: ["session", "chain", "replace", "--step-id", "s1", "--command", "plan"], expected: writeClassification("session", "none") },
    { argv: ["session", "chain", "update", "--step-id", "s1", "--stage", "review"], expected: writeClassification("session", "none") },
    // Shared legacy names are normalized back to their historical lease scope
    // by WorkflowCoordinator after it selects a non-v3 mode.
    { argv: ["session", "resume"], expected: writeClassification("execution-acquire", "acquire") },
    // Session family: v3-only reads.
    { argv: ["session", "resume-view"], expected: readClassification() },
    { argv: ["session", "resume-view", "--json"], expected: readClassification() },
    // Run family: orchestration-like commands target the Session; entity
    // lifecycle commands target a Run.
    { argv: ["run", "next"], expected: writeClassification("session", "none") },
    { argv: ["run", "create", "execute"], expected: writeClassification("session", "none") },
    { argv: ["run", "decide", "decision-1"], expected: writeClassification("session", "none") },
    { argv: ["run", "complete", "run-1"], expected: writeClassification("run", "none") },
    { argv: ["run", "transition", "run-1", "running"], expected: writeClassification("run", "none") },
    { argv: ["run", "cancel", "run-1"], expected: writeClassification("run", "none") },
    { argv: ["run", "seal", "run-1"], expected: writeClassification("run", "none") },
    // Core batch A/B removed session pause/chain audit and the participant family
    // entirely; those argv fall through to the shared/default classifications below
    // (fail closed at the core) instead of a dedicated v3 classification.
    { argv: ["session", "pause"], expected: writeClassification("execution", "required") },
    { argv: ["session", "chain", "audit"], expected: writeClassification("execution", "required") },
    { argv: ["participant", "status"], expected: writeClassification("execution", "required") },
    { argv: ["participant", "register", "--participant-id", "win-1"], expected: writeClassification("execution", "required") },
    { argv: ["participant", "unregister", "--participant-id", "win-1"], expected: writeClassification("execution", "required") },
  ];

  for (const fixture of cases) {
    assert.deepEqual(classifyRunControlArgv(fixture.argv), fixture.expected, fixture.argv.join(" "));
  }
});

test("run-control read helpers recognize v3 read-only commands", () => {
  assert.equal(isRunControlReadArgv(["session", "resume-view"]), true);
  assert.equal(isRunControlReadArgv(["session", "open", "objective"]), false);
  assert.equal(isRunControlReadArgv(["run", "transition", "run-1", "running"]), false);
  // Retired v3 commands are no longer classified as read-only (fail closed).
  assert.equal(isRunControlReadArgv(["session", "chain", "audit"]), false);
  assert.equal(isRunControlReadArgv(["session", "pause"]), false);
  assert.equal(isRunControlReadArgv(["participant", "status"]), false);
  assert.equal(isRunControlReadArgv(["participant", "register", "win-1"]), false);
});

test("run-control preserves unaffected v2 command classifications", () => {
  const cases: Array<{
    argv: string[];
    expected: RunControlClassification;
  }> = [
    // Reads.
    { argv: ["capabilities", "--json"], expected: readClassification() },
    { argv: ["skills", "--steps"], expected: readClassification() },
    { argv: ["run", "status"], expected: readClassification() },
    { argv: ["run", "brief"], expected: readClassification() },
    { argv: ["run", "check"], expected: readClassification() },
    { argv: ["session", "status"], expected: readClassification() },
    { argv: ["session", "show"], expected: readClassification() },
    { argv: ["session", "list"], expected: readClassification() },
    { argv: ["execution", "status"], expected: readClassification() },
    { argv: ["execution", "show"], expected: readClassification() },
    { argv: ["execution", "list"], expected: readClassification() },
    { argv: ["execution", "lease", "status"], expected: readClassification() },
    { argv: ["artifact", "inspect", "ART-1"], expected: readClassification() },
    { argv: ["artifact", "list"], expected: readClassification() },
    { argv: ["artifact", "show", "ART-1"], expected: readClassification() },
    // Session family writes not reclassified for the v3 orchestration surface.
    { argv: ["session", "create", "topic"], expected: writeClassification("session", "none", true) },
    { argv: ["session", "start"], expected: writeClassification("compatibility-start", "command-aware", true) },
    { argv: ["session", "attach"], expected: writeClassification("execution-acquire", "acquire") },
    { argv: ["session", "resolve"], expected: writeClassification("execution", "none") },
    { argv: ["session", "next"], expected: writeClassification("execution", "required") },
    // Run start and unrecognized Run mutations retain compatibility defaults.
    { argv: ["run", "start"], expected: writeClassification("compatibility-start", "command-aware", true) },
    { argv: ["run", "seal-session", "session-1"], expected: writeClassification("execution", "required") },
    // Execution/artifact/plan families are untouched by the v3 additions.
    { argv: ["execution", "start"], expected: writeClassification("execution-acquire", "acquire") },
    { argv: ["execution", "attach"], expected: writeClassification("execution-acquire", "acquire") },
    { argv: ["execution", "pause"], expected: writeClassification("execution", "required") },
    { argv: ["execution", "resolve"], expected: writeClassification("execution", "none") },
    { argv: ["execution", "resume"], expected: writeClassification("execution-acquire", "acquire") },
    { argv: ["execution", "seal"], expected: writeClassification("execution", "required") },
    { argv: ["execution", "handoff", "prepare"], expected: writeClassification("execution", "required") },
    { argv: ["execution", "handoff", "accept"], expected: writeClassification("execution-acquire", "acquire") },
    { argv: ["execution", "handoff", "cancel"], expected: writeClassification("execution", "required") },
    { argv: ["execution", "lease", "heartbeat"], expected: writeClassification("execution-lease", "required") },
    { argv: ["execution", "lease", "release"], expected: writeClassification("execution-lease", "required") },
    { argv: ["execution", "lease", "recover"], expected: writeClassification("execution-lease", "acquire") },
    { argv: ["artifact", "republish", "ART-1"], expected: writeClassification("artifact-republish", "none") },
    { argv: ["artifact", "future", "ART-1"], expected: writeClassification("artifact-republish", "none") },
    { argv: ["plan", "publish", "approved.md", "--handoff-key", "handoff-1"], expected: writeClassification("plan-publish", "required") },
    // Top-level compatibility and unknown-command defaults.
    { argv: ["start", "build"], expected: writeClassification("compatibility-start", "command-aware", true) },
    { argv: ["create", "session"], expected: writeClassification("execution", "required", true) },
    { argv: ["future", "command"], expected: writeClassification("execution", "required") },
    { argv: ["participant", "future"], expected: writeClassification("execution", "required") },
  ];

  for (const fixture of cases) {
    assert.deepEqual(classifyRunControlArgv(fixture.argv), fixture.expected, fixture.argv.join(" "));
  }
});

function readClassification(): RunControlClassification {
  return { write: false, sessionless: false, mutation: "read", lease: "none" };
}

function writeClassification(
  mutation: "session" | "run" | "execution" | "execution-acquire" | "execution-lease"
    | "compatibility-start" | "plan-publish" | "artifact-republish",
  lease: "none" | "required" | "acquire" | "command-aware",
  sessionless = false,
): RunControlClassification {
  return { write: true, sessionless, mutation, lease };
}
