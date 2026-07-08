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

  render(width: number): string[] {
    this.syncAgents();
    const out: string[] = [];

    // Tab bar
    const tabs = this.agentOrder.map((cid) => {
      const log = this.agents.get(cid);
      if (!log) return "";
      const a = log.agent;
      const label = a.name ?? cid.slice(0, 6);
      const active = cid === this.activeId;
      const depth = a.spawnedBy ? "↳" : "";
      return active ? `[${depth}${a.agent}/${label}]` : ` ${depth}${a.agent}/${label} `;
    }).join("│");
    out.push(tabs.slice(0, width));
    out.push("─".repeat(Math.min(width, 80)));

    const log = this.agents.get(this.activeId);
    if (!log) {
      out.push("(no agent selected)");
      return out;
    }

    // Agent header
    const a = log.agent;
    const uptime = Math.round((Date.now() - a.startedAt) / 1000);
    out.push(`${a.agent}/${a.name ?? a.correlationId.slice(0, 8)}  ${uptime}s  inbox:${a.inbox.length}`);
    out.push("");

    // Log content
    const viewH = 25;
    const visible = log.lines.slice(log.scrollOffset, log.scrollOffset + viewH);
    for (const entry of visible) {
      let prefix = "  ";
      if (entry.kind === "tool") prefix = "  ";
      else if (entry.kind === "output") prefix = "  │ ";
      else if (entry.kind === "system") prefix = "  ═ ";
      out.push((prefix + entry.text).slice(0, width));
    }

    while (out.length < viewH + 4) out.push("");

    // Footer
    const total = log.lines.length;
    const scrollInfo = total > viewH ? ` ${log.scrollOffset + 1}-${Math.min(log.scrollOffset + viewH, total)}/${total}` : "";
    const n = this.agentOrder.length;
    out.push(`─ [ESC] back │ [Tab] switch (${n}) │ [↑↓] scroll${scrollInfo} ─`.slice(0, width));

    return out;
  }

  dispose(): void {
    this.agents.clear();
    this.agentOrder.length = 0;
  }
}
