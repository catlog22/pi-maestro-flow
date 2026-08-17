import {
  Key,
  matchesKey,
  type Component,
  type Focusable,
  decodeKittyPrintable,
  truncateToWidth,
  visibleWidth,
} from "@earendil-works/pi-tui";
import {
  BracketedPasteDecoder,
  removeLastGrapheme,
  sanitizeSingleLineInput,
} from "./input-text.ts";
import type { KnowledgeReconciliationMatch, KnowledgeResolutionChoice } from "../knowledge/cli-adapter.ts";
import {
  type CandidateSummary,
  type KnowledgeCenterView,
  type KnowledgeSeverity,
  actionLabel,
  canPromote,
  dispositionLabel,
  eligibilityLabel,
  promoteBlockReason,
  resolutionChoicesFor,
} from "../knowledge/view-model.ts";

export type KnowledgeOverlayAction =
  | { kind: "refresh" }
  | { kind: "resolve"; candidateId: string; as: KnowledgeResolutionChoice; target?: string; reason: string }
  | { kind: "resolve-batch"; candidateIds: string[]; as: KnowledgeResolutionChoice; reason: string }
  | { kind: "promote"; candidateId: string }
  | { kind: "promote-all" };

export interface KnowledgeOverlayParams {
  view: KnowledgeCenterView;
  requestRender: () => void;
  close: () => void;
  onAction: (action: KnowledgeOverlayAction) => void | Promise<void>;
}

type OverlayMode =
  | "list"
  | "detail"
  | "health"
  | "resolve-choice"
  | "resolve-reason"
  | "batch-scope"
  | "batch-as"
  | "batch-reason"
  | "confirm";

type BatchScope = "review_required" | "stale-observed";

const SEVERITY_COLOR: Record<KnowledgeSeverity, string> = {
  conflict: "31",
  supersede: "33",
  duplicate: "35",
  extends: "34",
  unique: "32",
  unknown: "2",
};

const SEVERITY_GLYPH: Record<KnowledgeSeverity, string> = {
  conflict: "✖",
  supersede: "↑",
  duplicate: "≡",
  extends: "↳",
  unique: "✚",
  unknown: "·",
};

const BATCH_AS_CHOICES: KnowledgeResolutionChoice[] = ["unique", "duplicate", "related", "conflict", "supersede"];
const MAX_MATCHES = 3;
const MAX_VISIBLE_ROWS = 9;
const MAX_CONFIRM_PREVIEW = 5;

export class KnowledgeOverlay implements Component, Focusable {
  focused = false;
  private view: KnowledgeCenterView;
  private mode: OverlayMode = "list";
  private selected = 0;
  private triage = false;
  private pending = false;
  private status = "";

  private resolveChoices: KnowledgeResolutionChoice[] = [];
  private resolveChoiceIndex = 0;
  private resolveAs: KnowledgeResolutionChoice | null = null;
  private reasonText = "";
  private readonly pasteDecoder = new BracketedPasteDecoder();

  private batchScopeChoices: Array<{ key: BatchScope; label: string }> = [];
  private batchScopeIndex = 0;
  private batchAsIndex = 0;
  private batchIds: string[] = [];
  private batchAs: KnowledgeResolutionChoice | null = null;

  private confirmAction: KnowledgeOverlayAction | null = null;
  private confirmLabel = "";
  private confirmPreview: string[] = [];

  constructor(private readonly params: KnowledgeOverlayParams) {
    this.view = params.view;
  }

  invalidate(): void {}
  dispose(): void {}

  update(view: KnowledgeCenterView): void {
    this.view = view;
    this.selected = clampIndex(this.selected, this.activeCandidates().length);
    this.params.requestRender();
  }

  render(width: number): string[] {
    const safeWidth = Math.max(1, Math.min(width, 120));
    if (safeWidth < 20) return [this.renderCompact(safeWidth)];
    switch (this.mode) {
      case "health":
        return this.renderHealth(safeWidth);
      case "detail":
        return this.renderDetail(safeWidth);
      case "resolve-choice":
        return this.renderChoice(safeWidth, `Resolve ${this.selectedSummary()?.candidate.candidate_id ?? "candidate"}`, this.resolveChoices, this.resolveChoiceIndex);
      case "resolve-reason":
        return this.renderReason(safeWidth, `Resolve as ${fg("36", this.resolveAs ?? "?")}`, this.resolveTargetLabel());
      case "batch-scope":
        return this.renderBatchScope(safeWidth);
      case "batch-as":
        return this.renderChoice(safeWidth, `Batch resolve ${this.batchIds.length} candidate(s)`, BATCH_AS_CHOICES, this.batchAsIndex);
      case "batch-reason":
        return this.renderReason(safeWidth, `Batch resolve as ${fg("36", this.batchAs ?? "?")}`, `${this.batchIds.length} candidate(s)`);
      case "confirm":
        return this.renderConfirm(safeWidth);
      default:
        return this.renderList(safeWidth);
    }
  }

  handleInput(data: string): void {
    if (this.pending) return;
    if (this.mode === "resolve-reason" || this.mode === "batch-reason") return this.handleReasonInput(data);
    if (this.mode === "confirm") return this.handleConfirmInput(data);
    if (this.mode === "resolve-choice") return this.handleChoiceInput(data);
    if (this.mode === "batch-scope") return this.handleBatchScopeInput(data);
    if (this.mode === "batch-as") return this.handleBatchAsInput(data);

    if (matchesKey(data, Key.escape)) {
      if (this.mode === "list") this.params.close();
      else this.mode = "list";
      this.params.requestRender();
      return;
    }
    if (matchesKey(data, "a")) {
      this.mode = this.mode === "health" ? "list" : "health";
      this.params.requestRender();
      return;
    }
    if (matchesKey(data, "r")) {
      void this.execute({ kind: "refresh" });
      return;
    }
    if (matchesKey(data, Key.shift("p"))) {
      this.startPromoteAll();
      return;
    }
    if (this.mode === "health") return;

    if (this.mode === "list") {
      if (matchesKey(data, "t")) {
        this.triage = !this.triage;
        this.selected = clampIndex(this.selected, this.activeCandidates().length);
        this.params.requestRender();
        return;
      }
      if (matchesKey(data, Key.shift("b"))) {
        this.startBatch();
        return;
      }
      if (matchesKey(data, Key.up) || matchesKey(data, "k")) {
        this.selected = wrapIndex(this.selected - 1, this.activeCandidates().length);
        this.params.requestRender();
        return;
      }
      if (matchesKey(data, Key.down) || matchesKey(data, "j")) {
        this.selected = wrapIndex(this.selected + 1, this.activeCandidates().length);
        this.params.requestRender();
        return;
      }
      if (isEnter(data) && this.activeCandidates().length > 0) {
        this.mode = "detail";
        this.params.requestRender();
      }
      return;
    }

    // detail mode write keys
    if (matchesKey(data, "x")) this.startResolve();
    else if (matchesKey(data, "p")) this.startPromote();
  }

  private handleChoiceInput(data: string): void {
    if (matchesKey(data, Key.escape)) {
      this.mode = "detail";
      this.params.requestRender();
      return;
    }
    if (matchesKey(data, Key.up) || matchesKey(data, "k")) {
      this.resolveChoiceIndex = wrapIndex(this.resolveChoiceIndex - 1, this.resolveChoices.length);
      this.params.requestRender();
      return;
    }
    if (matchesKey(data, Key.down) || matchesKey(data, "j")) {
      this.resolveChoiceIndex = wrapIndex(this.resolveChoiceIndex + 1, this.resolveChoices.length);
      this.params.requestRender();
      return;
    }
    const digit = Number.parseInt(decodeKittyPrintable(data) ?? data, 10);
    if (Number.isInteger(digit) && digit >= 1 && digit <= this.resolveChoices.length) {
      this.pickResolutionChoice(digit - 1);
      return;
    }
    if (isEnter(data)) this.pickResolutionChoice(this.resolveChoiceIndex);
  }

  private handleBatchScopeInput(data: string): void {
    if (matchesKey(data, Key.escape)) {
      this.mode = "list";
      this.params.requestRender();
      return;
    }
    if (matchesKey(data, Key.up) || matchesKey(data, "k")) {
      this.batchScopeIndex = wrapIndex(this.batchScopeIndex - 1, this.batchScopeChoices.length);
      this.params.requestRender();
      return;
    }
    if (matchesKey(data, Key.down) || matchesKey(data, "j")) {
      this.batchScopeIndex = wrapIndex(this.batchScopeIndex + 1, this.batchScopeChoices.length);
      this.params.requestRender();
      return;
    }
    const digit = Number.parseInt(decodeKittyPrintable(data) ?? data, 10);
    if (Number.isInteger(digit) && digit >= 1 && digit <= this.batchScopeChoices.length) {
      this.pickBatchScope(digit - 1);
      return;
    }
    if (isEnter(data)) this.pickBatchScope(this.batchScopeIndex);
  }

  private handleBatchAsInput(data: string): void {
    if (matchesKey(data, Key.escape)) {
      this.mode = "batch-scope";
      this.params.requestRender();
      return;
    }
    if (matchesKey(data, Key.up) || matchesKey(data, "k")) {
      this.batchAsIndex = wrapIndex(this.batchAsIndex - 1, BATCH_AS_CHOICES.length);
      this.params.requestRender();
      return;
    }
    if (matchesKey(data, Key.down) || matchesKey(data, "j")) {
      this.batchAsIndex = wrapIndex(this.batchAsIndex + 1, BATCH_AS_CHOICES.length);
      this.params.requestRender();
      return;
    }
    const digit = Number.parseInt(decodeKittyPrintable(data) ?? data, 10);
    if (Number.isInteger(digit) && digit >= 1 && digit <= BATCH_AS_CHOICES.length) {
      this.pickBatchAs(digit - 1);
      return;
    }
    if (isEnter(data)) this.pickBatchAs(this.batchAsIndex);
  }

  private handleReasonInput(data: string): void {
    const isBatch = this.mode === "batch-reason";
    if (matchesKey(data, Key.escape)) {
      this.mode = isBatch ? "batch-as" : "resolve-choice";
      this.params.requestRender();
      return;
    }
    if (isEnter(data)) {
      const reason = this.reasonText.trim();
      if (!reason) {
        this.status = "reason is required";
        this.params.requestRender();
        return;
      }
      if (isBatch) this.confirmBatch(reason);
      else this.confirmResolve(reason);
      return;
    }
    if (matchesKey(data, Key.backspace) || data === "\b" || data === "\x7f") {
      this.reasonText = removeLastGrapheme(this.reasonText);
      this.params.requestRender();
      return;
    }
    for (const token of this.pasteDecoder.feed(data)) {
      if (token.kind === "paste") {
        this.reasonText += token.text;
        continue;
      }
      const decoded = decodeKittyPrintable(token.text);
      if (decoded !== undefined) {
        this.reasonText += decoded;
        continue;
      }
      if (token.text.startsWith("\x1b")) continue;
      const printable = sanitizeSingleLineInput(token.text);
      if (printable) this.reasonText += printable;
    }
    this.params.requestRender();
  }

  private handleConfirmInput(data: string): void {
    if (matchesKey(data, Key.escape)) {
      this.confirmAction = null;
      this.confirmPreview = [];
      this.mode = "list";
      this.params.requestRender();
      return;
    }
    if (isEnter(data) && this.confirmAction) {
      const action = this.confirmAction;
      this.confirmAction = null;
      this.confirmPreview = [];
      void this.execute(action);
    }
  }

  private startResolve(): void {
    const summary = this.selectedSummary();
    if (!summary) return;
    const choices = resolutionChoicesFor(summary.disposition);
    if (choices.length === 0) {
      this.status = "no resolution available for this disposition";
      this.params.requestRender();
      return;
    }
    this.resolveChoices = choices;
    this.resolveChoiceIndex = 0;
    this.resolveAs = null;
    this.reasonText = "";
    this.status = "";
    this.mode = "resolve-choice";
    this.params.requestRender();
  }

  private pickResolutionChoice(index: number): void {
    this.resolveAs = this.resolveChoices[index];
    this.mode = "resolve-reason";
    this.params.requestRender();
  }

  private confirmResolve(reason: string): void {
    const summary = this.selectedSummary();
    if (!summary || !this.resolveAs) return;
    const target = this.resolveTarget(summary, this.resolveAs);
    this.confirmAction = {
      kind: "resolve",
      candidateId: summary.candidate.candidate_id,
      as: this.resolveAs,
      target,
      reason,
    };
    this.confirmLabel = `Resolve ${summary.candidate.candidate_id} as ${this.resolveAs}?`;
    this.confirmPreview = [summary.candidate.title];
    this.mode = "confirm";
    this.params.requestRender();
  }

  private startBatch(): void {
    const reviewRequired = this.view.candidates.filter((c) => c.eligibility === "review_required").length;
    const staleObserved = this.view.candidates.filter((c) => c.staleObserved).length;
    this.batchScopeChoices = [
      { key: "review_required", label: `all review_required (${reviewRequired})` },
      { key: "stale-observed", label: `stale observed only (${staleObserved})` },
    ];
    this.batchScopeIndex = 0;
    this.batchAsIndex = 0;
    this.status = "";
    this.mode = "batch-scope";
    this.params.requestRender();
  }

  private pickBatchScope(index: number): void {
    const scope = this.batchScopeChoices[index]?.key;
    if (!scope) return;
    const matched = this.view.candidates.filter((c) =>
      scope === "review_required" ? c.eligibility === "review_required" : c.staleObserved);
    if (matched.length === 0) {
      this.status = "no candidates match this scope";
      this.mode = "list";
      this.params.requestRender();
      return;
    }
    this.batchIds = matched.map((c) => c.candidate.candidate_id);
    this.batchAsIndex = 0;
    this.batchAs = null;
    this.reasonText = "";
    this.mode = "batch-as";
    this.params.requestRender();
  }

  private pickBatchAs(index: number): void {
    this.batchAs = BATCH_AS_CHOICES[index];
    this.reasonText = "";
    this.mode = "batch-reason";
    this.params.requestRender();
  }

  private confirmBatch(reason: string): void {
    if (!this.batchAs) return;
    this.confirmAction = { kind: "resolve-batch", candidateIds: this.batchIds, as: this.batchAs, reason };
    this.confirmLabel = `Resolve ${this.batchIds.length} candidate(s) as ${this.batchAs}?`;
    this.confirmPreview = this.batchIds;
    this.mode = "confirm";
    this.params.requestRender();
  }

  private startPromote(): void {
    const summary = this.selectedSummary();
    if (!summary) return;
    const block = promoteBlockReason(summary);
    if (block) {
      this.status = `promote blocked: ${block}`;
      this.params.requestRender();
      return;
    }
    this.confirmAction = { kind: "promote", candidateId: summary.candidate.candidate_id };
    this.confirmLabel = `Promote ${summary.candidate.candidate_id} → ${summary.candidate.target}?`;
    this.confirmPreview = [summary.candidate.title];
    this.mode = "confirm";
    this.params.requestRender();
  }

  private startPromoteAll(): void {
    this.confirmAction = { kind: "promote-all" };
    this.confirmLabel = `Promote ALL eligible candidates in ${this.view.sessionId || "session"}?`;
    this.confirmPreview = [];
    this.mode = "confirm";
    this.params.requestRender();
  }

  private renderCompact(width: number): string {
    const { counts } = this.view;
    const content = counts.total > 0
      ? `KDC ${counts.total} · review ${counts.reviewRequired}`
      : "KDC · no candidates";
    return truncateToWidth(content, width, "…");
  }

  private renderList(width: number): string[] {
    const inner = width - 2;
    const { counts } = this.view;
    const header = this.view.sessionId ? `Knowledge · ${this.view.sessionId}` : "Knowledge center";
    const orderTag = this.triage ? fg("36", "triage") : fg("2", "severity");
    const rows = [
      fitLine(`${header} · order: ${orderTag}`, inner),
      fitLine(
        `${counts.total} candidate(s) · ${counts.missing} missing · ${counts.stale} stale · `
        + `${counts.reviewRequired} review · ${counts.eligible} eligible · ${counts.staleObserved} stale-obs`,
        inner,
      ),
      rule(inner),
    ];
    const list = this.activeCandidates();
    if (this.view.error) {
      rows.push(fitLine(fg("31", `Error: ${this.view.error}`), inner));
    } else if (list.length === 0) {
      rows.push(fitLine("○ no pending candidates", inner));
    } else {
      const start = Math.max(0, Math.min(this.selected - 4, list.length - MAX_VISIBLE_ROWS));
      for (let index = start; index < Math.min(list.length, start + MAX_VISIBLE_ROWS); index++) {
        rows.push(this.renderCandidateRow(list[index], index === this.selected, inner));
      }
    }
    rows.push(this.renderHealthStrip(inner));
    if (this.status) rows.push(fitLine(this.status, inner));
    rows.push(fitSegments(inner, ["Enter detail", "t order", "B batch", "P promote-all", "a health", "r refresh", "Esc close"]));
    return frame(rows, width);
  }

  private renderCandidateRow(summary: CandidateSummary, selected: boolean, width: number): string {
    const marker = selected ? "›" : " ";
    const glyph = fg(SEVERITY_COLOR[summary.severity], SEVERITY_GLYPH[summary.severity]);
    const disposition = fg(SEVERITY_COLOR[summary.severity], dispositionLabel(summary.disposition).padEnd(9, " "));
    const freshness = freshnessTag(summary.freshness);
    const stage = summary.candidate.stage === "corroborated" ? fg("36", "◆") : fg("2", "◇");
    const stale = summary.staleObserved ? fg("33", "⏰") : "";
    const age = summary.ageDays >= 1 ? fg("2", `${Math.floor(summary.ageDays)}d`) : "";
    const title = `${stage}${stale} ${summary.candidate.title}`;
    const prefix = `${marker} ${glyph} ${disposition} ${freshness} ${age} `.replace("  ", " ");
    const budget = Math.max(1, width - visibleWidth(prefix));
    return fitLine(prefix + truncateToWidth(title, budget, "…"), width);
  }

  private renderHealthStrip(width: number): string {
    const health = this.view.health;
    if (!health) return fitLine(fg("2", "health: unavailable (a)"), width);
    const spec = health.spec;
    const parts = [
      `spec ${spec.active}/${spec.total}`,
      spec.deprecated > 0 ? `dep ${spec.deprecated}` : "",
      spec.contested > 0 ? fg("31", `contested ${spec.contested}`) : "",
      spec.stale > 0 ? fg("33", `stale ${spec.stale}`) : "",
      `knowhow ${health.knowhow.active}/${health.knowhow.total}`,
    ].filter(Boolean);
    return fitLine(fg("2", "▪ ") + parts.join(" · "), width);
  }

  private renderDetail(width: number): string[] {
    const inner = width - 2;
    const summary = this.selectedSummary();
    const rows = [fitLine("Candidate detail", inner), rule(inner)];
    if (!summary) {
      rows.push(fitLine("○ no candidate selected", inner));
      rows.push(fitSegments(inner, ["Esc back"]));
      return frame(rows, width);
    }
    const candidate = summary.candidate;
    rows.push(fitLine(fg("1", candidate.title), inner));
    rows.push(fitLine(
      `${actionLabel(candidate)} · ${candidate.status} · ${candidate.stage} · ×${candidate.occurrences} · ${Math.floor(summary.ageDays)}d old`,
      inner,
    ));
    rows.push(fitLine(
      `disposition: ${fg(SEVERITY_COLOR[summary.severity], dispositionLabel(summary.disposition))} · `
      + `eligibility: ${eligibilityLabel(summary.eligibility)} · freshness: ${freshnessTag(summary.freshness)}`,
      inner,
    ));
    if (summary.candidate.review.blocked_reason) {
      rows.push(fitLine(fg("35", `blocked: ${summary.candidate.review.blocked_reason}`), inner));
    }
    if (summary.staleObserved) rows.push(fitLine(fg("33", "⏰ stale observed-only candidate"), inner));
    if (summary.canonicalId) rows.push(fitLine(`canonical: ${summary.canonicalId}`, inner));
    rows.push(rule(inner));

    const matches = candidate.reconciliation?.matches.slice(0, MAX_MATCHES) ?? [];
    if (matches.length === 0) {
      rows.push(fitLine(fg("2", "no reconciliation matches"), inner));
    } else {
      for (const match of matches) rows.push(...this.renderMatch(match, inner));
    }

    const block = promoteBlockReason(summary);
    if (block) rows.push(fitLine(fg("33", `promote: ${block}`), inner));

    if (this.status) rows.push(fitLine(this.status, inner));
    const controls = ["Esc back", "r refresh"];
    if (resolutionChoicesFor(summary.disposition).length > 0) controls.splice(0, 0, "x resolve");
    if (canPromote(summary)) controls.splice(controls.length - 1, 0, "p promote");
    controls.splice(controls.length - 1, 0, "P promote-all");
    rows.push(fitSegments(inner, controls));
    return frame(rows, width);
  }

  private renderMatch(match: KnowledgeReconciliationMatch, width: number): string[] {
    const score = match.scores.composite.toFixed(2);
    const head = `${fg("33", match.relation)} → ${match.knowledge_id} (${score})`;
    const rows = [fitLine(head, width), fitLine(fg("2", `   ${match.title}`), width)];
    const evidence = match.evidence[0];
    if (evidence) rows.push(fitLine(fg("2", `   ${evidence}`), width));
    return rows;
  }

  private renderChoice(width: number, title: string, choices: readonly string[], selectedIndex: number): string[] {
    const inner = width - 2;
    const rows = [fitLine(title, inner), fitLine(fg("2", "choose:"), inner), rule(inner)];
    choices.forEach((choice, index) => {
      const marker = index === selectedIndex ? "›" : " ";
      rows.push(fitLine(`${marker} ${fg("36", String(index + 1))} ${choice}`, inner));
    });
    rows.push(fitSegments(inner, ["Enter select", "Esc back"]));
    return frame(rows, width);
  }

  private renderReason(width: number, title: string, targetLabel: string): string[] {
    const inner = width - 2;
    const rows = [
      fitLine(title, inner),
      fitLine(`target: ${targetLabel}`, inner),
      rule(inner),
      fitLine(fg("2", "reason (evidence-backed):"), inner),
      fitLine(`${this.reasonText}▏`, inner),
    ];
    if (this.status) rows.push(fitLine(fg("33", this.status), inner));
    rows.push(fitSegments(inner, ["Enter confirm", "Esc back"]));
    return frame(rows, width);
  }

  private renderBatchScope(width: number): string[] {
    const inner = width - 2;
    const rows = [fitLine("Batch resolve — choose scope", inner), rule(inner)];
    this.batchScopeChoices.forEach((choice, index) => {
      const marker = index === this.batchScopeIndex ? "›" : " ";
      rows.push(fitLine(`${marker} ${fg("36", String(index + 1))} ${choice.label}`, inner));
    });
    if (this.status) rows.push(fitLine(fg("33", this.status), inner));
    rows.push(fitSegments(inner, ["Enter select", "Esc back"]));
    return frame(rows, width);
  }

  private renderConfirm(width: number): string[] {
    const inner = width - 2;
    const rows = [fitLine(fg("33", `✓ ${this.confirmLabel}`), inner)];
    for (const line of this.confirmPreview.slice(0, MAX_CONFIRM_PREVIEW)) {
      rows.push(fitLine(fg("2", `  ${line}`), inner));
    }
    if (this.confirmPreview.length > MAX_CONFIRM_PREVIEW) {
      rows.push(fitLine(fg("2", `  …+${this.confirmPreview.length - MAX_CONFIRM_PREVIEW} more`), inner));
    }
    rows.push(fitLine("Enter confirm · Esc back", inner));
    return frame(rows, width);
  }

  private renderHealth(width: number): string[] {
    const inner = width - 2;
    const rows = [fitLine("Knowledge health", inner), rule(inner)];
    const health = this.view.health;
    if (!health) {
      rows.push(fitLine(fg("2", "health unavailable — run: maestro knowledge audit --scope all"), inner));
    } else {
      const spec = health.spec;
      rows.push(fitLine(fg("1", "Spec"), inner));
      rows.push(fitLine(
        `  active ${spec.active}/${spec.total} · deprecated ${spec.deprecated} · contested ${spec.contested} · stale ${spec.stale}`,
        inner,
      ));
      rows.push(fitLine(
        `  chains ${spec.chains} · dangling ${spec.dangling} · avg freshness ${spec.avgFreshness.toFixed(2)}`,
        inner,
      ));
      const knowhow = health.knowhow;
      rows.push(fitLine(fg("1", "Knowhow"), inner));
      rows.push(fitLine(
        `  active ${knowhow.active}/${knowhow.total} · deprecated ${knowhow.deprecated} · invalid ${knowhow.invalid}`,
        inner,
      ));
      rows.push(fitLine(
        `concentration (gini): impression ${health.concentration.impression.toFixed(2)} · `
        + `consumption ${health.concentration.consumption.toFixed(2)}`,
        inner,
      ));
      if (health.bySource.length > 0) {
        rows.push(rule(inner));
        rows.push(fitLine(fg("1", "Exposure by source (impressions)"), inner));
        const max = Math.max(...health.bySource.map((entry) => entry.impressions), 1);
        const barWidth = Math.max(6, Math.min(24, inner - 22));
        for (const entry of health.bySource) {
          const filled = Math.round((entry.impressions / max) * barWidth);
          const bar = fg("36", "█".repeat(filled)) + fg("2", "░".repeat(Math.max(0, barWidth - filled)));
          rows.push(fitLine(`${entry.sourceType.padEnd(9, " ")} ${bar} ${entry.impressions}`, inner));
        }
      }
      if (health.findings.length > 0) {
        rows.push(rule(inner));
        for (const finding of health.findings.slice(0, 4)) {
          rows.push(fitLine(`${fg("33", finding.severity)} ${finding.message}`, inner));
        }
      }
      if (this.view.upstreamAdvisories.length > 0) {
        rows.push(rule(inner));
        rows.push(fitLine(fg("1", "Maestro2 upstream advisories"), inner));
        for (const advisory of this.view.upstreamAdvisories) {
          rows.push(fitLine(`${fg("33", advisory.id)} ${advisory.message}`, inner));
        }
      }
    }
    if (this.status) rows.push(fitLine(this.status, inner));
    rows.push(fitSegments(inner, ["a back", "r refresh", "Esc close"]));
    return frame(rows, width);
  }

  private activeCandidates(): CandidateSummary[] {
    return this.triage ? this.view.triageCandidates : this.view.candidates;
  }

  private selectedSummary(): CandidateSummary | undefined {
    return this.activeCandidates()[this.selected];
  }

  private resolveTarget(summary: CandidateSummary, as: KnowledgeResolutionChoice): string | undefined {
    if (as === "unique") return undefined;
    return summary.canonicalId ?? summary.candidate.reconciliation?.matches[0]?.knowledge_id;
  }

  private resolveTargetLabel(): string {
    const summary = this.selectedSummary();
    if (!summary || !this.resolveAs) return "—";
    if (this.resolveAs === "unique") return "(new knowledge)";
    return this.resolveTarget(summary, this.resolveAs) ?? "—";
  }

  private async execute(action: KnowledgeOverlayAction): Promise<void> {
    this.pending = true;
    this.status = `${action.kind}…`;
    this.params.requestRender();
    try {
      await this.params.onAction(action);
      this.status = `${action.kind} done`;
      this.mode = "list";
    } catch (error) {
      this.status = `Action failed: ${errorMessage(error)}`;
      this.mode = "list";
    } finally {
      this.pending = false;
      this.params.requestRender();
    }
  }
}

function freshnessTag(freshness: "fresh" | "stale" | "missing" | "blocked"): string {
  if (freshness === "blocked") return fg("35", "blocked");
  if (freshness === "missing") return fg("31", "missing");
  if (freshness === "stale") return fg("33", "stale");
  return fg("32", "fresh");
}

function fg(code: string, text: string): string {
  if (!code) return text;
  return `\x1b[${code}m${text}\x1b[0m`;
}

function isEnter(data: string): boolean {
  return matchesKey(data, Key.enter);
}

function wrapIndex(index: number, length: number): number {
  if (length === 0) return 0;
  return (index + length) % length;
}

function clampIndex(index: number, length: number): number {
  return length === 0 ? 0 : Math.max(0, Math.min(index, length - 1));
}

function fitSegments(width: number, segments: readonly string[]): string {
  const kept: string[] = [];
  for (const segment of segments) {
    const candidate = [...kept, segment].join(" · ");
    if (visibleWidth(candidate) > width) break;
    kept.push(segment);
  }
  if (kept.length === 0) return truncateToWidth(segments[0] ?? "", width, "…");
  return kept.join(" · ");
}

function fitLine(value: string, width: number): string {
  return truncateToWidth(value, Math.max(1, width), "…");
}

function rule(width: number): string {
  return "─".repeat(Math.max(1, width));
}

function frame(rows: readonly string[], width: number): string[] {
  if (width < 3) return rows.map((row) => fitLine(row, width));
  const inner = width - 2;
  return [
    `╭${"─".repeat(inner)}╮`,
    ...rows.map((row) => {
      const content = fitLine(row, inner);
      return `│${content}${" ".repeat(Math.max(0, inner - visibleWidth(content)))}│`;
    }),
    `╰${"─".repeat(inner)}╯`,
  ];
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
