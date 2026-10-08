import { VERSION, type ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey, type Component, type Focusable } from "@earendil-works/pi-tui";
import { type JsonValue, type SettingsSnapshot } from "pi-maestro-settings-core/v1";
import { supportsCustomOverlay } from "pi-maestro-settings-core/ui";
import { DecisionPolicySchema, type DecisionPolicy } from "../decision-policy/config.ts";
import { openDecisionPolicyPanel } from "../decision-policy/extension.ts";
import { classifierStatus, listClassifyDomains } from "pi-maestro-teammate/v1/classify";
import { applyHandoffAdvice, listHandoffAdviceTasks, previewHandoffAdvice, type HandoffAdviceSelection } from "../classifier/handoff-advice.ts";
import { businessPolicyDiagnostic, classifierBusinessStatus, diagnosticText, diagnosticWait, DIAGNOSTIC_INPUT_LIMIT, rawClassifierDiagnostic, readClassifierShadow } from "../classifier/diagnostics.ts";
import { configuredPanelValues, refreshClassifierPanelModels, panelChanges, saveClassifierPanel, type PanelModelCatalog } from "../classifier/panel-model.ts";
import type { ClassifierSettingsProvider } from "../classifier/settings-provider.ts";
import { fit, frame, type FrameTheme } from "./ui-primitives.ts";
import { BracketedPasteDecoder, removeLastGrapheme, sanitizeSingleLineInput } from "./input-text.ts";

type Group = "engine" | "policy";
type PanelIntent = "close" | "savePolicy" | "diagnostics" | "modelrefresh";
interface Row { key: string; label: string; choices?: JsonValue[]; numeric?: boolean; min?: number; max?: number; model?: "classifier" | "llm"; readonly?: boolean }
export interface ClassifierPanelState {
  snapshot: SettingsSnapshot;
  engine: Record<string, JsonValue>;
  engineInitial: Record<string, JsonValue>;
  policy: DecisionPolicy;
  policyInitial: DecisionPolicy;
  group: Group;
  selected: number;
  notice: string;
}
export interface ClassifierPanelParams {
  state: ClassifierPanelState;
  engineRows: () => Row[];
  classifierModels: PanelModelCatalog;
  llmModels: PanelModelCatalog;
  theme: FrameTheme;
  requestRender(): void;
  done(intent: PanelIntent): void;
  saveEngine(changes: ReturnType<typeof panelChanges>): Promise<SettingsSnapshot>;
  signal: AbortSignal;
  onDispose?: () => void;
}
const policyRows: Row[] = [
  { key: "ask.mode", label: "Ask mode", choices: ["off", "shadow", "enforce"] },
  { key: "selfEvolve.mode", label: "Self-evolve mode", choices: ["off", "shadow", "enforce"] },
  { key: "backend", label: "Classification backend", choices: ["auto", "classifier", "llm"] },
  { key: "minConfidence", label: "Minimum confidence (0.5–1)", numeric: true, min: 0.5, max: 1 },
  ...(["classification", "advice"] as const).flatMap(stage => [
    { key: `${stage}.model`, label: `${stage} LLM`, model: "llm" as const },
    { key: `${stage}.timeoutMs`, label: `${stage} timeout (ms)`, numeric: true, min: 100, max: 120_000 },
    { key: `${stage}.maxCallsPerSession`, label: `${stage} budget`, numeric: true, min: 1, max: 1000 },
  ]),
  { key: "rules", label: "Confirmed rules (read-only)", readonly: true },
];
const copyPolicy = (policy: DecisionPolicy): DecisionPolicy => structuredClone(policy);

/** One overlay, independent file drafts, inline confirmation (no nested host UI). */
export class ClassifierSettingsOverlay implements Component, Focusable {
  focused = false;
  private mode: "menu" | "edit" | "pick" | "confirm" = "menu";
  private input = "";
  private cursor = 0;
  private choices: { value: JsonValue; label: string }[] = [];
  private saving = false;
  private closed = false;
  private discardArmed = false;
  private readonly pasteDecoder = new BracketedPasteDecoder();
  constructor(private readonly params: ClassifierPanelParams) {}
  invalidate(): void {}
  dispose(): void { const cancelled = !this.closed; this.closed = true; if (cancelled) this.params.onDispose?.(); }
  private get state() { return this.params.state; }
  private rows() { return this.state.group === "engine" ? this.params.engineRows() : policyRows; }
  private row(): Row { const rows = this.rows(); this.state.selected = Math.min(this.state.selected, rows.length - 1); return rows[this.state.selected]!; }
  private value(row: Row): JsonValue {
    if (this.state.group === "engine") return this.state.engine[row.key] ?? "off";
    if (row.key === "rules") return `${this.state.policy.rules.length} confirmed · /skill:decision-policy to edit`;
    const [key, sub] = row.key.split(".");
    const value = this.state.policy[key as keyof DecisionPolicy];
    return (sub ? (value as Record<string, JsonValue>)[sub] : value) as JsonValue;
  }
  private set(row: Row, value: JsonValue): void {
    if (this.state.group === "engine") this.state.engine[row.key] = value;
    else {
      if ((row.key === "ask.mode" || row.key === "selfEvolve.mode") && value !== "off") {
        const domains = row.key === "ask.mode" ? ["ask"] : ["evolve-capture", "evolve-review"];
        if (!this.state.policy.rules.some(rule => domains.includes(rule.domain))) {
          this.state.notice = "Cannot enable policy without confirmed rules. Run /skill:decision-policy.";
          return;
        }
      }
      const [key, sub] = row.key.split(".");
      if (sub) (this.state.policy[key as keyof DecisionPolicy] as Record<string, unknown>)[sub] = value;
      else (this.state.policy as unknown as Record<string, unknown>)[key!] = value;
    }
    this.discardArmed = false;
    this.state.notice = "Unsaved draft; Ctrl+S saves only this file.";
  }
  private dirty(group = this.state.group): boolean {
    return group === "engine" ? panelChanges(this.state.engineInitial, this.state.engine).length > 0 : JSON.stringify(this.state.policy) !== JSON.stringify(this.state.policyInitial);
  }
  private filteredChoices() { return this.choices.filter(choice => choice.label.toLowerCase().includes(this.input.toLowerCase())); }
  render(width: number): string[] {
    const w = Math.max(1, Math.min(width, 140));
    const row = this.row();
    if (w < 4) return [fit("Classifier", w)];
    const inner = w - 2;
    const rows = [fit(`Classifier / Decision policy · ${this.state.group} ${this.dirty() ? "*" : ""}`, inner)];
    if (this.mode === "confirm") {
      rows.push(fit(`Save only .pi/${this.state.group === "engine" ? "classifier" : "decision-policy"}.json?`, inner));
      if (this.state.group === "engine") for (const change of panelChanges(this.state.engineInitial, this.state.engine)) rows.push(fit(`${change.key} → ${JSON.stringify(change.operation === "set" ? change.value : "default")}`, inner));
      else for (const item of policyRows.filter(item => !item.readonly)) rows.push(fit(`${item.label} → ${String(this.value(item))}`, inner));
      rows.push(fit("Enter confirm · Esc back", inner));
    } else if (this.mode === "edit") {
      rows.push(fit(row.label, inner), fit(`> ${this.input}`, inner), fit("Enter accept · Esc back · Ctrl+U clear", inner));
    } else if (this.mode === "pick") {
      rows.push(fit(`${row.label} · search: ${this.input}`, inner));
      const choices = this.filteredChoices();
      const start = Math.max(0, this.cursor - 5);
      choices.slice(start, start + 10).forEach((choice, index) => rows.push(fit(`${start + index === this.cursor ? ">" : " "} ${choice.label}`, inner)));
      if (!choices.length) rows.push(fit("No matching candidates", inner));
      if (row.model) {
        const catalog = row.model === "classifier" ? this.params.classifierModels : this.params.llmModels;
        if (catalog.unavailable) rows.push(fit(catalog.unavailable, inner));
        const current = String(this.value(row));
        if (current && current !== "inherit" && !catalog.options.some(option => option.reference === current)) rows.push(fit(`Configured unavailable (preserved): ${current}`, inner));
      }
      rows.push(fit("↑↓ select · Enter choose · Esc back", inner));
    } else {
      const all = this.rows();
      const start = Math.max(0, this.state.selected - 7);
      all.slice(start, start + 14).forEach((item, index) => rows.push(fit(`${start + index === this.state.selected ? ">" : " "} ${item.label}: ${String(this.value(item))}`, inner)));
      if (this.state.group === "engine") {
        const effective = this.state.snapshot.effective.values.find(value => value.key === row.key);
        const configured = this.state.snapshot.configured.values.find(value => value.key === row.key);
        rows.push(fit(`configured: ${configured?.state === "set" ? String(configured.value) : "default"} · effective: ${String(effective?.value)}`, inner));
        rows.push(fit(`envOverride: ${effective?.source === "runtime" ? effective.resource?.id : "none"}`, inner));
        if (configured?.state === "invalid") rows.push(fit(`Configuration unavailable: ${configured.messageKey ?? "invalid file"}; repair before saving.`, inner));
        const status = classifierStatus();
        if (this.params.classifierModels.unavailable) rows.push(fit(this.params.classifierModels.unavailable, inner));
        rows.push(fit(`Runtime: ${status.enabled ? "enabled" : "disabled"} · ${status.runtimeStatus ?? "unknown"} · model ${diagnosticText(status.effectiveModel) || "none"}`, inner));
        rows.push(fit(`Reason: ${diagnosticText(status.runtimeReason) || "none"} · calls ${status.callsUsed}/${status.maxCalls} · cache ${status.cacheSize}`, inner));
      } else {
        rows.push(fit("Policy modes are independent of classifier/domain modes; advice always needs an LLM.", inner));
        rows.push(fit(this.state.policy.backend === "auto" ? "auto: usable classifier first, then classification LLM fallback."
          : this.state.policy.backend === "classifier" ? "classifier-only: no classification LLM fallback; unavailable means human."
          : "llm: bypass classifier for classification.", inner));
        rows.push(fit(`Configured/effective: saved revision ${this.state.policyInitial.revision} · envOverride: none`, inner));
        rows.push(fit(`Rules read-only: ${this.state.policy.rules.map(rule => `${rule.id} (${rule.domain})`).join(", ") || "none; /skill:decision-policy"}`, inner));
        if (this.params.llmModels.unavailable) rows.push(fit(this.params.llmModels.unavailable, inner));
      }
      rows.push(fit("↑↓ select · Enter edit · Tab file · Ctrl+S save · Ctrl+R cancel file · Esc close", inner));
      rows.push(fit("F5 diagnostics/business/shadow/handoff · F6 model refresh (preserves drafts/pins)", inner));
    }
    if (this.state.notice) rows.push(fit(this.state.notice, inner));
    return frame(rows, w, this.params.theme);
  }
  handleInput(data: string): void {
    if (this.closed || this.params.signal.aborted) return;
    if (data === "\x1b") { this.handleKey(data); return; }
    for (const token of this.pasteDecoder.feed(data)) {
      if (token.kind === "paste") {
        if (!this.saving && (this.mode === "pick" || this.mode === "edit")) {
          this.input = `${this.input}${token.text}`.slice(0, 4096);
          this.cursor = 0;
          this.redraw();
        }
      } else this.handleKey(token.text);
    }
  }
  private handleKey(data: string): void {
    if (this.closed || this.params.signal.aborted) return;
    if (matchesKey(data, Key.escape)) {
      if (this.saving) { this.finish("close"); return; }
      if (this.mode !== "menu") { this.mode = "menu"; this.input = ""; this.redraw(); return; }
      if ((this.dirty("engine") || this.dirty("policy")) && !this.discardArmed) { this.discardArmed = true; this.state.notice = "Unsaved drafts · Esc again discards both files."; this.redraw(); return; }
      this.finish("close"); return;
    }
    if (this.saving) return;
    if (this.mode === "confirm") {
      if (matchesKey(data, Key.enter)) {
        if (this.state.group === "policy") this.finish("savePolicy");
        else void this.save();
      }
      return;
    }
    if (this.mode === "pick" || this.mode === "edit") {
      if (this.mode === "pick" && (matchesKey(data, Key.up) || matchesKey(data, Key.down))) {
        const count = this.filteredChoices().length;
        this.cursor = Math.max(0, Math.min(count - 1, this.cursor + (matchesKey(data, Key.up) ? -1 : 1)));
      } else if (matchesKey(data, Key.enter)) {
        if (this.mode === "pick") {
          const choice = this.filteredChoices()[this.cursor];
          if (choice) { this.set(this.row(), choice.value); this.mode = "menu"; }
        } else {
          const value = Number(this.input);
          const row = this.row();
          if (!this.input.trim() || !Number.isFinite(value) || (row.key !== "minConfidence" && !Number.isSafeInteger(value))
            || value < (row.min ?? 1) || (row.max !== undefined && value > row.max)) {
            this.state.notice = `Invalid numeric value; allowed ${row.min ?? 1}–${row.max ?? "safe integer"}.`;
          } else { this.set(row, value); this.mode = "menu"; }
        }
      } else if (matchesKey(data, Key.ctrl("u"))) { this.input = ""; this.cursor = 0; }
      else if (matchesKey(data, Key.backspace)) { this.input = removeLastGrapheme(this.input); this.cursor = 0; }
      else if (!data.includes("\x1b")) { this.input = `${this.input}${sanitizeSingleLineInput(data)}`.slice(0, 4096); this.cursor = 0; }
      this.redraw(); return;
    }
    if (matchesKey(data, Key.f5)) { this.finish("diagnostics"); return; }
    if (matchesKey(data, Key.f6)) { this.finish("modelrefresh"); return; }
    if (matchesKey(data, Key.tab)) { this.state.group = this.state.group === "engine" ? "policy" : "engine"; this.state.selected = 0; this.discardArmed = false; }
    else if (matchesKey(data, Key.up) || matchesKey(data, Key.down)) { this.state.selected = (this.state.selected + this.rows().length + (matchesKey(data, Key.up) ? -1 : 1)) % this.rows().length; this.discardArmed = false; }
    else if (matchesKey(data, Key.ctrl("r"))) {
      if (this.state.group === "engine") this.state.engine = { ...this.state.engineInitial };
      else this.state.policy = copyPolicy(this.state.policyInitial);
      this.state.notice = "Current file draft cancelled; other file unchanged.";
    } else if (matchesKey(data, Key.ctrl("s"))) {
      if (!this.dirty()) this.state.notice = "No changes in this file.";
      else if (this.state.group === "policy" && !DecisionPolicySchema.safeParse(this.state.policy).success) this.state.notice = "Invalid policy draft; confidence 0.5–1, timeout 100–120000, budget 1–1000; enabling needs confirmed rules (/skill:decision-policy).";
      else this.mode = "confirm";
    } else if (matchesKey(data, Key.enter) || data === " ") this.edit();
    this.redraw();
  }
  private edit(): void {
    const row = this.row();
    if (row.readonly) { this.state.notice = "Rules are read-only. Run /skill:decision-policy."; return; }
    this.input = ""; this.cursor = 0;
    if (row.numeric) { this.mode = "edit"; this.input = String(this.value(row)); }
    else {
      this.mode = "pick";
      if (row.model) {
        const catalog = row.model === "classifier" ? this.params.classifierModels : this.params.llmModels;
        this.choices = [{ value: row.model === "classifier" ? "" : "inherit", label: row.model === "classifier" ? "Auto (classifier runtime)" : "inherit (session LLM)" }, ...catalog.options.map(option => ({ value: option.reference, label: option.label }))];
      } else this.choices = (row.choices ?? []).map(value => ({ value, label: String(value) }));
    }
  }
  private async save(): Promise<void> {
    this.saving = true; this.state.notice = "Saving classifier.json…"; this.redraw();
    try {
      const snapshot = await this.params.saveEngine(panelChanges(this.state.engineInitial, this.state.engine));
      if (this.closed || this.params.signal.aborted) return;
      this.state.snapshot = snapshot;
      this.state.engineInitial = configuredPanelValues(snapshot);
      this.state.engine = { ...this.state.engineInitial };
      this.state.notice = "classifier.json saved; policy draft untouched.";
    } catch (error) {
      if (this.closed || this.params.signal.aborted) return;
      this.state.notice = `Save failed: ${error instanceof Error ? error.message : String(error)}`;
    } finally {
      if (!this.closed && !this.params.signal.aborted) { this.saving = false; this.mode = "menu"; this.redraw(); }
    }
  }
  private finish(intent: PanelIntent) { this.closed = true; this.params.done(intent); }
  private redraw() { if (!this.closed) this.params.requestRender(); }
}

export function classifierEngineRows(provider: ClassifierSettingsProvider): Row[] {
  // Provider describe is synchronous for this implementation; live domains are read on each render.
  const description = provider.describe({ context: { cwd: "", locale: "en" } });
  if (description instanceof Promise) throw new Error("Classifier settings description unexpectedly asynchronous");
  return description.settings.map(setting => ({
    key: setting.key,
    label: description.catalogs?.en?.[setting.labelKey] ?? setting.key,
    ...(setting.key === "classifier.model" ? { model: "classifier" as const } : {}),
    ...(setting.editor.kind === "integer" ? { numeric: true, min: setting.editor.min, max: setting.editor.max } : {}),
    ...(setting.editor.kind === "boolean" ? { choices: [false, true] } : {}),
    ...(setting.editor.kind === "enum" ? { choices: setting.editor.options?.map(option => option.value) } : {}),
  }));
}

export async function showClassifierSettings(ctx: ExtensionCommandContext, provider: ClassifierSettingsProvider, controller: AbortController, assertFresh: () => void): Promise<void> {
  if (!supportsCustomOverlay(ctx)) throw new Error("Classifier settings require an interactive TUI");
  const context = { cwd: ctx.cwd, locale: "en" as const };
  const ui = ctx.ui;
  let policyHandle: Awaited<ReturnType<typeof openDecisionPolicyPanel>> | undefined;
  let closeOverlay: (() => void) | undefined;
  const abort = () => { closeOverlay?.(); policyHandle?.close(); };
  controller.signal.addEventListener("abort", abort, { once: true });
  try {
    policyHandle = await openDecisionPolicyPanel(ctx);
    assertFresh();
    const snapshot = await provider.read({ context });
    const engine = configuredPanelValues(snapshot);
    let { classifierModels, llmModels } = await diagnosticWait(refreshClassifierPanelModels(VERSION, ctx.modelRegistry, controller.signal, false), controller.signal);
    assertFresh();
    const state: ClassifierPanelState = { snapshot, engine, engineInitial: { ...engine }, policy: copyPolicy(policyHandle.policy), policyInitial: copyPolicy(policyHandle.policy), group: "engine", selected: 0, notice: "Separate files: save/cancel each group independently." };
    while (true) {
      assertFresh();
      const intent = await ctx.ui.custom<PanelIntent>((tui, theme, _keys, done) => {
        closeOverlay = () => done("close");
        return new ClassifierSettingsOverlay({ state, classifierModels, llmModels, theme, signal: controller.signal,
          engineRows: () => classifierEngineRows(provider), requestRender: () => tui.requestRender(),
          done: value => { closeOverlay = undefined; if (value === "close") controller.abort(); done(value); },
          onDispose: () => controller.abort(),
          saveEngine: async changes => {
            const committed = await saveClassifierPanel(provider, context, state.snapshot, changes, assertFresh);
            if (controller.signal.aborted) ui.notify(`Classifier settings committed to ${context.cwd}/.pi/classifier.json before the panel closed.`, "info");
            return committed;
          },
        });
      }, { overlay: true, overlayOptions: { width: "90%", maxHeight: "90%", anchor: "center" } });
      closeOverlay = undefined;
      if (intent === "close") break;
      assertFresh();
      if (intent === "diagnostics" || intent === "modelrefresh") {
        try {
          if (intent === "diagnostics") await showClassifierDiagnostics(ctx, controller, assertFresh);
          else {
            const refreshed = await diagnosticWait(refreshClassifierPanelModels(VERSION, ctx.modelRegistry, controller.signal), controller.signal);
            assertFresh();
            classifierModels = refreshed.classifierModels; llmModels = refreshed.llmModels;
            state.notice = `Models refreshed: ${refreshed.readiness.status} · ${diagnosticText(refreshed.readiness.model) || "none"} · ${diagnosticText(refreshed.readiness.reason) || "ready"}; drafts and pins preserved. ${classifierModels.unavailable ?? ""} ${llmModels.unavailable ?? ""}`;
          }
        } catch (error) { assertFresh(); state.notice = `Diagnostic/refresh failed: ${diagnosticText(error)}; drafts and pins preserved.`; }
        continue;
      }
      // The custom overlay has settled; host confirmation cannot nest/deadlock here.
      try {
        const saved = await policyHandle.save(copyPolicy(state.policy), state.policyInitial.revision, controller.signal);
        try { assertFresh(); }
        catch (error) {
          if (!saved) throw error;
          ui.notify(`Decision policy settings committed to ${context.cwd}/.pi/decision-policy.json before the panel closed.`, "info");
          break;
        }
        if (saved) { state.policy = copyPolicy(saved); state.policyInitial = copyPolicy(saved); state.notice = "decision-policy.json saved; classifier draft untouched."; }
        else state.notice = "Policy save cancelled; draft preserved.";
      } catch (error) {
        assertFresh();
        policyHandle.close();
        policyHandle = await openDecisionPolicyPanel(ctx);
        assertFresh();
        state.policy = copyPolicy(policyHandle.policy);
        state.policyInitial = copyPolicy(policyHandle.policy);
        state.notice = `Policy save failed: ${String(error)}; policy reloaded, engine draft preserved.`;
      }
    }
  } finally {
    controller.signal.removeEventListener("abort", abort);
    policyHandle?.close();
    controller.abort();
  }
}

interface DiagnosticPrompt {
  title: string;
  lines?: string[];
  choices?: { value: string; label: string }[];
  input?: boolean;
  initial?: string;
}
/** Bounded read-only diagnostic overlay; no network or host UI is invoked inside it. */
export class ClassifierDiagnosticOverlay implements Component, Focusable {
  focused = false;
  private closed = false;
  private cursor = 0;
  private text: string;
  private readonly paste = new BracketedPasteDecoder();
  constructor(private readonly prompt: DiagnosticPrompt, private readonly theme: FrameTheme,
    private readonly signal: AbortSignal, private readonly done: (value: string | undefined) => void,
    private readonly redraw: () => void, private readonly onDispose: () => void) { this.text = prompt.initial ?? ""; }
  invalidate(): void {}
  dispose(): void { if (!this.closed) { this.closed = true; this.onDispose(); } }
  render(width: number): string[] {
    const w = Math.max(1, Math.min(width, 140));
    if (w < 4) return [fit("Diagnostics", w)];
    const inner = w - 2;
    const lines = [fit(diagnosticText(this.prompt.title), inner)];
    if (this.prompt.input) lines.push(fit(`> ${this.text}`, inner), fit(`${this.text.length}/${DIAGNOSTIC_INPUT_LIMIT} chars · Enter run · Ctrl+U clear · Esc cancel`, inner));
    else {
      const choices = this.prompt.choices;
      const content = choices ? choices.map((choice, index) => `${index === this.cursor ? ">" : " "} ${choice.label}`) : this.prompt.lines ?? [];
      const start = choices ? Math.max(0, this.cursor - 5) : this.cursor;
      lines.push(...content.slice(start, start + 14).map(line => fit(diagnosticText(line, 3000), inner)));
      lines.push(fit(choices ? "↑↓ select · Enter choose · Esc back" : "↑↓ scroll · Enter/Esc back", inner));
    }
    return frame(lines, w, this.theme);
  }
  handleInput(data: string): void {
    if (this.closed || this.signal.aborted) return;
    if (data === "\x1b") { this.finish(undefined); return; }
    for (const token of this.paste.feed(data)) {
      const value = token.text;
      if (token.kind === "input" && matchesKey(value, Key.escape)) { this.finish(undefined); return; }
      if (token.kind === "input" && matchesKey(value, Key.enter)) {
        if (this.prompt.input) { if (this.text.trim()) this.finish(this.text); }
        else this.finish(this.prompt.choices?.[this.cursor]?.value);
      } else if (!this.prompt.input && token.kind === "input" && (matchesKey(value, Key.up) || matchesKey(value, Key.down))) {
        const max = this.prompt.choices ? this.prompt.choices.length - 1 : Math.max(0, (this.prompt.lines?.length ?? 0) - 14);
        this.cursor = Math.max(0, Math.min(max, this.cursor + (matchesKey(value, Key.up) ? -1 : 1)));
      } else if (this.prompt.input) {
        if (token.kind === "input" && matchesKey(value, Key.ctrl("u"))) this.text = "";
        else if (token.kind === "input" && matchesKey(value, Key.backspace)) this.text = removeLastGrapheme(this.text);
        else if (!value.includes("\x1b")) this.text = `${this.text}${sanitizeSingleLineInput(value)}`.slice(0, DIAGNOSTIC_INPUT_LIMIT);
      }
      if (!this.closed) this.redraw();
    }
  }
  private finish(value: string | undefined) { this.closed = true; this.done(value); }
}

export async function showClassifierDiagnostics(ctx: ExtensionCommandContext, controller: AbortController, assertFresh: () => void, action?: string): Promise<void> {
  const signal = controller.signal;
  const prompt = async (params: DiagnosticPrompt): Promise<string | undefined> => {
    assertFresh();
    let close: (() => void) | undefined;
    const abort = () => close?.();
    signal.addEventListener("abort", abort, { once: true });
    try {
      const value = await ctx.ui.custom<string | undefined>((tui, theme, _keys, done) => {
        const overlay = new ClassifierDiagnosticOverlay(params, theme, signal, result => { close = undefined; done(result); }, () => tui.requestRender(), () => controller.abort());
        close = () => { overlay.handleInput("\x1b"); done(undefined); };
        return overlay;
      }, { overlay: true, overlayOptions: { width: "90%", maxHeight: "90%", anchor: "center" } });
      assertFresh();
      return value;
    } finally { signal.removeEventListener("abort", abort); }
  };
  const view = async (title: string, lines: string[]) => { await prompt({ title, lines }); };
  const choose = (title: string, values: string[]) => prompt({ title, choices: values.map(value => ({ value, label: value })) });
  const handoff = async () => {
    const tasks = listHandoffAdviceTasks(ctx);
    if (!tasks.length) { await view("Handoff", ["No active/owned Todo available in this canonical root session."]); return; }
    const taskId = await prompt({ title: `${tasks.some(task => task.status === "in_progress") ? "Choose owned Todo" : "Choose owned Todo (no active Todo; explicit choice required)"} · machine advice is not authorization`,  choices: tasks.map(task => ({ value: task.taskId, label: `#${task.taskId} ${task.subject} · ${task.status} · unknown=${task.unknownFiles} · ${task.nextAction ? "next step present" : "no explicit next step"}` })) });
    if (!taskId) return;
    assertFresh();
    // Original process-local preview object MUST survive to apply; never clone/serialize it.
    const preview = await diagnosticWait(previewHandoffAdvice(ctx, taskId, signal), signal);
    assertFresh();
    if (preview.status !== "ready") { await view("Handoff blocked", [preview.error ?? "No advice."]); return; }
    await view("Handoff machine advice (no changes yet)", preview.rows.flatMap(row => [
      `${row.path}: ${row.label} · confidence=${row.confidence.toFixed(2)} · layer=${row.layer} · model=${row.model ?? "none"}`,
      `Reason: ${row.reason} · ${row.error ?? "eligible"}`,
    ]));
    const selections = new Map<string, HandoffAdviceSelection>();
    while (true) {
      const choice = await prompt({ title: `Human selection · ${selections.size} selected · real host confirmation follows`, choices: [
        ...preview.rows.filter(row => row.eligible || row.needsWhen).map(row => ({ value: row.path, label: `${selections.has(row.path) ? "[x]" : "[ ]"} ${row.path} → ${row.label} · ${row.confidence.toFixed(2)} · ${row.model ?? "none"}${row.needsWhen ? " · needs human when" : ""}` })),
        { value: "\0apply", label: "Confirm selected advice with host (does not auto-apply)" },
      ] });
      if (!choice) return;
      if (choice === "\0apply") {
        if (!selections.size) { await view("Handoff", ["Select eligible advice first; no automatic Todo change."]); continue; }
        assertFresh();
        // prompt/custom has fully settled: B owns actual host confirmation and in-queue CAS.
        const applied = await applyHandoffAdvice(ctx, preview, [...selections.values()], signal);
        assertFresh();
        await view("Handoff result", [`${applied.status}: ${applied.appliedPaths.map(path => diagnosticText(path)).join(", ") || "no changes"}`, applied.error ?? "Machine advice was applied only after real human confirmation."]);
        return;
      }
      if (selections.has(choice)) { selections.delete(choice); continue; }
      const row = preview.rows.find(row => row.path === choice)!;
      let when = row.when;
      if (row.needsWhen) {
        when = await prompt({ title: "Concrete human conditional trigger (when)", input: true });
        if (!when?.trim()) continue;
      }
      selections.set(choice, { path: choice, ...(when ? { when } : {}) });
    }
  };
  while (true) {
    const selected = action ?? await choose("Classifier diagnostics (saved state; drafts untouched)", ["test", "businessdiagnose", "business", "shadow", "handoff"]);
    if (!selected) return;
    try {
      if (selected === "handoff") await handoff();
      else if (selected === "business") {
        const lines = await classifierBusinessStatus(ctx); assertFresh();
        await view("Business status / entry commands (read-only)", lines);
        const entry = await choose("Copy entry to editor only (never executes a switch/command)", ["Back", "/self-evolve", "/classifier handoff", "/enhance", "/api-manager prompt-enhance", "/skill:decision-policy"]);
        assertFresh();
        if (entry && entry !== "Back") { ctx.ui.setEditorText(entry); ctx.ui.notify("Entry copied to editor; close settings and explicitly submit it if wanted. No business configuration was changed.", "info"); return; }
      }
      else if (selected === "shadow") { const summary = await readClassifierShadow(); assertFresh(); await view("Recent shadow sample", summary.lines); }
      else {
        const domain = await choose(selected === "test" ? "Raw registered domain" : "Business policy domain (advice:false)", selected === "test" ? listClassifyDomains() : ["ask", "evolve-capture", "evolve-review"]);
        if (!domain) { if (action) return; continue; }
        const text = await prompt({ title: `Test ${domain} (uses existing budget; no force enable)`, input: true });
        if (!text) { if (action) return; continue; }
        assertFresh();
        ctx.ui.notify("Classifier diagnostic running outside custom UI; /classifier cancel or host cancellation aborts the consumer.", "info");
        const lines = selected === "test" ? await rawClassifierDiagnostic(ctx, domain, text, signal) : await businessPolicyDiagnostic(ctx, domain as "ask" | "evolve-capture" | "evolve-review", text, signal);
        assertFresh();
        await view("Diagnostic result", lines);
      }
    } catch (error) { assertFresh(); await view("Diagnostic unavailable", [diagnosticText(error, 2000)]); }
    if (action) return;
  }
}
