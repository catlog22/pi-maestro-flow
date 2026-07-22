import { type Component, type Focusable, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import type { TeamSwarmMetric, TeamSwarmProjection } from "../swarm/projection.ts";

type SwarmView = "summary" | "topology" | "metrics" | "result";
const VIEWS: readonly SwarmView[] = ["summary", "topology", "metrics", "result"];

export interface SwarmOverlayParams {
  snapshot: TeamSwarmProjection;
  requestRender: () => void;
  close: () => void;
  onDispose?: () => void;
}

export class SwarmOverlay implements Component, Focusable {
  focused = false;
  private snapshot: TeamSwarmProjection;
  private view: SwarmView = "summary";
  private readonly offsets = new Map<SwarmView, number>();
  private disposed = false;

  constructor(private readonly params: SwarmOverlayParams) { this.snapshot = params.snapshot; }
  invalidate(): void {}
  dispose(): void { if (!this.disposed) { this.disposed = true; this.params.onDispose?.(); } }
  update(snapshot: TeamSwarmProjection): void { this.snapshot = snapshot; this.params.requestRender(); }

  handleInput(data: string): void {
    if (data === "\x1b" || data === "q") return this.params.close();
    const wheel = parseMouseWheelDelta(data);
    if (wheel !== undefined) return this.scroll(wheel);
    const direct = Number.parseInt(data, 10);
    if (direct >= 1 && direct <= VIEWS.length) return this.switchView(VIEWS[direct - 1]!);
    if (data === "\x1b[C" || data === "l" || data === "\t") return this.switchView(VIEWS[(VIEWS.indexOf(this.view) + 1) % VIEWS.length]!);
    if (data === "\x1b[D" || data === "h") return this.switchView(VIEWS[(VIEWS.indexOf(this.view) - 1 + VIEWS.length) % VIEWS.length]!);
    if (data === "\x1b[A" || data === "k") return this.scroll(-1);
    if (data === "\x1b[B" || data === "j") return this.scroll(1);
    if (data === "\x1b[5~") return this.scroll(-6);
    if (data === "\x1b[6~") return this.scroll(6);
  }

  render(width: number): string[] {
    const safeWidth = Math.max(1, Math.min(width, 120));
    if (safeWidth < 24) return [fit(renderSwarmStatusLine(this.snapshot, safeWidth), safeWidth)];
    const terminalRows = Math.max(8, process.stdout.rows || 30);
    const height = Math.max(7, Math.min(26, terminalRows - 4));
    const inner = safeWidth - 2;
    const contentHeight = Math.max(1, height - 7);
    const content = this.renderView(inner);
    const maxOffset = Math.max(0, content.length - contentHeight);
    const offset = Math.max(0, Math.min(this.offsets.get(this.view) ?? 0, maxOffset));
    const visible = content.slice(offset, offset + contentHeight);
    while (visible.length < contentHeight) visible.push("");
    return [
      border("top", safeWidth),
      boxLine(`TEAM SWARM · JSON PROJECTION · ${this.snapshot.status.toUpperCase()}`, inner),
      boxLine(fit(this.snapshot.objective, inner), inner),
      border("middle", safeWidth),
      boxLine(VIEWS.map((view, index) => view === this.view ? `[${index + 1} ${view}]` : `${index + 1} ${view}`).join("  "), inner),
      ...visible.map((line) => boxLine(line, inner)),
      boxLine(`Esc close  ←/→ views  ↑/↓ scroll  ${offset + 1}/${maxOffset + 1}`, inner),
      border("bottom", safeWidth),
    ];
  }

  private renderView(width: number): string[] {
    if (this.view === "topology") return renderTopology(this.snapshot, width);
    if (this.view === "metrics") return renderMetrics(this.snapshot.metrics, width);
    if (this.view === "result") return renderResult(this.snapshot, width);
    return renderSummary(this.snapshot, width);
  }
  private switchView(view: SwarmView): void { this.view = view; this.params.requestRender(); }
  private scroll(delta: number): void { this.offsets.set(this.view, Math.max(0, (this.offsets.get(this.view) ?? 0) + delta)); this.params.requestRender(); }
}

export function parseMouseWheelDelta(data: string): number | undefined {
  const match = /^\x1b\[<(\d+);\d+;\d+[Mm]$/.exec(data);
  if (!match) return undefined;
  const button = Number.parseInt(match[1]!, 10);
  if ((button & 64) === 0) return undefined;
  return (button & 1) === 0 ? -3 : 3;
}

export function renderSwarmStatusLine(snapshot: TeamSwarmProjection, width: number): string {
  const metric = snapshot.metrics[snapshot.metrics.length - 1];
  return fit([
    `TEAM SWARM ${snapshot.iteration}/${snapshot.maxIterations || "?"}`,
    snapshot.status.toUpperCase(),
    snapshot.activeWorkers.length ? `${snapshot.activeWorkers.length} active` : undefined,
    metric?.bestScore !== undefined ? `BEST ${percent(metric.bestScore)}` : undefined,
  ].filter(Boolean).join(" · "), width);
}

function renderSummary(snapshot: TeamSwarmProjection, width: number): string[] {
  return [
    fit(`Session     ${snapshot.sessionId}`, width),
    fit(`Iteration   ${snapshot.iteration}/${snapshot.maxIterations || "?"} · ${snapshot.antsPerIteration || "?"} ants/iteration`, width),
    fit(`Completed   ${snapshot.completedIterations.join(", ") || "none"}`, width),
    fit(`Workers     ${snapshot.activeWorkers.join(", ") || "none recorded"}`, width),
    "",
    fit("Read-only source files", width),
    ...wrap(`  ${snapshot.teamDir}`, width),
    fit(`Updated     ${snapshot.updatedAt}`, width),
    "",
    fit("Execution remains owned by /skill:team-swarm and scripts/aco.py.", width),
  ];
}

function renderTopology(snapshot: TeamSwarmProjection, width: number): string[] {
  const rows = [fit(`Nodes ${snapshot.nodes.length} · pheromone edges ${snapshot.edges.length}`, width), ""];
  if (snapshot.best?.path.length) rows.push(fit(`Best path  ${snapshot.best.path.join(" → ")}`, width), "");
  rows.push(fit("Pheromone leaders", width));
  const max = Math.max(1, ...snapshot.edges.map((edge) => edge.pheromone));
  for (const edge of [...snapshot.edges].sort((a, b) => b.pheromone - a.pheromone).slice(0, 10)) {
    rows.push(fit(`${edge.source} → ${edge.target}  ${bar(edge.pheromone / max, 10)}  τ=${edge.pheromone.toFixed(3)}`, width));
  }
  if (!snapshot.edges.length) rows.push(fit("○ pheromone/current.json has no projected edges yet", width));
  return rows;
}

function renderMetrics(metrics: TeamSwarmMetric[], width: number): string[] {
  if (!metrics.length) return [fit("○ trails and pheromone history are not available yet", width)];
  const rows = [fit("iter   best   mean   entropy   tau-max   tau-mean", width)];
  for (const item of metrics) rows.push(fit([
    String(item.iteration).padStart(4),
    optionalPercent(item.bestScore).padStart(6),
    optionalPercent(item.meanScore).padStart(6),
    optionalFixed(item.entropy).padStart(9),
    optionalFixed(item.tauMax).padStart(9),
    optionalFixed(item.tauMean).padStart(10),
  ].join(" "), width));
  return rows;
}

function renderResult(snapshot: TeamSwarmProjection, width: number): string[] {
  if (!snapshot.best) return [fit("○ best.json has not been produced", width), fit(`Outputs ${snapshot.outputsDir}`, width)];
  return [
    fit(`Best ${snapshot.best.antId} · iteration ${snapshot.best.iteration} · ${percent(snapshot.best.score)}`, width),
    ...wrap(`Path: ${snapshot.best.path.join(" → ") || "not recorded"}`, width),
    ...wrap(`Candidate: ${snapshot.best.summary ?? "summary not recorded"}`, width),
    "",
    fit("Evidence", width),
    ...snapshot.best.evidence.slice(0, 10).flatMap((item) => wrap(`  • ${item}`, width)),
    "",
    fit(`Report ${snapshot.reportPath ?? "not produced"}`, width),
    fit(`Synthesis ${snapshot.bestSolutionPath ?? "not produced"}`, width),
  ];
}

function wrap(text: string, width: number): string[] { return wrapTextWithAnsi(text, Math.max(8, width)).map((line) => fit(line, width)); }
function optionalPercent(value: number | undefined): string { return value === undefined ? "—" : percent(value); }
function optionalFixed(value: number | undefined): string { return value === undefined ? "—" : value.toFixed(3); }
function percent(value: number): string { return `${Math.round(value * 100)}%`; }
function bar(value: number, length: number): string { const count = Math.max(0, Math.min(length, Math.round(value * length))); return `${"█".repeat(count)}${"░".repeat(length - count)}`; }
function fit(text: string, width: number): string { return truncateToWidth(text, Math.max(1, width), "…"); }
function boxLine(content: string, inner: number): string { const clipped = fit(` ${content}`, inner); return `│${clipped}${" ".repeat(Math.max(0, inner - visibleWidth(clipped)))}│`; }
function border(position: "top" | "middle" | "bottom", width: number): string { const [left, right] = position === "top" ? ["╭", "╮"] : position === "bottom" ? ["╰", "╯"] : ["├", "┤"]; return width <= 1 ? "─".slice(0, width) : `${left}${"─".repeat(width - 2)}${right}`; }
