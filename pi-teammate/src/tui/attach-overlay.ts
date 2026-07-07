/**
 * Attach overlay component — full-screen view of a sub-agent's activity.
 *
 * Shows real-time JSON line events from the agent's stdout,
 * rendered as a scrollable log with tool call status.
 * ESC to dismiss and return to main session.
 */

import type { Component } from "@earendil-works/pi-tui";
import type { ActiveAgent } from "../shared/types.ts";

const MAX_LOG_LINES = 200;

export class AttachOverlay implements Component {
  private logLines: string[] = [];
  private agent: ActiveAgent;
  private onDone: () => void;
  private scrollOffset = 0;

  constructor(agent: ActiveAgent, onDone: () => void) {
    this.agent = agent;
    this.onDone = onDone;
  }

  appendLog(line: string): void {
    this.logLines.push(line);
    if (this.logLines.length > MAX_LOG_LINES) {
      this.logLines.shift();
    }
    this.scrollOffset = Math.max(0, this.logLines.length - 30);
  }

  handleInput(data: string): void {
    if (data === "\x1b" || data === "q") {
      this.onDone();
      return;
    }
    // Scroll up/down
    if (data === "\x1b[A" || data === "k") {
      this.scrollOffset = Math.max(0, this.scrollOffset - 1);
    } else if (data === "\x1b[B" || data === "j") {
      this.scrollOffset = Math.min(
        Math.max(0, this.logLines.length - 10),
        this.scrollOffset + 1,
      );
    }
  }

  render(width: number): string[] {
    const lines: string[] = [];
    const name = this.agent.name ?? this.agent.correlationId.slice(0, 8);
    const status = this.agent.stdin?.writable ? "ACTIVE" : "IDLE";

    // Header
    const header = `─── Agent: ${this.agent.agent} / ${name} [${status}] ───`;
    lines.push(header.slice(0, width));
    lines.push("");

    // Log content (visible window)
    const viewHeight = 30;
    const visible = this.logLines.slice(this.scrollOffset, this.scrollOffset + viewHeight);
    for (const line of visible) {
      lines.push(("  " + line).slice(0, width));
    }

    // Pad to fill
    while (lines.length < viewHeight + 2) {
      lines.push("");
    }

    // Footer
    const scrollInfo = this.logLines.length > viewHeight
      ? ` (${this.scrollOffset + 1}-${Math.min(this.scrollOffset + viewHeight, this.logLines.length)}/${this.logLines.length})`
      : "";
    lines.push(`─── [ESC/q] back │ [↑/↓] scroll${scrollInfo} ───`.slice(0, width));

    return lines;
  }

  dispose(): void {
    this.logLines.length = 0;
  }
}
