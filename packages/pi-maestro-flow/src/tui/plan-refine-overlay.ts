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
  run: (role: RefineRole, model: string, label: string, userInput: string) => Promise<RefineRunResult>;
  signal?: AbortSignal;
}

export interface RenderRefineOverlayResult {
  action: "done" | "cancel";
  session: RefineSession;
  latestOutput?: string;
  latestRole?: RefineRole;
  latestAppliesAs?: RefineRoleSpec["appliesAs"];
}

type PreviewMode = "plan" | "output";
type Phase = "idle" | "running" | "input";

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
      let lastWidth = 80;

      const markdownTheme = refineMarkdownTheme(theme);

      function currentPreviewSource(): string {
        if (previewMode === "output" && session.turns.length > 0) {
          return session.turns[selectedTurnIndex]?.output ?? "";
        }
        return options.markdown;
      }

      function latestOutput(): string | undefined {
        return session.turns.at(-1)?.output;
      }

      function doneAction(action: "done" | "cancel"): void {
        const last = session.turns.at(-1);
        done({
          action,
          session,
          latestOutput: last?.output,
          latestRole: last?.role,
          latestAppliesAs: last ? options.roles[last.role].appliesAs : undefined,
        });
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
        const timer = setInterval(() => {
          frame = (frame + 1) % SPINNER_FRAMES.length;
          tui.requestRender();
        }, 120);
        tui.requestRender();
        try {
          const result = await options.run(session.currentRole, model, label, pendingInput);
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
            status = `${spec.label} done — R toggles Plan/Output, [ ] cycles history.`;
          } else {
            busyError = result.error ?? "unknown error";
            status = `${spec.label} failed: ${busyError}`;
          }
        } catch (error) {
          busyError = error instanceof Error ? error.message : String(error);
          status = `${spec.label} failed: ${busyError}`;
        } finally {
          clearInterval(timer);
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

      return {
        render(width: number): string[] {
          const safeWidth = Math.max(1, width);
          lastWidth = safeWidth;
          const inner = Math.max(1, safeWidth - 2);
          const terminalRows = process.stdout?.rows ?? 30;
          const previewHeight = Math.max(4, Math.min(16, terminalRows - 14));
          const md = new Markdown(currentPreviewSource(), 0, 0, markdownTheme);
          const rendered = md.render(Math.max(1, inner - 2));
          const visible = rendered.slice(0, previewHeight);

          const spec = options.roles[session.currentRole];
          const roleRow = `Role  [${spec.label}]`;
          const modelRow = `Model [${session.currentModel.label || "— pick (m) —"}]`;
          const inputRow = phase === "input"
            ? `› ${input.render(Math.max(1, inner - 2)).join("")}`
            : `Input ${pendingInput ? `“${truncateToWidth(pendingInput, inner - 14, "…")}”` : "(i to type, Enter to run)"}`;
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
          rows.push(theme.fg("dim", `${modeLabel}${turnCount > 1 && previewMode === "output" ? " · [ ] history" : ""}`));
          rows.push(theme.fg("dim", "─".repeat(inner)));
          rows.push(roleRow);
          rows.push(modelRow);
          rows.push(inputRow);
          const footer = phase === "running"
            ? `${SPINNER_FRAMES[frame]!} ${status}`
            : phase === "input"
              ? "Enter run · Esc exit input"
              : "←→ role · m model · i input · Enter run · R plan/output · [ ] history · d done · Esc cancel";
          rows.push(theme.fg("dim", truncateToWidth(footer, inner, "…")));
          if (status && phase !== "running") {
            rows.push(theme.fg(busyError ? "warning" : "dim", truncateToWidth(status, inner, "…")));
          }
          return frameBox(rows, safeWidth, theme);
        },

        handleInput(data: string): void {
          if (phase === "running") {
            if (matchesKey(data, Key.escape) && options.signal) options.signal.dispatchEvent(new Event("abort"));
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
          if (matchesKey(data, Key.left)) {
            session.currentRole = cycleRoleLocal(session.currentRole, -1);
            status = "";
            tui.requestRender();
            return;
          }
          if (matchesKey(data, Key.right)) {
            session.currentRole = cycleRoleLocal(session.currentRole, 1);
            status = "";
            tui.requestRender();
            return;
          }
          if (data === "m" || data === "M") {
            void pickModel();
            return;
          }
          if (data === "i" || data === "I") {
            phase = "input";
            input.setValue(pendingInput);
            status = "";
            tui.requestRender();
            return;
          }
          if (matchesKey(data, Key.enter)) {
            void runRole();
            return;
          }
          if (data === "d" || data === "D") {
            doneAction("done");
            return;
          }
          if (/^[rR]$/.test(data) && session.turns.length > 0) {
            previewMode = previewMode === "output" ? "plan" : "output";
            if (previewMode === "output") selectedTurnIndex = session.turns.length - 1;
            tui.requestRender();
            return;
          }
          if ((data === "[" || data === "]") && session.turns.length > 1 && previewMode === "output") {
            const direction = data === "]" ? 1 : -1;
            selectedTurnIndex = (selectedTurnIndex + direction + session.turns.length) % session.turns.length;
            tui.requestRender();
            return;
          }
          tui.requestRender();
        },

        invalidate(): void {
          input.invalidate();
        },

        dispose(): void {},
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
