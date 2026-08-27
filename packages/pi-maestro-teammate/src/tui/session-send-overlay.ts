import { Key, decodeKittyPrintable, matchesKey, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { statusIcon } from "../extension/monitor.ts";
import {
  createTuiTranslator,
  onTuiLocaleChange,
  translateStatusIdentifier,
  type SupportedSettingsLocale,
  type TuiTranslator,
} from "./locale.ts";

export interface SessionSelectionRow {
  correlationId: string;
  displayName: string;
  agentRole: string;
  status: string;
  idleSeconds: number;
  source?: string;
  kind?: "agent" | "window" | "remote";
  bindable?: boolean;
  ownerId?: string;
  depth?: number;
  parentCorrelationId?: string;
}

export interface SessionSendOverlayResult {
  target: string;
  message: string;
}

interface SessionSendOverlayCallbacks {
  getSessions: () => SessionSelectionRow[];
  close: (result: SessionSendOverlayResult | null) => void;
}

const MAX_MESSAGE_LENGTH = 64 * 1024;

/** Small session picker used by /teammate-send. */
export class SessionSendOverlay {
  private sessions: SessionSelectionRow[] = [];
  private cursor = 0;
  private selected?: string;
  private message = "";
  private editingMessage = false;
  private statusText = "";
  private requestRender: () => void = () => {};
  private readonly t: TuiTranslator;
  private readonly localeDisposer: () => void;

  constructor(private readonly cb: SessionSendOverlayCallbacks, locale?: SupportedSettingsLocale) {
    this.t = createTuiTranslator(locale);
    this.localeDisposer = locale === undefined
      ? onTuiLocaleChange(() => {
          this.statusText = "";
          this.requestRender();
        })
      : () => {};
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
    lines.push(this.frameLine(bold(` ${this.t("sessionSend.title")}`), inner, dim));
    lines.push(this.frameLine(dim(` ${this.t("sessionSend.intro")}`), inner, dim));

    const maxVisible = Math.min(this.sessions.length, 10);
    const scrollStart = Math.max(0, Math.min(this.cursor - 4, this.sessions.length - maxVisible));
    for (let index = scrollStart; index < scrollStart + maxVisible && index < this.sessions.length; index++) {
      const session = this.sessions[index]!;
      const current = index === this.cursor;
      const selected = session.correlationId === this.selected;
      const pointer = current ? accent(">") : " ";
      const check = selected ? green("[x]") : dim("[ ]");
      const source = session.source && session.source !== "local" ? dim(` [${session.source}]`) : "";
      const identifier = session.kind === "window" && session.ownerId
        ? session.ownerId
        : session.correlationId.split(":").at(-1) ?? session.correlationId;
      const id = dim(` · id=${identifier.slice(0, 8)}`);
      const row = ` ${pointer} ${check} ${statusIcon(session.status)} ${session.displayName}${id}  ${dim(translateStatusIdentifier(session.status, this.t))}  ${dim(session.agentRole)}${source}`;
      lines.push(this.frameLine(current ? accent(row) : row, inner, dim));
    }
    if (this.sessions.length === 0) {
      lines.push(this.frameLine(dim(`  ${this.t("sessionSend.noPeers")}`), inner, dim));
    }

    lines.push(this.frameLine("", inner, dim));
    const target = this.selected ? this.sessions.find((session) => session.correlationId === this.selected) : undefined;
    lines.push(this.frameLine(` ${this.t("sessionSend.target")} ${target?.displayName ?? dim(this.t("sessionSend.selectPlaceholder"))}`, inner, dim));
    lines.push(this.frameLine(` ID: ${target?.correlationId ?? dim("—")}`, inner, dim));
    const messageValue = this.editingMessage
      ? ` > ${this.message}\x1b[7m \x1b[0m`
      : ` > ${this.message || dim(this.t("sessionSend.editPlaceholder"))}`;
    lines.push(this.frameLine(` ${this.t("sessionSend.message")} ${messageValue}`, inner, dim));
    if (this.statusText) lines.push(this.frameLine(dim(` ${this.statusText}`), inner, dim));
    lines.push(this.frameLine("", inner, dim));
    lines.push(this.frameLine(dim(` ${this.t("sessionSend.footer")}`), inner, dim));
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
      if (matchesKey(data, Key.escape)) {
        this.editingMessage = false;
      } else if (matchesKey(data, Key.enter)) {
        this.editingMessage = false;
        this.confirm();
        return;
      } else if (matchesKey(data, Key.backspace)) {
        this.message = this.message.slice(0, -1);
      } else {
        const printable = decodeKittyPrintable(data)
          ?? (!data.startsWith("\x1b") ? data.replace(/[\u0000-\u001f\u007f]/g, "") : "");
        if (printable && this.message.length + printable.length <= MAX_MESSAGE_LENGTH) {
          this.message += printable;
        }
      }
      this.requestRender();
      return;
    }

    const commandInput = decodeKittyPrintable(data) ?? data;
    if (matchesKey(data, Key.escape)) {
      this.cb.close(null);
      return;
    }
    if (matchesKey(data, Key.enter)) {
      if (!this.selected) {
        this.statusText = this.t("sessionSend.selectFirst");
      } else {
        this.editingMessage = true;
        this.statusText = this.t("sessionSend.enterThenSend");
      }
    } else if (matchesKey(data, Key.tab)) {
      if (this.selected) {
        this.editingMessage = true;
        this.statusText = this.t("sessionSend.enterThenSend");
      } else {
        this.statusText = this.t("sessionSend.selectFirst");
      }
    } else if (matchesKey(data, Key.space)) {
      this.toggleSelection();
    } else if (matchesKey(data, Key.up) || commandInput === "k") {
      this.cursor = Math.max(0, this.cursor - 1);
    } else if (matchesKey(data, Key.down) || commandInput === "j") {
      this.cursor = Math.min(Math.max(0, this.sessions.length - 1), this.cursor + 1);
    }
    this.requestRender();
  }

  private toggleSelection(): void {
    const session = this.sessions[this.cursor];
    if (!session) return;
    this.selected = this.selected === session.correlationId ? undefined : session.correlationId;
    this.statusText = this.selected
      ? this.t("sessionSend.selected", { name: session.displayName })
      : this.t("sessionSend.selectionCleared");
  }

  private confirm(): void {
    const target = this.selected;
    const message = this.message.trim();
    if (!target) {
      this.statusText = this.t("sessionSend.selectFirst");
      this.requestRender();
      return;
    }
    if (!message) {
      this.statusText = this.t("sessionSend.enterFirst");
      this.editingMessage = true;
      this.requestRender();
      return;
    }
    this.cb.close({ target, message });
  }

  invalidate(): void {}
  dispose(): void {
    this.localeDisposer();
  }
}

export interface SessionSendOverlayDeps {
  getSessions: () => SessionSelectionRow[];
  locale?: SupportedSettingsLocale;
}

export async function showSessionSendOverlay(
  ctx: { ui: { custom: <T>(factory: (tui: { requestRender: () => void }, theme: unknown, keybindings: unknown, done: (result: T) => void) => { render: (width: number) => string[]; handleInput: (data: string) => void; invalidate: () => void; dispose: () => void }, options: Record<string, unknown>) => Promise<T> } },
  deps: SessionSendOverlayDeps,
): Promise<SessionSendOverlayResult | null> {
  return ctx.ui.custom<SessionSendOverlayResult | null>(
    (tui, _theme, _keybindings, done) => {
      const overlay = new SessionSendOverlay({ getSessions: deps.getSessions, close: done }, deps.locale);
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
