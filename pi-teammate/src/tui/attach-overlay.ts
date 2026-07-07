/**
 * Attach overlay component — multi-agent view with tab switching.
 *
 * Shows real-time activity for the selected agent.
 * Tab/Shift+Tab to switch between agents.
 * ESC to dismiss and return to main session.
 */

import type { Component } from "@earendil-works/pi-tui";
import type { ActiveAgent } from "../shared/types.ts";

const MAX_LOG_LINES = 200;

interface AgentLog {
  agent: ActiveAgent;
  lines: string[];
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
    const runs = this.getActiveRuns();
    for (const [cid, agent] of runs) {
      this.addAgent(agent);
    }
  }

  appendLog(correlationId: string, line: string): void {
    let log = this.agents.get(correlationId);
    if (!log) {
      const runs = this.getActiveRuns();
      const agent = runs.get(correlationId);
      if (agent) {
        this.addAgent(agent);
        log = this.agents.get(correlationId);
      }
    }
    if (!log) return;
    log.lines.push(line);
    if (log.lines.length > MAX_LOG_LINES) {
      log.lines.shift();
    }
    if (correlationId === this.activeId) {
      log.scrollOffset = Math.max(0, log.lines.length - 28);
    }
    this.requestRender?.();
  }

  handleInput(data: string): void {
    if (data === "\x1b" || data === "q") {
      this.onDone();
      return;
    }

    const currentLog = this.agents.get(this.activeId);

    // Tab / Shift+Tab — switch agent
    if (data === "\t") {
      this.syncAgents();
      const idx = this.agentOrder.indexOf(this.activeId);
      this.activeId = this.agentOrder[(idx + 1) % this.agentOrder.length];
      this.requestRender?.();
      return;
    }
    if (data === "\x1b[Z") { // Shift+Tab
      this.syncAgents();
      const idx = this.agentOrder.indexOf(this.activeId);
      this.activeId = this.agentOrder[(idx - 1 + this.agentOrder.length) % this.agentOrder.length];
      this.requestRender?.();
      return;
    }

    if (!currentLog) return;

    // Scroll up/down
    if (data === "\x1b[A" || data === "k") {
      currentLog.scrollOffset = Math.max(0, currentLog.scrollOffset - 1);
      this.requestRender?.();
    } else if (data === "\x1b[B" || data === "j") {
      currentLog.scrollOffset = Math.min(
        Math.max(0, currentLog.lines.length - 10),
        currentLog.scrollOffset + 1,
      );
      this.requestRender?.();
    }
  }

  render(width: number): string[] {
    this.syncAgents();
    const output: string[] = [];

    // Tab bar
    const tabs = this.agentOrder.map((cid) => {
      const log = this.agents.get(cid);
      if (!log) return "";
      const label = log.agent.name ?? cid.slice(0, 6);
      const active = cid === this.activeId;
      return active ? `[${log.agent.agent}/${label}]` : ` ${log.agent.agent}/${label} `;
    }).join(" │ ");
    output.push(tabs.slice(0, width));
    output.push("─".repeat(Math.min(width, 80)));

    const currentLog = this.agents.get(this.activeId);
    if (!currentLog) {
      output.push("(no agent selected)");
      return output;
    }

    // Agent info
    const a = currentLog.agent;
    const uptime = Math.round((Date.now() - a.startedAt) / 1000);
    const stdinStatus = a.stdin?.writable ? "ACTIVE" : "ENDED";
    output.push(`${a.agent}/${a.name ?? a.correlationId.slice(0, 8)}  ${stdinStatus}  ${uptime}s  inbox:${a.inbox.length}`);
    output.push("");

    // Log content
    const viewHeight = 28;
    const visible = currentLog.lines.slice(currentLog.scrollOffset, currentLog.scrollOffset + viewHeight);
    for (const line of visible) {
      output.push(("  " + line).slice(0, width));
    }

    while (output.length < viewHeight + 4) {
      output.push("");
    }

    // Footer
    const scrollInfo = currentLog.lines.length > viewHeight
      ? ` ${currentLog.scrollOffset + 1}-${Math.min(currentLog.scrollOffset + viewHeight, currentLog.lines.length)}/${currentLog.lines.length}`
      : "";
    const agentCount = this.agentOrder.length;
    output.push(`─ [ESC] back │ [Tab] switch (${agentCount}) │ [↑↓] scroll${scrollInfo} ─`.slice(0, width));

    return output;
  }

  dispose(): void {
    this.agents.clear();
    this.agentOrder.length = 0;
  }
}
