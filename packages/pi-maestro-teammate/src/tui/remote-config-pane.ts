import {
  CURSOR_MARKER,
  Key,
  type Component,
  type Focusable,
  decodeKittyPrintable,
  matchesKey,
  truncateToWidth,
} from "@earendil-works/pi-tui";
import type { ModelCliRow } from "../models/cli-list.ts";
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
    kind: "deployment";
    registrationId: string;
    modelId: string;
    deploymentId: string;
    harness: string;
    transportKind: string;
    resolvable: boolean;
    healthyStatic: boolean;
  }
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
  | { kind: "connection-edit-deployment"; registrationId: string }
  | { kind: "connection-add-deployment" }
  | { kind: "connection-upgrade-legacy" }
  | { kind: "remote-edit-host"; hostId: string; scope: RemotePaneScope }
  | { kind: "remote-new-host"; scope: RemotePaneScope }
  | { kind: "remote-edit-target"; targetId: string; scope: RemotePaneScope }
  | { kind: "remote-new-target"; scope: RemotePaneScope }
  | { kind: "remote-delete-host"; hostId: string; scope: RemotePaneScope }
  | { kind: "remote-delete-target"; targetId: string; scope: RemotePaneScope }
  | { kind: "remote-scope"; scope: RemotePaneScope }
  | { kind: "reload"; tab: "connections" };

export type RemotePaneDeployments =
  | {
    kind: "registry";
    rows: readonly ModelCliRow[];
    defaultModel: string;
    diagnostics: readonly string[];
  }
  | { kind: "legacy" };

export interface RemoteConfigPaneOptions {
  state: RemoteConfigState;
  deployments?: RemotePaneDeployments;
  theme: { fg(role: string, text: string): string; bold(text: string): string };
  t: TuiTranslator;
  requestRender: () => void;
  close: (action: RemotePaneAction | null) => void;
  onTest: (targetId: string, signal: AbortSignal) => Promise<string>;
  locale?: SupportedSettingsLocale;
  /** Injectable test hook; the product default is a 10s SSH probe timeout. */
  testTimeoutMs?: number;
}

type RemotePaneItem = RemotePaneRow | { kind: "legacy-notice" };

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
 * Pure-UI connections tab embedded in the Teammate Control Center.
 *
 * The pane renders precomputed registry deployments plus one remote scope at
 * a time (global or project), emits edit/create/delete/scope actions through
 * `close`, and runs inline target connectivity probes through `onTest`.
 * Manifest access, field-level wizards, persistence, and real SSH testing live
 * outside the pane.
 */
export class RemoteConfigPane implements Component, Focusable {
  focused = false;

  private scope: RemotePaneScope = "global";
  private query = "";
  private selected = 0;
  private testingId: string | null = null;
  /** Aborts the in-flight probe when the pane is disposed or a new test starts. */
  private testAbort: AbortController | null = null;
  private disposed = false;
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
    this.disposed = true;
    this.testAbort?.abort();
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
      if (matchesKey(data, "a")) {
        this.options.close({ kind: "connection-add-deployment" });
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
    // Governing ui-conventions spec: below 40 columns the tab degrades to an
    // action-first single column — no frame, scope, filter, or section chrome,
    // just the selectable rows plus status and a one-line hint.
    if (w < 40) return this.renderCompactRows(w);
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
      let previousSection: "deployments" | "hosts" | "targets" | undefined;
      for (const [index, row] of items.entries()) {
        const section = row.kind === "deployment" || row.kind === "legacy-notice"
          ? "deployments"
          : row.kind === "host"
            ? "hosts"
            : "targets";
        if (section !== previousSection) {
          rows.push(this.sectionLine(section, inner));
          previousSection = section;
        }
        rows.push(this.rowLine(row, index === this.selected, inner));
      }
    }
    rows.push(this.theme.fg("dim", "─".repeat(inner)));
    if (this.statusText) rows.push(this.statusLine(inner));
    rows.push(this.footerLine(inner));
    return this.frame(rows, w);
  }

  /** Action-first single-column layout for narrow terminals (<40 columns). */
  private renderCompactRows(w: number): string[] {
    const items = this.visibleItems();
    this.selected = clampIndex(this.selected, items.length);
    const rows: string[] = [
      truncateToWidth(this.theme.fg("accent", this.theme.bold(this.t(tKey("remote.title")))), w, "…"),
    ];
    if (this.statusText) rows.push(this.statusLine(w));
    if (items.length === 0) {
      rows.push(this.theme.fg("dim", this.t(tKey("remote.empty"))));
    } else {
      for (const [index, row] of items.entries()) {
        rows.push(this.rowLine(row, index === this.selected, w));
      }
    }
    rows.push(this.theme.fg("dim", truncateToWidth(this.t(tKey("connections.compactHint")), w, "…")));
    return rows;
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
      this.t(tKey("connections.scopeHint")),
      this.t(tKey("remote.filter")),
      this.t(tKey("remote.close")),
      this.t(tKey("connections.addDeployment")),
    ].join(" · ");
    return truncateToWidth(text, width, "…");
  }

  private sectionLine(section: "deployments" | "hosts" | "targets", width: number): string {
    const key = section === "deployments"
      ? "connections.deploymentsTitle"
      : section === "hosts"
        ? "connections.hostsTitle"
        : "connections.targetsTitle";
    return truncateToWidth(this.theme.bold(this.t(tKey(key))), width, "…");
  }

  private rowLine(row: RemotePaneItem, selected: boolean, width: number): string {
    const prefix = selected ? this.theme.fg("accent", "▸") : " ";
    const label = this.rowLabel(row);
    const body = row.kind === "legacy-notice"
      ? this.theme.fg("dim", label)
      : selected
        ? this.theme.bold(this.theme.fg("accent", label))
        : "hidden" in row && row.hidden
          ? this.theme.fg("dim", label)
          : label;
    return truncateToWidth(`${prefix} ${body}`, width, "…");
  }

  private rowLabel(row: RemotePaneItem): string {
    if (row.kind === "legacy-notice") return this.t(tKey("connections.legacyNotice"));
    if (row.kind === "deployment") {
      const resolvable = row.resolvable ? "✓" : "✗";
      return this.t(tKey("connections.deploymentRow"), {
        registration: row.registrationId,
        model: row.modelId,
        harness: row.harness,
        transport: row.transportKind,
        resolvable,
      });
    }
    if (row.hidden) {
      return row.kind === "host"
        ? this.t(tKey("connections.hiddenHost"), { id: row.id })
        : this.t(tKey("connections.hiddenTarget"), { id: row.id });
    }
    if (row.kind === "host") {
      return this.t(tKey("connections.hostRow"), {
        id: row.id,
        user: row.user,
        host: row.host,
        port: row.port,
        keyPrefix: row.keyPrefix,
      });
    }
    return this.t(tKey("connections.targetRow"), {
      id: row.id,
      driver: row.driver,
      cwd: row.cwd,
      host: row.host,
    });
  }

  private buildRows(): RemotePaneItem[] {
    const { state } = this.options;
    const rows: RemotePaneItem[] = [];
    const deployments = this.options.deployments;
    if (deployments?.kind === "legacy") {
      rows.push({ kind: "legacy-notice" });
    } else if (deployments?.kind === "registry") {
      for (const row of deployments.rows) {
        rows.push({
          kind: "deployment",
          registrationId: row.registrationId,
          modelId: row.modelId,
          deploymentId: row.deploymentId,
          harness: row.harness,
          transportKind: row.transportKind,
          resolvable: row.resolvable,
          healthyStatic: row.healthyStatic,
        });
      }
    }
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
    const order: Record<RemotePaneItem["kind"], number> = {
      deployment: 0,
      "legacy-notice": 0,
      host: 1,
      target: 2,
    };
    rows.sort((left, right) => {
      const sectionOrder = order[left.kind] - order[right.kind];
      if (sectionOrder !== 0) return sectionOrder;
      const leftId = left.kind === "deployment"
        ? left.registrationId
        : left.kind === "legacy-notice"
          ? ""
          : left.id;
      const rightId = right.kind === "deployment"
        ? right.registrationId
        : right.kind === "legacy-notice"
          ? ""
          : right.id;
      return leftId.localeCompare(rightId);
    });
    return rows;
  }

  private rowSearchText(row: RemotePaneItem): string {
    if (row.kind === "legacy-notice") return this.t(tKey("connections.legacyNotice"));
    if (row.kind === "deployment") {
      return [
        row.registrationId,
        row.modelId,
        row.deploymentId,
        row.harness,
        row.transportKind,
        row.resolvable ? "resolvable" : "unresolvable",
        row.healthyStatic ? "healthy" : "unhealthy",
      ].join(" ");
    }
    if (row.kind === "host") return `${row.id} ${row.host}`;
    return `${row.id} ${row.host} ${row.driver} ${row.cwd}`;
  }

  private visibleItems(): RemotePaneItem[] {
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

  private activateRow(row: RemotePaneItem): void {
    if (row.kind === "legacy-notice") {
      this.options.close({ kind: "connection-upgrade-legacy" });
    } else if (row.kind === "deployment") {
      this.options.close({ kind: "connection-edit-deployment", registrationId: row.registrationId });
    } else if (row.kind === "host") {
      this.options.close({ kind: "remote-edit-host", hostId: row.id, scope: this.scope });
    } else {
      this.options.close({ kind: "remote-edit-target", targetId: row.id, scope: this.scope });
    }
  }

  private deleteRow(row: RemotePaneItem): void {
    if (row.kind === "host") this.options.close({ kind: "remote-delete-host", hostId: row.id, scope: this.scope });
    else if (row.kind === "target") this.options.close({ kind: "remote-delete-target", targetId: row.id, scope: this.scope });
  }

  private startTest(row: RemotePaneItem): void {
    if (row.kind !== "target" || this.testingId) return;
    const targetId = row.id;
    this.testingId = targetId;
    this.statusTone = "dim";
    this.statusText = `${this.t(tKey("remote.testing"), { id: targetId })} ${this.t(tKey("connections.connecting"))}`;
    this.options.requestRender();
    const controller = new AbortController();
    this.testAbort = controller;
    const timeout = setTimeout(() => controller.abort(), this.testTimeoutMs);
    void this.runTest(targetId, controller.signal).finally(() => clearTimeout(timeout));
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
      // The probe may resolve with a timeout string instead of rejecting
      // (onTest catches aborts); treat any post-abort resolution as failure.
      if (signal.aborted) throw signal.reason;
      this.statusTone = "success";
      this.statusText = result
        ? `${this.t(tKey("remote.ok"))} ${sanitizeSingleLineInput(result)}`
        : this.t(tKey("remote.ok"));
    } catch (error) {
      this.statusTone = "error";
      this.statusText = signal.aborted
        ? `${this.t(tKey("remote.fail"))} ${this.t(tKey("connections.timedOut"), { timeout: this.timeoutLabel() })}`
        : `${this.t(tKey("remote.fail"))} ${error instanceof Error ? error.message : String(error)}`;
    } finally {
      this.testingId = null;
      if (this.testAbort?.signal === signal) this.testAbort = null;
      // A disposed pane must not drive renders on the torn-down overlay.
      if (!this.disposed) this.options.requestRender();
    }
  }

  private timeoutLabel(): string {
    return this.testTimeoutMs >= 1000 ? `${this.testTimeoutMs / 1000}s` : `${this.testTimeoutMs}ms`;
  }
}
