// Attach overlay — multi-agent view. pi-tui: Box (border), TabBar, ScrollView.
import {
  Box, type BoxBorder, ScrollView, TabBar, type Tab, type TabBarTheme,
  type Component, visibleWidth, truncateToWidth, wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import type { ActiveAgent } from "../shared/types.ts";

const MAX_LOG_LINES = 500;
const STREAMING_MAX_LINES = 8;
const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const SPINNER_MS = 80;

interface ToolEntry { name: string; status: "running" | "completed" | "failed"; startedAt: number }
interface AgentLog {
  agent: ActiveAgent;
  lines: Array<{ text: string; kind: "info" | "tool" | "output" | "system" }>;
  scrollOffset: number; streamingText: string; activeTools: ToolEntry[];
}

const dim = (s: string) => `\x1b[2m${s}\x1b[22m`;
const bold = (s: string) => `\x1b[1m${s}\x1b[22m`;
const yellow = (s: string) => `\x1b[33m${s}\x1b[39m`;
const green = (s: string) => `\x1b[32m${s}\x1b[39m`;
const red = (s: string) => `\x1b[31m${s}\x1b[39m`;

const BORDER: BoxBorder = {
  chars: { topLeft: "╭", topRight: "╮", bottomLeft: "╰", bottomRight: "╯", horizontal: "─", vertical: "│" },
  color: dim,
};
const TAB_THEME: TabBarTheme = { label: dim, activeTab: (s) => bold(green(s)), inactiveTab: dim, hint: dim };

class LinesProxy implements Component {
  lines: readonly string[] = [];
  invalidate(): void {}
  render(): readonly string[] { return this.lines; }
}

function activeMs(a: ActiveAgent): number {
  return Date.now() - a.startedAt - a.sleepMs - (a.sleptAt ? Date.now() - a.sleptAt : 0);
}

export class AttachOverlay implements Component {
  private agents: Map<string, AgentLog> = new Map();
  private activeId: string;
  private order: string[] = [];
  private onDone: () => void;
  private getActiveRuns: () => Map<string, ActiveAgent>;
  private requestRender: (() => void) | null = null;

  private tabBar: TabBar;
  private scroll: ScrollView;
  private proxy = new LinesProxy();
  private box: Box;
  private frame = 0;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(
    initial: ActiveAgent,
    onDone: () => void,
    getActiveRuns?: () => Map<string, ActiveAgent>,
  ) {
    this.onDone = onDone;
    this.getActiveRuns = getActiveRuns ?? (() => new Map());
    this.activeId = initial.correlationId;
    this.addAgent(initial);

    this.tabBar = new TabBar("", this.buildTabs(), TAB_THEME);
    this.tabBar.showHint = false;
    this.tabBar.onTabChange = (tab) => { this.activeId = tab.id; };

    this.scroll = new ScrollView([], {
      height: 10, scrollbar: "auto", theme: { track: dim, thumb: green },
    });

    this.box = new Box(0, 0, undefined, BORDER);
    this.box.addChild(this.proxy);

    this.timer = setInterval(() => {
      this.frame = (this.frame + 1) % SPINNER.length;
      const log = this.agents.get(this.activeId);
      if (log?.activeTools.some(t => t.status === "running")) this.requestRender?.();
    }, SPINNER_MS);
  }

  setRequestRender(fn: () => void): void { this.requestRender = fn; }

  private addAgent(agent: ActiveAgent): void {
    if (this.agents.has(agent.correlationId)) return;
    this.agents.set(agent.correlationId, {
      agent, lines: [], scrollOffset: 0, streamingText: "", activeTools: [],
    });
    this.order.push(agent.correlationId);
  }

  syncAgents(): void {
    for (const [, a] of this.getActiveRuns()) this.addAgent(a);
  }

  setStreamingText(cid: string, text: string): void {
    const log = this.ensureLog(cid);
    if (log) { log.streamingText = text; this.requestRender?.(); }
  }

  setActiveTools(cid: string, tools: ToolEntry[]): void {
    const log = this.ensureLog(cid);
    if (log) { log.activeTools = tools; this.requestRender?.(); }
  }

  appendLog(cid: string, text: string, kind: AgentLog["lines"][0]["kind"] = "info"): void {
    const log = this.ensureLog(cid);
    if (!log) return;
    log.lines.push({ text, kind });
    if (log.lines.length > MAX_LOG_LINES) log.lines.shift();
    if (cid === this.activeId) log.scrollOffset = Infinity;
    this.requestRender?.();
  }

  private ensureLog(cid: string): AgentLog | undefined {
    let log = this.agents.get(cid);
    if (!log) {
      const a = this.getActiveRuns().get(cid);
      if (a) { this.addAgent(a); log = this.agents.get(cid); }
    }
    return log;
  }

  handleInput(data: string): void {
    if (data === "\x1b" || data === "q") { this.onDone(); return; }
    this.syncAgents();
    if (this.tabBar.handleInput(data)) { this.requestRender?.(); return; }

    const log = this.agents.get(this.activeId);
    if (!log) return;
    this.scroll.setScrollOffset(log.scrollOffset);

    if (this.scroll.handleScrollKey(data)) {
      log.scrollOffset = this.scroll.getScrollOffset();
      this.requestRender?.();
      return;
    }
    if (data === "j") {
      this.scroll.scroll(1);
      log.scrollOffset = this.scroll.getScrollOffset();
      this.requestRender?.();
    } else if (data === "k") {
      this.scroll.scroll(-1);
      log.scrollOffset = this.scroll.getScrollOffset();
      this.requestRender?.();
    }
  }

  render(width: number, height?: number): string[] {
    this.syncAgents();
    const w = Math.min(width, 120);
    const inner = w - 2;
    this.tabBar.setTabs(this.buildTabs(), this.activeId);

    const log = this.agents.get(this.activeId);
    const rows: string[] = [];

    rows.push(...this.tabBar.render(inner));
    rows.push(dim("─".repeat(inner)));

    if (!log) {
      rows.push(" (no agent selected)");
      this.proxy.lines = rows;
      return [...this.box.render(w)];
    }

    const a = log.agent;
    const up = Math.round(activeMs(a) / 1000);
    const st = a.status === "sleeping" ? yellow("SLEEPING") : a.status === "completed" ? dim("DONE") : green("RUNNING");
    const hL = `${bold(a.agent)}/${bold(a.name ?? a.correlationId.slice(0, 8))}`;
    const hR = `${st}  ${dim(`${up}s`)}  ${dim(`inbox:${a.inbox.length}`)}`;
    rows.push(visibleWidth(hL) + 2 + visibleWidth(hR) <= inner ? `${hL}  ${hR}` : truncateToWidth(hL, inner, "…"));
    rows.push(dim("─".repeat(inner)));

    rows.push(...this.renderTools(log, inner));
    rows.push(dim("─".repeat(inner)));
    rows.push(...this.renderStream(log, inner));
    if (log.streamingText || log.activeTools.some(t => t.status === "running"))
      rows.push(dim("─".repeat(inner)));

    const logLines = this.buildLog(log, inner - 2);
    const fixedH = rows.length + 2 + (a.status === "sleeping" ? 2 : 0) + 1;
    const logH = Math.max(3, (height ?? 30) - fixedH);
    this.scroll.setHeight(logH);
    this.scroll.setLines(logLines);
    this.scroll.setScrollOffset(log.scrollOffset);
    rows.push(...this.scroll.render(inner));
    log.scrollOffset = this.scroll.getScrollOffset();

    if (a.status === "sleeping") {
      rows.push(dim("─".repeat(inner)));
      rows.push(`${yellow(" ◉")} ${dim("sleeping — teammate-send to wake")}`);
    }

    this.proxy.lines = rows;
    const out = [...this.box.render(w)];

    const off = this.scroll.getScrollOffset(), total = logLines.length;
    const si = total > logH ? ` ${off + 1}-${Math.min(off + logH, total)}/${total}` : "";
    out.push(truncateToWidth(` ${dim("ESC")} back  ${dim("Tab")} switch(${this.order.length})  ${dim("↑↓")} scroll${dim(si)}`, w, "…"));
    return out;
  }

  private buildTabs(): Tab[] {
    return this.order.map(cid => {
      const log = this.agents.get(cid);
      if (!log) return { id: cid, label: cid.slice(0, 6) };
      const a = log.agent, name = a.name ?? cid.slice(0, 6);
      const pre = a.spawnedBy ? "↳" : "";
      const icon = a.status === "sleeping" ? "◉" : a.status === "completed" ? "✓" : "■";
      return { id: cid, label: `${icon} ${pre}${a.agent}/${name}`, short: `${icon} ${name}`, muted: a.status === "completed" };
    });
  }

  private renderTools(log: AgentLog, w: number): string[] {
    if (log.activeTools.length === 0) return [dim(" tools: idle")];
    const parts: string[] = [];
    const sp = SPINNER[this.frame];
    for (const t of log.activeTools.slice(-6)) {
      const s = Math.round((Date.now() - t.startedAt) / 1000);
      if (t.status === "running") parts.push(yellow(`${sp} ${bold(t.name)} ${dim(`${s}s`)}`));
      else if (t.status === "failed") parts.push(red(`✗ ${t.name}`));
      else parts.push(dim(`└ ${t.name}`));
    }
    if (log.activeTools.length > 6) parts.unshift(dim(`+${log.activeTools.length - 6}`));
    return [truncateToWidth(dim(" tools: ") + parts.join(dim("  ")), w, "…")];
  }

  private renderStream(log: AgentLog, w: number): string[] {
    if (!log.streamingText) return [dim(" output: waiting...")];
    const all = log.streamingText.split("\n"), tail = all.slice(-STREAMING_MAX_LINES);
    const header = all.length > STREAMING_MAX_LINES ? dim(` output: (${all.length - STREAMING_MAX_LINES} earlier)`) : dim(" output:");
    const cw = w - 4;
    return [header, ...tail.map(l => `${dim(" │")} ${truncateToWidth(l, cw, "…")}`)];
  }

  private buildLog(log: AgentLog, w: number): string[] {
    const result: string[] = [];
    for (const e of log.lines) {
      for (const wl of wrapTextWithAnsi(e.text, w)) {
        if (e.kind === "tool") result.push(`${green("■")} ${bold(wl)}`);
        else if (e.kind === "output") result.push(`${dim("│")} ${wl}`);
        else if (e.kind === "system") result.push(`${dim("»")} ${yellow(wl)}`);
        else result.push(`  ${wl}`);
      }
    }
    if (log.agent.inbox.length > 0) {
      result.push(dim("── inbox ──"));
      for (const msg of log.agent.inbox.slice(-5)) {
        const t = new Date(msg.timestamp).toISOString().slice(11, 19);
        for (const wl of wrapTextWithAnsi(`[${t}] ◀ ${msg.from}: ${msg.payload}`, w)) {
          result.push(`${yellow("◀")} ${wl}`);
        }
      }
    }
    return result;
  }

  dispose(): void {
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
    this.agents.clear();
    this.order.length = 0;
  }
}
