/**
 * Attach overlay — multi-agent view with manual tabs and scroll state.
 * Uses only APIs exported by the installed pi-tui package.
 */

import {
  CURSOR_MARKER,
  Key,
  type Component,
  type Focusable,
  matchesKey,
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import type { ActiveAgent, AgentProgressSnapshot } from "../shared/types.ts";
import {
  buildProgressTree,
  focusTaskIndex,
  progressIcon,
  progressLabel,
  selectProgressWindow,
  type ProgressPalette,
} from "./progress-tree.ts";
import {
  BracketedPasteDecoder,
  nextGraphemeBoundary,
  previousGraphemeBoundary,
  sanitizeSingleLineInput,
  type DecodedInputToken,
} from "./input-text.ts";

const MAX_LOG_LINES = 500;
const STREAMING_MAX_LINES = 8;
const GRAPH_LIST_MAX_ROWS = 7;
const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const SPINNER_MS = 120;

interface ToolEntry {
  name: string;
  status: "running" | "completed" | "failed";
  startedAt: number;
}

interface AgentLog {
  agent: ActiveAgent;
  lines: Array<{ text: string; kind: "info" | "tool" | "output" | "system" }>;
  scrollOffset: number;
  streamingText: string;
  activeTools: ToolEntry[];
  progress: AgentProgressSnapshot[];
  selectedTaskIndex?: number;
}

const dim = (s: string) => `\x1b[2m${s}\x1b[22m`;
const bold = (s: string) => `\x1b[1m${s}\x1b[22m`;
const yellow = (s: string) => `\x1b[33m${s}\x1b[39m`;
const green = (s: string) => `\x1b[32m${s}\x1b[39m`;
const red = (s: string) => `\x1b[31m${s}\x1b[39m`;
const progressPalette: ProgressPalette = {
  dim,
  accent: green,
  running: yellow,
  success: green,
  error: red,
  bold,
};

function fitFooter(width: number, segments: string[]): string {
  let footer = "";
  for (const segment of segments.filter(Boolean)) {
    const next = footer ? `${footer}  ${segment}` : segment;
    if (visibleWidth(next) > width) break;
    footer = next;
  }
  return footer || segments.find(Boolean) || "";
}

function activeMs(agent: ActiveAgent): number {
  return Date.now() - agent.startedAt - agent.sleepMs
    - (agent.sleptAt ? Date.now() - agent.sleptAt : 0);
}

function frameLine(content: string, innerWidth: number): string {
  return dim("│") + truncateToWidth(` ${content}`, innerWidth, "…", true) + dim("│");
}

function frameRule(innerWidth: number): string {
  return dim("─".repeat(Math.max(0, innerWidth - 1)));
}

function progressStatusText(entry: AgentProgressSnapshot): string {
  const status = entry.status === "running"
    ? yellow("Running")
    : entry.status === "completed"
      ? green("Done")
      : entry.status === "failed"
        ? red("Failed")
        : dim("Pending");
  const parts = [
    status,
    entry.toolCount ? dim(`${entry.toolCount} tools`) : "",
    entry.tokens ? dim(`${entry.tokens} tok`) : "",
  ].filter(Boolean);
  return parts.join(dim(" · "));
}

export class AttachOverlay implements Component, Focusable {
  focused = false;
  private agents = new Map<string, AgentLog>();
  private activeId: string;
  private order: string[] = [];
  private readonly onDone: () => void;
  private readonly getActiveRuns: () => Map<string, ActiveAgent>;
  private requestRender: (() => void) | null = null;
  private frame = 0;
  private timer: ReturnType<typeof setInterval> | null = null;
  private composing = false;
  private draft = "";
  private cursor = 0;
  private sendStatus = "";
  private sending = false;
  private readonly pasteDecoder = new BracketedPasteDecoder();
  private pasteFlushTimer: ReturnType<typeof setTimeout> | undefined;
  private lastWidth = 80;
  private readonly onSend?: (correlationId: string, message: string) => Promise<{ ok: boolean; message: string }>;

  constructor(
    initial: ActiveAgent,
    onDone: () => void,
    getActiveRuns?: () => Map<string, ActiveAgent>,
    onSend?: (correlationId: string, message: string) => Promise<{ ok: boolean; message: string }>,
  ) {
    this.onDone = onDone;
    this.getActiveRuns = getActiveRuns ?? (() => new Map());
    this.onSend = onSend;
    this.activeId = initial.correlationId;
    this.addAgent(initial);

    this.timer = setInterval(() => {
      this.frame = (this.frame + 1) % SPINNER.length;
      const log = this.agents.get(this.activeId);
      if (log?.activeTools.some((tool) => tool.status === "running")) {
        this.requestRender?.();
      }
    }, SPINNER_MS);
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
      streamingText: "",
      activeTools: [],
      progress: agent.progress ?? [],
    });
    this.order.push(agent.correlationId);
  }

  syncAgents(): void {
    for (const [, agent] of this.getActiveRuns()) this.addAgent(agent);
  }

  setStreamingText(cid: string, text: string): void {
    const log = this.ensureLog(cid);
    if (!log) return;
    log.streamingText = text;
    this.requestRender?.();
  }

  setActiveTools(cid: string, tools: ToolEntry[]): void {
    const log = this.ensureLog(cid);
    if (!log) return;
    log.activeTools = tools;
    this.requestRender?.();
  }

  setProgress(cid: string, progress: AgentProgressSnapshot[]): void {
    const log = this.ensureLog(cid);
    if (!log) return;
    log.progress = [...progress].sort((a, b) => a.taskIndex - b.taskIndex);
    if (
      log.selectedTaskIndex !== undefined
      && !log.progress.some((entry) => entry.taskIndex === log.selectedTaskIndex)
    ) {
      log.selectedTaskIndex = undefined;
      log.scrollOffset = Number.POSITIVE_INFINITY;
    }
    this.requestRender?.();
  }

  appendLog(
    cid: string,
    text: string,
    kind: AgentLog["lines"][0]["kind"] = "info",
  ): void {
    const log = this.ensureLog(cid);
    if (!log) return;
    log.lines.push({ text, kind });
    if (log.lines.length > MAX_LOG_LINES) log.lines.shift();
    if (cid === this.activeId) log.scrollOffset = Number.POSITIVE_INFINITY;
    this.requestRender?.();
  }

  private ensureLog(cid: string): AgentLog | undefined {
    let log = this.agents.get(cid);
    if (!log) {
      const agent = this.getActiveRuns().get(cid);
      if (agent) {
        this.addAgent(agent);
        log = this.agents.get(cid);
      }
    }
    return log;
  }

  private switchAgent(direction: 1 | -1): void {
    this.syncAgents();
    if (this.order.length === 0) return;
    const index = Math.max(0, this.order.indexOf(this.activeId));
    this.activeId = this.order[(index + direction + this.order.length) % this.order.length];
    this.requestRender?.();
  }

  handleInput(data: string): void {
    if (this.lastWidth < 20) {
      if (matchesKey(data, Key.escape) || data === "q") this.onDone();
      else if (matchesKey(data, Key.left) || matchesKey(data, Key.shift("tab"))) this.switchAgent(-1);
      else if (matchesKey(data, Key.right) || matchesKey(data, Key.tab)) this.switchAgent(1);
      return;
    }
    if (this.pasteFlushTimer) clearTimeout(this.pasteFlushTimer);
    for (const token of this.pasteDecoder.feed(data)) this.dispatchDecodedToken(token);
    if (this.pasteDecoder.hasPending()) {
      this.pasteFlushTimer = setTimeout(() => {
        this.pasteFlushTimer = undefined;
        for (const token of this.pasteDecoder.flushPending()) this.dispatchDecodedToken(token);
        this.requestRender?.();
      }, 16);
    }
    this.requestRender?.();
  }

  private dispatchDecodedToken(token: DecodedInputToken): void {
    if (token.kind === "paste") {
      if (!this.composing && this.onSend) this.composing = true;
      this.insertDraft(token.text);
      return;
    }
    this.handleDecodedInput(token.text);
  }

  private handleDecodedInput(data: string): void {
    if (this.composing) {
      if (this.sending) return;
      if (matchesKey(data, Key.escape)) {
        this.composing = false;
        this.sendStatus = "Message cancelled";
      } else if (matchesKey(data, Key.enter)) {
        const message = this.draft.trim();
        if (!message || !this.onSend) {
          this.sendStatus = message ? "Message cannot be sent" : "Message is empty";
          this.requestRender?.();
          return;
        }
        this.sending = true;
        this.sendStatus = "Sending…";
        void Promise.resolve(this.onSend(this.activeId, message)).then((result) => {
          this.sending = false;
          if (result.ok) {
            this.composing = false;
            this.draft = "";
            this.cursor = 0;
            this.sendStatus = result.message;
          } else {
            this.composing = true;
            this.sendStatus = `${result.message} · Enter retry · Esc cancel`;
          }
          this.requestRender?.();
        }).catch((error: unknown) => {
          this.sending = false;
          this.composing = true;
          this.sendStatus = `Send failed · ${error instanceof Error ? error.message : String(error)} · Enter retry · Esc cancel`;
          this.requestRender?.();
        });
      } else if (matchesKey(data, Key.backspace)) {
        if (this.cursor > 0) {
          const previous = previousGraphemeBoundary(this.draft, this.cursor);
          this.draft = this.draft.slice(0, previous) + this.draft.slice(this.cursor);
          this.cursor = previous;
        }
      } else if (matchesKey(data, Key.left)) {
        this.cursor = previousGraphemeBoundary(this.draft, this.cursor);
      } else if (matchesKey(data, Key.right)) {
        this.cursor = nextGraphemeBoundary(this.draft, this.cursor);
      } else {
        this.insertDraft(sanitizeSingleLineInput(data));
      }
      this.requestRender?.();
      return;
    }
    if (matchesKey(data, Key.escape) || data === "q") {
      this.onDone();
      return;
    }
    if (matchesKey(data, Key.enter) && this.onSend) {
      this.composing = true;
      this.sendStatus = "";
      this.requestRender?.();
      return;
    }
    if (matchesKey(data, Key.tab)) {
      this.switchAgent(1);
      return;
    }
    if (matchesKey(data, Key.shift("tab"))) {
      this.switchAgent(-1);
      return;
    }
    if (matchesKey(data, Key.left)) {
      this.switchAgent(-1);
      return;
    }
    if (matchesKey(data, Key.right)) {
      this.switchAgent(1);
      return;
    }

    const log = this.agents.get(this.activeId);
    if (!log) return;
    if (data === "0" && log.progress.length > 0) {
      log.selectedTaskIndex = undefined;
      log.scrollOffset = Number.POSITIVE_INFINITY;
      this.requestRender?.();
      return;
    }
    if (/^[1-9]$/.test(data) && log.progress.length > 0) {
      const taskIndex = Number(data) - 1;
      if (log.progress.some((entry) => entry.taskIndex === taskIndex)) {
        log.selectedTaskIndex = taskIndex;
        log.scrollOffset = Number.POSITIVE_INFINITY;
        this.requestRender?.();
      }
      return;
    }
    if (matchesKey(data, Key.up) || data === "k") {
      log.scrollOffset = Math.max(0, log.scrollOffset - 1);
    } else if (matchesKey(data, Key.down) || data === "j") {
      log.scrollOffset = Number.isFinite(log.scrollOffset) ? log.scrollOffset + 1 : log.scrollOffset;
    } else if (data === "\x1b[5~") {
      log.scrollOffset = Math.max(0, log.scrollOffset - 10);
    } else if (data === "\x1b[6~") {
      log.scrollOffset = Number.isFinite(log.scrollOffset) ? log.scrollOffset + 10 : log.scrollOffset;
    } else {
      return;
    }
    this.requestRender?.();
  }

  private insertDraft(input: string): void {
    if (!input) return;
    this.draft = this.draft.slice(0, this.cursor) + input + this.draft.slice(this.cursor);
    this.cursor += input.length;
  }

  invalidate(): void {}

  render(width: number, height?: number): string[] {
    this.syncAgents();
    const w = Math.max(1, Math.min(width, 120));
    this.lastWidth = w;
    const log = this.agents.get(this.activeId);
    if (w < 20) return [this.renderCompact(log, w)];
    const terminalHeight = Math.max(6, (process.stdout?.rows ?? 30) - 2);
    const targetHeight = Math.max(6, Math.min(height ?? terminalHeight, terminalHeight));
    if (targetHeight <= 12) return this.renderDocked(log, w, targetHeight);
    const inner = w - 2;
    const rows: string[] = [this.renderTabs(inner), frameRule(inner)];

    if (!log) {
      rows.push(dim("No agent selected"));
      return this.renderFrame(rows, w);
    }

    const agent = log.agent;
    const selected = log.selectedTaskIndex === undefined
      ? undefined
      : log.progress.find((entry) => entry.taskIndex === log.selectedTaskIndex);
    const uptime = Math.max(0, Math.round(activeMs(agent) / 1000));
    const status = selected
      ? progressStatusText(selected)
      : agent.status === "sleeping"
        ? yellow("Sleeping")
        : agent.status === "completed"
          ? dim("Done")
          : green("Running");
    const title = selected
      ? `${progressIcon(selected.status, progressPalette)} ${bold(progressLabel(selected))}${dim(` (${selected.agent})`)}`
      : `${bold(agent.agent)}/${bold(agent.name ?? agent.correlationId.slice(0, 8))}`;
    const meta = selected
      ? status
      : `${status}  ${dim(`${uptime}s`)}  ${dim(`inbox:${agent.inbox.length}`)}`;
    rows.push(
      visibleWidth(title) + 2 + visibleWidth(meta) <= inner
        ? `${title}  ${meta}`
        : truncateToWidth(`${title}  ${meta}`, inner, "…"),
    );

    if (log.progress.length > 1) {
      rows.push(frameRule(inner));
      rows.push(...this.renderProgressTree(
        log,
        inner,
        Math.max(1, Math.min(GRAPH_LIST_MAX_ROWS, targetHeight - rows.length - 5)),
      ));
    }

    rows.push(frameRule(inner));
    rows.push(...(selected ? this.renderSelectedTools(selected, inner) : this.renderTools(log, inner)));
    rows.push(frameRule(inner));
    if (!selected) rows.push(...this.renderStream(log, inner));
    if (!selected && (log.streamingText || log.activeTools.some((tool) => tool.status === "running"))) {
      rows.push(frameRule(inner));
    }

    const logLines = selected
      ? this.buildSelectedLog(selected, Math.max(1, inner - 2))
      : this.buildLog(log, Math.max(1, inner - 2));
    const sleepingRows = agent.status === "sleeping" ? 2 : 0;
    const composerRows = this.onSend ? 2 : 0;
    const logHeight = Math.max(3, targetHeight - rows.length - sleepingRows - composerRows - 3);
    const maxOffset = Math.max(0, logLines.length - logHeight);
    log.scrollOffset = Number.isFinite(log.scrollOffset)
      ? Math.max(0, Math.min(log.scrollOffset, maxOffset))
      : maxOffset;
    const visibleLogs = logLines.slice(log.scrollOffset, log.scrollOffset + logHeight);
    rows.push(...visibleLogs);
    for (let i = visibleLogs.length; i < logHeight; i++) rows.push("");

    if (agent.status === "sleeping") {
      rows.push(frameRule(inner));
      rows.push(`${yellow("◉")} ${dim("Sleeping · teammate-send to wake")}`);
    }

    if (this.onSend) {
      rows.push(frameRule(inner));
      if (this.composing && this.sendStatus) {
        rows.push(truncateToWidth(`${red("!")} ${this.sendStatus}`, inner, "…"));
      }
      rows.push(this.renderComposer(inner));
    }

    const out = this.renderFrame(rows, w);
    const range = logLines.length > logHeight
      ? ` ${log.scrollOffset + 1}-${Math.min(log.scrollOffset + logHeight, logLines.length)}/${logLines.length}`
      : "";
    const agentHint = log.progress.length > 1
      ? `  ${dim("0")} overview  ${dim(`1-${Math.min(9, log.progress.length)}`)} view`
      : "";
    out.push(dim(fitFooter(w, [
      "Esc back",
      this.onSend ? "Enter message" : "",
      `←→ switch(${this.order.length})`,
      agentHint.trim(),
      `↑↓ scroll${range}`,
    ])));
    return out;
  }

  private renderComposer(width: number): string {
    if (!this.composing) {
      return truncateToWidth(
        this.sendStatus ? `${dim("Message ·")} ${this.sendStatus}` : `${dim("Message ·")} Enter to compose`,
        width,
        "…",
      );
    }
    const before = this.draft.slice(0, this.cursor);
    const next = nextGraphemeBoundary(this.draft, this.cursor);
    const cursorChar = this.cursor < this.draft.length ? this.draft.slice(this.cursor, next) : " ";
    const after = this.draft.slice(next);
    const marker = this.focused ? CURSOR_MARKER : "";
    return truncateToWidth(
      `${green("›")} ${before}${marker}\x1b[7m${cursorChar}\x1b[27m${after}`,
      width,
      "…",
    );
  }

  private renderDocked(log: AgentLog | undefined, width: number, height: number): string[] {
    if (!log) {
      return [
        truncateToWidth(dim("Agents · no active session"), width, "…"),
        truncateToWidth(dim("Esc back"), width, "…"),
      ];
    }

    const agent = log.agent;
    const selected = log.selectedTaskIndex === undefined
      ? undefined
      : log.progress.find((entry) => entry.taskIndex === log.selectedTaskIndex);
    const status = selected
      ? progressStatusText(selected)
      : agent.status === "sleeping"
        ? yellow("Sleeping")
        : agent.status === "completed"
          ? dim("Done")
          : green("Running");
    const title = selected
      ? `${progressIcon(selected.status, progressPalette)} ${bold(progressLabel(selected))} ${dim(`(${selected.agent})`)}`
      : `${bold(agent.agent)}/${bold(agent.name ?? agent.correlationId.slice(0, 8))}`;
    const lines: string[] = [
      this.renderTabs(width),
      truncateToWidth(`${title}  ${status}`, width, "…"),
    ];

    if (log.progress.length > 1) {
      const tree = buildProgressTree(log.progress, progressPalette);
      const focus = log.selectedTaskIndex ?? focusTaskIndex(log.progress);
      const maxTreeRows = Math.max(1, Math.min(3, height - 6));
      const window = selectProgressWindow(tree, maxTreeRows, focus);
      lines.push(...window.rows.map((row) => truncateToWidth(
        `${row.taskIndex === log.selectedTaskIndex ? green("›") : " "} ${row.text}`,
        width,
        "…",
      )));
    }

    const toolLine = selected
      ? this.renderSelectedTools(selected, width)[0]
      : this.renderTools(log, width)[0];
    lines.push(toolLine);

    const streamLines = selected
      ? this.buildSelectedLog(selected, width)
      : [
          ...this.buildLog(log, width),
          ...log.streamingText.split("\n").filter((line) => line.trim()).slice(-STREAMING_MAX_LINES),
        ];
    if (streamLines.length === 0) streamLines.push(dim("Waiting for output…"));

    const footer = dim(fitFooter(width, [
      "Esc back",
      this.onSend ? "Enter message" : "",
      "←→ switch",
      log.progress.length > 1 ? `0 overview · 1-${Math.min(9, log.progress.length)} view` : "",
      "↑↓ scroll",
    ]));
    const contentHeight = Math.max(1, height - lines.length - 1);
    const maxOffset = Math.max(0, streamLines.length - contentHeight);
    log.scrollOffset = Number.isFinite(log.scrollOffset)
      ? Math.max(0, Math.min(log.scrollOffset, maxOffset))
      : maxOffset;
    lines.push(...streamLines.slice(log.scrollOffset, log.scrollOffset + contentHeight));
    lines.push(footer);

    return lines.slice(0, height).map((line) => truncateToWidth(line, width, "…"));
  }

  private renderProgressTree(log: AgentLog, width: number, maxRows = GRAPH_LIST_MAX_ROWS): string[] {
    const tree = buildProgressTree(log.progress, progressPalette);
    const focus = log.selectedTaskIndex ?? focusTaskIndex(log.progress);
    const window = selectProgressWindow(tree, maxRows, focus);
    const running = log.progress.filter((entry) => entry.status === "running").length;
    const pending = log.progress.filter((entry) => entry.status === "pending").length;
    const failed = log.progress.filter((entry) => entry.status === "failed").length;
    const range = window.total > window.rows.length
      ? `${window.start + 1}-${window.start + window.rows.length}/${window.total}`
      : `${window.total}`;
    const header = dim(`Agents · ${running} running · ${pending} pending${failed ? ` · ${failed} failed` : ""} · ${range}`);
    return [
      truncateToWidth(header, width, "…"),
      ...window.rows.map((row) => truncateToWidth(
        `${row.taskIndex === log.selectedTaskIndex ? green("›") : " "} ${row.text}`,
        width,
        "…",
      )),
    ];
  }

  private renderSelectedTools(entry: AgentProgressSnapshot, width: number): string[] {
    const tools = entry.recentTools ?? [];
    if (tools.length === 0) return [dim("Tools · idle")];
    const parts = tools.slice(-6).map((tool) => {
      if (tool.status === "running") return yellow(`${SPINNER[this.frame]} ${tool.name}`);
      if (tool.status === "failed") return red(`✗ ${tool.name}`);
      return dim(`✓ ${tool.name}`);
    });
    if (tools.length > 6) parts.unshift(dim(`+${tools.length - 6}`));
    return [truncateToWidth(`${dim("Tools ·")} ${parts.join(dim("  "))}`, width, "…")];
  }

  private buildSelectedLog(entry: AgentProgressSnapshot, width: number): string[] {
    const message = entry.lastMessage?.trim();
    if (!message) return [dim(entry.status === "pending" ? "Waiting for dependencies…" : "Waiting for output…")];
    const lines: string[] = [];
    for (const rawLine of message.split("\n")) {
      lines.push(...wrapTextWithAnsi(rawLine, width));
    }
    return lines;
  }

  private renderCompact(log: AgentLog | undefined, width: number): string {
    if (this.composing) {
      const content = this.sendStatus || this.draft || "Type message";
      return truncateToWidth(`Esc cancel · ${content}`, width, "…");
    }
    if (!log) return truncateToWidth(`${dim("□")} Agents`, width, "…");
    const selected = log.selectedTaskIndex === undefined
      ? undefined
      : log.progress.find((entry) => entry.taskIndex === log.selectedTaskIndex);
    if (selected) {
      return truncateToWidth(
        `${progressIcon(selected.status, progressPalette)} ${selected.taskIndex + 1} ${progressLabel(selected)}`,
        width,
        "…",
      );
    }
    const agent = log.agent;
    const icon = agent.status === "sleeping" ? yellow("◉") : agent.status === "completed" ? dim("✓") : green("■");
    const name = agent.name ?? agent.correlationId.slice(0, 6);
    return truncateToWidth(`${icon} ${agent.agent}/${name} · Enter msg · Esc`, width, "…");
  }

  private renderFrame(rows: string[], width: number): string[] {
    const inner = width - 2;
    return [
      dim(`╭${"─".repeat(inner)}╮`),
      ...rows.map((row) => frameLine(row, inner)),
      dim(`╰${"─".repeat(inner)}╯`),
    ];
  }

  private renderTabs(width: number): string {
    if (this.order.length === 0) return dim("Agents");
    const activeIndex = Math.max(0, this.order.indexOf(this.activeId));
    const labels = this.order.map((cid) => {
      const log = this.agents.get(cid);
      if (!log) return dim(cid.slice(0, 6));
      const agent = log.agent;
      const name = agent.name ?? cid.slice(0, 6);
      const icon = agent.status === "sleeping" ? "◉" : agent.status === "completed" ? "✓" : "■";
      const label = `${icon} @${name}`;
      return cid === this.activeId ? `${green("▸")} ${bold(green(label))}` : dim(label);
    });
    const prefix = `${dim(`Agents ${activeIndex + 1}/${this.order.length} ·`)} `;
    const full = `${prefix}${labels.join(dim(" · "))}`;
    if (visibleWidth(full) <= width) return full;
    const hiddenLeft = activeIndex > 0 ? dim(`‹${activeIndex}`) : "";
    const hiddenRight = activeIndex < this.order.length - 1 ? dim(`${this.order.length - activeIndex - 1}›`) : "";
    return truncateToWidth(
      `${prefix}${labels[activeIndex]}${hiddenLeft ? ` ${hiddenLeft}` : ""}${hiddenRight ? ` ${hiddenRight}` : ""}`,
      width,
      "…",
    );
  }

  private renderTools(log: AgentLog, width: number): string[] {
    if (log.activeTools.length === 0) return [dim("Tools · idle")];
    const parts: string[] = [];
    const spinner = SPINNER[this.frame];
    for (const tool of log.activeTools.slice(-6)) {
      const seconds = Math.max(0, Math.round((Date.now() - tool.startedAt) / 1000));
      if (tool.status === "running") parts.push(yellow(`${spinner} ${bold(tool.name)} ${dim(`${seconds}s`)}`));
      else if (tool.status === "failed") parts.push(red(`✗ ${tool.name}`));
      else parts.push(dim(`✓ ${tool.name}`));
    }
    if (log.activeTools.length > 6) parts.unshift(dim(`+${log.activeTools.length - 6}`));
    return [truncateToWidth(`${dim("Tools ·")} ${parts.join(dim("  "))}`, width, "…")];
  }

  private renderStream(log: AgentLog, width: number): string[] {
    if (!log.streamingText) return [dim("Output · waiting")];
    const all = log.streamingText.split("\n");
    const tail = all.slice(-STREAMING_MAX_LINES);
    const header = all.length > STREAMING_MAX_LINES
      ? dim(`Output · ${all.length - STREAMING_MAX_LINES} earlier`)
      : dim("Output");
    const contentWidth = Math.max(1, width - 3);
    return [
      header,
      ...tail.map((line) => `${dim("│")} ${truncateToWidth(line, contentWidth, "…")}`),
    ];
  }

  private buildLog(log: AgentLog, width: number): string[] {
    const result: string[] = [];
    for (const entry of log.lines) {
      for (const line of wrapTextWithAnsi(entry.text, width)) {
        if (entry.kind === "tool") result.push(`${green("■")} ${bold(line)}`);
        else if (entry.kind === "output") result.push(`${dim("│")} ${line}`);
        else if (entry.kind === "system") result.push(`${dim("»")} ${yellow(line)}`);
        else result.push(`  ${line}`);
      }
    }
    if (log.agent.inbox.length > 0) {
      result.push(dim("Inbox"));
      for (const message of log.agent.inbox.slice(-5)) {
        const time = new Date(message.timestamp).toISOString().slice(11, 19);
        for (const line of wrapTextWithAnsi(`[${time}] ◀ ${message.from}: ${message.payload}`, width)) {
          result.push(`${yellow("◀")} ${line}`);
        }
      }
    }
    return result;
  }

  dispose(): void {
    if (this.pasteFlushTimer) clearTimeout(this.pasteFlushTimer);
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.agents.clear();
    this.order.length = 0;
  }
}
