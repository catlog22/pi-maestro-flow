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

  const result = await ctx.ui.custom<RenderRefineOverlayResult>(
    (tui, theme, _keybindings, done) => {
      const input = new Input();
      let pendingInput = "";
      let status = "";
      let busyError = "";
      let frame = 0;
      let selected = SELECTION_ROWS.indexOf("run");
      let previewOffset = 0;
      let previewMaxOffset = 0;
      let lastWidth = 80;
      let activeRun: {
        controller: AbortController;
        signal: AbortSignal;
        timer: ReturnType<typeof setInterval>;
        startedAt: number;
        onAbort: () => void;
      } | undefined;
      let settled = false;
      let onParentAbort: (() => void) | undefined;

      const markdownTheme = refineMarkdownTheme(theme);
      const now = options.now ?? Date.now;

      function currentPreviewSource(): string {
        if (previewMode === "output" && session.turns.length > 0) {
          return session.turns[selectedTurnIndex]?.output ?? "";
        }
        return options.markdown;
      }

      function latestOutput(): string | undefined {
        return session.turns.at(-1)?.output;
      }

      function doneAction(action: "apply" | "discard" | "cancel"): void {
        if (settled) return;
        settled = true;
        if (onParentAbort) options.signal?.removeEventListener("abort", onParentAbort);
        const last = session.turns.at(-1);
        done({
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
        if (render) tui.requestRender();
      }

      if (options.signal) {
        onParentAbort = () => {
          cancelActiveRun(activeRun, false);
          doneAction("cancel");
        };
        options.signal.addEventListener("abort", onParentAbort, { once: true });
        if (options.signal.aborted) onParentAbort();
      }

      async function runRole(): Promise<void> {
        const spec = options.roles[session.currentRole];
        const model = session.currentModel.model;
        const label = session.currentModel.label;
        if (!model) {
          status = "No model selected — press m to pick one.";
          tui.requestRender();
          return;
        }
        phase = "running";
        busyError = "";
        status = `Running ${spec.label}…`;
        const controller = new AbortController();
        const signal = options.signal
          ? AbortSignal.any([options.signal, controller.signal])
          : controller.signal;
        const timer = setInterval(() => {
          frame = (frame + 1) % SPINNER_FRAMES.length;
          tui.requestRender();
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
        tui.requestRender();
        try {
          const result = await options.run(session.currentRole, model, label, pendingInput, signal);
          if (activeRun !== run || signal.aborted) return;
          if (result.ok && result.output) {
            const turn: RefineTurn = {
              role: session.currentRole,
              modelLabel: label,
              userInput: pendingInput,
              output: result.output,
              createdAt: new Date().toISOString(),
            };
            session.turns.push(turn);
            selectedTurnIndex = session.turns.length - 1;
            previewMode = "output";
            previewOffset = 0;
            previewMaxOffset = 0;
            status = `${spec.label} done — R toggles Plan/Output, [ ] cycles history.`;
          } else {
            busyError = result.error ?? "unknown error";
            status = `${spec.label} failed: ${busyError}`;
          }
        } catch (error) {
          if (activeRun !== run || signal.aborted) return;
          busyError = error instanceof Error ? error.message : String(error);
          status = `${spec.label} failed: ${busyError}`;
        } finally {
          if (activeRun !== run) return;
          activeRun = undefined;
          clearInterval(run.timer);
          run.signal.removeEventListener("abort", run.onAbort);
          pendingInput = "";
          input.setValue("");
          phase = "idle";
          tui.requestRender();
        }
      }

      async function pickModel(): Promise<void> {
        if (phase === "running") return;
        const picked = await options.pickModel();
        if (picked) {
          session.currentModel = { model: picked.model, label: picked.label };
          status = `Model: ${picked.label}`;
          tui.requestRender();
        }
      }

      function enterInput(): void {
        selected = SELECTION_ROWS.indexOf("input");
        phase = "input";
        input.setValue(pendingInput);
        status = "";
        tui.requestRender();
      }

      function chooseSelection(): void {
        const row = SELECTION_ROWS[selected];
        if (row === "role") {
          session.currentRole = cycleRoleLocal(session.currentRole, 1);
          status = "";
          tui.requestRender();
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
            tui.requestRender();
            return;
          }
          doneAction("apply");
          return;
        }
        if (row === "discard") doneAction("discard");
      }

      function selectionLine(row: SelectionRow, label: string): string {
        const active = phase === "input" ? row === "input" : SELECTION_ROWS[selected] === row;
        const line = `${active ? "›" : " "} ${label}`;
        return active ? theme.fg("accent", theme.bold(line)) : line;
      }

      return {
        render(width: number): string[] {
          const safeWidth = Math.max(1, width);
          lastWidth = safeWidth;
          const inner = Math.max(1, safeWidth - 2);
          const terminalRows = process.stdout?.rows ?? 30;
          const previewHeight = Math.max(4, Math.min(16, terminalRows - 14));
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

          const header = `${theme.bold("Review & Refine")}  ${theme.fg("dim", `role ${spec.role} · turns ${turnCount}`)}`;
          const rows = [
            header,
            theme.fg("dim", "─".repeat(inner)),
            ...visible.map((line) => ` ${line}`),
          ];
          while (rows.length < previewHeight + 2) rows.push("");
          const range = rendered.length > previewHeight
            ? ` · ${previewOffset + 1}-${Math.min(rendered.length, previewOffset + previewHeight)}/${rendered.length}`
            : "";
          rows.push(theme.fg("dim", `${modeLabel}${range}${turnCount > 1 && previewMode === "output" ? " · [ ] history" : ""}`));
          rows.push(theme.fg("dim", "─".repeat(inner)));
          rows.push(...controls.map(([row, label], index) => selectionLine(row, `${index + 1}. ${label}`)));
          const footer = phase === "running"
            ? `${SPINNER_FRAMES[frame]!} ${status} ${formatElapsed(activeRun ? now() - activeRun.startedAt : 0)} · Esc cancel`
            : phase === "input"
              ? "Enter run · Esc keep input"
              : "1-6 select · ↑↓ scroll/select · ←→ change role · Enter choose · PgUp/PgDn scroll · m model · i input · R plan/output · [ ] history · a apply · d discard · Esc cancel";
          rows.push(theme.fg("dim", truncateToWidth(footer, inner, "…")));
          if (status && phase !== "running") {
            rows.push(theme.fg(busyError ? "warning" : "dim", truncateToWidth(status, inner, "…")));
          }
          return frameBox(rows, safeWidth, theme);
        },

        handleInput(data: string): void {
          if (phase === "running") {
            if (matchesKey(data, Key.escape)) cancelActiveRun();
            return;
          }
          if (phase === "input") {
            if (matchesKey(data, Key.escape)) {
              pendingInput = input.getValue();
              phase = "idle";
              status = "Input kept — Enter to run, i to resume.";
              tui.requestRender();
              return;
            }
            if (matchesKey(data, Key.enter)) {
              pendingInput = input.getValue();
              input.setValue("");
              void runRole();
              return;
            }
            input.handleInput(data);
            tui.requestRender();
            return;
          }
          if (matchesKey(data, Key.escape)) {
            doneAction("cancel");
            return;
          }
          if (matchesKey(data, Key.up)) {
            if (previewOffset >= previewMaxOffset) {
              if (selected > 0) selected -= 1;
              else previewOffset = Math.max(0, previewOffset - 1);
            } else previewOffset = Math.max(0, previewOffset - 1);
            status = "";
            tui.requestRender();
            return;
          }
          if (matchesKey(data, Key.down)) {
            if (previewOffset >= previewMaxOffset) selected = Math.min(SELECTION_ROWS.length - 1, selected + 1);
            else previewOffset = Math.min(previewMaxOffset, previewOffset + 1);
            status = "";
            tui.requestRender();
            return;
          }
          if (matchesKey(data, Key.pageUp)) {
            previewOffset = Math.max(0, previewOffset - 5);
            tui.requestRender();
            return;
          }
          if (matchesKey(data, Key.pageDown)) {
            previewOffset = Math.min(previewMaxOffset, previewOffset + 5);
            tui.requestRender();
            return;
          }
          if (matchesKey(data, Key.left) && SELECTION_ROWS[selected] === "role") {
            session.currentRole = cycleRoleLocal(session.currentRole, -1);
            status = "";
            tui.requestRender();
            return;
          }
          if (matchesKey(data, Key.right) && SELECTION_ROWS[selected] === "role") {
            session.currentRole = cycleRoleLocal(session.currentRole, 1);
            status = "";
            tui.requestRender();
            return;
          }
          if (data === "m" || data === "M") {
            selected = SELECTION_ROWS.indexOf("model");
            void pickModel();
            return;
          }
          if (data === "i" || data === "I") {
            enterInput();
            return;
          }
          if (/^[1-6]$/.test(data)) {
            selected = Number(data) - 1;
            chooseSelection();
            return;
          }
          if (matchesKey(data, Key.enter)) {
            chooseSelection();
            return;
          }
          if (data === "a" || data === "A") {
            if (session.turns.length === 0) {
              status = "No refine result to apply — run review/refine first.";
              tui.requestRender();
              return;
            }
            doneAction("apply");
            return;
          }
          if (data === "d" || data === "D") {
            doneAction("discard");
            return;
          }
          if (/^[rR]$/.test(data) && session.turns.length > 0) {
            previewMode = previewMode === "output" ? "plan" : "output";
            if (previewMode === "output") selectedTurnIndex = session.turns.length - 1;
            previewOffset = 0;
            previewMaxOffset = 0;
            tui.requestRender();
            return;
          }
          if ((data === "[" || data === "]") && session.turns.length > 1 && previewMode === "output") {
            const direction = data === "]" ? 1 : -1;
            selectedTurnIndex = (selectedTurnIndex + direction + session.turns.length) % session.turns.length;
            previewOffset = 0;
            previewMaxOffset = 0;
            tui.requestRender();
            return;
          }
          tui.requestRender();
        },

        invalidate(): void {
          input.invalidate();
        },

        dispose(): void {
          cancelActiveRun(activeRun, false);
          doneAction("cancel");
        },
      };
    },
    {
      overlay: true,
      overlayOptions: {
        width: "92%",
        minWidth: 40,
        maxHeight: 32,
        anchor: "center" as const,
      },
    },
  );

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

function frameBox(
  rows: string[],
  width: number,
  theme: { fg(name: string, text: string): string },
): string[] {
  const inner = Math.max(0, width - 2);
  const border = (text: string) => theme.fg("dim", text);
  return [
    border(`╭${"─".repeat(inner)}╮`),
    ...rows.map((row) => {
      const content = truncateToWidth(row, inner, "…");
      return `${border("│")}${content}${" ".repeat(Math.max(0, inner - visibleWidth(content)))}${border("│")}`;
    }),
    border(`╰${"─".repeat(inner)}╯`),
  ];
}

function refineMarkdownTheme(theme: {
  fg(name: string, text: string): string;
  bold(text: string): string;
}): MarkdownTheme {
  return {
    heading: (text) => theme.fg("accent", theme.bold(text)),
    link: (text) => theme.fg("accent", text),
    linkUrl: (text) => theme.fg("dim", text),
    code: (text) => theme.fg("warning", text),
    codeBlock: (text) => text,
    codeBlockBorder: (text) => theme.fg("dim", text),
    quote: (text) => text,
    quoteBorder: (text) => theme.fg("dim", text),
    hr: (text) => theme.fg("dim", text),
    listBullet: (text) => theme.fg("accent", text),
    bold: (text) => theme.bold(text),
    italic: (text) => text,
    strikethrough: (text) => theme.fg("dim", text),
    underline: (text) => text,
  };
}
