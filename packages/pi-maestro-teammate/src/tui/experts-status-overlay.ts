import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

/**
 * Read-only Experts Mode status panel overlay.
 *
 * Rendered through ctx.ui.custom as a centered modal (NOT the full teammate
 * control center): a bordered text box showing pre-formatted panel lines.
 * Closes on Esc / q / Q / Enter; arrow keys and PgUp/PgDn scroll long bodies.
 * The body is produced by the pure formatters in experts-mode/status-panel.ts,
 * so this overlay never reads state or prints model ids itself.
 */

/** Structural slice of the host Theme we use; null → plain box fallback. */
export interface ExpertsStatusOverlayThemeLike {
  fg(color: string, text: string): string;
  bg(color: string, text: string): string;
}

const VISIBLE_HEIGHT = 24;

export class ExpertsStatusOverlay {
  private readonly lines: string[];
  private scrollOffset = 0;
  private requestRender: () => void = () => {};

  constructor(
    body: string,
    private readonly title: string,
    private readonly theme: ExpertsStatusOverlayThemeLike | null,
    private readonly close: () => void,
  ) {
    this.lines = body.split("\n");
  }

  setRequestRender(fn: () => void): void {
    this.requestRender = fn;
  }

  private get maxScrollOffset(): number {
    return Math.max(0, this.lines.length - VISIBLE_HEIGHT);
  }

  render(width: number): string[] {
    const inner = Math.max(1, width - 4);
    const dim = (value: string): string =>
      this.theme ? this.theme.fg("dim", value) : `\x1b[2m${value}\x1b[0m`;
    const accent = (value: string): string =>
      this.theme ? this.theme.fg("accent", value) : `\x1b[36m${value}\x1b[0m`;
    const border = (glyph: string): string =>
      this.theme ? this.theme.bg("customMessageBg", this.theme.fg("borderMuted", glyph)) : glyph;
    const fill = (line: string): string => {
      const fitted = truncateToWidth(line, inner, "…");
      return `${dim("|")} ${fitted}${" ".repeat(Math.max(0, inner - visibleWidth(fitted)))} ${dim("|")}`;
    };

    const out: string[] = [border(`╭${"─".repeat(inner)}╮`)];
    out.push(fill(accent(` ${this.title} `)));

    const long = this.lines.length > VISIBLE_HEIGHT;
    const visible = long
      ? this.lines.slice(this.scrollOffset, this.scrollOffset + VISIBLE_HEIGHT)
      : this.lines;
    for (const line of visible) out.push(fill(line === "" ? " " : line));

    out.push(fill(""));
    out.push(fill(long
      ? dim(`Esc / q / Enter close · ↑↓ scroll · ${this.scrollOffset + 1}-${this.scrollOffset + visible.length}/${this.lines.length}`)
      : dim("Esc / q / Enter close")));
    out.push(border(`╰${"─".repeat(inner)}╯`));
    return out;
  }

  handleInput(data: string): void {
    // Esc / q / Q / Enter / Ctrl-C close the panel.
    if (data === "\x1b" || data === "q" || data === "Q" || data === "\r" || data === "\n" || data === "\x03") {
      this.close();
      return;
    }
    if (data === "\x1b[A" || data === "k") {
      this.scrollOffset = Math.max(0, this.scrollOffset - 1);
    } else if (data === "\x1b[B" || data === "j") {
      this.scrollOffset = Math.min(this.maxScrollOffset, this.scrollOffset + 1);
    } else if (data === "\x1b[5~") {
      this.scrollOffset = Math.max(0, this.scrollOffset - 10);
    } else if (data === "\x1b[6~") {
      this.scrollOffset = Math.min(this.maxScrollOffset, this.scrollOffset + 10);
    } else {
      return;
    }
    this.requestRender();
  }

  invalidate(): void {}
  dispose(): void {}
}

export interface ExpertsStatusOverlayCtx {
  ui: { custom: Function };
  cwd?: string;
}

/**
 * Show a read-only Experts status panel as a centered modal overlay.
 * Resolves when the user closes it (Esc/q/Enter). When the host has no
 * interactive custom overlay, the caller falls back to ctx.ui.notify.
 */
export async function showExpertsStatusOverlay(
  ctx: ExpertsStatusOverlayCtx,
  body: string,
  title = "Experts",
): Promise<void> {
  return ctx.ui.custom(
    (
      tui: { requestRender: () => void },
      theme: unknown,
      _keybindings: unknown,
      done: (result: undefined) => void,
    ) => {
      const themeLike = (
        theme
        && typeof (theme as { fg?: unknown }).fg === "function"
        && typeof (theme as { bg?: unknown }).bg === "function"
      )
        ? theme as ExpertsStatusOverlayThemeLike
        : null;
      const overlay = new ExpertsStatusOverlay(body, title, themeLike, () => done(undefined));
      overlay.setRequestRender(() => tui.requestRender());
      return {
        render: (width: number) => overlay.render(width),
        handleInput: (data: string) => overlay.handleInput(data),
        invalidate: () => overlay.invalidate(),
        dispose: () => overlay.dispose(),
      };
    },
    { overlay: true, overlayOptions: { anchor: "center", width: "90%", maxHeight: "85%" } },
  );
}
