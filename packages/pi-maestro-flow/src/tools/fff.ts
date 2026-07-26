import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import { singleLine } from "../tui/components.ts";
import { FileFinder, type FileFinderApi } from "@ff-labs/fff-node";
import { Type } from "typebox";

const SCAN_TIMEOUT_MS = 15_000;

const FffGrepParams = Type.Object({
  pattern: Type.String({ minLength: 1, description: "Literal text to search for" }),
  context: Type.Optional(Type.Integer({ minimum: 0, maximum: 20 })),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
});

const FffFindParams = Type.Object({
  pattern: Type.String({ minLength: 1, description: "Fuzzy file-path query" }),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
});

/**
 * Adds FFF's native index only to the root Pi session. The tools stay separate
 * from Pi's built-ins, so existing grep/find calls remain backward compatible.
 */
export function registerFff(pi: ExtensionAPI): void {
  let finder: FileFinderApi | undefined;
  let finderCwd: string | undefined;
  let initializing: Promise<FileFinderApi> | undefined;

  const ensureFinder = async (cwd: string): Promise<FileFinderApi> => {
    if (finder && !finder.isDestroyed && finderCwd === cwd) return finder;
    if (initializing) return initializing;
    initializing = (async () => {
      finder?.destroy();
      const created = FileFinder.create({ basePath: cwd, aiMode: true });
      if (!created.ok) throw new Error(`FFF initialization failed: ${created.error}`);
      finder = created.value;
      finderCwd = cwd;
      const scanned = await finder.waitForScan(SCAN_TIMEOUT_MS);
      if (!scanned.ok) {
        finder.destroy();
        finder = undefined;
        finderCwd = undefined;
        throw new Error(`FFF initial scan failed: ${scanned.error}`);
      }
      return finder;
    })().finally(() => { initializing = undefined; });
    return initializing;
  };

  pi.on("session_shutdown", () => {
    finder?.destroy();
    finder = undefined;
    finderCwd = undefined;
  });

  pi.registerTool({
    name: "ffgrep",
    label: "FFF Grep",
    description: "Fast FFF-backed literal content search in the current workspace.",
    promptSnippet: "Search workspace file contents with FFF.",
    parameters: FffGrepParams,
    async execute(_id, params, signal, _onUpdate, ctx): Promise<AgentToolResult<unknown>> {
      if (signal?.aborted) throw abortError();
      const activeFinder = await ensureFinder(ctx.cwd);
      if (signal?.aborted) throw abortError();
      const result = activeFinder.grep(params.pattern, {
        mode: "plain",
        smartCase: true,
        pageSize: params.limit ?? 20,
        beforeContext: params.context ?? 0,
        afterContext: params.context ?? 0,
        classifyDefinitions: true,
      });
      if (!result.ok) throw new Error(`FFF grep failed: ${result.error}`);
      return { content: [{ type: "text", text: formatGrep(result.value) }] } as AgentToolResult<unknown>;
    },
    renderCall(args, theme) {
      return singleLine(`${theme.fg("toolTitle", theme.bold("ffgrep "))}${theme.fg("accent", `"${String(args.pattern ?? "")}"`)}`);
    },
    renderResult(result, _opts, theme) {
      const text = result.content[0] && "text" in result.content[0] ? result.content[0].text : "";
      const lines = text.split("\n").filter(Boolean);
      if (lines.length === 0 || text === "No matches") return singleLine(theme.fg("dim", "No matches"));
      const header = lines[0].slice(0, 100);
      const extra = lines.length > 1 ? theme.fg("dim", ` · ${lines.length} lines`) : "";
      return singleLine(`${theme.fg("success", "✓")} ${theme.fg("muted", header)}${extra}`);
    },
  });

  pi.registerTool({
    name: "fffind",
    label: "FFF Find",
    description: "Fast FFF-backed fuzzy file-path search in the current workspace.",
    promptSnippet: "Find workspace files by fuzzy path with FFF.",
    parameters: FffFindParams,
    async execute(_id, params, signal, _onUpdate, ctx): Promise<AgentToolResult<unknown>> {
      if (signal?.aborted) throw abortError();
      const activeFinder = await ensureFinder(ctx.cwd);
      if (signal?.aborted) throw abortError();
      const result = activeFinder.fileSearch(params.pattern, { pageSize: params.limit ?? 30 });
      if (!result.ok) throw new Error(`FFF file search failed: ${result.error}`);
      const text = result.value.items.length
        ? result.value.items.map((item) => item.relativePath).join("\n")
        : "No files found";
      return { content: [{ type: "text", text }] } as AgentToolResult<unknown>;
    },
    renderCall(args, theme) {
      return singleLine(`${theme.fg("toolTitle", theme.bold("fffind "))}${theme.fg("accent", `"${String(args.pattern ?? "")}"`)}`);
    },
    renderResult(result, _opts, theme) {
      const text = result.content[0] && "text" in result.content[0] ? result.content[0].text : "";
      if (text === "No files found") return singleLine(theme.fg("dim", "No files found"));
      const lines = text.split("\n").filter(Boolean);
      const header = lines[0]?.slice(0, 100) ?? "";
      const extra = lines.length > 1 ? theme.fg("dim", ` · ${lines.length} files`) : "";
      return singleLine(`${theme.fg("success", "✓")} ${theme.fg("muted", header)}${extra}`);
    },
  });
}

function formatGrep(result: { items: Array<{ relativePath: string; lineNumber: number; lineContent: string }> }): string {
  return result.items.length
    ? result.items.map((item) => `${item.relativePath}:${item.lineNumber}: ${item.lineContent}`).join("\n")
    : "No matches found";
}

function abortError(): Error {
  const error = new Error("FFF search aborted.");
  error.name = "AbortError";
  return error;
}
