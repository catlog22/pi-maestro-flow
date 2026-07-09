/**
 * TUI rendering for the teammate tool.
 *
 * renderCall: compact tree with dependency topology for chain/graph
 * renderResult: real-time streaming for foreground, compact status for completed
 */

import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  Text, Box, type BoxBorder, type Component,
  truncateToWidth,
} from "@earendil-works/pi-tui";
import type { Details, SingleResult } from "../shared/types.ts";
import { extractDependencies } from "../runs/execution.ts";

type Theme = ExtensionContext["ui"]["theme"];

function resultBorder(exitCode: number, theme: Theme): BoxBorder {
  return {
    chars: { topLeft: "╭", topRight: "╮", bottomLeft: "╰", bottomRight: "╯", horizontal: "─", vertical: "│" },
    color: exitCode === 0 ? (s: string) => theme.fg("dim", s) : (s: string) => theme.fg("error", s),
  };
}

function statusMeta(parts: string[], theme: Theme): string {
  const filtered = parts.filter(Boolean);
  return filtered.length > 0 ? theme.fg("dim", filtered.join(" · ")) : "";
}

function dynamicComponent(build: (width: number) => string[]): Component {
  return { render: (w: number) => build(w), invalidate() {} };
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;
  return `${minutes}m${remainingSeconds}s`;
}

function formatTokens(count: number): string {
  if (count < 1000) return `${count}`;
  if (count < 1_000_000) return `${(count / 1000).toFixed(1)}k`;
  return `${(count / 1_000_000).toFixed(2)}M`;
}

// ---------------------------------------------------------------------------
// renderCall — how the tool invocation appears in conversation
// ---------------------------------------------------------------------------

interface TaskArg {
  agent: string;
  name?: string;
  task?: string;
}

export function renderTeammateCall(
  args: Record<string, unknown>,
  theme: Theme,
): Component {
  const tasks = args.tasks as TaskArg[] | undefined;
  const isBg = args.background !== false;

  // Multi-task: tree with dependency topology
  if (tasks?.length) {
    return renderMultiTaskCall(tasks, isBg, args, theme);
  }

  // Single agent
  const agent = args.agent as string ?? "?";
  const name = args.name as string | undefined;
  const nameLabel = name ? `${theme.fg("accent", `@${name}`)} ` : "";
  const agentLabel = name
    ? theme.fg("dim", `(${agent})`)
    : theme.fg("accent", agent);
  const modeHint = isBg
    ? theme.fg("dim", " [bg]")
    : theme.fg("dim", " (Alt+B to detach)");

  return new Text(
    `${theme.fg("success", "■")} ${nameLabel}${agentLabel}${modeHint}`,
    0,
    0,
  );
}

function renderMultiTaskCall(
  tasks: TaskArg[],
  isBg: boolean,
  args: Record<string, unknown>,
  theme: Theme,
): Component {
  const taskNames = new Set(tasks.filter((t) => t.name).map((t) => t.name!));
  const hasDeps = tasks.some((t) => extractDependencies(t.task, taskNames).length > 0);

  const modeWord = isBg ? "background" : "foreground";
  const hint = isBg
    ? theme.fg("dim", " (Alt+R to manage)")
    : theme.fg("dim", " (Alt+B to detach)");

  // Detect topology type
  let topoLabel = "";
  if (hasDeps) {
    const allLinear = isLinearChain(tasks, taskNames);
    topoLabel = allLinear ? " chain" : " graph";
  }

  const header = `${theme.fg("success", "■")} ${theme.bold(`${tasks.length}${topoLabel} ${modeWord} agents launched`)}${hint}`;
  const lines = [header];

  if (hasDeps) {
    // Show dependency topology
    renderTopologyTree(tasks, taskNames, lines, theme);
  } else {
    // Parallel — flat list
    for (let i = 0; i < tasks.length; i++) {
      const t = tasks[i];
      const connector = i === tasks.length - 1 ? "└" : "├";
      const label = t.name ? `@${t.name}` : `#${i}`;
      lines.push(`  ${theme.fg("dim", connector)} ${theme.fg("accent", label)} ${theme.fg("dim", `(${t.agent})`)}`);
    }
  }

  return new Text(lines.join("\n"), 0, 0);
}

function isLinearChain(tasks: TaskArg[], taskNames: Set<string>): boolean {
  for (let i = 0; i < tasks.length; i++) {
    const deps = extractDependencies(tasks[i].task, taskNames);
    if (deps.length > 1) return false;
    if (deps.length === 1 && i > 0 && deps[0] !== tasks[i - 1].name) return false;
  }
  return true;
}

function renderTopologyTree(
  tasks: TaskArg[],
  taskNames: Set<string>,
  lines: string[],
  theme: Theme,
): void {
  // Build dep map: taskIndex -> depIndices
  const indexByName = new Map<string, number>();
  for (let i = 0; i < tasks.length; i++) {
    if (tasks[i].name) indexByName.set(tasks[i].name!, i);
  }

  const depMap = tasks.map((t) =>
    extractDependencies(t.task, taskNames).map((n) => indexByName.get(n)!),
  );

  // Find roots (no dependents pointing to them... actually, roots = no deps)
  const roots = tasks.map((_, i) => i).filter((i) => depMap[i].length === 0);
  const childrenOf = new Map<number, number[]>();

  // For chain/graph, build parent→children from deps
  for (let i = 0; i < tasks.length; i++) {
    for (const dep of depMap[i]) {
      const children = childrenOf.get(dep) ?? [];
      children.push(i);
      childrenOf.set(dep, children);
    }
  }

  // Render tree via DFS
  const rendered = new Set<number>();

  function renderNode(idx: number, prefix: string, isLast: boolean): void {
    if (rendered.has(idx)) return;
    rendered.add(idx);

    const t = tasks[idx];
    const connector = isLast ? "└" : "├";
    const label = t.name ? `@${t.name}` : `#${idx}`;
    const deps = depMap[idx];
    const depHint = deps.length > 0
      ? theme.fg("dim", ` ← ${deps.map((d) => tasks[d].name ?? `#${d}`).join(", ")}`)
      : "";
    lines.push(`${prefix}${theme.fg("dim", connector)} ${theme.fg("accent", label)} ${theme.fg("dim", `(${t.agent})`)}${depHint}`);

    const children = childrenOf.get(idx) ?? [];
    const childPrefix = prefix + (isLast ? "  " : "│ ");
    for (let ci = 0; ci < children.length; ci++) {
      renderNode(children[ci], childPrefix, ci === children.length - 1);
    }
  }

  // Start from roots
  for (let ri = 0; ri < roots.length; ri++) {
    renderNode(roots[ri], "  ", ri === roots.length - 1);
  }

  // Render any remaining (shouldn't happen with DAG, but safety)
  for (let i = 0; i < tasks.length; i++) {
    if (!rendered.has(i)) {
      renderNode(i, "  ", true);
    }
  }
}

// ---------------------------------------------------------------------------
// renderResult — how the tool result appears in conversation
// ---------------------------------------------------------------------------

export function renderTeammateResult(
  result: AgentToolResult<Details>,
  options: { expanded: boolean },
  theme: Theme,
): Component {
  const details = result.details;

  // No results yet — streaming progress or background ack
  if (!details || details.results.length === 0) {
    return renderProgress(result, details, theme);
  }

  // Single result
  if (details.results.length === 1) {
    return renderSingleResult(details.results[0], options, theme);
  }

  // Multi-result
  return renderMultiResult(details, options, theme);
}

// ---------------------------------------------------------------------------
// Streaming progress (foreground real-time display)
// ---------------------------------------------------------------------------

interface ProgressEntry {
  agent: string;
  status: string;
  startedAt?: string;
  toolCount?: number;
  tokens?: number;
  lastMessage?: string;
  recentTools?: Array<{ name: string; status: string }>;
}

function renderProgress(
  result: AgentToolResult<Details>,
  details: Details | undefined,
  theme: Theme,
): Component {
  const progress = details?.progress;

  if (!progress?.length) {
    const content = typeof result.content === "string"
      ? result.content
      : result.content
        .filter((c: { type: string }) => c.type === "text")
        .map((c: { type: string; text: string }) => c.text)
        .join("\n");
    return dynamicComponent((w) => {
      const preview = truncateToWidth(content.split("\n")[0] ?? "", w - 4, "…");
      const icon = result.isError ? theme.fg("error", "✗") : theme.fg("dim", "↑");
      return [`${icon} ${theme.fg("dim", preview)}`];
    });
  }

  return dynamicComponent((w) => {
    const cw = Math.max(20, w - 6);
    const lines: string[] = [];

    for (const p of progress as ProgressEntry[]) {
      const isRunning = p.status === "running";
      const icon = isRunning ? theme.fg("warning", "■") : theme.fg("success", "✓");
      const dur = p.startedAt ? formatDuration(Date.now() - new Date(p.startedAt).getTime()) : "";
      const meta = statusMeta([dur, p.toolCount ? `${p.toolCount} tools` : "", p.tokens ? formatTokens(p.tokens) : ""], theme);
      lines.push(`${icon} ${theme.bold(p.agent)}  ${meta}`);

      if (isRunning) {
        const activeTools = p.recentTools?.filter((t) => t.status === "running") ?? [];
        const doneTools = p.recentTools?.filter((t) => t.status !== "running") ?? [];
        for (const t of doneTools.slice(-3)) lines.push(`  ${theme.fg("dim", `└ ${t.name}`)}`);
        for (const t of activeTools) lines.push(`  ${theme.fg("warning", `■ ${t.name}`)}`);

        if (p.lastMessage) {
          const tail = p.lastMessage.split("\n").filter((l: string) => l.trim()).slice(-4);
          for (const line of tail) lines.push(`  ${theme.fg("dim", `│ `)}${theme.fg("dim", truncateToWidth(line, cw, "…"))}`);
        }
      }
    }
    return lines;
  });
}

// ---------------------------------------------------------------------------
// Completed results
// ---------------------------------------------------------------------------

function renderSingleResult(
  r: SingleResult,
  options: { expanded: boolean },
  theme: Theme,
): Component {
  const icon = r.exitCode === 0 ? theme.fg("success", "✓") : theme.fg("error", "✗");
  const totalTokens = r.usage.inputTokens + r.usage.outputTokens;
  const meta = statusMeta([
    formatDuration(r.durationMs),
    totalTokens > 0 ? `${formatTokens(totalTokens)} tokens` : "",
    r.usage.cost > 0 ? `$${r.usage.cost.toFixed(4)}` : "",
  ], theme);
  const header = `${icon} ${theme.bold(r.agent)}  ${meta}`;

  if (!options.expanded) {
    return new Text(header, 0, 0);
  }

  const proxy = { lines: [] as string[], invalidate() {}, render() { return this.lines; } };
  const border = resultBorder(r.exitCode, theme);
  const box = new Box(1, 0, undefined, border);
  box.addChild(proxy);

  return dynamicComponent((w) => {
    const cw = Math.max(20, w - 6);
    const lines: string[] = [header];

    const usageParts: string[] = [];
    if (r.usage.inputTokens > 0) usageParts.push(`${formatTokens(r.usage.inputTokens)}in`);
    if (r.usage.outputTokens > 0) usageParts.push(`${formatTokens(r.usage.outputTokens)}out`);
    if (r.usage.turns > 0) usageParts.push(`${r.usage.turns} turns`);
    if (usageParts.length > 0) lines.push(theme.fg("dim", usageParts.join(" · ")));

    const lastMsg = r.messages[r.messages.length - 1]?.content;
    if (lastMsg) {
      const contentLines = lastMsg.split("\n");
      const maxLines = 20;
      for (const line of contentLines.slice(0, maxLines))
        lines.push(theme.fg("dim", `│ ${truncateToWidth(line, cw, "…")}`));
      if (contentLines.length > maxLines)
        lines.push(theme.fg("dim", `… ${contentLines.length - maxLines} more lines`));
    }

    proxy.lines = lines;
    return [...box.render(w)];
  });
}

function renderMultiResult(
  details: Details,
  options: { expanded: boolean },
  theme: Theme,
): Component {
  const results = details.results;
  const okCount = results.filter((r) => r.exitCode === 0).length;
  const total = results.length;
  const allOk = okCount === total;
  const icon = allOk ? theme.fg("success", "✓") : theme.fg("warning", "!");
  const meta = statusMeta([details.mode, formatDuration(Math.max(...results.map((r) => r.durationMs), 0))], theme);
  const header = `${icon} ${theme.bold(`${okCount}/${total} completed`)}  ${meta}`;

  if (!options.expanded) {
    const lines = [header];
    for (let i = 0; i < results.length; i++) {
      const r = results[i];
      const connector = i === results.length - 1 ? "└" : "├";
      const rIcon = r.exitCode === 0 ? theme.fg("success", "✓") : theme.fg("error", "✗");
      lines.push(`  ${theme.fg("dim", connector)} ${rIcon} ${r.agent} ${theme.fg("dim", formatDuration(r.durationMs))}`);
    }
    return new Text(lines.join("\n"), 0, 0);
  }

  const hasError = results.some((r) => r.exitCode !== 0);
  const proxy = { lines: [] as string[], invalidate() {}, render() { return this.lines; } };
  const border = resultBorder(hasError ? 1 : 0, theme);
  const box = new Box(1, 0, undefined, border);
  box.addChild(proxy);

  return dynamicComponent((w) => {
    const cw = Math.max(20, w - 8);
    const lines = [header];

    for (let i = 0; i < results.length; i++) {
      const r = results[i];
      const connector = i === results.length - 1 ? "└" : "├";
      const rIcon = r.exitCode === 0 ? theme.fg("success", "✓") : theme.fg("error", "✗");
      const rMeta = statusMeta([formatDuration(r.durationMs), formatTokens(r.usage.inputTokens + r.usage.outputTokens)], theme);
      lines.push(`${theme.fg("dim", connector)} ${rIcon} ${r.agent}  ${rMeta}`);

      if (r.messages.length > 0) {
        const lastMsg = r.messages[r.messages.length - 1]?.content ?? "";
        const preview = truncateToWidth(lastMsg.split("\n")[0] ?? "", cw, "…");
        if (preview) {
          const pad = i === results.length - 1 ? " " : "│";
          lines.push(`${theme.fg("dim", pad)}  ${theme.fg("dim", preview)}`);
        }
      }
    }

    proxy.lines = lines;
    return [...box.render(w)];
  });
}
