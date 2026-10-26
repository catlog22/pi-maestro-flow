/**
 * TUI overlay for the Plan Review & Refine panel.
 *
 * Single overlay with regions: header, Markdown preview (Plan ⇄ latest output),
 * role selector row, model row, input row, and key-hint footer. Owned by
 * plan-refine.ts via renderRefineOverlay(); the run loop and model picker are
 * injected so this component stays free of teammate/extension dependencies.
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  Input,
  Key,
  Markdown,
  type MarkdownTheme,
  matchesKey,
  truncateToWidth,
  visibleWidth,
} from "@earendil-works/pi-tui";
import {
  ansiToSpans,
  line,
  openOverlay,
  resolveGlyphs,
  span,
  type Frame,
  type OverlayController,
  type OverlayKeys,
  type OverlayTheme,
} from "pi-maestro-settings-core/ui";
import type {
  RefineRole,
  RefineRoleSpec,
  RefineSession,
  RefineTurn,
  RefineRunResult,
} from "../tools/plan-refine.ts";

export interface RefineOverlayRunInput {
  role: RefineRole;
  model: string;
  label: string;
  userInput: string;
}

export interface RenderRefineOverlayOptions {
  markdown: string;
  session: RefineSession;
  roles: Record<RefineRole, RefineRoleSpec>;
  pickModel: () => Promise<{ model: string; label: string } | undefined>;
  run: (role: RefineRole, model: string, label: string, userInput: string, signal: AbortSignal) => Promise<RefineRunResult>;
  signal?: AbortSignal;
  now?: () => number;
  /**
   * Optional remote mirror. The local overlay stays the sole authority for the
   * refine session; the mirror only receives state snapshots and may feed user
   * intents back in. A failing or detached mirror never affects this overlay.
   */
  mirror?: RefineOverlayMirror;
}

/** Authoritative state the overlay publishes to a remote mirror. */
export interface RefineOverlayMirrorState {
  readonly session: RefineSession;
  readonly phase: Phase;
  readonly status: string;
  readonly latestTurnId?: string;
}

/** A remote surface's request, replayed against the local authority. */
export type RefineOverlayIntent =
  | { type: "run"; role: RefineRole; model: string; label: string; userInput: string }
  | { type: "apply"; turnId?: string }
  | { type: "discard" }
  | { type: "cancel" }
  | { type: "select_role"; role: RefineRole }
  | { type: "select_model"; model: string; label: string }
  | { type: "snapshot_request" };

export interface RefineOverlayMirror {
  /** Receive the current authoritative state; called after every change. */
  publish(state: RefineOverlayMirrorState): void;
  /** Register the intent handler; returns an unsubscribe function. */
  onIntent(handler: (intent: RefineOverlayIntent) => void): () => void;
}

export interface RenderRefineOverlayResult {
  action: "apply" | "discard" | "cancel";
  session: RefineSession;
  latestOutput?: string;
  latestRole?: RefineRole;
  latestAppliesAs?: RefineRoleSpec["appliesAs"];
}

type PreviewMode = "plan" | "output";
type Phase = "idle" | "running" | "input";
type SelectionRow = "role" | "model" | "input" | "run" | "apply" | "discard";

const SELECTION_ROWS: SelectionRow[] = ["role", "model", "input", "run", "apply", "discard"];
const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

type RefineOverlayContext = Pick<ExtensionContext, "hasUI" | "ui">;

export async function renderRefineOverlay(
  ctx: RefineOverlayContext,
  options: RenderRefineOverlayOptions,
): Promise<RenderRefineOverlayResult> {
  if (!ctx.hasUI) {
    return { action: "cancel", session: options.session };
  }
  const session = options.session;
  let phase: Phase = "idle";
  let previewMode: PreviewMode = "output";
  let selectedTurnIndex = session.turns.length - 1;
  if (session.turns.length === 0) previewMode = "plan";

  const input = new Input();
  let pendingInput = "";
  let status = "";
  let busyError = "";
  let frame = 0;
  let selected = SELECTION_ROWS.indexOf("run");
  let previewOffset = 0;
  let previewMaxOffset = 0;
  let activeRun: {
    controller: AbortController;
    signal: AbortSignal;
    timer: ReturnType<typeof setInterval>;
    startedAt: number;
    onAbort: () => void;
  } | undefined;
  let settled = false;
  let onParentAbort: (() => void) | undefined;
  let host: { requestRender(): void; close(result?: RenderRefineOverlayResult): void } | undefined;

  const now = options.now ?? Date.now;

  let disposeMirrorIntents: (() => void) | undefined;

  /** Publish the authoritative state so a remote mirror can render it. */
  function publishState(): void {
    if (!options.mirror) return;
    try {
      options.mirror.publish({
        session: { ...session, turns: [...session.turns] },
        phase,
        status,
        ...(session.turns.at(-1)?.turnId ? { latestTurnId: session.turns.at(-1)!.turnId } : {}),
      });
    } catch {
      // A detached mirror must never break the local authority.
    }
  }

  function currentPreviewSource(): string {
    if (previewMode === "output" && session.turns.length > 0) {
      return session.turns[selectedTurnIndex]?.output ?? "";
    }
    return options.markdown;
  }

  function doneAction(action: "apply" | "discard" | "cancel"): void {
    if (settled) return;
    settled = true;
    if (onParentAbort) options.signal?.removeEventListener("abort", onParentAbort);
    const last = session.turns.at(-1);
    host?.close({
      action,
      session,
      latestOutput: last?.output,
      latestRole: last?.role,
      latestAppliesAs: last ? options.roles[last.role].appliesAs : undefined,
    });
  }

  function cancelActiveRun(run = activeRun, render = true): void {
    if (!run || activeRun !== run) return;
    activeRun = undefined;
    clearInterval(run.timer);
    run.signal.removeEventListener("abort", run.onAbort);
    run.controller.abort();
    pendingInput = "";
    input.setValue("");
    phase = "idle";
    busyError = "";
    status = `${options.roles[session.currentRole].label} cancelled.`;
    publishState();
    if (render) host?.requestRender();
  }

  if (options.signal) {
    onParentAbort = () => {
      cancelActiveRun(activeRun, false);
      doneAction("cancel");
    };
    options.signal.addEventListener("abort", onParentAbort, { once: true });
    if (options.signal.aborted) onParentAbort();
  }

  async function runRole(overrides?: { role: RefineRole; model: string; label: string; userInput: string }): Promise<void> {
    const spec = options.roles[overrides?.role ?? session.currentRole];
    const model = overrides?.model ?? session.currentModel.model;
    const label = overrides?.label ?? session.currentModel.label;
    if (!model) {
      status = "No model selected — press m to pick one.";
      publishState();
      host?.requestRender();
      return;
    }
    if (overrides) {
      session.currentRole = overrides.role;
      session.currentModel = { model: overrides.model, label: overrides.label };
      pendingInput = overrides.userInput;
    }
    phase = "running";
    busyError = "";
    status = `Running ${spec.label}…`;
    publishState();
    const controller = new AbortController();
    const signal = options.signal
      ? AbortSignal.any([options.signal, controller.signal])
      : controller.signal;
    const timer = setInterval(() => {
      frame = (frame + 1) % SPINNER_FRAMES.length;
      host?.requestRender();
    }, 120);
    const run = {
      controller,
      signal,
      timer,
      startedAt: now(),
      onAbort: () => {},
    };
    run.onAbort = () => cancelActiveRun(run);
    activeRun = run;
    signal.addEventListener("abort", run.onAbort, { once: true });
    if (signal.aborted) {
      cancelActiveRun(run);
      return;
    }
    host?.requestRender();
    const runInput = pendingInput;
    try {
      const result = await options.run(session.currentRole, model, label, runInput, signal);
      if (activeRun !== run || signal.aborted) return;
      if (result.ok && result.output) {
        const turn: RefineTurn = {
          role: session.currentRole,
          modelLabel: label,
          userInput: runInput,
          output: result.output,
          createdAt: result.createdAt ?? new Date().toISOString(),
        };
        session.turns.push(turn);
        selectedTurnIndex = session.turns.length - 1;
        previewMode = "output";
        previewOffset = 0;
        previewMaxOffset = 0;
        status = result.warning
          ? result.warning
          : `${spec.label} done — R toggles Plan/Output, [ ] cycles history.`;
        publishState();
      } else {
        busyError = result.error ?? "unknown error";
        status = `${spec.label} failed: ${busyError}`;
        publishState();
      }
    } catch (error) {
      if (activeRun !== run || signal.aborted) return;
      busyError = error instanceof Error ? error.message : String(error);
      status = `${spec.label} failed: ${busyError}`;
      publishState();
    } finally {
      if (activeRun !== run) return;
      activeRun = undefined;
      clearInterval(run.timer);
      run.signal.removeEventListener("abort", run.onAbort);
      pendingInput = "";
      input.setValue("");
      phase = "idle";
      publishState();
      host?.requestRender();
    }
  }

  async function pickModel(): Promise<void> {
    if (phase === "running") return;
    const picked = await options.pickModel();
    if (picked) {
      session.currentModel = { model: picked.model, label: picked.label };
      status = `Model: ${picked.label}`;
      publishState();
      host?.requestRender();
    }
  }

  function enterInput(): void {
    selected = SELECTION_ROWS.indexOf("input");
    phase = "input";
    input.setValue(pendingInput);
    status = "";
    publishState();
    host?.requestRender();
  }

  function chooseSelection(): void {
    const row = SELECTION_ROWS[selected];
    if (row === "role") {
      session.currentRole = cycleRoleLocal(session.currentRole, 1);
      status = "";
      publishState();
      host?.requestRender();
      return;
    }
    if (row === "model") {
      void pickModel();
      return;
    }
    if (row === "input") {
      enterInput();
      return;
    }
    if (row === "run") {
      void runRole();
      return;
    }
    if (row === "apply") {
      if (session.turns.length === 0) {
        status = "No refine result to apply — run review/refine first.";
        publishState();
        host?.requestRender();
        return;
      }
      doneAction("apply");
      return;
    }
    if (row === "discard") doneAction("discard");
  }

  /** Apply one remote intent against the local authority. */
  function applyIntent(intent: RefineOverlayIntent): void {
    if (settled) return;
    switch (intent.type) {
      case "run":
        if (phase === "running") return;
        void runRole({ role: intent.role, model: intent.model, label: intent.label, userInput: intent.userInput });
        return;
      case "apply":
        if (phase === "running" || session.turns.length === 0) return;
        doneAction("apply");
        return;
      case "discard":
        if (phase === "running") return;
        doneAction("discard");
        return;
      case "cancel":
        doneAction("cancel");
        return;
      case "select_role":
        session.currentRole = intent.role;
        publishState();
        host?.requestRender();
        return;
      case "select_model":
        session.currentModel = { model: intent.model, label: intent.label };
        publishState();
        host?.requestRender();
        return;
      case "snapshot_request":
        publishState();
        return;
    }
  }

  function selectionLine(row: SelectionRow, label: string): Frame[number] {
    const active = phase === "input" ? row === "input" : SELECTION_ROWS[selected] === row;
    const text = `${active ? "›" : " "} ${label}`;
    return [span(text, active ? "selected" : "text", active)];
  }

  const controller: OverlayController<RenderRefineOverlayResult> = {
    attach(h) {
      host = h;
    },
    dispose() {
      cancelActiveRun(activeRun, false);
      doneAction("cancel");
    },
    invalidate() {
      input.invalidate();
    },
    render(w, h, theme) {
      const inner = Math.max(1, w);
      // Body rows: header + rule + preview + mode label + rule + 6 controls
      // + footer + optional status. Preview gets the rest, capped at 16.
      const fixed = 1 + 1 + 1 + 1 + SELECTION_ROWS.length + 1 + (status && phase !== "running" ? 1 : 0);
      const previewHeight = Math.max(2, Math.min(16, h - fixed));
      const markdownTheme = theme ? refineMarkdownTheme(theme) : refineMarkdownTheme({ fg: (_n, t) => t });
      const md = new Markdown(currentPreviewSource(), 0, 0, markdownTheme);
      const rendered = md.render(Math.max(1, inner - 2));
      previewMaxOffset = Math.max(0, rendered.length - previewHeight);
      previewOffset = Math.min(previewOffset, previewMaxOffset);
      const visible = rendered.slice(previewOffset, previewOffset + previewHeight);

      const spec = options.roles[session.currentRole];
      const inputLabel = phase === "input"
        ? input.render(Math.max(1, inner - 10)).join("")
        : pendingInput
          ? `“${truncateToWidth(pendingInput, Math.max(1, inner - 16), "…")}”`
          : "(optional instruction)";
      const controls: Array<[SelectionRow, string]> = [
        ["role", `Role  [${spec.label}]`],
        ["model", `Model [${session.currentModel.label || "— pick (m) —"}]`],
        ["input", `Input ${inputLabel}`],
        ["run", session.turns.length > 0 ? "Re-run review/refine" : "Run review/refine"],
        ["apply", "Apply refine result"],
        ["discard", "Discard (return to Plan)"],
      ];
      const turnCount = session.turns.length;
      const modeLabel = previewMode === "output" && turnCount > 0
        ? (turnCount > 1 ? `Output ${selectedTurnIndex + 1}/${turnCount} (${spec.role})` : `Output (${spec.role})`)
        : "Plan";

      const rows: Frame = [
        line(`role ${spec.role} · turns ${turnCount}`, "dim"),
        line("─".repeat(inner), "dim"),
        ...visible.map((l) => ansiToSpans(` ${l}`)),
      ];
      while (rows.length < previewHeight + 2) rows.push([span("")]);
      const range = rendered.length > previewHeight
        ? ` · ${previewOffset + 1}-${Math.min(rendered.length, previewOffset + previewHeight)}/${rendered.length}`
        : "";
      rows.push(line(`${modeLabel}${range}${turnCount > 1 && previewMode === "output" ? " · [ ] history" : ""}`, "dim"));
      rows.push(line("─".repeat(inner), "dim"));
      rows.push(...controls.map(([row, label], index) => selectionLine(row, `${index + 1}. ${label}`)));
      const footer = phase === "running"
        ? `${SPINNER_FRAMES[frame]!} ${status} ${formatElapsed(activeRun ? now() - activeRun.startedAt : 0)} · Esc cancel`
        : phase === "input"
          ? "Enter run · Esc keep input"
          : "1-6 select · ↑↓ scroll/select · ←→ change role · Enter choose · PgUp/PgDn scroll · m model · i input · R plan/output · [ ] history · a apply · d discard · Esc cancel";
      rows.push(line(truncateToWidth(footer, inner, "…"), "dim"));
      if (status && phase !== "running") {
        rows.push(line(
          truncateToWidth(status, inner, "…"),
          busyError || status.includes("could not be saved") ? "warning" : "dim",
        ));
      }
      return rows;
    },
    handleKey(data, keys) {
      if (phase === "running") {
        if (keys.cancel(data)) cancelActiveRun();
        return true;
      }
      if (phase === "input") {
        if (keys.cancel(data)) {
          pendingInput = input.getValue();
          phase = "idle";
          status = "Input kept — Enter to run, i to resume.";
          return true;
        }
        if (keys.confirm(data)) {
          pendingInput = input.getValue();
          input.setValue("");
          void runRole();
          return true;
        }
        input.handleInput(data);
        return true;
      }
      if (keys.cancel(data)) {
        doneAction("cancel");
        return true;
      }
      if (keys.up(data)) {
        if (previewOffset >= previewMaxOffset) {
          if (selected > 0) selected -= 1;
          else previewOffset = Math.max(0, previewOffset - 1);
        } else previewOffset = Math.max(0, previewOffset - 1);
        status = "";
        return true;
      }
      if (keys.down(data)) {
        if (previewOffset >= previewMaxOffset) selected = Math.min(SELECTION_ROWS.length - 1, selected + 1);
        else previewOffset = Math.min(previewMaxOffset, previewOffset + 1);
        status = "";
        return true;
      }
      if (keys.pageUp(data)) {
        previewOffset = Math.max(0, previewOffset - 5);
        return true;
      }
      if (keys.pageDown(data)) {
        previewOffset = Math.min(previewMaxOffset, previewOffset + 5);
        return true;
      }
      if (matchesKey(data, Key.left) && SELECTION_ROWS[selected] === "role") {
        session.currentRole = cycleRoleLocal(session.currentRole, -1);
        status = "";
        return true;
      }
      if (matchesKey(data, Key.right) && SELECTION_ROWS[selected] === "role") {
        session.currentRole = cycleRoleLocal(session.currentRole, 1);
        status = "";
        return true;
      }
      if (data === "m" || data === "M") {
        selected = SELECTION_ROWS.indexOf("model");
        void pickModel();
        return true;
      }
      if (data === "i" || data === "I") {
        enterInput();
        return true;
      }
      if (/^[1-6]$/.test(data)) {
        selected = Number(data) - 1;
        chooseSelection();
        return true;
      }
      if (keys.confirm(data)) {
        chooseSelection();
        return true;
      }
      if (data === "a" || data === "A") {
        if (session.turns.length === 0) {
          status = "No refine result to apply — run review/refine first.";
          return true;
        }
        doneAction("apply");
        return true;
      }
      if (data === "d" || data === "D") {
        doneAction("discard");
        return true;
      }
      if (/^[rR]$/.test(data) && session.turns.length > 0) {
        previewMode = previewMode === "output" ? "plan" : "output";
        if (previewMode === "output") selectedTurnIndex = session.turns.length - 1;
        previewOffset = 0;
        previewMaxOffset = 0;
        return true;
      }
      if ((data === "[" || data === "]") && session.turns.length > 1 && previewMode === "output") {
        const direction = data === "]" ? 1 : -1;
        selectedTurnIndex = (selectedTurnIndex + direction + session.turns.length) % session.turns.length;
        previewOffset = 0;
        previewMaxOffset = 0;
        return true;
      }
      return false;
    },
  };

  if (options.mirror) {
    try {
      disposeMirrorIntents = options.mirror.onIntent(applyIntent);
    } catch {
      disposeMirrorIntents = undefined;
    }
    publishState();
  }

  const result = await openOverlay<RenderRefineOverlayResult>(
    ctx,
    {
      kind: "card",
      title: "Review & Refine",
      width: "92%",
      minWidth: 40,
      maxHeight: 32,
      anchor: "center",
      hints: [
        { key: "1-6", verb: "select" },
        { key: "Enter", verb: "choose" },
        { key: "m", verb: "model" },
        { key: "a", verb: "apply" },
        { key: "d", verb: "discard" },
        { key: "Esc", verb: "cancel" },
      ],
    },
    controller,
    {
      utils: {
        measure: visibleWidth,
        clip: (text, width, ellipsis) => truncateToWidth(text, width, ellipsis),
      },
      glyphs: resolveGlyphs("nerd"),
      matchesKey: (data, keyId) => matchesKey(data, keyId as never),
    },
  );

  disposeMirrorIntents?.();
  disposeMirrorIntents = undefined;
  return result ?? { action: "cancel", session: options.session };
}

function formatElapsed(elapsedMs: number): string {
  const seconds = Math.max(0, Math.floor(elapsedMs / 1000));
  if (seconds < 60) return `${seconds}s`;
  return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

function cycleRoleLocal(role: RefineRole, direction: 1 | -1): RefineRole {
  const order: RefineRole[] = ["reviewer", "decomposer", "optimizer", "brainstormer"];
  const index = order.indexOf(role);
  const next = (index + direction + order.length) % order.length;
  return order[next]!;
}

function refineMarkdownTheme(theme: OverlayTheme): MarkdownTheme {
  const bold = (text: string) => theme.bold ? theme.bold(text) : text;
  return {
    heading: (text) => theme.fg("accent", bold(text)),
    link: (text) => theme.fg("accent", text),
    linkUrl: (text) => theme.fg("dim", text),
    code: (text) => theme.fg("warning", text),
    codeBlock: (text) => text,
    codeBlockBorder: (text) => theme.fg("dim", text),
    quote: (text) => text,
    quoteBorder: (text) => theme.fg("dim", text),
    hr: (text) => theme.fg("dim", text),
    listBullet: (text) => theme.fg("accent", text),
    bold,
    italic: (text) => text,
    strikethrough: (text) => theme.fg("dim", text),
    underline: (text) => text,
  };
}
