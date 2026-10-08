import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { VERSION } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { bindClassifierRuntime, classifierStatus, configureClassifier, registerClassifyDomain, registerBuiltinClassifyDomains, resetClassifierForTest } from "pi-maestro-teammate/v1/classify";
import { boundedDiagnosticInput, businessPolicyDiagnostic, classifierBusinessStatus, diagnosticText, diagnosticWait, rawClassifierDiagnostic, readClassifierShadow } from "../src/classifier/diagnostics.ts";
import { defaultDecisionPolicy } from "../src/decision-policy/config.ts";
import { policyClassifyDomain } from "../src/decision-policy/domains.ts";
import { ClassifierDiagnosticOverlay, showClassifierDiagnostics, showClassifierSettings } from "../src/tui/classifier-settings.ts";
import { createClassifierSettingsProvider } from "../src/classifier/settings-provider.ts";
import { refreshClassifierPanelModels } from "../src/classifier/panel-model.ts";
import registerClassifier from "../src/classifier/extension.ts";
import { executeTodo, getVisibleTasks, initTodo, onSessionStart, onSessionShutdown } from "../src/tools/todo.ts";

const theme = { fg(_role: string, text: string) { return text; }, bold(text: string) { return text; } };
const down = "\x1b[B";
async function fixture() {
  const cwd = await mkdtemp(join(tmpdir(), "classifier-diagnostic-"));
  const requests: any[] = [];
  const model = { provider: "openrouter", id: "jev-only", api: "typesafe-classifier", baseUrl: "https://mock.invalid" };
  const registry = { getAvailableOfType: async () => [model], getModelOfType: () => model,
    getAvailable: () => [{ provider: "mock", id: "llm" }],
    classify: async (_model: unknown, context: any) => {
      requests.push(context);
      return { stopReason: "stop", provider: model.provider, model: model.id, answers: {
        verdict: { type: "choice", choice: "internal", confidence: 0.95 }, rule: { type: "choice", choice: "current", confidence: 0.95 }, worth: { type: "bool", probability: 0.95 },
        value: { type: "choice", choice: "required", confidence: 0.95 },
      } };
    } };
  resetClassifierForTest(); registerBuiltinClassifyDomains();
  const ctx = { cwd, hasUI: true, modelRegistry: registry, model: { provider: "mock", id: "llm" }, sessionManager: { getSessionId: () => cwd, getEntries: () => [] }, ui: { notify() {}, setStatus() {} } };
  bindClassifierRuntime({ hostVersion: VERSION, runtime: registry as never, sessionId: cwd, cwd });
  configureClassifier({ enabled: true, maxCallsPerSession: 4, domains: { "decision-owner": "jev", "file-value": "jev" } });
  await mkdir(join(cwd, ".pi"));
  const policy = { ...defaultDecisionPolicy(), ask: { mode: "enforce" as const }, rules: [{ id: "current", domain: "ask" as const, instruction: "Current project rule" }] };
  await writeFile(join(cwd, ".pi", "decision-policy.json"), JSON.stringify(policy));
  return { cwd, ctx, registry, requests, policy, close: async () => { resetClassifierForTest(); await rm(cwd, { recursive: true, force: true }); } };
}

test("fresh policy raw tests use current cwd/rules, not stale registry; missing/invalid cannot reuse history", async () => {
  const f = await fixture();
  const other = await mkdtemp(join(tmpdir(), "classifier-other-"));
  try {
    registerClassifyDomain(policyClassifyDomain("ask", { ...f.policy, rules: [{ id: "stale", domain: "ask", instruction: "Wrong project" }] }));
    const lines = await rawClassifierDiagnostic(f.ctx as never, "decision-owner", "Should this be internal?", new AbortController().signal);
    assert.match(lines.join("\n"), /mode=jev.*backend=jev/);
    assert.deepEqual(Object.keys(f.requests[0].questions.rule.criteria), ["none", "current"]);
    await mkdir(join(other, ".pi"));
    (f.ctx as any).cwd = other;
    await assert.rejects(rawClassifierDiagnostic(f.ctx as never, "decision-owner", "Anything", new AbortController().signal), /Missing/);
    await writeFile(join(other, ".pi", "decision-policy.json"), "{");
    await assert.rejects(rawClassifierDiagnostic(f.ctx as never, "decision-owner", "Anything", new AbortController().signal), /unavailable/);
    assert.equal(f.requests.length, 1);
    const updated = { ...f.policy, rules: [{ id: "other", domain: "ask", instruction: "Other project" }] };
    await writeFile(join(other, ".pi", "decision-policy.json"), JSON.stringify(updated));
    await rawClassifierDiagnostic(f.ctx as never, "decision-owner", "Second project", new AbortController().signal);
    assert.deepEqual(Object.keys(f.requests[1].questions.rule.criteria), ["none", "other"]);
  } finally { await f.close(); await rm(other, { recursive: true, force: true }); }
});

test("raw domain follows off/shadow/JEV while business follows saved policy and never generates advice", async () => {
  const f = await fixture();
  try {
    for (const mode of ["off", "shadow", "jev"] as const) {
      configureClassifier({ enabled: true, domains: { "decision-owner": mode }, maxCallsPerSession: 4 });
      const raw = await rawClassifierDiagnostic(f.ctx as never, "decision-owner", `raw ${mode}`, new AbortController().signal);
      assert.match(raw[0], new RegExp(`mode=${mode}`));
      if (mode !== "jev") assert.doesNotMatch(raw[0], /backend=jev/);
    }
    configureClassifier({ enabled: true, domains: { "decision-owner": "jev" }, maxCallsPerSession: 4 });
    const lines = await businessPolicyDiagnostic(f.ctx as never, "ask", "Business question", new AbortController().signal);
    assert.match(lines.join("\n"), /mode=enforce.*backend=classifier/);
    assert.match(lines.join("\n"), /ruleIds=current/);
    assert.match(lines.join("\n"), /advice:false/);
    assert.equal(classifierStatus().callsUsed, 3); // shadow + raw JEV + business; raw off costs nothing
    await refreshClassifierPanelModels(VERSION, f.registry);
    assert.equal(classifierStatus().callsUsed, 3);
  } finally { await f.close(); }
});

test("shadow is bounded, recent, malformed-visible, control-safe and withholds state/error secrets", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "classifier-shadow-"));
  try {
    assert.match((await readClassifierShadow(join(cwd, "missing"))).lines.join("\n"), /missing/);
    const row = { at: "2026-10-08", domain: "file-value\x1b[31m\x07", state: "SECRET INPUT", rule: { label: "unknown", terminal: false }, jev: { label: "required", confidence: 0.9 }, agree: false, error: "SECRET ERROR" };
    for (const date of ["01", "02", "03", "04"]) await writeFile(join(cwd, `2026-10-${date}.jsonl`), `${"x".repeat(40000)}\n${JSON.stringify(row)}\nnot-json\n{}\n`);
    const result = await readClassifierShadow(cwd);
    assert.equal(result.records, 3); assert.equal(result.malformed, 6);
    assert.equal(result.bytesRead, 3 * 32768);
    assert.doesNotMatch(result.lines.join("\n"), /SECRET|\x1b|\x07/);
    assert.match(result.lines.join("\n"), /rule=unknown.*JEV=required.*agree=no.*confidence=0.90/);
    assert.match(result.lines.join("\n"), /errors=3/);
    assert.equal(diagnosticText("\x1b[31mhello\x07\u202e"), "hello  ");
  } finally { await rm(cwd, { recursive: true, force: true }); }
});

test("diagnostic overlay paste/text is bounded, cancel/dispose aborts, every mode fits 1..120 columns", () => {
  const controller = new AbortController();
  let value: string | undefined;
  const input = new ClassifierDiagnosticOverlay({ title: "Diagnostic", input: true }, theme, controller.signal, text => { value = text; }, () => {}, () => controller.abort());
  input.handleInput("\x1b[200~" + "a".repeat(4000) + "\x07\x1b[201~");
  const choices = new ClassifierDiagnosticOverlay({ title: "Select", choices: [{ value: "one", label: "\x1b[31mone" }] }, theme, controller.signal, () => {}, () => {}, () => {});
  const result = new ClassifierDiagnosticOverlay({ title: "Result", lines: Array.from({ length: 40 }, () => "long ".repeat(70)) }, theme, controller.signal, () => {}, () => {}, () => {});
  for (let width = 1; width <= 120; width++) for (const overlay of [input, choices, result]) for (const line of overlay.render(width)) assert.ok(visibleWidth(line) <= width);
  input.handleInput("\r"); assert.equal(value!.length, 3000);
  assert.throws(() => boundedDiagnosticInput("x".repeat(3001)), /exceeds/);
  assert.throws(() => boundedDiagnosticInput("  "), /required/);
  assert.throws(() => boundedDiagnosticInput("\x00\x07"), /required/);
  choices.dispose();
  const abandoned = new ClassifierDiagnosticOverlay({ title: "Disposed", input: true }, theme, controller.signal, () => {}, () => {}, () => controller.abort());
  abandoned.dispose(); assert.equal(controller.signal.aborted, true);
});

test("openrouter-only actual panel probes selected model; F5/F6 retain independent drafts and old pin", async () => {
  const f = await fixture();
  const child = process.env.PI_TEAMMATE_CHILD; const managed = process.env.PI_TEAMMATE_MANAGED_WINDOW;
  delete process.env.PI_TEAMMATE_CHILD; delete process.env.PI_TEAMMATE_MANAGED_WINDOW;
  let active = false; let opens = 0; let refreshes = 0; let probes = 0;
  const original = f.registry.getAvailableOfType;
  f.registry.getAvailableOfType = async () => { assert.equal(active, false); probes++; return original(); };
  (f.registry as any).refresh = async (options: any) => { assert.equal(active, false); assert.equal(options.allowNetwork, false); refreshes++; return { aborted: false, errors: new Map() }; };
  const controller = new AbortController();
  (f.ctx.ui as any).confirm = async () => true;
  const provider = createClassifierSettingsProvider();
  (f.ctx.ui as any).custom = async (factory: any) => {
    active = true;
    return new Promise(resolve => {
      const overlay = factory({ requestRender() {} }, theme, {}, (value: unknown) => { active = false; resolve(value); });
      const rendered = overlay.render(140).join("\n");
      if (++opens === 1) {
        assert.match(rendered, /available.*openrouter\/jev-only/);
        overlay.handleInput("\r"); overlay.handleInput(down); overlay.handleInput("\r"); // dirty engine
        overlay.handleInput("\t"); overlay.handleInput(down); overlay.handleInput(down); // backend
        overlay.handleInput("\r"); overlay.handleInput(down); overlay.handleInput("\r"); // dirty policy
        overlay.handleInput("\x1b[17~"); // F6
      } else if (opens === 2) {
        assert.match(rendered, /policy \*/); assert.match(rendered, /Classification backend: classifier/);
        assert.match(rendered, /drafts and pins preserved/);
        overlay.handleInput("\t"); assert.match(overlay.render(140).join("\n"), /Enabled: true/);
        overlay.handleInput("\x1b[15~"); // F5
      } else if (opens === 3) { assert.match(rendered, /diagnostics/); overlay.handleInput("\x1b"); }
      else { assert.match(rendered, /Enabled: true/); overlay.handleInput("\x1b"); overlay.handleInput("\x1b"); }
      overlay.dispose();
    });
  };
  try {
    await showClassifierSettings(f.ctx as never, provider, controller, () => { if (controller.signal.aborted) throw new Error("Cancelled"); });
    assert.equal(opens, 4); assert.equal(refreshes, 1); assert.ok(probes >= 4); assert.equal(f.requests.length, 0);
    await assert.rejects(readFile(join(f.cwd, ".pi", "classifier.json")), { code: "ENOENT" });
    assert.deepEqual(JSON.parse(await readFile(join(f.cwd, ".pi", "decision-policy.json"), "utf8")), f.policy);
  } finally {
    if (child === undefined) delete process.env.PI_TEAMMATE_CHILD; else process.env.PI_TEAMMATE_CHILD = child;
    if (managed === undefined) delete process.env.PI_TEAMMATE_MANAGED_WINDOW; else process.env.PI_TEAMMATE_MANAGED_WINDOW = managed;
    await f.close();
  }
});

test("explicit model refresh failure retains config and reports host errors/pin unavailability", async () => {
  const f = await fixture();
  try {
    configureClassifier({ enabled: true, model: "missing/pin", maxCallsPerSession: 4 });
    const refreshed = await refreshClassifierPanelModels(VERSION, f.registry);
    assert.equal(refreshed.readiness.status, "unavailable");
    assert.match(refreshed.readiness.reason!, /no matching/);
    assert.equal(classifierStatus().model, "missing/pin");
    (f.registry as any).refresh = async () => ({ aborted: false, errors: new Map([["openrouter", new Error("catalog offline")]]) });
    await assert.rejects(refreshClassifierPanelModels(VERSION, f.registry), /catalog offline/);
    assert.equal(classifierStatus().model, "missing/pin");
  } finally { await f.close(); }
});

test("business prerequisites cover 7 domains and are read-only, deterministic new_context, independent models", async () => {
  const f = await fixture();
  try {
    const before = await readFile(join(f.cwd, ".pi", "decision-policy.json"), "utf8");
    const lines = (await classifierBusinessStatus(f.ctx as never)).join("\n");
    for (const domain of ["retry-error", "file-value", "signal-type", "evolve-capture", "evolve-review", "prompt-route", "decision-owner"]) assert.match(lines, new RegExp(domain));
    assert.match(lines, /shadow-only/); assert.match(lines, /\/self-evolve/); assert.match(lines, /independent generation LLM/);
    assert.match(lines, /new_context is always deterministic/); assert.match(lines, /\/classifier handoff/); assert.match(lines, /\/api-manager prompt-enhance/);
    assert.equal(f.requests.length, 0); assert.equal(await readFile(join(f.cwd, ".pi", "decision-policy.json"), "utf8"), before);
  } finally { await f.close(); }
});

test("late raw results, abort and controller destruction cannot update diagnostic UI", async () => {
  const f = await fixture();
  const controller = new AbortController();
  let resolve!: (value: any) => void;
  let entered!: () => void;
  const start = new Promise<void>(r => { entered = r; });
  f.registry.classify = async () => { entered(); return new Promise(r => { resolve = r; }); };
  try {
    const pending = rawClassifierDiagnostic(f.ctx as never, "file-value", "unknown.extension Next action review", controller.signal);
    const rejected = assert.rejects(pending, /cancelled/);
    await start; controller.abort(); await rejected;
    resolve({ stopReason: "stop", provider: "openrouter", model: "jev-only", answers: { value: { type: "choice", choice: "required", confidence: 0.99 } } });
    await new Promise(r => setTimeout(r, 10));
    assert.equal(classifierStatus().callsUsed, 1);
    const signal = new AbortController(); signal.abort();
    await assert.rejects(diagnosticWait(Promise.resolve("late"), signal.signal), /cancelled/);
  } finally { await f.close(); }
});

for (const variant of ["apply", "conditional", "cancel", "session-fence"] as const) {
  test(`handoff TUI uses original preview, explicit human selections and host confirm outside custom: ${variant}`, async () => {
    const f = await fixture();
    const child = process.env.PI_TEAMMATE_CHILD; const managed = process.env.PI_TEAMMATE_MANAGED_WINDOW;
    delete process.env.PI_TEAMMATE_CHILD; delete process.env.PI_TEAMMATE_MANAGED_WINDOW;
    let active = false; let opens = 0; let confirms = 0;
    const controller = new AbortController();
    const original = f.registry.classify;
    f.registry.classify = async (...args: any[]) => {
      assert.equal(active, false, "network must be outside custom overlay");
      const result = await original(args[0], args[1]);
      if (variant === "conditional") result.answers.value.choice = "conditional";
      return result;
    };
    initTodo({ appendEntry() {} } as never); onSessionStart(f.ctx as never);
    try {
      await executeTodo({ action: "create", subject: "Owned task", handoff: { nextSteps: ["Review contract"], files: [{ path: "not-existing.file", value: "unknown", reason: "Review relevant contract" }] } }, f.ctx as never);
      (f.ctx.ui as any).confirm = async (_title: string, message: string) => {
        assert.equal(active, false); confirms++;
        assert.match(message, /not-existing.file/);
        if (variant === "conditional") assert.match(message, /When editing API/);
        if (variant === "session-fence") controller.abort();
        return variant !== "cancel";
      };
      (f.ctx.ui as any).custom = async (factory: any) => {
        active = true;
        return new Promise(resolve => {
          const overlay = factory({ requestRender() {} }, theme, {}, (value: unknown) => { active = false; resolve(value); });
          const rendered = overlay.render(140).join("\n");
          opens++;
          if (rendered.includes("Choose owned Todo")) overlay.handleInput("\r");
          else if (rendered.includes("Handoff machine advice")) { assert.match(rendered, /confidence=0.95.*model=openrouter\/jev-only/); overlay.handleInput("\r"); }
          else if (rendered.includes("Concrete human")) { overlay.handleInput("When editing API"); overlay.handleInput("\r"); }
          else if (rendered.includes("Human selection")) {
            if (rendered.includes("[x]")) { overlay.handleInput(down); overlay.handleInput("\r"); }
            else overlay.handleInput("\r");
          } else { assert.match(rendered, /applied|cancelled/); overlay.handleInput("\r"); }
          overlay.dispose();
        });
      };
      const work = showClassifierDiagnostics(f.ctx as never, controller, () => { if (controller.signal.aborted) throw new Error("Cancelled"); }, "handoff");
      if (variant === "session-fence") await assert.rejects(work, /Cancelled/);
      else await work;
      assert.equal(confirms, 1); assert.equal(f.requests.length, 1);
      const file = getVisibleTasks()[0]!.handoff!.files[0]!;
      assert.equal(file.value, variant === "apply" ? "required" : variant === "conditional" ? "conditional" : "unknown");
      if (variant === "conditional") assert.equal(file.when, "When editing API");
      assert.equal(opens, variant === "conditional" ? 6 : variant === "session-fence" ? 4 : 5);
    } finally {
      onSessionShutdown(f.ctx as never);
      if (child === undefined) delete process.env.PI_TEAMMATE_CHILD; else process.env.PI_TEAMMATE_CHILD = child;
      if (managed === undefined) delete process.env.PI_TEAMMATE_MANAGED_WINDOW; else process.env.PI_TEAMMATE_MANAGED_WINDOW = managed;
      await f.close();
    }
  });
}

test("headless status/modelrefresh actively probe openrouter and bind real session+cwd; reset keeps quota", async () => {
  const f = await fixture();
  let session = "first"; let handler!: (args: string, ctx: any) => Promise<void>;
  const notices: string[] = [];
  (f.ctx as any).sessionManager.getSessionId = () => session;
  (f.ctx as any).hasUI = false;
  f.ctx.ui.notify = (text: string) => { notices.push(text); };
  const pi = { on() {}, registerCommand(_name: string, command: any) { handler = command.handler; } };
  try {
    await writeFile(join(f.cwd, ".pi", "classifier.json"), JSON.stringify({ enabled: true, domains: { "file-value": "jev" } }));
    registerClassifier(pi as never);
    await handler("status", f.ctx);
    assert.match(notices.at(-1)!, /runtime=available/); assert.match(notices.at(-1)!, /selected: openrouter\/jev-only/);
    await handler("test file-value random.extension Next action", f.ctx);
    assert.equal(classifierStatus().callsUsed, 1);
    await handler("modelrefresh", f.ctx); assert.equal(classifierStatus().callsUsed, 1);
    await handler("reset", f.ctx); assert.equal(classifierStatus().callsUsed, 1);
    assert.match(notices.at(-1)!, /spent session quota is not cleared/);
    session = "second"; await handler("status", f.ctx); assert.equal(classifierStatus().callsUsed, 0);
    session = "first"; await handler("status", f.ctx); assert.equal(classifierStatus().callsUsed, 1);
  } finally { await f.close(); }
});

test("TUI modelrefresh retains unavailable saved pin and both dirty drafts on catalog failure", async () => {
  const f = await fixture();
  const child = process.env.PI_TEAMMATE_CHILD; const managed = process.env.PI_TEAMMATE_MANAGED_WINDOW;
  delete process.env.PI_TEAMMATE_CHILD; delete process.env.PI_TEAMMATE_MANAGED_WINDOW;
  let opens = 0;
  const controller = new AbortController();
  const saved = { enabled: false, model: "legacy/unavailable" };
  await writeFile(join(f.cwd, ".pi", "classifier.json"), JSON.stringify(saved));
  configureClassifier({ enabled: true, model: "legacy/unavailable" });
  (f.registry as any).refresh = async () => { throw new Error("refresh offline"); };
  (f.ctx.ui as any).confirm = async () => true;
  (f.ctx.ui as any).custom = async (factory: any) => new Promise(resolve => {
    const overlay = factory({ requestRender() {} }, theme, {}, resolve);
    if (++opens === 1) {
      overlay.handleInput("\r"); overlay.handleInput(down); overlay.handleInput("\r");
      overlay.handleInput("\t"); overlay.handleInput(down); overlay.handleInput(down);
      overlay.handleInput("\r"); overlay.handleInput(down); overlay.handleInput("\r");
      overlay.handleInput("\x1b[17~");
    } else {
      let lines = overlay.render(140).join("\n");
      assert.match(lines, /Classification backend: classifier/); assert.match(lines, /refresh offline/);
      overlay.handleInput("\t"); lines = overlay.render(140).join("\n");
      assert.match(lines, /Enabled: true/); assert.match(lines, /legacy\/unavailable/);
      overlay.handleInput("\x1b"); overlay.handleInput("\x1b");
    }
    overlay.dispose();
  });
  try {
    await showClassifierSettings(f.ctx as never, createClassifierSettingsProvider(), controller, () => { if (controller.signal.aborted) throw new Error("Cancelled"); });
    assert.equal(opens, 2); assert.equal(classifierStatus().model, "legacy/unavailable");
    assert.deepEqual(JSON.parse(await readFile(join(f.cwd, ".pi", "classifier.json"), "utf8")), saved);
  } finally {
    if (child === undefined) delete process.env.PI_TEAMMATE_CHILD; else process.env.PI_TEAMMATE_CHILD = child;
    if (managed === undefined) delete process.env.PI_TEAMMATE_MANAGED_WINDOW; else process.env.PI_TEAMMATE_MANAGED_WINDOW = managed;
    await f.close();
  }
});

for (const missing of ["active", "unknown", "next-step"] as const) {
  test(`handoff diagnostic explains missing ${missing} without model calls or Todo edits`, async () => {
    const f = await fixture();
    const child = process.env.PI_TEAMMATE_CHILD; const managed = process.env.PI_TEAMMATE_MANAGED_WINDOW;
    delete process.env.PI_TEAMMATE_CHILD; delete process.env.PI_TEAMMATE_MANAGED_WINDOW;
    initTodo({ appendEntry() {} } as never); onSessionStart(f.ctx as never);
    const seen: string[] = [];
    if (missing !== "active") await executeTodo({ action: "create", subject: "Owned", handoff: { nextSteps: missing === "next-step" ? [] : ["Review API"], files: missing === "unknown" ? [] : [{ path: "no.file", value: "unknown", reason: "Relevant" }] } }, f.ctx as never);
    const before = JSON.stringify(getVisibleTasks());
    (f.ctx.ui as any).custom = async (factory: any) => new Promise(resolve => {
      const overlay = factory({ requestRender() {} }, theme, {}, resolve);
      seen.push(overlay.render(140).join("\n")); overlay.handleInput("\r"); overlay.dispose();
    });
    try {
      await showClassifierDiagnostics(f.ctx as never, new AbortController(), () => {}, "handoff");
      assert.match(seen.join("\n"), missing === "active" ? /No active\/owned Todo/ : missing === "unknown" ? /No existing unknown/ : /No explicit next action/);
      assert.equal(f.requests.length, 0); assert.equal(JSON.stringify(getVisibleTasks()), before);
    } finally {
      onSessionShutdown(f.ctx as never);
      if (child === undefined) delete process.env.PI_TEAMMATE_CHILD; else process.env.PI_TEAMMATE_CHILD = child;
      if (managed === undefined) delete process.env.PI_TEAMMATE_MANAGED_WINDOW; else process.env.PI_TEAMMATE_MANAGED_WINDOW = managed;
      await f.close();
    }
  });
}

test("business TUI jump only copies an explicit entry; it does not execute/enable the business", async () => {
  const f = await fixture();
  const controller = new AbortController();
  let copied = "";
  (f.ctx.ui as any).setEditorText = (text: string) => { copied = text; };
  (f.ctx.ui as any).custom = async (factory: any) => new Promise(resolve => {
    const overlay = factory({ requestRender() {} }, theme, {}, resolve);
    if (overlay.render(140).join("\n").includes("Copy entry")) overlay.handleInput(down);
    overlay.handleInput("\r"); overlay.dispose();
  });
  try {
    await showClassifierDiagnostics(f.ctx as never, controller, () => {}, "business");
    assert.equal(copied, "/self-evolve"); assert.equal(f.requests.length, 0);
    await assert.rejects(readFile(join(f.cwd, ".pi", "self-evolve.json")), { code: "ENOENT" });
  } finally { await f.close(); }
});

for (const boundary of ["cwd", "session", "abort"] as const) {
  test(`raw diagnostic TUI does not publish late results after ${boundary} fence`, async () => {
    const f = await fixture();
    const controller = new AbortController();
    const originalCwd = f.cwd; const originalSession = f.ctx.sessionManager.getSessionId();
    let session = originalSession;
    f.ctx.sessionManager.getSessionId = () => session;
    let opens = 0; let started!: () => void; let release!: () => void;
    const reached = new Promise<void>(resolve => { started = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    const original = f.registry.classify;
    f.registry.classify = async (model: any, context: any) => { started(); await gate; return original(model, context); };
    (f.ctx.ui as any).custom = async (factory: any) => new Promise(resolve => {
      const overlay = factory({ requestRender() {} }, theme, {}, resolve);
      if (++opens === 2) overlay.handleInput("odd.extension next action");
      overlay.handleInput("\r"); overlay.dispose();
    });
    const assertFresh = () => { if (controller.signal.aborted || f.ctx.cwd !== originalCwd || session !== originalSession) throw new Error("Cancelled or stale"); };
    try {
      const work = showClassifierDiagnostics(f.ctx as never, controller, assertFresh, "test");
      const rejected = assert.rejects(work, /Cancelled or stale/);
      await reached;
      if (boundary === "cwd") (f.ctx as any).cwd = `${originalCwd}-other`;
      else if (boundary === "session") session = "other-session";
      else controller.abort();
      release(); await rejected;
      assert.equal(opens, 2, "late result must not open a result/error overlay");
    } finally { release(); await f.close(); }
  });
}
