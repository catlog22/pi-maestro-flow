import {
  type Component,
  type Focusable,
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
} from "@earendil-works/pi-tui";

import type {
  SwarmAgentSnapshot,
  SwarmMetricPoint,
  SwarmRunArtifact,
  SwarmStreamEntry,
} from "../swarm/types.ts";
import { renderSwarmAgentProgress } from "../swarm/progress.ts";

type SwarmView = "live" | "prepare" | "topology" | "metrics" | "result";

const VIEWS: readonly SwarmView[] = ["live", "prepare", "topology", "metrics", "result"];
const VIEW_LABELS: Record<SwarmView, string> = {
  live: "Live",
  prepare: "Prepare",
  topology: "Topology",
  metrics: "Metrics",
  result: "Result",
};

export interface SwarmOverlayParams {
  snapshot: SwarmRunArtifact;
  requestRender: () => void;
  close: () => void;
  onDispose?: () => void;
}

export class SwarmOverlay implements Component, Focusable {
  focused = false;
  private snapshot: SwarmRunArtifact;
  private view: SwarmView = "live";
  private readonly offsets = new Map<SwarmView, number>();
  private followTail = true;
  private lastStreamSequence = 0;
  private disposed = false;

  constructor(private readonly params: SwarmOverlayParams) {
    this.snapshot = params.snapshot;
  }

  invalidate(): void {}
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.params.onDispose?.();
  }

  update(snapshot: SwarmRunArtifact): void {
    const lastSequence = snapshot.stream[snapshot.stream.length - 1]?.sequence ?? 0;
    if (this.view === "live" && this.followTail && lastSequence !== this.lastStreamSequence) {
      this.offsets.set("live", Number.MAX_SAFE_INTEGER);
    }
    this.lastStreamSequence = lastSequence;
    this.snapshot = snapshot;
    this.params.requestRender();
  }

  handleInput(data: string): void {
    if (data === "\x1b" || data === "q") {
      this.params.close();
      return;
    }
    const wheelDelta = parseMouseWheelDelta(data);
    if (wheelDelta !== undefined) {
      this.scroll(wheelDelta);
      this.params.requestRender();
      return;
    }
    const direct = Number.parseInt(data, 10);
    if (direct >= 1 && direct <= VIEWS.length) {
      this.switchView(VIEWS[direct - 1]!);
      return;
    }
    if (data === "\x1b[C" || data === "l" || data === "\t") {
      this.switchView(VIEWS[(VIEWS.indexOf(this.view) + 1) % VIEWS.length]!);
      return;
    }
    if (data === "\x1b[D" || data === "h") {
      this.switchView(VIEWS[(VIEWS.indexOf(this.view) - 1 + VIEWS.length) % VIEWS.length]!);
      return;
    }
    if (data === "f" && this.view === "live") {
      this.followTail = !this.followTail;
      if (this.followTail) this.offsets.set("live", Number.MAX_SAFE_INTEGER);
      this.params.requestRender();
      return;
    }
    if (data === "\x1b[A" || data === "k") this.scroll(-1);
    else if (data === "\x1b[B" || data === "j") this.scroll(1);
    else if (data === "\x1b[5~") this.scroll(-6);
    else if (data === "\x1b[6~") this.scroll(6);
    else if (data === "g" || data === "\x1b[H") this.scrollTo(0);
    else if (data === "G" || data === "\x1b[F") this.scrollTo(Number.MAX_SAFE_INTEGER);
    else return;
    this.params.requestRender();
  }

  render(width: number): string[] {
    const safeWidth = Math.max(1, Math.min(width, 120));
    if (safeWidth < 24) return [truncateToWidth(renderSwarmStatusLine(this.snapshot, safeWidth), safeWidth, "…")];

    const terminalRows = Math.max(8, process.stdout.rows || 30);
    const targetHeight = Math.max(6, Math.min(28, terminalRows - 4));
    if (targetHeight <= 10) return this.renderDocked(safeWidth, targetHeight);

    const inner = safeWidth - 2;
    const contentHeight = Math.max(1, targetHeight - 9);
    const content = this.renderView(inner);
    const maxOffset = Math.max(0, content.length - contentHeight);
    const requested = this.offsets.get(this.view) ?? 0;
    const offset = Math.max(0, Math.min(requested, maxOffset));
    this.offsets.set(this.view, offset);
    const visible = content.slice(offset, offset + contentHeight);
    while (visible.length < contentHeight) visible.push("");

    return [
      border("top", safeWidth),
      boxLine(titleLine(this.snapshot), inner),
      boxLine(phaseLine(this.snapshot), inner),
      border("middle", safeWidth),
      boxLine(tabLine(this.view, inner), inner),
      border("middle", safeWidth),
      ...visible.map((line) => boxLine(line, inner)),
      border("middle", safeWidth),
      boxLine(this.footer(inner, offset, maxOffset), inner),
      border("bottom", safeWidth),
    ];
  }

  private renderDocked(width: number, height: number): string[] {
    const inner = width - 2;
    const rows = [
      border("top", width),
      boxLine(titleLine(this.snapshot), inner),
      boxLine(phaseLine(this.snapshot), inner),
      boxLine(renderSwarmStatusLine(this.snapshot, inner), inner),
      boxLine(fitFooter(inner, ["Esc close", "1-5 views"]), inner),
      border("bottom", width),
    ];
    return rows.slice(0, Math.max(1, height));
  }

  private renderView(width: number): string[] {
    if (this.view === "prepare") return renderPreparation(this.snapshot, width);
    if (this.view === "topology") return renderTopology(this.snapshot, width);
    if (this.view === "metrics") return renderMetrics(this.snapshot.metrics, width);
    if (this.view === "result") return renderResult(this.snapshot, width);
    return renderLive(this.snapshot, width);
  }

  private footer(width: number, offset: number, maxOffset: number): string {
    const position = maxOffset > 0 ? `${offset + 1}/${maxOffset + 1}` : "all";
    return fitFooter(width, [
      "Esc close",
      "←/→ views",
      "↑/↓ scroll",
      "wheel scroll",
      "PgUp/PgDn",
      this.view === "live" ? `f follow:${this.followTail ? "on" : "off"}` : "",
      `rows:${position}`,
    ]);
  }

  private switchView(view: SwarmView): void {
    this.view = view;
    if (view === "live" && this.followTail) this.offsets.set("live", Number.MAX_SAFE_INTEGER);
    this.params.requestRender();
  }

  private scroll(delta: number): void {
    const current = this.offsets.get(this.view) ?? 0;
    this.offsets.set(this.view, Math.max(0, current + delta));
    if (this.view === "live" && delta < 0) this.followTail = false;
  }

  private scrollTo(offset: number): void {
    this.offsets.set(this.view, offset);
    if (this.view === "live") this.followTail = offset === Number.MAX_SAFE_INTEGER;
  }
}

export function parseMouseWheelDelta(data: string): number | undefined {
  const match = /^\x1b\[<(\d+);\d+;\d+[Mm]$/.exec(data);
  if (!match) return undefined;
  const button = Number.parseInt(match[1]!, 10);
  if ((button & 64) === 0) return undefined;
  return (button & 1) === 0 ? -3 : 3;
}

export function renderSwarmStatusLine(snapshot: SwarmRunArtifact, width: number): string {
  const metric = snapshot.metrics[snapshot.metrics.length - 1];
  const agents = [...snapshot.activeAgents, ...(snapshot.stageAgents ?? [])];
  const running = agents.filter((agent) => agent.status === "running").length;
  const completed = agents.filter((agent) => agent.status === "completed").length;
  const content = [
    `Swarm ${statusLabel(snapshot.status)}`,
    `skill:${snapshot.skill.phase}`,
    snapshot.status === "preparing"
      ? `prep ${snapshot.preparation.steps.filter((step) => step.status === "completed").length}/${snapshot.preparation.steps.length}`
      : `iter ${snapshot.currentIteration}/${snapshot.config.maxIterations}`,
    `${running} running`,
    `${completed}/${agents.length || snapshot.config.nAnts + 2} done`,
    metric ? `best ${percent(metric.bestScore)}` : undefined,
    metric ? `conv ${percent(metric.convergence)}` : undefined,
  ].filter(Boolean).join(" · ");
  return truncateToWidth(content, Math.max(1, width), "…");
}

function renderLive(snapshot: SwarmRunArtifact, width: number): string[] {
  const agents = [...snapshot.activeAgents, ...(snapshot.stageAgents ?? [])];
  const recentStream = snapshot.stream.slice(-8);
  const rows = [
    fit(`Objective  ${snapshot.objective}`, width),
    fit(`Skill      ${snapshot.skill.name} · ${snapshot.skill.status} · phase ${snapshot.skill.phase}`, width),
    fit(`Agents     ${agentCounts(agents)} · stream ${snapshot.stream.length} events`, width),
    "",
    fit("Recent runtime events", width),
  ];
  if (recentStream.length === 0) rows.push(fit("○ Waiting for preparation events…", width));
  for (const entry of recentStream) rows.push(...renderStreamEntry(entry, width));
  rows.push(
    "",
    fit("Agent diagnostics · fixed roles", width),
    ...renderSwarmAgentProgress(agents, width, { maxAgents: 8, details: "focus" }),
    fit(`Latest signal  ${snapshot.stream[snapshot.stream.length - 1]?.text ?? "Waiting for runtime event"}`, width),
  );
  return rows;
}

function renderStreamEntry(entry: SwarmStreamEntry, width: number): string[] {
  const time = entry.timestamp.slice(11, 19);
  const glyph = entry.kind === "assistant" ? "›"
    : entry.kind === "tool" ? "⚙"
    : entry.kind === "skill" ? "S"
    : entry.kind === "artifact" ? "↳"
    : entry.kind === "convergence" ? "◆"
    : entry.kind === "metric" ? "◆"
    : entry.kind === "preparation" ? "◇"
    : entry.kind === "system" ? "!"
    : "•";
  const source = entry.agentId ?? entry.kind;
  const prefix = `${time} ${glyph} ${source}`;
  const textWidth = Math.max(8, width - visibleWidth(prefix) - 3);
  const wrapped = wrapTextWithAnsi(entry.text.replace(/\s+/g, " ").trim(), textWidth).slice(-3);
  if (wrapped.length === 0) return [fit(prefix, width)];
  return wrapped.map((line, index) => fit(index === 0 ? `${prefix} · ${line}` : `${" ".repeat(Math.min(24, visibleWidth(prefix) + 3))}${line}`, width));
}

function renderPreparation(snapshot: SwarmRunArtifact, width: number): string[] {
  const rows = [
    fit(`Skill plan  ${snapshot.skill.status} · phase ${snapshot.skill.phase}`, width),
    fit(`Preparation ${snapshot.preparation.status} · private Ant + dynamic judge/analyst`, width),
  ];
  rows.push(...indentedWrap("Rationale", snapshot.plan?.rationale ?? "waiting for Skill coordinator", width));
  rows.push("");
  for (const step of snapshot.preparation.steps) {
    const glyph = step.status === "completed" ? "✓"
      : step.status === "running" ? "▶"
      : step.status === "failed" ? "×"
      : "○";
    const duration = step.durationMs == null ? "" : ` · ${step.durationMs}ms`;
    rows.push(fit(`${glyph} ${step.label.padEnd(18)} ${step.detail}${duration}`, width));
  }
  rows.push("", fit("Private system Ant + selected judge/analyst", width));
  for (const role of snapshot.preparation.roles) {
    rows.push(
      fit(`${role.id.padEnd(14)} ${role.stage}/${role.taskType} · ${role.agent} [${role.source}]`, width),
      fit(`               role #${role.rolePromptHash} · task #${role.promptHash} · ${role.promptChars} chars`, width),
      ...indentedWrap("Mission", role.mission, width, 15),
      fit(`               ${role.layers.join(" → ")}`, width),
    );
  }
  if (snapshot.preparation.roles.length === 0) rows.push(fit("○ Private Ant and selected roles are waiting to load.", width));
  return rows;
}

function renderTopology(snapshot: SwarmRunArtifact, width: number): string[] {
  const path = snapshot.best?.path ?? snapshot.activeAgents[0]?.path ?? [];
  const judge = snapshot.preparation.roles.find((role) => role.stage === "judge")?.agent ?? "judge";
  const analyst = snapshot.preparation.roles.find((role) => role.stage === "analyst")?.agent ?? "analyst";
  const rows = [
    fit("Execution topology", width),
    fit(`/swarm → dynamic contract → [private Ant ×${snapshot.config.nAnts}] → ${judge} → MMAS ↻ → ${analyst}`, width),
    "",
    fit("Live teammate graph", width),
    ...renderAgentGraph([...snapshot.activeAgents, ...(snapshot.stageAgents ?? [])], width),
    "",
    fit("Dominant search path", width),
  ];
  if (path.length > 0) {
    const segments: string[] = [];
    for (let index = 0; index < path.length; index++) {
      const node = snapshot.graph.nodes.find((candidate) => candidate.id === path[index]);
      segments.push(`[${node?.label ?? path[index]}]`);
      if (index < path.length - 1) {
        const id = [...[path[index]!, path[index + 1]!]].sort().join("::");
        const edge = snapshot.graph.edges.find((candidate) => candidate.id === id);
        segments.push(edgeGlyph(edge?.pheromone ?? 0));
      }
    }
    rows.push(fit(segments.join(""), width));
  } else rows.push(fit("○ Search topology will emerge after ant assignment.", width));

  rows.push("", fit("Pheromone leaders", width));
  for (const edge of [...snapshot.graph.edges].sort((left, right) => right.pheromone - left.pheromone).slice(0, 6)) {
    rows.push(fit(`${edge.source.padEnd(14)} ─ ${edge.target.padEnd(14)} ${bar(normalizeTau(edge.pheromone, snapshot.config.tauMax), 10)} τ=${edge.pheromone.toFixed(2)}`, width));
  }
  return rows;
}

function renderAgentGraph(agents: SwarmAgentSnapshot[], width: number): string[] {
  return renderSwarmAgentProgress(agents, width, { maxAgents: 8, details: "all" });
}

function renderMetrics(metrics: SwarmMetricPoint[], width: number): string[] {
  if (metrics.length === 0) return [fit("○ Metrics begin after the first judged iteration.", width)];
  const current = metrics[metrics.length - 1]!;
  const rows = [
    fit(`Best         ${sparkline(metrics.map((point) => point.bestScore))}  ${percent(current.bestScore)}`, width),
    fit(`Mean         ${sparkline(metrics.map((point) => point.meanScore))}  ${percent(current.meanScore)}`, width),
    fit(`Convergence  ${sparkline(metrics.map((point) => point.convergence))}  ${percent(current.convergence)}`, width),
    fit(`Entropy      ${sparkline(metrics.map((point) => point.entropy))}  ${current.entropy.toFixed(3)}`, width),
    "",
    fit("iter  best   mean   delta  entropy  diverse  consensus  converge", width),
  ];
  for (const point of metrics) {
    rows.push(fit([
      String(point.iteration).padStart(4),
      percent(point.bestScore).padStart(6),
      percent(point.meanScore).padStart(6),
      signed(point.scoreDelta).padStart(7),
      point.entropy.toFixed(3).padStart(8),
      percent(point.diversity).padStart(8),
      percent(point.consensus).padStart(10),
      percent(point.convergence).padStart(9),
    ].join(" "), width));
  }
  return rows;
}

function renderResult(snapshot: SwarmRunArtifact, width: number): string[] {
  if (!snapshot.best && !snapshot.synthesis) {
    return [
      fit(`${statusLabel(snapshot.status)} · result not ready`, width),
      fit("The Result tab will populate after convergence and analyst synthesis.", width),
    ];
  }
  const rows = [fit(`Result  ${statusLabel(snapshot.status)} · ${snapshot.convergence.reason}`, width), ""];
  if (snapshot.best) {
    rows.push(
      fit(`Best candidate  ${snapshot.best.antId} · ${percent(snapshot.best.score)} · ${snapshot.best.path.join(" → ")}`, width),
      ...section("Candidate", snapshot.best.candidate.summary, width),
    );
  }
  if (snapshot.synthesis) {
    rows.push(
      ...section("Summary", snapshot.synthesis.summary, width),
      ...section("Recommendation", snapshot.synthesis.recommendation, width),
      ...listSection("Actions", snapshot.synthesis.actions, width),
      ...listSection("Risks", snapshot.synthesis.risks, width),
      ...listSection("Evidence", snapshot.synthesis.evidence, width),
    );
  }
  rows.push("", fit(`Artifacts  ${snapshot.artifactDir}`, width));
  return rows;
}

function section(label: string, text: string, width: number): string[] {
  return ["", fit(label, width), ...wrapTextWithAnsi(text, Math.max(8, width)).map((line) => fit(`  ${line}`, width))];
}

function listSection(label: string, items: string[], width: number): string[] {
  if (items.length === 0) return [];
  return ["", fit(label, width), ...items.flatMap((item) => wrapTextWithAnsi(item, Math.max(8, width - 4)).map((line, index) => fit(`${index === 0 ? "  • " : "    "}${line}`, width)))];
}

function indentedWrap(label: string, text: string, width: number, indent = 12): string[] {
  const prefix = `${label.padEnd(Math.max(1, indent - 1))} `;
  const bodyWidth = Math.max(8, width - visibleWidth(prefix));
  const lines = wrapTextWithAnsi(text.replace(/\s+/g, " ").trim(), bodyWidth);
  if (lines.length === 0) return [fit(prefix, width)];
  return lines.map((line, index) => fit(`${index === 0 ? prefix : " ".repeat(visibleWidth(prefix))}${line}`, width));
}

function titleLine(snapshot: SwarmRunArtifact): string {
  const pulse = snapshot.status === "running" || snapshot.status === "preparing" ? spinner() : statusIcon(snapshot.status);
  return `${pulse} SWARM SKILL · ${snapshot.status.toUpperCase()} · ${snapshot.objective}`;
}

function phaseLine(snapshot: SwarmRunArtifact): string {
  const prep = snapshot.preparation.steps.map((step) => step.status === "completed" ? "✓" : step.status === "running" ? "▶" : step.status === "failed" ? "×" : "○").join("");
  const run = snapshot.currentIteration > 0 ? `${snapshot.currentIteration}/${snapshot.config.maxIterations}` : "0";
  const synth = snapshot.status === "completed" ? "✓" : snapshot.status === "synthesizing" ? "▶" : "○";
  return `SKILL ${snapshot.skill.phase}  ─  PREP ${prep}  ─  RUN ${run}  ─  SYNTH ${synth}`;
}

function tabLine(active: SwarmView, width: number): string {
  return fitFooter(width, VIEWS.map((view, index) => view === active ? `[${index + 1} ${VIEW_LABELS[view]}]` : `${index + 1} ${VIEW_LABELS[view]}`));
}

function fitFooter(width: number, segments: string[]): string {
  let footer = "";
  for (const segment of segments.filter(Boolean)) {
    const next = footer ? `${footer}  ${segment}` : segment;
    if (visibleWidth(next) > width) break;
    footer = next;
  }
  return footer || segments.find(Boolean) || "";
}

function agentCounts(agents: SwarmAgentSnapshot[]): string {
  const counts = new Map<string, number>();
  for (const agent of agents) counts.set(agent.status, (counts.get(agent.status) ?? 0) + 1);
  return [...counts.entries()].map(([status, count]) => `${status} ${count}`).join(" · ") || "pending";
}

function statusIcon(status: SwarmRunArtifact["status"]): string {
  if (status === "completed") return "✓";
  if (status === "failed") return "×";
  if (status === "cancelled") return "⊘";
  if (status === "converged") return "◆";
  if (status === "synthesizing") return "◇";
  if (status === "running") return "▶";
  return "○";
}

function statusLabel(status: SwarmRunArtifact["status"]): string {
  return `${statusIcon(status)} ${status}`;
}

function spinner(): string {
  const frames = "⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏";
  return frames[Math.floor(Date.now() / 120) % frames.length]!;
}

function edgeGlyph(tau: number): string {
  if (tau >= 5) return "━━━";
  if (tau >= 2) return "━━";
  return "──";
}

function normalizeTau(value: number, maximum: number): number {
  return Math.max(0, Math.min(1, value / Math.max(1, maximum)));
}

function bar(value: number, length: number): string {
  const filled = Math.max(0, Math.min(length, Math.round(value * length)));
  return `${"█".repeat(filled)}${"░".repeat(length - filled)}`;
}

function sparkline(values: number[]): string {
  const glyphs = "▁▂▃▄▅▆▇█";
  if (values.length === 0) return "";
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min;
  return values.map((value) => glyphs[Math.min(glyphs.length - 1, span === 0 ? 3 : Math.round(((value - min) / span) * (glyphs.length - 1)))]).join("");
}

function percent(value: number): string {
  return `${Math.round(value * 100)}%`;
}

function signed(value: number): string {
  return `${value >= 0 ? "+" : ""}${value.toFixed(3)}`;
}

function fit(text: string, width: number): string {
  return truncateToWidth(text, Math.max(1, width), "…");
}

function boxLine(content: string, innerWidth: number): string {
  const clipped = fit(` ${content}`, innerWidth);
  const padding = Math.max(0, innerWidth - visibleWidth(clipped));
  return `│${clipped}${" ".repeat(padding)}│`;
}

function border(position: "top" | "middle" | "bottom", width: number): string {
  if (width <= 1) return "─".slice(0, width);
  const [left, right] = position === "top" ? ["╭", "╮"]
    : position === "bottom" ? ["╰", "╯"]
    : ["├", "┤"];
  return `${left}${"─".repeat(Math.max(0, width - 2))}${right}`;
}
