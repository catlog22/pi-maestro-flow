import type { AgentToolResult, ToolRenderResultOptions } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { compactJson, toolCallLine, toolResultLine, resultSummary } from "../quiet-render.ts";

type McpToolResultDetails = Record<string, unknown> & { error?: unknown };
type McpToolContentBlock = AgentToolResult<McpToolResultDetails>["content"][number];

interface RenderTheme {
  fg: (name: string, text: string) => string;
  bold?: (text: string) => string;
}

export interface McpProxyToolCallInput {
  tool?: string;
  args?: string;
  connect?: string;
  describe?: string;
  search?: string;
  regex?: boolean;
  includeSchemas?: boolean;
  server?: string;
  action?: string;
}

interface McpToolRenderContext {
  isError?: boolean;
  isPartial?: boolean;
  args?: unknown;
}

export interface McpToolResultDisplay {
  lines: string[];
  truncated: boolean;
}

const DEFAULT_MAX_CALL_INPUT_CHARS = 1500;

function truncateText(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value;
  return `${value.slice(0, Math.max(0, maxChars - 1))}…`;
}

function formatJsonish(value: unknown, maxChars: number): string {
  if (typeof value === "string") {
    try {
      return truncateText(JSON.stringify(JSON.parse(value), null, 2), maxChars);
    } catch {
      return truncateText(value, maxChars);
    }
  }

  try {
    return truncateText(JSON.stringify(value, null, 2), maxChars);
  } catch {
    return truncateText(String(value), maxChars);
  }
}

function hasUsefulObjectContent(value: unknown): boolean {
  return typeof value === "object" && value !== null && !Array.isArray(value) && Object.keys(value).length > 0;
}

export function formatMcpProxyToolCallLines(
  args: McpProxyToolCallInput,
  maxInputChars = DEFAULT_MAX_CALL_INPUT_CHARS,
): string[] {
  if (args.action === "ui-messages") return [`mcp ${args.action}`];

  if (args.tool) {
    const target = args.server ? `${args.tool} @ ${args.server}` : args.tool;
    const lines = [`mcp call ${target}`];
    if (args.args) lines.push(formatJsonish(args.args, maxInputChars));
    return lines;
  }

  if (args.connect) return [`mcp connect ${args.connect}`];
  if (args.describe) return [`mcp describe ${args.describe}`];

  if (args.search) {
    let line = `mcp search ${args.search}`;
    if (args.server) line += ` @ ${args.server}`;
    if (args.regex === true) line += " (regex)";
    if (args.includeSchemas === false) line += " (schemas hidden)";
    return [line];
  }

  if (args.server) return [`mcp list ${args.server}`];
  if (args.action) return [`mcp ${args.action}`];

  return ["mcp status"];
}

export function formatMcpDirectToolCallLines(
  displayName: string,
  args: Record<string, unknown>,
  maxInputChars = DEFAULT_MAX_CALL_INPUT_CHARS,
): string[] {
  if (!hasUsefulObjectContent(args)) return [displayName];
  return [displayName, formatJsonish(args, maxInputChars)];
}

export function renderMcpProxyToolCall(
  args: McpProxyToolCallInput,
  theme: RenderTheme,
  context?: McpToolRenderContext,
) {
  if (context?.isPartial === false) return new Text("", 0, 0);
  const [head = "status"] = formatMcpProxyToolCallLines(args);
  return toolCallLine(theme, "mcp", head.replace(/^mcp\s+/, ""));
}

export function createMcpDirectToolCallRenderer(displayName: string) {
  return (args: Record<string, unknown>, theme: RenderTheme, context?: McpToolRenderContext) => {
    if (context?.isPartial === false) return new Text("", 0, 0);
    return toolCallLine(theme, displayName, hasUsefulObjectContent(args) ? compactJson(args) : "");
  };
}

function blockToLines(block: McpToolContentBlock): string[] {
  if (block.type === "text") {
    return block.text.split("\n");
  }
  return [`[image: ${block.mimeType}]`];
}

export function formatMcpToolResultLines(
  result: Pick<AgentToolResult<McpToolResultDetails>, "content">,
  expanded: boolean,
  maxCollapsedLines = 3,
): McpToolResultDisplay {
  const allLines = result.content.flatMap(blockToLines);
  const lines = allLines.length > 0 ? allLines : ["(empty result)"];

  if (expanded || lines.length <= maxCollapsedLines) {
    return { lines, truncated: false };
  }

  return {
    lines: [...lines.slice(0, maxCollapsedLines), "…"],
    truncated: true,
  };
}

export function renderMcpToolResult(
  result: AgentToolResult<McpToolResultDetails>,
  options: ToolRenderResultOptions,
  theme: RenderTheme,
  context?: McpToolRenderContext,
) {
  if (options.isPartial) {
    return new Text(theme.fg("warning", "Running MCP tool..."), 0, 0);
  }

  const hasErrorDetails = Boolean(result.details.error);
  const display = formatMcpToolResultLines(result, options.expanded || context?.isError === true || hasErrorDetails);
  const output = display.lines
    .map((line) => line === "…" ? theme.fg("muted", line) : theme.fg("toolOutput", line))
    .join("\n");
  const hint = display.truncated && !options.expanded
    ? `\n${theme.fg("muted", "(Ctrl+O to expand)")}`
    : "";

  return new Text(`${output}${hint}`, 0, 0);
}

function mcpResultOk(result: AgentToolResult<McpToolResultDetails>, context?: McpToolRenderContext): boolean {
  return !result.details.error && context?.isError !== true;
}

export function createMcpDirectToolResultRenderer(displayName: string) {
  return (
    result: AgentToolResult<McpToolResultDetails>,
    options: ToolRenderResultOptions,
    theme: RenderTheme,
    context?: McpToolRenderContext,
  ) => {
    if (options.isPartial) return new Text("", 0, 0);
    const detail = formatMcpToolResultLines(result, true).lines.join("\n");
    const arg = hasUsefulObjectContent(context?.args) ? compactJson(context?.args) : "";
    return toolResultLine(theme, {
      name: displayName,
      ok: mcpResultOk(result, context),
      arg,
      summary: resultSummary(result),
      expanded: options.expanded,
      detail,
    });
  };
}

export function renderMcpProxyToolResult(
  result: AgentToolResult<McpToolResultDetails>,
  options: ToolRenderResultOptions,
  theme: RenderTheme,
  context?: McpToolRenderContext,
) {
  if (options.isPartial) return new Text("", 0, 0);
  const detail = formatMcpToolResultLines(result, true).lines.join("\n");
  const input = hasUsefulObjectContent(context?.args) ? context?.args as McpProxyToolCallInput : undefined;
  const arg = input ? (formatMcpProxyToolCallLines(input)[0] ?? "").replace(/^mcp\s+/, "") : "";
  return toolResultLine(theme, {
    name: "mcp",
    ok: mcpResultOk(result, context),
    arg,
    summary: resultSummary(result),
    expanded: options.expanded,
    detail,
  });
}
