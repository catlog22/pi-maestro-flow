import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { statusIcon } from "../extension/monitor.ts";
import type { MonitorSessionRow } from "./monitor-overlay.ts";

export interface SessionSendOverlayResult {
  target: string;
  message: string;
}

interface SessionSendOverlayCallbacks {
  getSessions: () => MonitorSessionRow[];
  close: (result: SessionSendOverlayResult | null) => void;
}

const MAX_MESSAGE_LENGTH = 64 * 1024;

/** Small session picker used by /teammate-send. */
export class SessionSendOverlay {
  private sessions: MonitorSessionRow[] = [];
  private cursor = 0;
  private selected?: string;
  private message = "";
  private editingMessage = false;
  private statusText = "";
  private requestRender: () => void = () => {};

  constructor(private readonly cb: SessionSendOverlayCallbacks) {
    this.sessions = cb.getSessions().filter((session) => session.bindable === true);
  }

  setRequestRender(fn: () => void): void {
    this.requestRender = fn;
  }

  render(width: number): string[] {
    const inner = Math.max(1, width - 4);
    const lines: string[] = [];
    const dim = (value: string) => `\x1b[2m${value}\x1b[0m`;
    const bold = (value: string) => `\x1b[1m${value}\x1b[0m`;
    const accent = (value: string) => `\x1b[36m${value}\x1b[0m`;
    const green = (value: string) => `\x1b[32m${value}\x1b[0m`;

    lines.push(dim(`+${"-".repeat(inner)}+`));
    lines.push(this.frameLine(bold(" Send to another session"), inner, dim));
    lines.push(this.frameLine(dim(" Select a window, then enter a message."), inner, dim));

    const maxVisible = Math.min(this.sessions.length, 10);
    const scrollStart = Math.max(0, Math.min(this.cursor - 4, this.sessions.length - maxVisible));
    for (let index = scrollStart; index < scrollStart + maxVisible && index < this.sessions.length; index++) {
      const session = this.sessions[index]!;
      const current = index === this.cursor;
      const selected = session.correlationId === this.selected;
      const pointer = current ? accent(">") : " ";
      const check = selected ? green("[x]") : dim("[ ]");
      const source = session.source && session.source !== "local" ? dim(` [${session.source}]`) : "";
      const row = ` ${pointer} ${check} ${statusIcon(session.status)} ${session.displayName}  ${dim(session.status)}  ${dim(session.agentRole)}${source}`;
      lines.push(this.frameLine(current ? accent(row) : row, inner, dim));
    }
    if (this.sessions.length === 0) {
      lines.push(this.frameLine(dim("  No available peer sessions"), inner, dim));
    }

    lines.push(this.frameLine("", inner, dim));
    const target = this.selected ? this.sessions.find((session) => session.correlationId === this.selected) : undefined;
    lines.push(this.frameLine(` Target: ${target?.displayName ?? dim("(select a session)")}`, inner, dim));
    const messageValue = this.editingMessage
      ? ` > ${this.message}\x1b[7m \x1b[0m`
      : ` > ${this.message || dim("(Tab or Enter to edit message)")}`;
    lines.push(this.frameLine(` Message: ${messageValue}`, inner, dim));
    if (this.statusText) lines.push(this.frameLine(dim(` ${this.statusText}`), inner, dim));
    lines.push(this.frameLine("", inner, dim));
    lines.push(this.frameLine(dim(" Up/Down select · Space choose · Tab edit · Enter send · Esc cancel"), inner, dim));
    lines.push(dim(`+${"-".repeat(inner)}+`));
    return lines;
  }

  private frameLine(content: string, inner: number, dim: (value: string) => string): string {
    const truncated = truncateToWidth(content, inner, "…");
    const pad = Math.max(0, inner - visibleWidth(truncated));
    return `${dim("|")} ${truncated}${" ".repeat(pad)} ${dim("|")}`;
  }

  handleInput(data: string): void {
    if (this.editingMessage) {
      if (data === "\x1b") {
        this.editingMessage = false;
      } else if (data === "\r" || data === "\n") {
        this.editingMessage = false;
        this.confirm();
        return;
      } else if (data === "\x7f" || data === "\b") {
        this.message = this.message.slice(0, -1);
      } else if (!data.startsWith("\x1b")) {
        const printable = data.replace(/[\u0000-\u001f\u007f]/g, "");
        if (printable && this.message.length + printable.length <= MAX_MESSAGE_LENGTH) {
          this.message += printable;
        }
      }
      this.requestRender();
      return;
    }

    switch (data) {
      case "\x1b":
        this.cb.close(null);
        return;
      case "\r":
      case "\n":
        if (!this.selected) {
          this.statusText = "Select a peer session first";
        } else {
          this.editingMessage = true;
          this.statusText = "Enter a message, then press Enter to send";
        }
        break;
      case "\t":
        if (this.selected) {
          this.editingMessage = true;
          this.statusText = "Enter a message, then press Enter to send";
        } else {
          this.statusText = "Select a peer session first";
        }
        break;
      case " ":
        this.toggleSelection();
        break;
      case "\x1b[A":
      case "k":
        this.cursor = Math.max(0, this.cursor - 1);
        break;
      case "\x1b[B":
      case "j":
        this.cursor = Math.min(Math.max(0, this.sessions.length - 1), this.cursor + 1);
        break;
      default:
        break;
    }
    this.requestRender();
  }

  private toggleSelection(): void {
    const session = this.sessions[this.cursor];
    if (!session) return;
    this.selected = this.selected === session.correlationId ? undefined : session.correlationId;
    this.statusText = this.selected ? `Selected ${session.displayName}` : "Session selection cleared";
  }

  private confirm(): void {
    const target = this.selected;
    const message = this.message.trim();
    if (!target) {
      this.statusText = "Select a peer session first";
      this.requestRender();
      return;
    }
    if (!message) {
      this.statusText = "Enter a message first";
      this.editingMessage = true;
      this.requestRender();
      return;
    }
    this.cb.close({ target, message });
  }

  invalidate(): void {}
  dispose(): void {}
}

export interface SessionSendOverlayDeps {
  getSessions: () => MonitorSessionRow[];
}

export async function showSessionSendOverlay(
  ctx: { ui: { custom: <T>(factory: (tui: { requestRender: () => void }, theme: unknown, keybindings: unknown, done: (result: T) => void) => { render: (width: number) => string[]; handleInput: (data: string) => void; invalidate: () => void; dispose: () => void }, options: Record<string, unknown>) => Promise<T> } },
  deps: SessionSendOverlayDeps,
): Promise<SessionSendOverlayResult | null> {
  return ctx.ui.custom<SessionSendOverlayResult | null>(
    (tui, _theme, _keybindings, done) => {
      const overlay = new SessionSendOverlay({ getSessions: deps.getSessions, close: done });
      overlay.setRequestRender(() => tui.requestRender());
      return {
        render: (width: number) => overlay.render(width),
        handleInput: (data: string) => overlay.handleInput(data),
        invalidate: () => overlay.invalidate(),
        dispose: () => overlay.dispose(),
      };
    },
    { overlay: true, overlayOptions: { anchor: "center", width: "80%", maxHeight: "70%" } },
  );
}
