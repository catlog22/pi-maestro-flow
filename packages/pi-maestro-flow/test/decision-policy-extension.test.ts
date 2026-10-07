import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test, { before, after } from "node:test";
import registerDecisionPolicy, { isDecisionPolicyConfiguring } from "../src/decision-policy/extension.ts";
import { defaultDecisionPolicy, loadDecisionPolicy, saveDecisionPolicy } from "../src/decision-policy/config.ts";
import { classifierConfig, classifierStatus, configureClassifier, listClassifyDomains } from "pi-maestro-teammate/v1/classify";

// The test runner itself may be launched by a teammate. Harnesses model a parent host.
const childEnvironment = ["PI_TEAMMATE_CHILD", "PI_TEAMMATE_MANAGED_WINDOW"] as const;
const originalEnvironment = new Map(childEnvironment.map((name) => [name, process.env[name]]));
before(() => { for (const name of childEnvironment) delete process.env[name]; });
after(() => {
  for (const name of childEnvironment) {
    const value = originalEnvironment.get(name);
    if (value === undefined) delete process.env[name]; else process.env[name] = value;
  }
});

type Handler = (event: any, ctx: any) => any;
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}
async function harness(t: any, cwd?: string, id = "manual-session") {
  cwd ??= await mkdtemp(join(tmpdir(), "policy-extension-"));
  const directory = cwd;
  const handlers = new Map<string, Set<Handler>>();
  const tools = new Map<string, any>();
  let active = ["read", "ask"];
  let sessionId = id;
  const notices: string[] = [];
  const confirmations: string[] = [];
  let confirm: (title: string, message: string) => Promise<boolean> = async () => true;
  const ctx: any = {
    cwd,
    hasUI: true,
    sessionManager: { getSessionId: () => sessionId },
    ui: {
      notify: (text: string) => notices.push(text),
      confirm: (title: string, message: string) => { confirmations.push(message); return confirm(title, message); },
    },
  };
  const pi: any = {
    registerTool: (tool: any) => tools.set(tool.name, tool),
    getActiveTools: () => [...active],
    setActiveTools: (names: string[]) => { active = [...names]; },
    on: (name: string, handler: Handler) => {
      const set = handlers.get(name) ?? new Set();
      handlers.set(name, set);
      set.add(handler);
      return () => { set.delete(handler); };
    },
  };
  let dispose = registerDecisionPolicy(pi);
  t.after(async () => { dispose(); await rm(directory, { recursive: true, force: true }); });
  const emit = async (name: string, event: any = {}) => {
    let result: any;
    for (const h of [...handlers.get(name) ?? []]) result = await h(event, ctx);
    return result;
  };
  const input = (text = "/skill:decision-policy", source = "interactive") => emit("input", { text, source });
  const call = (params: any, signal?: AbortSignal, context = ctx) => tools.get("policy_config").execute("call", params, signal, undefined, context);
  const draft = () => ({ ...defaultDecisionPolicy(), description: "Project-approved trial", ask: { mode: "shadow" }, rules: [{ id: "human-risk", domain: "ask", instruction: "Keep destructive changes human." }] });
  const propose = async () => { await input(); return call({ action: "propose", draft: draft(), expectedRevision: 0 }); };
  return { pi, ctx, tools, input, emit, call, draft, propose, notices, confirmations,
    active: () => active,
    addTool: (name: string) => { active.push(name); },
    setConfirm: (fn: typeof confirm) => { confirm = fn; },
    switchIdentity: (next: string) => { sessionId = next; },
    reload: () => { dispose = registerDecisionPolicy(pi); },
  };
}

test("hidden default, model-only exposure, and raw interactive Skill authorization", async (t) => {
  const h = await harness(t);
  const tool = h.tools.get("policy_config");
  assert.equal(tool.defaultActive, false);
  assert.equal(tool.exposure, "model-only");
  assert.equal(tool.parameters.additionalProperties, false);
  assert.ok(!h.active().includes("policy_config"));
  h.addTool("policy_config"); // Even explicit tool activation does not authorize.
  await assert.rejects(h.call({ action: "read", approved: true }), /interactively/);
  for (const source of ["rpc", "extension"]) {
    await h.input("/skill:decision-policy", source);
    await assert.rejects(h.call({ action: "commit", approved: true }), /interactively/);
  }
  for (const text of ["please /skill:decision-policy", "/skill:decision-policy-other", "<skill>decision-policy</skill>"]) {
    await h.input(text);
    assert.equal(isDecisionPolicyConfiguring(h.ctx), false);
  }
  assert.equal((await h.input("/skill:decision-policy ask avoid deletion")).action, "continue");
  assert.equal(isDecisionPolicyConfiguring(h.ctx.cwd, "manual-session"), true);
  assert.equal((await h.call({ action: "read" })).details.expectedRevision, 0);
  await h.call({ action: "cancel" });
  assert.ok(h.active().includes("policy_config"), "Do not revoke someone else's activation");
});

test("policy domains are registered eagerly before the first model call", async (t) => {
  await harness(t);
  for (const name of ["decision-owner", "evolve-capture", "evolve-review"]) {
    assert.ok(listClassifyDomains().includes(name));
    assert.deepEqual(classifierStatus().domains[name].supportedModes, ["off", "shadow", "jev"]);
  }
});

test("confirmation separates classifier effective settings from policy fallback without leaking credentials", async (t) => {
  const previous = classifierConfig();
  t.after(() => configureClassifier(previous));
  configureClassifier({ enabled: true, apiKey: "must-never-be-shown", endpoint: "typesafe", model: "classifier-model", maxCallsPerSession: 7, domains: { "decision-owner": "jev", "evolve-capture": "shadow", "evolve-review": "off" } });
  for (const backend of ["auto", "classifier", "llm"]) {
    const h = await harness(t);
    await h.input();
    const read = await h.call({ action: "read" });
    assert.equal(read.details.backendSummary.classifierEffectiveSettings.model, "classifier-model");
    const proposed = await h.call({ action: "propose", draft: { ...h.draft(), backend }, expectedRevision: 0 });
    const summary = proposed.details.backendSummary;
    assert.equal(summary.classifierEffectiveSettings.enabled, true);
    assert.equal(summary.classifierEffectiveSettings.maxCallsPerSession, 7);
    assert.deepEqual(summary.classifierEffectiveSettings.domainModes, { "decision-owner": "jev", "evolve-capture": "shadow", "evolve-review": "off" });
    assert.equal(summary.policySettings.backend, backend);
    assert.equal(summary.policySettings.ask, "shadow");
    assert.equal(summary.policySettings.selfEvolve, "off");
    h.setConfirm(async () => false);
    await h.call({ action: "commit", expectedRevision: 0 });
    assert.match(h.confirmations[0], /Classifier effective settings vs policy fallback/);
    assert.ok(h.confirmations[0].includes(JSON.stringify(summary, null, 2)));
    assert.ok(!h.confirmations[0].includes("must-never-be-shown"));
    assert.match(summary.fallback, backend === "auto" ? /falls back to the policy classification LLM/ : backend === "classifier" ? /no LLM classification fallback/ : /bypass classifier/);
  }
});

test("exact normalized draft is confirmed in real UI; save increments revision and cleans only its activation", async (t) => {
  const h = await harness(t);
  const proposed = await h.propose();
  h.addTool("new-tool");
  const saved = await h.call({ action: "commit", expectedRevision: 0, approved: true });
  assert.equal(h.confirmations.length, 1);
  assert.ok(h.confirmations[0].includes(JSON.stringify(proposed.details.draft, null, 2)));
  assert.ok(h.confirmations[0].includes(h.ctx.cwd));
  assert.match(h.confirmations[0], /manual-session[\s\S]*Expected revision: 0/);
  assert.equal(saved.details.policy.revision, 1);
  assert.deepEqual(await loadDecisionPolicy(h.ctx.cwd), { ...proposed.details.draft, revision: 1 });
  assert.deepEqual(h.active(), ["read", "ask", "new-tool"]);
  assert.equal(isDecisionPolicyConfiguring(h.ctx), false);
});

test("declined UI cannot be overridden by approved tool arguments", async (t) => {
  const h = await harness(t);
  await h.propose();
  h.setConfirm(async () => false);
  const result = await h.call({ action: "commit", expectedRevision: 0, approved: true });
  assert.equal(result.details.saved, false);
  assert.equal(await loadDecisionPolicy(h.ctx.cwd), undefined);
  assert.equal(isDecisionPolicyConfiguring(h.ctx), false);
});

test("status does not authorize, cancel is handled without expansion", async (t) => {
  const h = await harness(t);
  assert.equal((await h.input("/skill:decision-policy status")).action, "handled");
  assert.equal(isDecisionPolicyConfiguring(h.ctx), false);
  assert.ok(h.notices[0].includes('"revision": 0'));
  await h.input();
  assert.equal((await h.input("/skill:decision-policy cancel")).action, "handled");
  await assert.rejects(h.call({ action: "read" }), /interactively/);
});

test("child and managed worker interactive commands never authorize", async (t) => {
  const h = await harness(t);
  for (const variable of ["PI_TEAMMATE_CHILD", "PI_TEAMMATE_MANAGED_WINDOW"]) {
    const previous = process.env[variable];
    process.env[variable] = "1";
    try {
      assert.equal((await h.input()).action, "handled");
      assert.equal(isDecisionPolicyConfiguring(h.ctx), false);
      await assert.rejects(h.call({ action: "commit" }), /interactively/);
    } finally {
      if (previous === undefined) delete process.env[variable]; else process.env[variable] = previous;
    }
  }
  h.ctx.hasUI = false;
  assert.equal((await h.input()).action, "handled");
  assert.equal(isDecisionPolicyConfiguring(h.ctx), false);
});

test("all lifecycle boundaries revoke owned activation", async (t) => {
  const h = await harness(t);
  for (const event of ["session_start", "session_before_switch", "session_before_fork", "session_shutdown"]) {
    await h.input();
    h.addTool(`tool-${event}`);
    await h.emit(event);
    assert.ok(!h.active().includes("policy_config"));
    assert.ok(h.active().includes(`tool-${event}`));
    assert.equal(isDecisionPolicyConfiguring(h.ctx), false);
  }
  await h.input();
  h.reload();
  assert.ok(!h.active().includes("policy_config"));
  assert.equal(isDecisionPolicyConfiguring(h.ctx), false);
});

test("cancel fences both async read and propose without stale resurrection", async (t) => {
  const h = await harness(t);
  for (const action of ["read", "propose"]) {
    await h.input();
    const pending = h.call({ action, draft: h.draft(), expectedRevision: 0 });
    const rejected = assert.rejects(pending, /fresh interactive/);
    await h.call({ action: "cancel" });
    await rejected;
    assert.equal(isDecisionPolicyConfiguring(h.ctx), false);
    assert.ok(!h.active().includes("policy_config"));
  }
});

test("cancel during awaited confirmation cannot save or revoke a replacement lane", async (t) => {
  const h = await harness(t);
  await h.propose();
  const gate = deferred<boolean>();
  const opened = deferred<boolean>();
  h.setConfirm(async () => { opened.resolve(true); return gate.promise; });
  const commit = h.call({ action: "commit", expectedRevision: 0 });
  const rejected = assert.rejects(commit, /fresh interactive/);
  await opened.promise;
  await h.call({ action: "cancel" });
  await h.input();
  gate.resolve(true);
  await rejected;
  assert.equal(await loadDecisionPolicy(h.ctx.cwd), undefined);
  assert.equal(isDecisionPolicyConfiguring(h.ctx), true);
  assert.ok(h.active().includes("policy_config"));
});

test("switch, reload and abort during confirmation all fence the old commit", async (t) => {
  const h = await harness(t);
  for (const boundary of ["switch", "reload", "abort"]) {
    await h.propose();
    const gate = deferred<boolean>();
    const opened = deferred<boolean>();
    h.setConfirm(async () => { opened.resolve(true); return gate.promise; });
    const abort = new AbortController();
    const pending = h.call({ action: "commit", expectedRevision: 0 }, abort.signal);
    const rejected = assert.rejects(pending, /fresh interactive/);
    await opened.promise;
    if (boundary === "switch") await h.emit("session_before_switch");
    if (boundary === "reload") h.reload();
    if (boundary === "abort") abort.abort();
    gate.resolve(true);
    await rejected;
    assert.equal(await loadDecisionPolicy(h.ctx.cwd), undefined);
    assert.equal(isDecisionPolicyConfiguring(h.ctx), false);
  }
});

test("identity changes without lifecycle notification still fence writes", async (t) => {
  const h = await harness(t);
  await h.propose();
  h.switchIdentity("new-session");
  await assert.rejects(h.call({ action: "commit", expectedRevision: 0 }), /fresh interactive/);
  assert.equal(h.confirmations.length, 0);
  assert.equal(await loadDecisionPolicy(h.ctx.cwd), undefined);
  await h.propose();
  const wrongWorkspace = { ...h.ctx, cwd: join(h.ctx.cwd, "other") };
  await assert.rejects(h.call({ action: "commit", expectedRevision: 0 }, undefined, wrongWorkspace), /fresh interactive/);
});

test("cancellation while persistence awaits its lock is fenced under the lock", async (t) => {
  const h = await harness(t);
  await h.propose();
  const lockfile = createRequire(import.meta.url)("proper-lockfile");
  const original = lockfile.lock;
  const entered = deferred<boolean>();
  const gate = deferred<boolean>();
  lockfile.lock = async (...args: any[]) => {
    entered.resolve(true);
    await gate.promise;
    return original(...args);
  };
  try {
    const pending = h.call({ action: "commit", expectedRevision: 0 });
    const rejected = assert.rejects(pending, /fresh interactive/);
    await entered.promise;
    await h.call({ action: "cancel" });
    gate.resolve(true);
    await rejected;
    assert.equal(await loadDecisionPolicy(h.ctx.cwd), undefined);
    assert.equal(isDecisionPolicyConfiguring(h.ctx), false);
  } finally {
    lockfile.lock = original;
    gate.resolve(true);
  }
});

test("before-agent guidance is opt-in and configuration dialogue always stays human", async (t) => {
  const h = await harness(t);
  const event = { systemPrompt: "base-system-prompt" };
  assert.equal(await h.emit("before_agent_start", event), undefined);
  await saveDecisionPolicy(h.ctx.cwd, defaultDecisionPolicy(), 0);
  assert.equal(await h.emit("before_agent_start", event), undefined);
  await saveDecisionPolicy(h.ctx.cwd, h.draft(), 1);
  const policyGuidance = await h.emit("before_agent_start", event);
  assert.ok(policyGuidance.systemPrompt.startsWith(event.systemPrompt));
  assert.match(policyGuidance.systemPrompt, /\[Project decision policy\]/);
  assert.match(policyGuidance.systemPrompt, /"ask":"shadow"/);
  assert.match(policyGuidance.systemPrompt, /Shadow is diagnostic only/);
  assert.match(policyGuidance.systemPrompt, /never approves permissions, Plan gates, knowledge promotion/);
  await h.input();
  const manualGuidance = await h.emit("before_agent_start", event);
  assert.match(manualGuidance.systemPrompt, /All ask decisions.*MUST remain human/);
  await h.call({ action: "cancel" });
  await writeFile(join(h.ctx.cwd, ".pi", "decision-policy.json"), "invalid json");
  assert.equal(await h.emit("before_agent_start", event), undefined);
});

test("late before-agent reads cannot inject policy guidance after lifecycle change or manual activation", async (t) => {
  const h = await harness(t);
  await saveDecisionPolicy(h.ctx.cwd, h.draft(), 0);
  let pending = h.emit("before_agent_start", { systemPrompt: "base" });
  await h.emit("session_shutdown");
  assert.equal(await pending, undefined);
  pending = h.emit("before_agent_start", { systemPrompt: "base" });
  await h.input();
  assert.equal(await pending, undefined);
});

test("CAS catches concurrent external revision change after UI opened", async (t) => {
  const h = await harness(t);
  await h.propose();
  h.setConfirm(async () => {
    await saveDecisionPolicy(h.ctx.cwd, defaultDecisionPolicy(), 0);
    return true;
  });
  await assert.rejects(h.call({ action: "commit", expectedRevision: 0 }), /revision conflict/);
  assert.equal((await loadDecisionPolicy(h.ctx.cwd))?.description, "");
  assert.equal((await loadDecisionPolicy(h.ctx.cwd))?.revision, 1);
  assert.equal(isDecisionPolicyConfiguring(h.ctx), false);
});

test("invalid drafts, mismatched revision and replacement commit drafts fail closed", async (t) => {
  const h = await harness(t);
  for (const params of [
    { action: "propose", draft: { ...h.draft(), rules: [] }, expectedRevision: 0 },
    { action: "propose", draft: h.draft(), expectedRevision: 1 },
    { action: "commit", draft: h.draft(), expectedRevision: 0 },
    { action: "commit", expectedRevision: 1 },
  ]) {
    await h.propose();
    await assert.rejects(h.call(params));
    assert.equal(isDecisionPolicyConfiguring(h.ctx), false);
    assert.equal(await loadDecisionPolicy(h.ctx.cwd), undefined);
  }
});

test("read resets staged draft; parallel operations cannot replace a confirming draft", async (t) => {
  const h = await harness(t);
  await h.propose();
  await h.call({ action: "read" });
  await assert.rejects(h.call({ action: "commit", expectedRevision: 0 }), /Propose a draft/);
  await h.propose();
  const gate = deferred<boolean>();
  const opened = deferred<boolean>();
  h.setConfirm(async () => { opened.resolve(true); return gate.promise; });
  const pending = h.call({ action: "commit", expectedRevision: 0 });
  await opened.promise;
  await assert.rejects(h.call({ action: "propose", draft: h.draft(), expectedRevision: 0 }), /already in progress/);
  await assert.rejects(h.call({ action: "read" }), /already in progress/);
  gate.resolve(true);
  assert.equal((await pending).details.saved, true);
});

test("confirmation failure closes lane and leaves no policy", async (t) => {
  const h = await harness(t);
  await h.propose();
  h.setConfirm(async () => { throw new Error("UI unavailable"); });
  await assert.rejects(h.call({ action: "commit", expectedRevision: 0 }), /UI unavailable/);
  assert.equal(isDecisionPolicyConfiguring(h.ctx), false);
  assert.equal(await loadDecisionPolicy(h.ctx.cwd), undefined);
});

test("manual Skill discovery and no-ideas project-to-suggestions-to-confirm contract", async () => {
  const skill = await readFile(new URL("../../../.pi/skills/decision-policy/SKILL.md", import.meta.url), "utf8");
  assert.match(skill, /^---\nname: decision-policy\n/);
  assert.match(skill, /^disable-model-invocation: true$/m);
  assert.match(skill, /^session-mode: none$/m);
  assert.match(skill, /allowed-tools:.*policy_config/);
  assert.match(skill, /no classifier prerequisite/);
  assert.match(skill, /no ideas or no arguments/);
  assert.match(skill, /bounded read-only project analysis/);
  assert.match(skill, /2–4 \*\*concrete suggestions\*\*/);
  assert.match(skill, /\*\*each recommendation\*\*/);
  assert.match(skill, /\*\*whole combined policy\*\*/);
  assert.match(skill, /UI\.confirm/);
  assert.match(skill, /Do not modify `\.pi\/decision-policy\.json` directly/);
  assert.match(skill, /evolve-capture/);
  assert.match(skill, /evolve-review/);
  const pack = await readFile(new URL("../scripts/prepare-package-skills.mjs", import.meta.url), "utf8");
  assert.match(pack, /sourceDir = resolve\(packageRoot, "\.\.", "\.\.", "\.pi"\)/);
  assert.match(pack, /cpSync\(sourceDir, targetDir/);
  const extension = await readFile(new URL("../src/decision-policy/extension.ts", import.meta.url), "utf8");
  assert.doesNotMatch(extension, /executeAsk/);
  assert.match(extension, /saveDecisionPolicy\(current\.cwd, draft, revision, \(\) => authorized\(current, ctx, signal\)\)/);
  assert.match(extension, /if \(previous\) invalidateDecisionPolicySession\(previous\)/);
  for (const boundary of ["session_start", "session_before_switch", "session_before_fork", "session_shutdown"]) {
    assert.match(extension, new RegExp(`pi\\.on\\("${boundary}",[^\\n]*resetSession`));
  }
  assert.match(skill, /classifier effective settings versus policy fallback/);
});

test("native Pi discovers the manual Skill but omits it from model prompts", async () => {
  const { loadSkillsFromDir, formatSkillsForPrompt } = await import("@earendil-works/pi-coding-agent");
  const dir = fileURLToPath(new URL("../../../.pi/skills/decision-policy", import.meta.url));
  const discovered = loadSkillsFromDir({ dir, source: "project" });
  assert.deepEqual(discovered.diagnostics, []);
  assert.equal(discovered.skills.length, 1);
  assert.equal(discovered.skills[0].name, "decision-policy");
  assert.equal(discovered.skills[0].disableModelInvocation, true);
  assert.equal(formatSkillsForPrompt(discovered.skills), "");
});
