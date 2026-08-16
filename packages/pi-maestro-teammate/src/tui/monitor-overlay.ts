/**
 * MonitorOverlay — TUI form for configuring monitor bindings.
 *
 * Opened via /monitor command. Shows active sessions, allows selecting
 * which to monitor, choosing auto/custom mode, and entering a custom prompt.
 *
 * Pattern: follows TeammateControlCenter (ctx.ui.custom + Component).
 */

import { Key, decodeKittyPrintable, matchesKey, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { statusIcon } from "../extension/monitor.ts";
import type { MonitorSupervisionMode } from "../extension/monitor.ts";
import {
  createTuiTranslator,
  onTuiLocaleChange,
  translateStatusIdentifier,
  type SupportedSettingsLocale,
  type TuiTranslator,
} from "./locale.ts";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface MonitorSessionRow {
  correlationId: string;
  displayName: string;
  agentRole: string;
  status: string;
  idleSeconds: number;
  /** Session/owner source; "local" for the current root process. */
  source?: string;
  /** Whether this session already has a monitor binding. */
  bound: boolean;
  /** Row kind: local agent, Pi workspace window, or owned remote worker. */
  kind?: "agent" | "window" | "remote";
  /** Whether this row can be selected as a monitor target (windows only). */
  bindable?: boolean;
  /** Owner (window) key this row belongs to; groups rows into window trees. */
  ownerId?: string;
  /** Dispatch depth; 0 = direct child of the window. */
  depth?: number;
  /** Correlation id of the parent agent within the same window, if nested. */
  parentCorrelationId?: string;
}

export interface MonitorOverlayResult {
  /** Selected session correlationIds. */
  selected: string[];
  mode: MonitorSupervisionMode;
  customPrompt?: string;
}

interface OverlayCallbacks {
  getSessions: () => MonitorSessionRow[];
  close: (result: MonitorOverlayResult | null) => void;
}

interface TreeNode {
  row: MonitorSessionRow;
  children: TreeNode[];
}

interface FlatTreeNode {
  row: MonitorSessionRow;
  depth: number;
  branch: string;
}

/** Nest agents under their parent agent (same owner) and return tree roots. */
function buildAgentTree(ownerKey: string, agents: MonitorSessionRow[]): TreeNode[] {
  const nodeById = new Map<string, TreeNode>();
  for (const agent of agents) nodeById.set(agent.correlationId, { row: agent, children: [] });
  const roots: TreeNode[] = [];
  for (const agent of agents) {
    const node = nodeById.get(agent.correlationId)!;
    const parentKey = agent.parentCorrelationId
      ? (ownerKey === "local" ? agent.parentCorrelationId : `${ownerKey}:${agent.parentCorrelationId}`)
      : undefined;
    const parent = parentKey ? nodeById.get(parentKey) : undefined;
    if (parent) parent.children.push(node);
    else roots.push(node);
  }
  return roots;
}

/** Depth-first flatten with branch glyphs (├─/└─/│) per level. */
function flattenTree(root: TreeNode, depth: number, isLast: boolean, continuation: string): FlatTreeNode[] {
  const branch = depth === 0 ? "" : `${continuation}${isLast ? "└─ " : "├─ "}`;
  const childContinuation = depth === 0 ? "" : `${continuation}${isLast ? "   " : "│  "}`;
  const nodes: FlatTreeNode[] = [{ row: root.row, depth, branch }];
  root.children.forEach((child, index) => {
    nodes.push(...flattenTree(child, depth + 1, index === root.children.length - 1, childContinuation));
  });
  return nodes;
}

/** Build a display tree: window roots and remote workers, with nested local agents. */
function buildTreeRows(sessions: MonitorSessionRow[]): FlatTreeNode[] {
  const windowRoots = sessions.filter((row) => row.kind === "window" || row.kind === "remote");
  const agentsByOwner = new Map<string, MonitorSessionRow[]>();
  for (const row of sessions) {
    if (row.kind === "window" || row.kind === "remote") continue;
    const ownerKey = row.ownerId ?? "local";
    let bucket = agentsByOwner.get(ownerKey);
    if (!bucket) {
      bucket = [];
      agentsByOwner.set(ownerKey, bucket);
    }
    bucket.push(row);
  }
  const nodes: FlatTreeNode[] = [];
  for (const root of windowRoots) {
    const ownerKey = root.ownerId ?? "local";
    const treeRoot: TreeNode = { row: root, children: buildAgentTree(ownerKey, agentsByOwner.get(ownerKey) ?? []) };
    nodes.push(...flattenTree(treeRoot, 0, true, ""));
  }
  // Standalone agents without a matching window root are NOT monitor targets
  // (no owner window to route interventions through) — drop them.
  return nodes;
}

// ---------------------------------------------------------------------------
// Overlay component
// ---------------------------------------------------------------------------

export class MonitorOverlay {
  private sessions: MonitorSessionRow[] = [];
  private treeRows: FlatTreeNode[] = [];
  private cursor = 0;
  private selected: Set<string> = new Set();
  private mode: MonitorSupervisionMode = "auto";
  private customPrompt = "";
  private editingPrompt = false;
  private statusText = "";
  private requestRender: () => void = () => {};
  private readonly t: TuiTranslator;
  private readonly localeDisposer: () => void;

  constructor(private readonly cb: OverlayCallbacks, locale?: SupportedSettingsLocale) {
    this.t = createTuiTranslator(locale);
    this.localeDisposer = locale === undefined
      ? onTuiLocaleChange(() => {
          this.statusText = "";
          this.requestRender();
        })
      : () => {};
    this.sessions = cb.getSessions();
    this.treeRows = buildTreeRows(this.sessions);
    // Pre-select already-bound sessions
    for (const s of this.sessions) {
      if (s.bound) this.selected.add(s.correlationId);
    }
  }

  setRequestRender(fn: () => void): void {
    this.requestRender = fn;
  }

  // --- Rendering ---

  render(width: number): string[] {
    // Follow the overlay width; the previous 20-col floor forced overflow on
    // narrow terminals (frameLine truncates, borders repeat inner exactly).
    const inner = Math.max(1, width - 4);
    const lines: string[] = [];
    const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;
    const bold = (s: string) => `\x1b[1m${s}\x1b[0m`;
    const accent = (s: string) => `\x1b[36m${s}\x1b[0m`;
    const green = (s: string) => `\x1b[32m${s}\x1b[0m`;

    // Title
    lines.push(dim(`╭${"─".repeat(inner)}╮`));
    lines.push(this.frameLine(bold(` ${this.t("monitor.title")}`), inner, dim));

    // Session list (window → agent → sub-agent tree)
    const maxVisible = Math.min(this.treeRows.length, 10);
    const scrollStart = Math.max(0, Math.min(this.cursor - 4, this.treeRows.length - maxVisible));

    for (let i = scrollStart; i < scrollStart + maxVisible && i < this.treeRows.length; i++) {
      const { row: s, branch } = this.treeRows[i]!;
      const isCursor = i === this.cursor;
      const isSelected = this.selected.has(s.correlationId);

      const pointer = isCursor ? accent("▸") : " ";
      const check = isSelected ? green("✓") : dim("○");
      const icon = statusIcon(s.status);
      const idle = s.kind === "window" || s.kind === "remote" || s.status !== "running" ? "—" : `${s.idleSeconds}s`;
      const boundTag = s.bound ? dim(" [MON]") : "";
      const sourceTag = s.source && s.source !== "local" ? dim(` [${s.source}]`) : "";
      const kindTag = s.kind === "window"
        ? dim(this.t("monitor.tag.window"))
        : s.kind === "remote" ? dim("[Remote]") : dim(this.t("monitor.tag.agent"));

      const row = ` ${pointer} ${check} ${branch}${icon} ${kindTag} ${s.displayName}  ${dim(translateStatusIdentifier(s.status, this.t))}  ${dim(idle)}  ${dim(s.agentRole)}${sourceTag}${boundTag}`;
      lines.push(this.frameLine(isCursor ? accent(row) : row, inner, dim));
    }

    if (this.treeRows.length === 0) {
      lines.push(this.frameLine(dim(`  ${this.t("monitor.noSessions")}`), inner, dim));
    }

    lines.push(this.frameLine("", inner, dim));

    // Mode selection
    const autoLabel = this.mode === "auto" ? accent(`● ${this.t("common.auto")}`) : dim(`○ ${this.t("common.auto")}`);
    const customLabel = this.mode === "custom" ? accent(`● ${this.t("common.custom")}`) : dim(`○ ${this.t("common.custom")}`);
    lines.push(this.frameLine(` ${this.t("monitor.mode")} ${autoLabel}  ${customLabel}  ${dim("(Tab)")}`, inner, dim));

    // Custom prompt (only in custom mode)
    if (this.mode === "custom") {
      const promptDisplay = this.editingPrompt
        ? ` > ${this.customPrompt}\x1b[7m \x1b[0m`
        : ` > ${this.customPrompt || dim(this.t("monitor.editPrompt"))}`;
      lines.push(this.frameLine(promptDisplay, inner, dim));
    }

    // Status
    if (this.statusText) {
      lines.push(this.frameLine(dim(` ${this.statusText}`), inner, dim));
    }

    // Footer
    lines.push(this.frameLine("", inner, dim));
    lines.push(this.frameLine(
      dim(this.t("monitor.footer")),
      inner, dim,
    ));
    lines.push(dim(`╰${"─".repeat(inner)}╯`));

    return lines;
  }

  private frameLine(content: string, inner: number, dim: (s: string) => string): string {
    const truncated = truncateToWidth(content, inner, "…");
    const pad = Math.max(0, inner - visibleWidth(truncated));
    return `${dim("│")} ${truncated}${" ".repeat(pad)} ${dim("│")}`;
  }

  // --- Input ---

  handleInput(data: string): void {
    // Editing custom prompt
    if (this.editingPrompt) {
      if (matchesKey(data, Key.escape) || matchesKey(data, Key.enter)) {
        this.editingPrompt = false;
        this.statusText = this.customPrompt ? this.t("monitor.promptStatus", { prompt: this.customPrompt.slice(0, 40) }) : "";
      } else if (matchesKey(data, Key.backspace)) {
        this.customPrompt = this.customPrompt.slice(0, -1);
      } else {
        const printable = decodeKittyPrintable(data) ?? (!data.startsWith("\x1b") ? data : "");
        if (printable >= " " && printable.length <= 2) this.customPrompt += printable;
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
      if (this.mode === "custom" && !this.customPrompt) {
        this.editingPrompt = true;
        this.statusText = this.t("monitor.typePrompt");
      } else {
        this.confirm();
      }
    } else if (matchesKey(data, Key.tab)) {
      this.mode = this.mode === "auto" ? "custom" : "auto";
      this.statusText = "";
    } else if (matchesKey(data, Key.space)) {
      if (this.treeRows.length > 0) {
        const s = this.treeRows[this.cursor]!.row;
        if (s.bindable === false) {
          this.statusText = s.kind === "window"
            ? this.t("monitor.currentWindow")
            : s.kind === "remote"
              ? "Remote workers use remote-worker for lifecycle control."
              : this.t("monitor.subagents");
        } else if (this.selected.has(s.correlationId)) {
          this.selected.delete(s.correlationId);
        } else {
          this.selected.add(s.correlationId);
        }
      }
    } else if (matchesKey(data, Key.up) || commandInput === "k") {
      this.cursor = Math.max(0, this.cursor - 1);
    } else if (matchesKey(data, Key.down) || commandInput === "j") {
      this.cursor = Math.min(this.treeRows.length - 1, this.cursor + 1);
    } else if (/^[1-9]$/.test(commandInput)) {
      const idx = Number(commandInput) - 1;
      if (idx < this.treeRows.length) {
        this.cursor = idx;
        const s = this.treeRows[idx]!.row;
        if (s.bindable === false) {
          this.statusText = s.kind === "window"
            ? this.t("monitor.currentWindow")
            : s.kind === "remote"
              ? "Remote workers use remote-worker for lifecycle control."
              : this.t("monitor.subagents");
        } else if (this.selected.has(s.correlationId)) this.selected.delete(s.correlationId);
        else this.selected.add(s.correlationId);
      }
    }
    this.requestRender();
  }

  private confirm(): void {
    const selected = [...this.selected];
    if (selected.length === 0) {
      this.statusText = this.t("monitor.selectOne");
      this.requestRender();
      return;
    }
    if (this.mode === "custom" && !this.customPrompt.trim()) {
      this.editingPrompt = true;
      this.statusText = this.t("monitor.enterPrompt");
      this.requestRender();
      return;
    }
    this.cb.close({
      selected,
      mode: this.mode,
      customPrompt: this.mode === "custom" ? this.customPrompt.trim() : undefined,
    });
  }

  invalidate(): void {}
  dispose(): void {
    this.localeDisposer();
  }
}

// ---------------------------------------------------------------------------
// Opening helper
// ---------------------------------------------------------------------------

export interface MonitorOverlayDeps {
  getSessions: () => MonitorSessionRow[];
  locale?: SupportedSettingsLocale;
}

/**
 * Opens the monitor overlay and returns the user's selection.
 * Returns null if cancelled.
 */
export async function showMonitorOverlay(
  ctx: { ui: { custom: <T>(factory: (tui: { requestRender: () => void }, theme: unknown, keybindings: unknown, done: (result: T) => void) => { render: (width: number) => string[]; handleInput: (data: string) => void; invalidate: () => void; dispose: () => void }, options: Record<string, unknown>) => Promise<T> } },
  deps: MonitorOverlayDeps,
): Promise<MonitorOverlayResult | null> {
  return ctx.ui.custom<MonitorOverlayResult | null>(
    (tui, _theme, _keybindings, done) => {
      const overlay = new MonitorOverlay({
        getSessions: deps.getSessions,
        close: done,
      }, deps.locale);
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
