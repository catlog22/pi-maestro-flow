/**
 * Attach overlay — multi-agent view with tab switching.
 *
 * Shows real-time tool activity and output content for agents.
 * Tab/Shift+Tab to switch. ↑↓ to scroll. ESC to dismiss.
 */

import type { Component } from "@earendil-works/pi-tui";
import type { ActiveAgent } from "../shared/types.ts";

const MAX_LOG_LINES = 500;

interface AgentLog {
  agent: ActiveAgent;
  lines: Array<{ text: string; kind: "info" | "tool" | "output" | "system" }>;
  scrollOffset: number;
}

function wrapLine(text: string, maxW: number): string[] {
  if (text.length <= maxW) return [text];
  const lines: string[] = [];
  let pos = 0;
  while (pos < text.length) {
    lines.push(text.slice(pos, pos + maxW));
    pos += maxW;
  }
  return lines;
}

export class AttachOverlay implements Component {
  private agents: Map<string, AgentLog> = new Map();
  private activeId: string;
  private agentOrder: string[] = [];
  private onDone: () => void;
  private getActiveRuns: () => Map<string, ActiveAgent>;
  private requestRender: (() => void) | null = null;

  constructor(
    initialAgent: ActiveAgent,
    onDone: () => void,
    getActiveRuns?: () => Map<string, ActiveAgent>,
  ) {
    this.onDone = onDone;
    this.getActiveRuns = getActiveRuns ?? (() => new Map());
    this.activeId = initialAgent.correlationId;
    this.addAgent(initialAgent);
  }

  setRequestRender(fn: () => void): void {
    this.requestRender = fn;
  }

  private addAgent(agent: ActiveAgent): void {
    if (this.agents.has(agent.correlationId)) return;
    this.agents.set(agent.correlationId, {
      agent,
      lines: [],
      scrollOffset: 0,
    });
    this.agentOrder.push(agent.correlationId);
  }

  syncAgents(): void {
    for (const [cid, agent] of this.getActiveRuns()) {
      this.addAgent(agent);
    }
  }

  appendLog(correlationId: string, text: string, kind: "info" | "tool" | "output" | "system" = "info"): void {
    let log = this.agents.get(correlationId);
    if (!log) {
      const agent = this.getActiveRuns().get(correlationId);
      if (agent) {
        this.addAgent(agent);
        log = this.agents.get(correlationId);
      }
    }
    if (!log) return;
    log.lines.push({ text, kind });
    if (log.lines.length > MAX_LOG_LINES) {
      log.lines.shift();
    }
    if (correlationId === this.activeId) {
      log.scrollOffset = Math.max(0, log.lines.length - 25);
    }
    this.requestRender?.();
  }

  setOutput(correlationId: string, content: string): void {
    const log = this.agents.get(correlationId);
    if (!log) return;
    // Replace last output block with new content
    while (log.lines.length > 0 && log.lines[log.lines.length - 1].kind === "output") {
      log.lines.pop();
    }
    const lines = content.split("\n").slice(-12);
    for (const line of lines) {
      log.lines.push({ text: line, kind: "output" });
    }
    if (content.split("\n").length > 12) {
      log.lines.push({ text: `… ${content.split("\n").length - 12} earlier lines`, kind: "output" });
    }
    if (correlationId === this.activeId) {
      log.scrollOffset = Math.max(0, log.lines.length - 25);
    }
    this.requestRender?.();
  }

  handleInput(data: string): void {
    if (data === "\x1b" || data === "q") {
      this.onDone();
      return;
    }
    if (data === "\t") {
      this.syncAgents();
      const idx = this.agentOrder.indexOf(this.activeId);
      this.activeId = this.agentOrder[(idx + 1) % this.agentOrder.length];
      this.requestRender?.();
      return;
    }
    if (data === "\x1b[Z") {
      this.syncAgents();
      const idx = this.agentOrder.indexOf(this.activeId);
      this.activeId = this.agentOrder[(idx - 1 + this.agentOrder.length) % this.agentOrder.length];
      this.requestRender?.();
      return;
    }
    const log = this.agents.get(this.activeId);
    if (!log) return;
    if (data === "\x1b[A" || data === "k") {
      log.scrollOffset = Math.max(0, log.scrollOffset - 1);
      this.requestRender?.();
    } else if (data === "\x1b[B" || data === "j") {
      log.scrollOffset = Math.min(Math.max(0, log.lines.length - 10), log.scrollOffset + 1);
      this.requestRender?.();
    }
  }

  render(width: number, height?: number): string[] {
    this.syncAgents();
    const dim = (s: string) => `\x1b[2m${s}\x1b[22m`;
    const bold = (s: string) => `\x1b[1m${s}\x1b[22m`;
    const cyan = (s: string) => `\x1b[36m${s}\x1b[39m`;
    const yellow = (s: string) => `\x1b[33m${s}\x1b[39m`;
    const green = (s: string) => `\x1b[32m${s}\x1b[39m`;
    const red = (s: string) => `\x1b[31m${s}\x1b[39m`;
    const out: string[] = [];
    const w = Math.min(width, 120);

    // Top border
    out.push(dim("╭" + "─".repeat(w - 2) + "╮"));

    // Tab bar
    const tabs = this.agentOrder.map((cid) => {
      const log = this.agents.get(cid);
      if (!log) return "";
      const a = log.agent;
      const label = a.name ?? cid.slice(0, 6);
      const prefix = a.spawnedBy ? "↳" : "";
      const statusIcon = a.status === "sleeping" ? yellow("◉") : green("●");
      if (cid === this.activeId) {
        return ` ${statusIcon} ${bold(`${prefix}${a.agent}/${label}`)} `;
      }
      return ` ${statusIcon} ${dim(`${prefix}${a.agent}/${label}`)} `;
    }).join(dim("│"));
    out.push(dim("│") + tabs.slice(0, w - 2).padEnd(w - 2) + dim("│"));
    out.push(dim("├" + "─".repeat(w - 2) + "┤"));

    const log = this.agents.get(this.activeId);
    if (!log) {
      out.push(dim("│") + " (no agent selected)".padEnd(w - 2) + dim("│"));
      out.push(dim("╰" + "─".repeat(w - 2) + "╯"));
      return out;
    }

    // Agent header
    const a = log.agent;
    const activeMs = (() => {
      const total = Date.now() - a.startedAt;
      const sleeping = a.sleptAt ? Date.now() - a.sleptAt : 0;
      return total - a.sleepMs - sleeping;
    })();
    const uptime = Math.round(activeMs / 1000);
    const statusLabel = a.status === "sleeping" ? yellow(" SLEEPING") : a.status === "completed" ? dim(" DONE") : green(" RUNNING");
    const headerText = `${a.agent}/${a.name ?? a.correlationId.slice(0, 8)}  ${uptime}s  inbox:${a.inbox.length}`;
    out.push(dim("│") + ` ${bold(headerText)}${statusLabel}`.padEnd(w - 2) + dim("│"));
    out.push(dim("├" + "─".repeat(w - 2) + "┤"));

    // Build wrapped content lines
    const contentW = w - 6;
    const wrappedLines: Array<{ text: string; kind: string }> = [];
    for (const entry of log.lines) {
      const wrapped = wrapLine(entry.text, contentW);
      for (const wl of wrapped) {
        wrappedLines.push({ text: wl, kind: entry.kind });
      }
    }
    // Inbox messages
    if (a.inbox.length > 0) {
      wrappedLines.push({ text: "── inbox ──", kind: "system" });
      for (const msg of a.inbox.slice(-5)) {
        const time = new Date(msg.timestamp).toISOString().slice(11, 19);
        const msgText = `[${time}] ◀ ${msg.from}: ${msg.payload}`;
        for (const wl of wrapLine(msgText, contentW)) {
          wrappedLines.push({ text: wl, kind: "system" });
        }
      }
    }

    // Log content — fill available height
    const extraRows = a.status === "sleeping" ? 2 : 0;
    const viewH = (height ?? 30) - 7 - extraRows;
    log.scrollOffset = Math.max(0, Math.min(log.scrollOffset, wrappedLines.length - viewH));
    const visible = wrappedLines.slice(log.scrollOffset, log.scrollOffset + viewH);
    for (const entry of visible) {
      let line = "";
      if (entry.kind === "tool") line = `  ${cyan(entry.text)}`;
      else if (entry.kind === "output") line = `  ${dim("│")} ${entry.text}`;
      else if (entry.kind === "system") line = `  ${yellow(entry.text)}`;
      else line = `  ${entry.text}`;
      out.push(dim("│") + ` ${line}`.padEnd(w - 2) + dim("│"));
    }

    const fillLines = viewH - visible.length;
    for (let i = 0; i < fillLines; i++) {
      out.push(dim("│") + " ".repeat(w - 2) + dim("│"));
    }

    // Sleeping hint
    if (a.status === "sleeping") {
      out.push(dim("├" + "─".repeat(w - 2) + "┤"));
      out.push(dim("│") + yellow(" ◉ sleeping — teammate-send to wake").padEnd(w - 2) + dim("│"));
    }

    // Footer
    const total = wrappedLines.length;
    const scrollInfo = total > viewH ? ` ${log.scrollOffset + 1}-${Math.min(log.scrollOffset + viewH, total)}/${total}` : "";
    const n = this.agentOrder.length;
    const footer = ` ${dim("ESC")} back  ${dim("Tab")} switch(${n})  ${dim("↑↓")} scroll${dim(scrollInfo)}`;
    out.push(dim("╰" + "─".repeat(w - 2) + "╯"));
    out.push(footer.slice(0, w));

    return out;
  }

  dispose(): void {
    this.agents.clear();
    this.agentOrder.length = 0;
  }
}
