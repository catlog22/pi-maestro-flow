import {
  CURSOR_MARKER,
  Key,
  type Component,
  type Focusable,
  decodeKittyPrintable,
  matchesKey,
  truncateToWidth,
} from "@earendil-works/pi-tui";
import type { RemoteConfigState } from "../remote/config.ts";
import type { RemoteHostConfig } from "../remote/types.ts";
import { removeLastGrapheme, sanitizeSingleLineInput } from "./input-text.ts";
import {
  onTuiLocaleChange,
  type SupportedSettingsLocale,
  type TuiTranslationKey,
  type TuiTranslator,
} from "./locale.ts";

export type RemotePaneScope = "global" | "project";

export type RemotePaneRow =
  | {
    kind: "host";
    id: string;
    host: string;
    user: string;
    port: number;
    keyPrefix: string;
    scope: RemotePaneScope;
    hidden?: boolean;
  }
  | {
    kind: "target";
    id: string;
    host: string;
    driver: string;
    cwd: string;
    scope: RemotePaneScope;
    hidden?: boolean;
  };

export type RemotePaneAction =
  | { kind: "remote-edit-host"; hostId: string; scope: RemotePaneScope }
  | { kind: "remote-new-host"; scope: RemotePaneScope }
  | { kind: "remote-edit-target"; targetId: string; scope: RemotePaneScope }
  | { kind: "remote-new-target"; scope: RemotePaneScope }
  | { kind: "remote-delete-host"; hostId: string; scope: RemotePaneScope }
  | { kind: "remote-delete-target"; targetId: string; scope: RemotePaneScope }
  | { kind: "remote-scope"; scope: RemotePaneScope }
  | { kind: "reload"; tab: "remotes" };

export interface RemoteConfigPaneOptions {
  state: RemoteConfigState;
  theme: { fg(role: string, text: string): string; bold(text: string): string };
  t: TuiTranslator;
  requestRender: () => void;
  close: (action: RemotePaneAction | null) => void;
  onTest: (targetId: string, signal: AbortSignal) => Promise<string>;
  locale?: SupportedSettingsLocale;
  /** Injectable test hook; the product default is a 10s SSH probe timeout. */
  testTimeoutMs?: number;
}

function tKey(key: string): TuiTranslationKey {
  return key as TuiTranslationKey;
}

function printableInput(data: string): string {
  // Reject escape sequences (arrows / function keys) before sanitizing.
  if (data.startsWith("\x1b")) return "";
  return decodeKittyPrintable(data) ?? sanitizeSingleLineInput(data);
}

function padToWidth(value: string, width: number): string {
  return truncateToWidth(value, Math.max(0, width), "", true);
}

function clampIndex(index: number, length: number): number {
  return length === 0 ? 0 : Math.max(0, Math.min(index, length - 1));
}

function hostKeyPrefix(host: RemoteHostConfig): string {
  return host.hostKeySha256.replace(/^SHA256:/, "").slice(0, 12);
}

/**
 * Pure-UI "Remote targets" tab embedded in the Teammate Control Center.
 *
 * The pane renders one scope at a time (global or project), emits
 * edit/create/delete/scope actions through `close`, and runs inline target
 * connectivity probes through `onTest`. Field-level wizards, persistence, and
 * real SSH testing live outside the pane.
 */
export class RemoteConfigPane implements Component, Focusable {
  focused = false;

  private scope: RemotePaneScope = "global";
  private query = "";
  private selected = 0;
  private testingId: string | null = null;
  private statusText = "";
  private statusTone: "dim" | "success" | "error" = "dim";
  private lastWidth = 80;
  private readonly t: TuiTranslator;
  private readonly testTimeoutMs: number;
  private readonly localeDisposer: () => void;

  constructor(private readonly options: RemoteConfigPaneOptions) {
    this.t = options.t;
    this.testTimeoutMs = options.testTimeoutMs ?? 10_000;
    this.localeDisposer = options.locale === undefined
      ? onTuiLocaleChange(() => {
          this.statusText = "";
          this.options.requestRender();
        })
      : () => {};
  }

  invalidate(): void {}

  dispose(): void {
    this.localeDisposer();
  }

  handleInput(data: string): void {
    if (this.lastWidth < 20) {
      if (matchesKey(data, Key.escape)) this.options.close(null);
      return;
    }
    if (matchesKey(data, Key.escape)) {
      this.options.close(null);
      return;
    }
    if (matchesKey(data, Key.backspace)) {
      if (this.query) {
        this.query = removeLastGrapheme(this.query);
        this.selected = 0;
        this.options.requestRender();
      }
      return;
    }
    if (matchesKey(data, Key.enter)) {
      const row = this.visibleItems()[this.selected];
      if (row) this.activateRow(row);
      return;
    }
    if (matchesKey(data, Key.up) || (matchesKey(data, "k") && !this.query)) {
      this.move(-1);
      return;
    }
    if (matchesKey(data, Key.down) || (matchesKey(data, "j") && !this.query)) {
      this.move(1);
      return;
    }
    if (!this.query) {
      if (matchesKey(data, "g")) {
        this.setScope("global");
        return;
      }
      if (matchesKey(data, "p")) {
        this.setScope("project");
        return;
      }
      if (matchesKey(data, "n")) {
        this.options.close({ kind: "remote-new-host", scope: this.scope });
        return;
      }
      if (matchesKey(data, Key.shift("n"))) {
        this.options.close({ kind: "remote-new-target", scope: this.scope });
        return;
      }
      if (matchesKey(data, "d")) {
        const row = this.visibleItems()[this.selected];
        if (row) this.deleteRow(row);
        return;
      }
      if (matchesKey(data, "t")) {
        const row = this.visibleItems()[this.selected];
        if (row) this.startTest(row);
        return;
      }
    }
    const input = printableInput(data);
    if (input) {
      this.query += input;
      this.selected = 0;
      this.options.requestRender();
    }
  }

  render(width: number): string[] {
    const w = Math.max(1, Math.min(width, 112));
    this.lastWidth = w;
    const inner = Math.max(0, w - 2);
    const rows: string[] = [];
    rows.push(this.headerLine(inner));
    rows.push(this.scopeLine(inner));
    if (this.query) {
      rows.push(this.filterLine(inner));
      rows.push(this.theme.fg("dim", "─".repeat(inner)));
    }
    const items = this.visibleItems();
    this.selected = clampIndex(this.selected, items.length);
    if (items.length === 0) {
      rows.push(this.theme.fg("dim", this.t(tKey("remote.empty"))));
    } else {
      rows.push(...items.map((row, index) => this.rowLine(row, index === this.selected, inner)));
    }
    rows.push(this.theme.fg("dim", "─".repeat(inner)));
    if (this.statusText) rows.push(this.statusLine(inner));
    rows.push(this.footerLine(inner));
    return this.frame(rows, w);
  }

  private get theme(): RemoteConfigPaneOptions["theme"] {
    return this.options.theme;
  }

  private frame(rows: string[], width: number): string[] {
    const inner = Math.max(0, width - 2);
    const dim = (value: string) => this.theme.fg("dim", value);
    return [
      dim(`╭${"─".repeat(inner)}╮`),
      ...rows.map((row) => `${dim("│")}${padToWidth(` ${row}`, inner)}${dim("│")}`),
      dim(`╰${"─".repeat(inner)}╯`),
    ];
  }

  private headerLine(width: number): string {
    return truncateToWidth(
      this.theme.fg("accent", this.theme.bold(this.t(tKey("remote.title")))),
      width,
      "…",
    );
  }

  private scopeLine(width: number): string {
    const global = this.t(tKey("remote.scopeGlobal"));
    const project = this.t(tKey("remote.scopeProject"));
    const text = this.scope === "global"
      ? `[${global} ●] [${project} ○]  (g/p)`
      : `[${global} ○] [${project} ●]  (g/p)`;
    return truncateToWidth(text, width, "…");
  }

  private filterLine(width: number): string {
    const marker = this.focused ? CURSOR_MARKER : "";
    return truncateToWidth(
      `${this.theme.fg("accent", "›")} ${sanitizeSingleLineInput(this.query)}${marker}`,
      width,
      "…",
    );
  }

  private statusLine(width: number): string {
    return truncateToWidth(this.theme.fg(this.statusTone, sanitizeSingleLineInput(this.statusText)), width, "…");
  }

  private footerLine(width: number): string {
    const text = [
      this.t(tKey("remote.newHost")),
      this.t(tKey("remote.newTarget")),
      this.t(tKey("remote.test")),
      this.t(tKey("remote.delete")),
      "g/p scope",
      this.t(tKey("remote.filter")),
      this.t(tKey("remote.close")),
    ].join(" · ");
    return truncateToWidth(text, width, "…");
  }

  private rowLine(row: RemotePaneRow, selected: boolean, width: number): string {
    const prefix = selected ? this.theme.fg("accent", "▸") : " ";
    const label = this.rowLabel(row);
    const body = selected
      ? this.theme.bold(this.theme.fg("accent", label))
      : row.hidden
        ? this.theme.fg("dim", label)
        : label;
    return truncateToWidth(`${prefix} ${body}`, width, "…");
  }

  private rowLabel(row: RemotePaneRow): string {
    if (row.hidden) {
      return row.kind === "host" ? `(hidden) [H] ${row.id}` : `(hidden) [T] ${row.id}`;
    }
    if (row.kind === "host") {
      return `[H] ${row.id}  ${row.user}@${row.host}:${row.port} · SHA256:${row.keyPrefix}`;
    }
    return `[T] ${row.id}  ${row.driver} · ${row.cwd} · host ${row.host}`;
  }

  private buildRows(): RemotePaneRow[] {
    const { state } = this.options;
    const rows: RemotePaneRow[] = [];
    if (this.scope === "global") {
      for (const [id, host] of Object.entries(state.global.hosts)) {
        rows.push({ kind: "host", id, host: host.host, user: host.user, port: host.port, keyPrefix: hostKeyPrefix(host), scope: "global" });
      }
      for (const [id, target] of Object.entries(state.global.targets)) {
        rows.push({ kind: "target", id, host: target.host, driver: target.driver, cwd: target.cwd, scope: "global" });
      }
    } else {
      for (const [id, entry] of Object.entries(state.project.hosts)) {
        rows.push(entry === null
          ? { kind: "host", id, host: "", user: "", port: 0, keyPrefix: "", scope: "project", hidden: true }
          : { kind: "host", id, host: entry.host, user: entry.user, port: entry.port, keyPrefix: hostKeyPrefix(entry), scope: "project" });
      }
      for (const [id, entry] of Object.entries(state.project.targets)) {
        rows.push(entry === null
          ? { kind: "target", id, host: "", driver: "", cwd: "", scope: "project", hidden: true }
          : { kind: "target", id, host: entry.host, driver: entry.driver, cwd: entry.cwd, scope: "project" });
      }
    }
    rows.sort((left, right) => {
      if (left.kind !== right.kind) return left.kind === "host" ? -1 : 1;
      return left.id.localeCompare(right.id);
    });
    return rows;
  }

  private rowSearchText(row: RemotePaneRow): string {
    if (row.kind === "host") return `${row.id} ${row.host}`;
    return `${row.id} ${row.host} ${row.driver} ${row.cwd}`;
  }

  private visibleItems(): RemotePaneRow[] {
    const query = this.query.trim().toLowerCase();
    if (!query) return this.buildRows();
    return this.buildRows().filter((row) => this.rowSearchText(row).toLowerCase().includes(query));
  }

  private move(delta: -1 | 1): void {
    const length = this.visibleItems().length;
    this.selected = clampIndex(this.selected + delta, length);
    this.options.requestRender();
  }

  private setScope(scope: RemotePaneScope): void {
    if (this.scope === scope) return;
    this.scope = scope;
    this.selected = 0;
    this.statusText = "";
    this.options.requestRender();
  }

  private activateRow(row: RemotePaneRow): void {
    if (row.kind === "host") this.options.close({ kind: "remote-edit-host", hostId: row.id, scope: this.scope });
    else this.options.close({ kind: "remote-edit-target", targetId: row.id, scope: this.scope });
  }

  private deleteRow(row: RemotePaneRow): void {
    if (row.kind === "host") this.options.close({ kind: "remote-delete-host", hostId: row.id, scope: this.scope });
    else this.options.close({ kind: "remote-delete-target", targetId: row.id, scope: this.scope });
  }

  private startTest(row: RemotePaneRow): void {
    if (row.kind !== "target" || this.testingId) return;
    const targetId = row.id;
    this.testingId = targetId;
    this.statusTone = "dim";
    this.statusText = `${this.t(tKey("remote.testing"), { id: targetId })} (connecting)`;
    this.options.requestRender();
    const signal = AbortSignal.timeout(this.testTimeoutMs);
    void this.runTest(targetId, signal);
  }

  private async runTest(targetId: string, signal: AbortSignal): Promise<void> {
    const probe = this.options.onTest(targetId, signal);
    // The probe may outlive the abort race; swallow its late rejection.
    probe.catch(() => {});
    try {
      const result = await Promise.race([
        probe,
        new Promise<never>((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(signal.reason), { once: true });
        }),
      ]);
      this.statusTone = "success";
      this.statusText = result
        ? `${this.t(tKey("remote.ok"))} ${sanitizeSingleLineInput(result)}`
        : this.t(tKey("remote.ok"));
    } catch (error) {
      this.statusTone = "error";
      this.statusText = signal.aborted
        ? `${this.t(tKey("remote.fail"))} timed out after ${this.timeoutLabel()}`
        : `${this.t(tKey("remote.fail"))} ${error instanceof Error ? error.message : String(error)}`;
    } finally {
      this.testingId = null;
      this.options.requestRender();
    }
  }

  private timeoutLabel(): string {
    return this.testTimeoutMs >= 1000 ? `${this.testTimeoutMs / 1000}s` : `${this.testTimeoutMs}ms`;
  }
}
