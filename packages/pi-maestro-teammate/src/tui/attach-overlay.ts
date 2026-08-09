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
import {
  STATUS_PRESENTATION,
  effectiveDisplayStatus,
  idleSeconds,
} from "../shared/agent-status.ts";
import type { ActiveAgent, AgentProgressSnapshot, MessageEnvelope } from "../shared/types.ts";
import {
  buildProgressTree,
  focusTaskIndex,
  progressIcon,
  progressLabel,
  selectProgressWindow,
  toneText,
  type ProgressPalette,
} from "./progress-tree.ts";
import type { TranscriptLoad, TranscriptRow } from "../shared/transcript.ts";
import {
  createTuiTranslator,
  getTuiLocale,
  onTuiLocaleChange,
  translateStatusText,
  type SupportedSettingsLocale,
  type TuiTranslator,
} from "./locale.ts";

/** Loader injected by the extension; reads the agent's session file. */
export type TranscriptLoader = (agent: ActiveAgent) => Promise<TranscriptLoad>;
import {
  BracketedPasteDecoder,
  cursorForColumn,
  layoutDraftCursor,
  nextGraphemeBoundary,
  previousGraphemeBoundary,
  sanitizeMultiLineInput,
  type DecodedInputToken,
  type DraftLayoutLine,
} from "./input-text.ts";

const MAX_LOG_LINES = 500;
const STREAMING_MAX_LINES = 8;
/** Composer draft rows shown before the window scrolls (a leading ⋯ marks hidden rows). */
const MAX_COMPOSER_ROWS = 5;
/** Inbox payloads are bounded by bytes, not by display size — preview only. */
const INBOX_PREVIEW_CHARS = 400;
const INBOX_PREVIEW_LINES = 4;
const GRAPH_LIST_MAX_ROWS = 7;
const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const SPINNER_MS = 120;

/** Tab identity for the main conversation — a switching target, not a log. */
export const MAIN_TAB = "__main__";

export interface ToolEntry {
  name: string;
  status: "running" | "completed" | "failed";
  startedAt: number;
}

export interface OverlayProgressUpdate {
  progress?: AgentProgressSnapshot[];
  activeTools?: ToolEntry[];
  streamingText?: string;
  lines?: Array<{ text: string; kind: "info" | "tool" | "output" | "system" }>;
}

interface LogRenderCache {
  width: number;
  locale: SupportedSettingsLocale;
  lineCount: number;
  lastLine: AgentLog["lines"][number] | undefined;
  inboxCount: number;
  lastInbox: MessageEnvelope | undefined;
  rendered: string[];
}

interface AgentLog {
  agent: ActiveAgent;
  lines: Array<{ text: string; kind: "info" | "tool" | "output" | "system" }>;
  scrollOffset: number;
  maxScrollOffset: number;
  followTail: boolean;
  streamingText: string;
  activeTools: ToolEntry[];
  progress: AgentProgressSnapshot[];
  selectedTaskIndex?: number;
  logCache?: LogRenderCache;
  /** Full conversation view state (t/v keys). */
  transcript?: TranscriptLoad;
  transcriptLoading?: boolean;
  transcriptMode: boolean;
  transcriptError?: string;
  transcriptRefreshTimer?: ReturnType<typeof setTimeout>;
  transcriptCache?: {
    width: number;
    locale: SupportedSettingsLocale;
    rows: TranscriptRow[];
    loading: boolean;
    rendered: string[];
  };
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

function activeMs(agent: ActiveAgent, now = Date.now()): number {
  return now - agent.startedAt - agent.sleepMs
    - (agent.sleptAt ? now - agent.sleptAt : 0);
}

function frameLine(content: string, innerWidth: number): string {
  return dim("│") + truncateToWidth(` ${content}`, innerWidth, "…", true) + dim("│");
}

function frameRule(innerWidth: number): string {
  return dim("─".repeat(Math.max(0, innerWidth - 1)));
}

function titleCase(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** An idle tool row must say how long it has been idle, not just "idle". */
function idleLabel(
  lastActivityAt: number | undefined,
  now: number,
  t: TuiTranslator,
): string {
  const seconds = idleSeconds(lastActivityAt, now);
  return seconds > 0
    ? t("attach.toolsIdleSeconds", { seconds })
    : t("attach.toolsIdle");
}

/**
 * Status of one graph task. Derived states win: a running task that has gone
 * quiet reads `stalled 42s` instead of an indistinguishable `Running`.
 */
function progressStatusText(
  entry: AgentProgressSnapshot,
  now: number,
  t: TuiTranslator,
): string {
  const display = effectiveDisplayStatus(entry.status, entry.resultReadyAt, entry.lastActivityAt, now, entry.phase);
  const status = display === "stalled"
    ? red(t("status.stalled", { seconds: idleSeconds(entry.lastActivityAt, now) }))
    : display === "result-ready"
      ? green(t("status.resultReady"))
      : toneText(
          progressPalette,
          STATUS_PRESENTATION[display].tone,
          titleCase(translateStatusText(STATUS_PRESENTATION[display].text, t)),
        );
  const parts = [
    status,
    entry.toolCount ? dim(t("metrics.tools", { count: entry.toolCount })) : "",
    entry.tokens ? dim(t("metrics.tok", { count: entry.tokens })) : "",
  ].filter(Boolean);
  return parts.join(dim(" · "));
}

/**
 * Status of the attached agent itself. This is the screen a user opens after
 * the widget flagged something odd, so it must expose the same derived states
 * the widget does — a 10-minute-idle agent cannot look like a fresh one.
 */
function agentStatusText(agent: ActiveAgent, now: number, t: TuiTranslator): string {
  const display = effectiveDisplayStatus(
    agent.status,
    agent.resultReadyAt,
    agent.lastActivityAt,
    now,
    agent.phase,
    agent.pendingInteractions?.size ?? 0,
  );
  if (display === "stalled") return red(t("status.stalled", { seconds: idleSeconds(agent.lastActivityAt, now) }));
  if (display === "result-ready") return green(t("status.resultReady"));
  if (display === "completed") return dim(t("common.done"));
  const presentation = STATUS_PRESENTATION[display];
  return toneText(progressPalette, presentation.tone, titleCase(translateStatusText(presentation.text, t)));
}

export class AttachOverlay implements Component, Focusable {
  focused = false;
  private agents = new Map<string, AgentLog>();
  /** Agents whose data changed while they were not the visible tab. */
  private dirtyAgents = new Set<string>();
  private activeId: string;
  private order: string[] = [];
  private readonly onDone: () => void;
  private readonly getActiveRuns: () => Map<string, ActiveAgent>;
  private readonly loadTranscript?: TranscriptLoader;
  private requestRender: (() => void) | null = null;
  private frame = 0;
  private timer: ReturnType<typeof setInterval> | null = null;
  private tickVisibility: "hidden" | "tools" | "full" = "hidden";
  private renderedTickSignature = "";
  private composing = false;
  private draft = "";
  private cursor = 0;
  /** Target column for ↑/↓ across wrapped lines; cleared on any other edit. */
  private desiredCursorCol: number | undefined;
  /** Draft width used for cursor layout between renders (mirrors last composer render). */
  private composerDraftWidth = 78;
  private sendStatus = "";
  private sending = false;
  private readonly pasteDecoder = new BracketedPasteDecoder({ multiline: true });
  private pasteFlushTimer: ReturnType<typeof setTimeout> | undefined;
  private lastWidth = 80;
  private readonly onSend?: (correlationId: string, message: string) => Promise<{ ok: boolean; message: string }>;
  private readonly t: TuiTranslator;
  private readonly localeDisposer: () => void;

  constructor(
    initial: ActiveAgent,
    onDone: () => void,
    getActiveRuns?: () => Map<string, ActiveAgent>,
    onSend?: (correlationId: string, message: string) => Promise<{ ok: boolean; message: string }>,
    loadTranscript?: TranscriptLoader,
    initialTranscript = false,
    private readonly locale?: SupportedSettingsLocale,
  ) {
    this.t = createTuiTranslator(locale);
    this.localeDisposer = locale === undefined
      ? onTuiLocaleChange(() => {
          this.sendStatus = "";
          this.requestRender?.();
        })
      : () => {};
    this.onDone = onDone;
    this.getActiveRuns = getActiveRuns ?? (() => new Map());
    this.onSend = onSend;
    this.loadTranscript = loadTranscript;
    this.activeId = initial.correlationId;
    this.order.push(MAIN_TAB);
    this.addAgent(initial);
    if (initialTranscript) {
      const log = this.agents.get(this.activeId);
      if (log && this.loadTranscript) {
        log.transcriptMode = true;
        this.ensureTranscript(log);
      }
    }

    this.timer = setInterval(() => {
      const nextFrame = (this.frame + 1) % SPINNER.length;
      const nextSignature = this.tickSignature(Date.now(), nextFrame);
      if (nextSignature === this.renderedTickSignature) return;
      this.frame = nextFrame;
      this.renderedTickSignature = nextSignature;
      this.requestRender?.();
    }, SPINNER_MS);
  }

  setRequestRender(fn: () => void): void {
    this.requestRender = fn;
  }

  private tickSignature(now: number, frame: number): string {
    if (this.tickVisibility === "hidden") return "";
    const log = this.agents.get(this.activeId);
    if (!log) return "";
    const selected = log.selectedTaskIndex === undefined
      ? undefined
      : log.progress.find((entry) => entry.taskIndex === log.selectedTaskIndex);
    const parts: string[] = [];
    if (selected) {
      for (const tool of (selected.recentTools ?? []).slice(-6)) {
        if (tool.status === "running") parts.push(`spinner:${frame}`);
      }
      return parts.join("|");
    }
    if (this.tickVisibility === "full") {
      parts.push(`uptime:${Math.max(0, Math.round(activeMs(log.agent, now) / 1000))}`);
    }
    for (const tool of log.activeTools.slice(-6)) {
      if (tool.status !== "running") continue;
      const elapsed = Math.max(0, Math.round((now - tool.startedAt) / 1000));
      parts.push(`spinner:${frame}:${elapsed}`);
    }
    return parts.join("|");
  }

  private setTickVisibility(visibility: "hidden" | "tools" | "full", now: number): void {
    this.tickVisibility = visibility;
    this.renderedTickSignature = this.tickSignature(now, this.frame);
  }

  /**
   * The overlay only ever draws the active tab, but progress events arrive for
   * every concurrent agent. Repainting on a background agent's event burns a
   * full frame whose visible region is identical; mark it dirty instead and let
   * the tab switch pick the data up.
   */
  private requestRenderFor(cid: string): void {
    if (cid === this.activeId) {
      this.dirtyAgents.delete(cid);
      this.requestRender?.();
      return;
    }
    this.dirtyAgents.add(cid);
  }

  private addAgent(agent: ActiveAgent): void {
    if (this.agents.has(agent.correlationId)) return;
    this.agents.set(agent.correlationId, {
      agent,
      lines: [],
      scrollOffset: 0,
      maxScrollOffset: 0,
      followTail: true,
      streamingText: "",
      activeTools: [],
      progress: agent.progress ?? [],
      transcriptMode: false,
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
    this.requestRenderFor(cid);
  }

  setActiveTools(cid: string, tools: ToolEntry[]): void {
    const log = this.ensureLog(cid);
    if (!log) return;
    log.activeTools = tools;
    this.requestRenderFor(cid);
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
      log.followTail = true;
    }
    this.requestRenderFor(cid);
  }

  applyProgressEvent(cid: string, update: OverlayProgressUpdate): void {
    const log = this.ensureLog(cid);
    if (!log) return;
    let changed = false;
    if (update.progress) {
      log.progress = [...update.progress].sort((a, b) => a.taskIndex - b.taskIndex);
      if (
        log.selectedTaskIndex !== undefined
        && !log.progress.some((entry) => entry.taskIndex === log.selectedTaskIndex)
      ) {
        log.selectedTaskIndex = undefined;
        log.followTail = true;
      }
      changed = true;
    }
    if (update.activeTools) {
      log.activeTools = update.activeTools;
      changed = true;
    }
    if (update.streamingText !== undefined) {
      log.streamingText = update.streamingText;
      changed = true;
    }
    for (const line of update.lines ?? []) {
      log.lines.push(line);
      if (log.lines.length > MAX_LOG_LINES) {
        log.lines.shift();
        if (!log.followTail) log.scrollOffset = Math.max(0, log.scrollOffset - 1);
      }
      changed = true;
    }
    if (changed) this.requestRenderFor(cid);
  }

  appendLog(
    cid: string,
    text: string,
    kind: AgentLog["lines"][0]["kind"] = "info",
  ): void {
    const log = this.ensureLog(cid);
    if (!log) return;
    log.lines.push({ text, kind });
    if (log.lines.length > MAX_LOG_LINES) {
      log.lines.shift();
      if (!log.followTail) log.scrollOffset = Math.max(0, log.scrollOffset - 1);
    }
    this.requestRenderFor(cid);
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
    this.dirtyAgents.delete(this.activeId);
    const log = this.agents.get(this.activeId);
    if (log && log.transcriptMode && !log.transcript && this.loadTranscript) {
      this.ensureTranscript(log);
    }
    this.requestRender?.();
  }

  handleInput(data: string): void {
    if (this.lastWidth < 20) {
      // Ultra-narrow mode deliberately blocks composing (the composer is not
      // visible — blind sends must not be possible). The one exception: if
      // composing started wide and the terminal shrank, Esc cancels the draft
      // instead of closing the overlay, matching renderCompact's hint.
      if (this.composing) {
        if (matchesKey(data, Key.escape)) {
          this.composing = false;
          this.sendStatus = this.t("attach.messageCancelled");
        }
        return;
      }
      if (this.activeId === MAIN_TAB && matchesKey(data, Key.enter)) {
        this.onDone();
        return;
      }
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
      this.handleComposerKey(data);
      this.requestRender?.();
      return;
    }
    if (matchesKey(data, Key.escape) || data === "q") {
      this.onDone();
      return;
    }
    if (this.activeId === MAIN_TAB) {
      // The main tab is a switching target, not a log: Enter returns to the
      // main conversation. Navigation keys are handled above.
      if (matchesKey(data, Key.enter)) this.onDone();
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
    if (data === "t" || data === "v") {
      if (!this.loadTranscript) return;
      const enter = data === "v" || !log.transcriptMode;
      if (enter && !log.transcript) this.ensureTranscript(log);
      log.transcriptMode = enter;
      if (enter) log.followTail = true;
      this.requestRender?.();
      return;
    }
    if (data === "0" && log.progress.length > 0) {
      log.selectedTaskIndex = undefined;
      log.followTail = true;
      this.requestRender?.();
      return;
    }
    if (/^[1-9]$/.test(data) && log.progress.length > 0) {
      const taskIndex = Number(data) - 1;
      if (log.progress.some((entry) => entry.taskIndex === taskIndex)) {
        log.selectedTaskIndex = taskIndex;
        log.followTail = true;
        this.requestRender?.();
      }
      return;
    }
    const currentOffset = log.followTail ? log.maxScrollOffset : log.scrollOffset;
    if (matchesKey(data, Key.up) || data === "k") {
      log.scrollOffset = Math.max(0, currentOffset - 1);
      log.followTail = false;
    } else if (matchesKey(data, Key.down) || data === "j") {
      log.scrollOffset = Math.min(log.maxScrollOffset, currentOffset + 1);
      log.followTail = log.scrollOffset >= log.maxScrollOffset;
    } else if (data === "\x1b[5~") {
      log.scrollOffset = Math.max(0, currentOffset - 10);
      log.followTail = false;
    } else if (data === "\x1b[6~") {
      log.scrollOffset = Math.min(log.maxScrollOffset, currentOffset + 10);
      log.followTail = log.scrollOffset >= log.maxScrollOffset;
    } else {
      return;
    }
    this.requestRender?.();
  }

  /** Composer key handling shared by wide and narrow render paths. */
  private handleComposerKey(data: string): void {
    if (this.sending) return;
    if (matchesKey(data, Key.escape)) {
      this.composing = false;
      this.desiredCursorCol = undefined;
      this.sendStatus = this.t("attach.messageCancelled");
    } else if (
      data === "\n"
      || data === "\x1b\r"
      || data === "\x1b[13;2~"
      || matchesKey(data, Key.shift("enter"))
      || matchesKey(data, Key.alt("enter"))
    ) {
      // Shift+Enter / Alt+Enter (or a raw LF) inserts a hard newline; plain
      // Enter below stays the send key, mirroring the host editor's semantics.
      this.insertDraft("\n");
      this.desiredCursorCol = undefined;
    } else if (matchesKey(data, Key.enter)) {
      const message = this.draft.trim();
      if (!message || !this.onSend) {
        this.sendStatus = message
          ? this.t("attach.messageCannotSend")
          : this.t("attach.messageEmpty");
        return;
      }
      this.sending = true;
      this.sendStatus = this.t("attach.sending");
      void Promise.resolve(this.onSend(this.activeId, message)).then((result) => {
        this.sending = false;
        if (result.ok) {
          this.composing = false;
          this.draft = "";
          this.cursor = 0;
          this.desiredCursorCol = undefined;
          this.sendStatus = result.message;
        } else {
          this.composing = true;
          this.sendStatus = this.t("attach.retryHint", { message: result.message });
        }
        this.requestRender?.();
      }).catch((error: unknown) => {
        this.sending = false;
        this.composing = true;
        this.sendStatus = this.t("attach.sendFailed", {
          message: error instanceof Error ? error.message : String(error),
        });
        this.requestRender?.();
      });
    } else if (matchesKey(data, Key.backspace)) {
      if (this.cursor > 0) {
        const previous = previousGraphemeBoundary(this.draft, this.cursor);
        this.draft = this.draft.slice(0, previous) + this.draft.slice(this.cursor);
        this.cursor = previous;
      }
      this.desiredCursorCol = undefined;
    } else if (matchesKey(data, Key.left)) {
      this.cursor = previousGraphemeBoundary(this.draft, this.cursor);
      this.desiredCursorCol = undefined;
    } else if (matchesKey(data, Key.right)) {
      this.cursor = nextGraphemeBoundary(this.draft, this.cursor);
      this.desiredCursorCol = undefined;
    } else if (matchesKey(data, Key.up)) {
      this.moveCursorVertical(-1);
    } else if (matchesKey(data, Key.down)) {
      this.moveCursorVertical(1);
    } else if (matchesKey(data, Key.home)) {
      this.moveCursorLineEdge("start");
    } else if (matchesKey(data, Key.end)) {
      this.moveCursorLineEdge("end");
    } else if (matchesKey(data, Key.pageUp) || matchesKey(data, Key.pageDown)
      || matchesKey(data, Key.delete)) {
      // 忽略翻页/删除功能键，避免转义序列残渣（如 `[A`）混入文本。
    } else if (data.startsWith("\x1b")) {
      // 兜底：丢弃以 ESC 开头的未识别序列（拆分到达的 CSI/SS3 残渣）。
    } else {
      this.insertDraft(sanitizeMultiLineInput(data));
      this.desiredCursorCol = undefined;
    }
  }

  private insertDraft(input: string): void {
    if (!input) return;
    this.draft = this.draft.slice(0, this.cursor) + input + this.draft.slice(this.cursor);
    this.cursor += input.length;
  }

  /** Move the cursor one wrapped visual line up/down, keeping the target column. */
  private moveCursorVertical(direction: 1 | -1): void {
    const layout = layoutDraftCursor(this.draft, this.cursor, this.composerDraftWidth);
    if (this.desiredCursorCol === undefined) this.desiredCursorCol = layout.cursorCol;
    const targetRow = layout.cursorRow + direction;
    if (targetRow < 0) {
      // Already on the first visual line: jump to its start (host editor behavior).
      this.cursor = layout.lines[0].start;
      this.desiredCursorCol = undefined;
      return;
    }
    if (targetRow >= layout.lines.length) {
      // Already on the last visual line: jump to its end.
      this.cursor = layout.lines[layout.lines.length - 1].end;
      this.desiredCursorCol = undefined;
      return;
    }
    this.cursor = cursorForColumn(this.draft, layout.lines[targetRow], this.desiredCursorCol);
  }

  /** Move the cursor to the start/end of the current wrapped visual line. */
  private moveCursorLineEdge(edge: "start" | "end"): void {
    const layout = layoutDraftCursor(this.draft, this.cursor, this.composerDraftWidth);
    const line = layout.lines[layout.cursorRow];
    this.cursor = edge === "start" ? line.start : line.start + line.text.length;
    this.desiredCursorCol = undefined;
  }

  invalidate(): void {}

  render(width: number, height?: number): string[] {
    this.syncAgents();
    const now = Date.now();
    const w = Math.max(1, Math.min(width, 120));
    this.lastWidth = w;
    const log = this.agents.get(this.activeId);
    if (w < 20) {
      this.setTickVisibility("hidden", now);
      return [this.renderCompact(log, w)];
    }
    const terminalHeight = Math.max(6, (process.stdout?.rows ?? 30) - 2);
    const targetHeight = Math.max(6, Math.min(height ?? terminalHeight, terminalHeight));
    if (targetHeight <= 12) return this.renderDocked(log, w, targetHeight, now);
    const inner = w - 2;
    const rows: string[] = [this.renderTabs(inner), frameRule(inner)];

    if (this.activeId === MAIN_TAB) {
      this.setTickVisibility("hidden", now);
      return this.renderMainTab(rows, inner, w);
    }

    if (!log) {
      this.setTickVisibility("hidden", now);
      rows.push(dim(this.t("attach.noAgentSelected")));
      return this.renderFrame(rows, w);
    }

    const agent = log.agent;
    const selected = log.selectedTaskIndex === undefined
      ? undefined
      : log.progress.find((entry) => entry.taskIndex === log.selectedTaskIndex);
    this.setTickVisibility("full", now);
    const uptime = Math.max(0, Math.round(activeMs(agent, now) / 1000));
    const status = selected ? progressStatusText(selected, now, this.t) : agentStatusText(agent, now, this.t);
    const title = selected
      ? `${progressIcon(selected.status, progressPalette)} ${bold(progressLabel(selected))}${dim(` (${selected.agent})`)}`
      : `${bold(agent.agent)}/${bold(agent.name ?? agent.correlationId.slice(0, 8))}`;
    const meta = selected
      ? status
      : `${status}  ${dim(`${uptime}s`)}  ${dim(this.t("attach.inboxCount", { count: agent.inbox.length }))}`;
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
    rows.push(...(selected ? this.renderSelectedTools(selected, inner) : this.renderTools(log, inner, now)));
    rows.push(frameRule(inner));
    if (!selected) rows.push(...this.renderStream(log, inner));
    if (!selected && (log.streamingText || log.activeTools.some((tool) => tool.status === "running"))) {
      rows.push(frameRule(inner));
    }

    const logLines = selected
      ? this.buildSelectedLog(selected, Math.max(1, inner - 2))
      : log.transcriptMode
        ? this.buildTranscript(log, Math.max(1, inner - 2))
        : this.buildLog(log, Math.max(1, inner - 2));
    const tailRows: string[] = [];
    if (agent.status === "sleeping") {
      tailRows.push(frameRule(inner));
      tailRows.push(`${yellow("◉")} ${dim(this.t("attach.sleepingHint"))}`);
    }
    if (this.onSend) {
      tailRows.push(frameRule(inner));
      if (this.composing && this.sendStatus) {
        tailRows.push(truncateToWidth(`${red("!")} ${this.sendStatus}`, inner, "…"));
      }
      tailRows.push(...this.renderComposer(inner));
    }

    const logHeight = targetHeight - rows.length - tailRows.length - 3;
    if (logHeight < 1) return this.renderDocked(log, w, targetHeight, now);
    const maxOffset = Math.max(0, logLines.length - logHeight);
    log.maxScrollOffset = maxOffset;
    log.scrollOffset = log.followTail
      ? maxOffset
      : Math.max(0, Math.min(log.scrollOffset, maxOffset));
    const visibleLogs = logLines.slice(log.scrollOffset, log.scrollOffset + logHeight);
    rows.push(...visibleLogs);
    for (let i = visibleLogs.length; i < logHeight; i++) rows.push("");
    rows.push(...tailRows);

    const out = this.renderFrame(rows, w);
    const range = logLines.length > logHeight
      ? ` ${log.scrollOffset + 1}-${Math.min(log.scrollOffset + logHeight, logLines.length)}/${logLines.length}`
      : "";
    const agentHint = log.progress.length > 1
      ? `  ${dim("0")} ${this.t("attach.footer.overview")}  ${dim(`1-${Math.min(9, log.progress.length)}`)} ${this.t("common.view")}`
      : "";
    const transcriptHint = this.loadTranscript
      ? log.transcriptMode ? this.t("attach.footer.activity") : this.t("attach.footer.transcript")
      : "";
    out.push(dim(fitFooter(w, [
      this.t("attach.footer.back"),
      this.onSend ? (this.composing ? this.t("attach.footer.send") : this.t("attach.footer.message")) : "",
      this.composing ? this.t("attach.footer.newline") : "",
      this.t("attach.footer.switchCount", { count: this.order.length }),
      agentHint.trim(),
      transcriptHint,
      this.t("attach.footer.scroll", { range }),
    ])));
    return out;
  }

  private renderComposer(width: number, maxRows = MAX_COMPOSER_ROWS, framed = true): string[] {
    const prefix = `${green("›")} `;
    // The frame line reserves `│ ` + a leading space (3 cols total); docked
    // rows truncate at `width` directly, so only the prefix is reserved.
    const draftWidth = Math.max(1, width - (framed ? 3 : 2));
    this.composerDraftWidth = draftWidth;
    if (!this.composing) {
      return [truncateToWidth(
        this.sendStatus ? `${dim(this.t("attach.message.label"))} ${this.sendStatus}` : `${dim(this.t("attach.message.label"))} ${this.t("attach.message.compose")}`,
        width,
        "…",
      )];
    }
    const layout = layoutDraftCursor(this.draft, this.cursor, draftWidth);
    const indent = " ".repeat(visibleWidth(prefix));
    const maxVisible = Math.max(1, maxRows);
    const total = layout.lines.length;
    // Window around the cursor line so a long draft scrolls instead of
    // starving the log area; the window follows the cursor when it moves.
    const start = total > maxVisible
      ? Math.max(0, Math.min(layout.cursorRow - (maxVisible - 1), total - maxVisible))
      : 0;
    const rows = layout.lines.slice(start, start + maxVisible);
    const out: string[] = [];
    if (start > 0) out.push(truncateToWidth(dim("⋯"), width, "…"));
    for (let i = 0; i < rows.length; i++) {
      const rowIndex = start + i;
      out.push(this.renderComposerRow(
        rows[i],
        rowIndex === 0 ? prefix : indent,
        rowIndex === layout.cursorRow ? this.cursor : undefined,
        width,
      ));
    }
    return out;
  }

  /** One wrapped draft line, with the cursor grapheme reversed at `cursorOffset`. */
  private renderComposerRow(
    line: DraftLayoutLine,
    prefix: string,
    cursorOffset: number | undefined,
    width: number,
  ): string {
    if (cursorOffset === undefined) {
      return truncateToWidth(`${prefix}${line.text}`, width, "…");
    }
    const text = line.text;
    const visualEnd = line.start + text.length;
    const marker = this.focused ? CURSOR_MARKER : "";
    if (cursorOffset >= visualEnd) {
      return truncateToWidth(`${prefix}${text}${marker}\x1b[7m \x1b[27m`, width, "…");
    }
    const next = nextGraphemeBoundary(this.draft, cursorOffset);
    const cursorChar = this.draft.slice(cursorOffset, next);
    return truncateToWidth(
      `${prefix}${this.draft.slice(line.start, cursorOffset)}${marker}\x1b[7m${cursorChar}\x1b[27m${this.draft.slice(next, visualEnd)}`,
      width,
      "…",
    );
  }

  private renderDocked(log: AgentLog | undefined, width: number, height: number, now: number): string[] {
    if (this.activeId === MAIN_TAB) {
      this.setTickVisibility("hidden", now);
      return [
        this.renderTabs(width),
        truncateToWidth(dim(this.t("attach.mainDocked")), width, "…"),
        dim(fitFooter(width, [
          this.t("attach.footer.back"),
          this.t("attach.footer.switch"),
          this.t("attach.footer.return"),
        ])),
      ];
    }
    if (!log) {
      this.setTickVisibility("hidden", now);
      return [
        truncateToWidth(dim(this.t("attach.noActiveSession")), width, "…"),
        truncateToWidth(dim(this.t("attach.footer.back")), width, "…"),
      ];
    }

    const agent = log.agent;
    const selected = log.selectedTaskIndex === undefined
      ? undefined
      : log.progress.find((entry) => entry.taskIndex === log.selectedTaskIndex);
    this.setTickVisibility("tools", now);
    const status = selected ? progressStatusText(selected, now, this.t) : agentStatusText(agent, now, this.t);
    const title = selected
      ? `${progressIcon(selected.status, progressPalette)} ${bold(progressLabel(selected))} ${dim(`(${selected.agent})`)}`
      : `${bold(agent.agent)}/${bold(agent.name ?? agent.correlationId.slice(0, 8))}`;
    const lines: string[] = [
      this.renderTabs(width),
      truncateToWidth(`${title}  ${status}`, width, "…"),
    ];

    const footer = dim(fitFooter(width, [
      this.t("attach.footer.back"),
      this.onSend ? (this.composing ? this.t("attach.footer.send") : this.t("attach.footer.message")) : "",
      this.composing ? this.t("attach.footer.newline") : "",
      this.t("attach.footer.switch"),
      log.progress.length > 1
        ? `${this.t("attach.footer.overview")} · ${this.t("attach.footer.view", { max: Math.min(9, log.progress.length) })}`
        : "",
      this.loadTranscript ? (log.transcriptMode ? this.t("attach.footer.activity") : this.t("attach.footer.transcript")) : "",
      this.t("attach.footer.scroll", { range: "" }),
    ]));
    const tailRows: string[] = [];
    if (this.onSend && this.composing && this.sendStatus) {
      tailRows.push(truncateToWidth(`${red("!")} ${this.sendStatus}`, width, "…"));
    }
    if (this.onSend) tailRows.push(...this.renderComposer(width, Math.max(1, Math.min(MAX_COMPOSER_ROWS, height - 6)), false));
    tailRows.push(footer);

    if (log.progress.length > 1) {
      const tree = buildProgressTree(log.progress, progressPalette, now, this.locale);
      const focus = log.selectedTaskIndex ?? focusTaskIndex(log.progress);
      const maxTreeRows = Math.max(0, Math.min(3, height - lines.length - tailRows.length - 2));
      if (maxTreeRows > 0) {
        const window = selectProgressWindow(tree, maxTreeRows, focus);
        lines.push(...window.rows.map((row) => truncateToWidth(
          `${row.taskIndex === log.selectedTaskIndex ? green("›") : " "} ${row.text}`,
          width,
          "…",
        )));
      }
    }

    const toolLine = selected
      ? this.renderSelectedTools(selected, width)[0]
      : this.renderTools(log, width, now)[0];
    lines.push(toolLine);

    const streamLines = selected
      ? this.buildSelectedLog(selected, width)
      : log.transcriptMode
        ? this.buildTranscript(log, width)
        : [
            ...this.buildLog(log, width),
            ...log.streamingText.split("\n").filter((line) => line.trim()).slice(-STREAMING_MAX_LINES),
          ];
    if (streamLines.length === 0) streamLines.push(dim(this.t("attach.waitingOutput")));

    const contentHeight = Math.max(0, height - lines.length - tailRows.length);
    const maxOffset = Math.max(0, streamLines.length - contentHeight);
    log.maxScrollOffset = maxOffset;
    log.scrollOffset = log.followTail
      ? maxOffset
      : Math.max(0, Math.min(log.scrollOffset, maxOffset));
    if (contentHeight > 0) {
      lines.push(...streamLines.slice(log.scrollOffset, log.scrollOffset + contentHeight));
    }
    lines.push(...tailRows);

    return lines.slice(0, height).map((line) => truncateToWidth(line, width, "…"));
  }

  private renderProgressTree(log: AgentLog, width: number, maxRows = GRAPH_LIST_MAX_ROWS): string[] {
    const tree = buildProgressTree(log.progress, progressPalette, Date.now(), this.locale);
    const focus = log.selectedTaskIndex ?? focusTaskIndex(log.progress);
    const window = selectProgressWindow(tree, maxRows, focus);
    const running = log.progress.filter((entry) => entry.status === "running").length;
    const pending = log.progress.filter((entry) => entry.status === "pending").length;
    const failed = log.progress.filter((entry) => entry.status === "failed").length;
    const range = window.total > window.rows.length
      ? `${window.start + 1}-${window.start + window.rows.length}/${window.total}`
      : `${window.total}`;
    const header = dim(this.t("attach.agentsSummary", {
      running,
      pending,
      failed: failed ? ` · ${this.t("progress.summary.failedCount", { count: failed })}` : "",
      range,
    }));
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
    if (tools.length === 0) return [dim(idleLabel(entry.lastActivityAt, Date.now(), this.t))];
    const parts = tools.slice(-6).map((tool) => {
      if (tool.status === "running") return yellow(`${SPINNER[this.frame]} ${tool.name}`);
      if (tool.status === "failed") return red(`✗ ${tool.name}`);
      return dim(`✓ ${tool.name}`);
    });
    if (tools.length > 6) parts.unshift(dim(`+${tools.length - 6}`));
    return [truncateToWidth(`${dim(this.t("attach.tools"))} ${parts.join(dim("  "))}`, width, "…")];
  }

  private buildSelectedLog(entry: AgentProgressSnapshot, width: number): string[] {
    const message = entry.lastMessage?.trim();
    if (!message) return [dim(entry.status === "pending" ? this.t("attach.waitingDependencies") : this.t("attach.waitingOutput"))];
    const lines: string[] = [];
    for (const rawLine of message.split("\n")) {
      lines.push(...wrapTextWithAnsi(rawLine, width));
    }
    return lines;
  }

  /**
   * First load of an agent's conversation from its session file. Tolerant of
   * failures — the live activity log remains the fallback view.
   */
  private ensureTranscript(log: AgentLog): void {
    if (!this.loadTranscript || log.transcriptLoading) return;
    log.transcriptLoading = true;
    log.transcriptError = undefined;
    this.requestRender?.();
    void this.loadTranscript(log.agent).then((transcript) => {
      const live = this.agents.get(log.agent.correlationId);
      if (!live) return;
      live.transcript = transcript;
      live.transcriptLoading = false;
      this.requestRender?.();
    }).catch((error: unknown) => {
      const live = this.agents.get(log.agent.correlationId);
      if (!live) return;
      live.transcriptLoading = false;
      live.transcriptError = error instanceof Error ? error.message : String(error);
      this.requestRender?.();
    });
  }

  /**
   * Live IPC arrived for a running agent whose transcript tab is open —
   * debounce a disk refresh so new session entries appear without a manual
   * reload. The loader is cheap (incremental read of an append-only file).
   */
  noteLiveEvent(cid: string): void {
    const log = this.agents.get(cid);
    if (!log || !log.transcriptMode || !this.loadTranscript) return;
    if (log.transcriptRefreshTimer) clearTimeout(log.transcriptRefreshTimer);
    log.transcriptRefreshTimer = setTimeout(() => {
      log.transcriptRefreshTimer = undefined;
      if (!log.transcriptLoading) this.refreshTranscript(log);
    }, 300);
  }

  private refreshTranscript(log: AgentLog): void {
    if (!this.loadTranscript) return;
    log.transcriptLoading = true;
    this.requestRender?.();
    void this.loadTranscript(log.agent).then((next) => {
      const live = this.agents.get(log.agent.correlationId);
      if (!live) return;
      live.transcript = next;
      live.transcriptLoading = false;
      this.requestRender?.();
    }).catch(() => {
      const live = this.agents.get(log.agent.correlationId);
      if (!live) return;
      live.transcriptLoading = false;
      this.requestRender?.();
    });
  }

  /** Rows beyond this cap are hidden behind a dim marker (scroll not affected). */
  private static readonly TRANSCRIPT_MAX_ROWS = 2000;

  private buildTranscript(log: AgentLog, width: number): string[] {
    const transcript = log.transcript;
    if (!transcript) {
      return [dim(log.transcriptLoading ? this.t("attach.loadingTranscript") : this.t("attach.noTranscript"))];
    }
    if (transcript.rows.length === 0) {
      return [dim(this.t("attach.emptyTranscript"))];
    }
    const locale = this.locale ?? getTuiLocale();
    const cache = log.transcriptCache;
    if (
      cache
      && cache.width === width
      && cache.locale === locale
      && cache.rows === transcript.rows
      && cache.loading === log.transcriptLoading
    ) {
      return cache.rendered;
    }
    const start = transcript.rows.length > AttachOverlay.TRANSCRIPT_MAX_ROWS
      ? transcript.rows.length - AttachOverlay.TRANSCRIPT_MAX_ROWS
      : 0;
    const out: string[] = [];
    if (start > 0) out.push(dim(this.t("attach.olderMessages", { count: start })));
    for (let i = start; i < transcript.rows.length; i++) {
      out.push(...this.renderTranscriptRow(transcript.rows[i]!, width));
    }
    if (log.transcriptLoading) out.push(dim(this.t("attach.refreshing")));
    if (transcript.source === "memory") {
      out.push(dim(this.t("attach.memoryTranscript")));
    }
    log.transcriptCache = {
      width,
      locale,
      rows: transcript.rows,
      loading: log.transcriptLoading ?? false,
      rendered: out,
    };
    return out;
  }

  private renderTranscriptRow(row: TranscriptRow, width: number): string[] {
    const contentWidth = Math.max(1, width - 2);
    switch (row.kind) {
      case "user":
        return this.prefixedLines(
          `${progressPalette.accent("❯")} `,
          row.text,
          contentWidth,
          3,
        );
      case "assistant":
        return this.prefixedLines(
          `${progressPalette.dim("·")} `,
          row.text,
          contentWidth,
          3,
        );
      case "tool": {
        const name = row.toolName ?? "tool";
        const head = `${progressPalette.dim("▸")} ${progressPalette.accent(name)} `;
        const lines = this.limitText(row.text, contentWidth - visibleWidth(head), 1);
        if (lines.length === 0) return [head.trimEnd()];
        return lines.map((line, i) => i === 0 ? `${head}${line}` : line);
      }
      case "tool_result": {
        const mark = row.isError ? progressPalette.error("✗") : progressPalette.dim("·");
        return this.prefixedLines(`${mark} `, row.text, contentWidth, 3);
      }
      case "thinking": {
        const lines = row.text.trim().split("\n").filter((line) => line.trim() !== "");
        const preview = lines[0] ?? "";
        const suffix = lines.length > 1
          ? progressPalette.dim(this.t("attach.thinkingLines", { count: lines.length }))
          : "";
        // Truncate the preview against the width left after the suffix, so the
        // line-count hint is never cut by the outer frame truncation.
        const available = Math.max(1, contentWidth - visibleWidth(suffix));
        return [`${progressPalette.dim("…")} ${progressPalette.dim(truncateToWidth(preview, available, "…"))}${suffix}`];
      }
      case "meta":
        return [progressPalette.dim(`─ ${truncateToWidth(row.text, contentWidth, "…")}`)];
      case "system":
      default:
        return this.prefixedLines(progressPalette.dim("»") + " ", row.text, contentWidth, 3);
    }
  }

  /** Prefix a multi-line text block, indenting continuation lines. */
  private prefixedLines(
    prefix: string,
    text: string,
    width: number,
    maxLines: number,
  ): string[] {
    const lines = this.limitText(text, Math.max(1, width - visibleWidth(prefix)), maxLines);
    if (lines.length === 0) return [prefix.trimEnd()];
    const indent = " ".repeat(visibleWidth(prefix));
    return lines.map((line, i) => (i === 0 ? `${prefix}${line}` : `${indent}${line}`));
  }

  /** First maxLines text lines, each truncated to width, with a … marker. */
  private limitText(text: string, width: number, maxLines: number): string[] {
    const trimmed = text.trim();
    if (!trimmed) return [];
    const raw = trimmed.split("\n").map((line) => line.trimEnd());
    const shown = raw.slice(0, maxLines).map((line) => truncateToWidth(line, width, "…"));
    if (raw.length > maxLines) shown.push(progressPalette.dim("…"));
    return shown;
  }

  private renderMainTab(rows: string[], inner: number, w: number): string[] {
    rows.push(frameRule(inner));
    rows.push(dim(`● ${this.t("attach.main")}`));
    rows.push(dim(`   ${this.t("attach.mainReturn")}`));
    rows.push(frameRule(inner));
    const out = this.renderFrame(rows, w);
    out.push(dim(fitFooter(w, [
      this.t("attach.footer.back"),
      this.t("attach.footer.switchCount", { count: this.order.length }),
      this.t("attach.footer.return"),
    ])));
    return out;
  }

  private renderCompact(log: AgentLog | undefined, width: number): string {
    if (this.composing) {
      const content = this.sendStatus || this.draft.replace(/\n/g, " ") || this.t("attach.typeMessage");
      return truncateToWidth(this.t("attach.compactCancel", { content }), width, "…");
    }
    if (this.activeId === MAIN_TAB) {
      return truncateToWidth(dim(this.t("attach.mainCompact")), width, "…");
    }
    if (!log) return truncateToWidth(`${dim("□")} ${this.t("common.agents")}`, width, "…");
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
    return truncateToWidth(`${icon} ${agent.agent}/${name} · ${this.t("attach.compactMessage")}`, width, "…");
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
    if (this.order.length === 0) return dim(this.t("common.agents"));
    const activeIndex = Math.max(0, this.order.indexOf(this.activeId));
    const labels = this.order.map((cid) => {
      if (cid === MAIN_TAB) {
        const main = `● ${this.t("attach.main")}`;
        return cid === this.activeId ? `${green("▸")} ${bold(green(main))}` : main;
      }
      const log = this.agents.get(cid);
      if (!log) return dim(cid.slice(0, 6));
      const agent = log.agent;
      const name = agent.name ?? cid.slice(0, 6);
      const icon = agent.status === "sleeping" ? "◉" : agent.status === "completed" ? "✓" : "■";
      const label = `${icon} @${name}`;
      return cid === this.activeId ? `${green("▸")} ${bold(green(label))}` : dim(label);
    });
    const prefix = `${dim(`${this.t("common.agents")} ${activeIndex + 1}/${this.order.length} ·`)} `;
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

  private renderTools(log: AgentLog, width: number, now: number): string[] {
    if (log.activeTools.length === 0) return [dim(idleLabel(log.agent.lastActivityAt, now, this.t))];
    const parts: string[] = [];
    const spinner = SPINNER[this.frame];
    for (const tool of log.activeTools.slice(-6)) {
      const seconds = Math.max(0, Math.round((now - tool.startedAt) / 1000));
      if (tool.status === "running") parts.push(yellow(`${spinner} ${bold(tool.name)} ${dim(`${seconds}s`)}`));
      else if (tool.status === "failed") parts.push(red(`✗ ${tool.name}`));
      else parts.push(dim(`✓ ${tool.name}`));
    }
    if (log.activeTools.length > 6) parts.unshift(dim(`+${log.activeTools.length - 6}`));
    return [truncateToWidth(`${dim(this.t("attach.tools"))} ${parts.join(dim("  "))}`, width, "…")];
  }

  private renderStream(log: AgentLog, width: number): string[] {
    if (!log.streamingText) return [dim(this.t("attach.outputWaiting"))];
    const all = log.streamingText.split("\n");
    const tail = all.slice(-STREAMING_MAX_LINES);
    const header = all.length > STREAMING_MAX_LINES
      ? dim(this.t("attach.outputEarlier", { count: all.length - STREAMING_MAX_LINES }))
      : dim(this.t("attach.output"));
    const contentWidth = Math.max(1, width - 3);
    return [
      header,
      ...tail.map((line) => `${dim("│")} ${truncateToWidth(line, contentWidth, "…")}`),
    ];
  }

  /**
   * Wrapping the full 500-line backlog on every frame is ~96% wasted work: the
   * caller slices a ~20-line window out of it. The backlog only changes when a
   * line is appended (or evicted, which changes the tail identity), so memoize
   * on (width, count, tail identity) for both the log and the inbox.
   */
  private buildLog(log: AgentLog, width: number): string[] {
    const inbox = log.agent.inbox;
    const lastLine = log.lines[log.lines.length - 1];
    const lastInbox = inbox[inbox.length - 1];
    const locale = this.locale ?? getTuiLocale();
    const cache = log.logCache;
    if (
      cache
      && cache.width === width
      && cache.locale === locale
      && cache.lineCount === log.lines.length
      && cache.lastLine === lastLine
      && cache.inboxCount === inbox.length
      && cache.lastInbox === lastInbox
    ) {
      return cache.rendered;
    }

    const result: string[] = [];
    for (const entry of log.lines) {
      for (const line of wrapTextWithAnsi(entry.text, width)) {
        if (entry.kind === "tool") result.push(`${green("■")} ${bold(line)}`);
        else if (entry.kind === "output") result.push(`${dim("│")} ${line}`);
        else if (entry.kind === "system") result.push(`${dim("»")} ${yellow(line)}`);
        else result.push(`  ${line}`);
      }
    }
    if (inbox.length > 0) {
      result.push(dim(this.t("attach.inbox")));
      for (const message of inbox.slice(-5)) {
        const time = new Date(message.timestamp).toISOString().slice(11, 19);
        // Payloads are capped by bytes (256KB total), never by display size —
        // truncate before wrapping instead of wrapping the whole payload.
        const payload = message.payload.length > INBOX_PREVIEW_CHARS
          ? `${message.payload.slice(0, INBOX_PREVIEW_CHARS)}…`
          : message.payload;
        const wrapped = wrapTextWithAnsi(`[${time}] ◀ ${message.from}: ${payload}`, width);
        for (const line of wrapped.slice(0, INBOX_PREVIEW_LINES)) {
          result.push(`${yellow("◀")} ${line}`);
        }
        if (wrapped.length > INBOX_PREVIEW_LINES) result.push(`${yellow("◀")} ${dim("…")}`);
      }
    }
    log.logCache = {
      width,
      locale,
      lineCount: log.lines.length,
      lastLine,
      inboxCount: inbox.length,
      lastInbox,
      rendered: result,
    };
    return result;
  }

  dispose(): void {
    this.localeDisposer();
    if (this.pasteFlushTimer) clearTimeout(this.pasteFlushTimer);
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    for (const log of this.agents.values()) {
      if (log.transcriptRefreshTimer) clearTimeout(log.transcriptRefreshTimer);
    }
    this.agents.clear();
    this.order.length = 0;
  }
}
