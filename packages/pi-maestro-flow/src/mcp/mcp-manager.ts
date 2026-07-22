import {
  Key,
  type Component,
  type Focusable,
  matchesKey,
  truncateToWidth,
  visibleWidth,
} from "@earendil-works/pi-tui";
import type { McpManagedServer } from "./mcp-manager-store.ts";

export type McpManagerStatus = "connected" | "idle" | "needs-auth" | "failed";
export type McpManagerActionKind = "close" | "add" | "edit" | "delete" | "reconnect" | "authenticate";
export type McpManagerScope = "all" | "user" | "project" | "import";

export interface McpManagerServerView extends McpManagedServer {
  status: McpManagerStatus;
  toolNames: string[];
  canAuthenticate: boolean;
}

export interface McpManagerUiState {
  query: string;
  scope: McpManagerScope;
  selectedName?: string;
  detail: boolean;
}

export interface McpManagerAction {
  kind: McpManagerActionKind;
  serverName?: string;
  uiState: McpManagerUiState;
}

interface McpManagerTheme {
  fg(role: string, text: string): string;
  bold(text: string): string;
}

export interface McpManagerParams {
  servers: readonly McpManagerServerView[];
  theme: McpManagerTheme;
  notice?: string;
  initialState?: Partial<McpManagerUiState>;
  requestRender: () => void;
  done: (action: McpManagerAction) => void;
}

const SCOPES: readonly McpManagerScope[] = ["all", "user", "project", "import"];
const MAX_VISIBLE = 10;

export class McpManagerOverlay implements Component, Focusable {
  focused = false;
  private query: string;
  private scope: McpManagerScope;
  private selected = 0;
  private detail: boolean;
  private lastWidth = 80;

  constructor(private readonly params: McpManagerParams) {
    this.query = params.initialState?.query ?? "";
    this.scope = params.initialState?.scope ?? "all";
    this.detail = params.initialState?.detail ?? false;
    const selectedName = params.initialState?.selectedName;
    if (selectedName) {
      const index = this.filteredServers().findIndex((server) => server.name === selectedName);
      if (index >= 0) this.selected = index;
    }
  }

  invalidate(): void {}
  dispose(): void {}

  render(width: number): string[] {
    const safeWidth = Math.max(1, Math.min(width, 140));
    this.lastWidth = safeWidth;
    this.clampSelection();
    if (safeWidth < 20) return [this.renderCompact(safeWidth)];
    if (safeWidth >= 72) return this.renderWide(safeWidth);
    return this.detail ? this.renderDetail(safeWidth) : this.renderList(safeWidth);
  }

  handleInput(data: string): void {
    if (matchesKey(data, Key.escape)) {
      if (this.detail && this.lastWidth < 72) {
        this.detail = false;
        this.params.requestRender();
        return;
      }
      if (this.query) {
        this.query = "";
        this.selected = 0;
        this.params.requestRender();
        return;
      }
      this.finish("close");
      return;
    }
    if (this.lastWidth < 20) return;
    if (matchesKey(data, Key.left)) {
      this.moveScope(-1);
      return;
    }
    if (matchesKey(data, Key.right) || data === "\t") {
      this.moveScope(1);
      return;
    }
    if (matchesKey(data, Key.up)) {
      this.moveSelection(-1);
      return;
    }
    if (matchesKey(data, Key.down)) {
      this.moveSelection(1);
      return;
    }
    if (matchesKey(data, Key.pageUp)) {
      this.moveSelection(-MAX_VISIBLE);
      return;
    }
    if (matchesKey(data, Key.pageDown)) {
      this.moveSelection(MAX_VISIBLE);
      return;
    }
    if (matchesKey(data, Key.enter)) {
      if (this.selectedServer() && this.lastWidth < 72) this.detail = true;
      this.params.requestRender();
      return;
    }
    if (data === "A") return this.finish("add");
    if (data === "E") return this.finish("edit");
    if (data === "D") return this.finish("delete");
    if (data === "R") return this.finish("reconnect");
    if (data === "O") return this.finish("authenticate");
    if (this.detail) return;
    if (matchesKey(data, Key.backspace) || data === "\b") {
      this.query = removeLastGrapheme(this.query);
      this.selected = 0;
      this.params.requestRender();
      return;
    }
    const printable = sanitizeSingleLineInput(data);
    if (!printable) return;
    this.query += printable;
    this.selected = 0;
    this.params.requestRender();
  }

  private renderCompact(width: number): string {
    const server = this.selectedServer() ?? this.filteredServers()[0];
    const value = server
      ? `Esc · MCP · ${statusText(server.status)} · ${server.name}`
      : "Esc · MCP · no matching servers";
    return truncateToWidth(value, width, "…");
  }

  private renderList(width: number): string[] {
    const inner = width - 2;
    const servers = this.filteredServers();
    const rows = [this.header(inner), rule(inner)];
    rows.push(...this.listRows(servers, inner));
    rows.push(this.filterLine(inner, servers.length));
    if (this.params.notice) rows.push(this.styledNotice(this.params.notice, inner));
    rows.push(fitSegments(inner, ["Esc close", "Enter inspect", "←→ scope", "A add", "E edit", "R reconnect"]));
    return frame(rows, width, this.params.theme);
  }

  private renderWide(width: number): string[] {
    const inner = width - 2;
    const leftWidth = Math.max(31, Math.floor((inner - 3) * 0.43));
    const rightWidth = inner - leftWidth - 3;
    const servers = this.filteredServers();
    const left = this.listRows(servers, leftWidth);
    const right = this.detailLines(this.selectedServer(), rightWidth);
    const rowCount = Math.max(left.length, right.length, 1);
    const rows = [this.header(inner), rule(inner)];
    for (let index = 0; index < rowCount; index++) {
      rows.push(`${pad(left[index] ?? "", leftWidth)} ${this.params.theme.fg("dim", "│")} ${pad(right[index] ?? "", rightWidth)}`);
    }
    rows.push(this.filterLine(inner, servers.length));
    if (this.params.notice) rows.push(this.styledNotice(this.params.notice, inner));
    rows.push(fitSegments(inner, ["Esc close", "↑↓ server", "←→ scope", "A add", "E edit", "R reconnect", "O auth", "D delete"]));
    return frame(rows, width, this.params.theme);
  }

  private renderDetail(width: number): string[] {
    const inner = width - 2;
    const rows = [this.header(inner), rule(inner), ...this.detailLines(this.selectedServer(), inner)];
    if (this.params.notice) rows.push(this.styledNotice(this.params.notice, inner));
    rows.push(fitSegments(inner, ["Esc back", "↑↓ server", "E edit", "R reconnect", "O auth", "D delete"]));
    return frame(rows, width, this.params.theme);
  }

  private header(width: number): string {
    const scopes = SCOPES.map((scope) => scope === this.scope ? `[${scopeLabel(scope)}]` : scopeLabel(scope)).join(" ");
    return fitLine(`${this.params.theme.bold("MCP Control Center")} · ${this.params.servers.length} servers · ${scopes}`, width);
  }

  private listRows(servers: readonly McpManagerServerView[], width: number): string[] {
    if (servers.length === 0) {
      return [this.params.theme.fg("warning", fitLine("○ No matching servers · press A to add one", width))];
    }
    const start = visibleStart(this.selected, servers.length, MAX_VISIBLE);
    return servers.slice(start, start + MAX_VISIBLE).map((server, offset) => {
      const selected = start + offset === this.selected;
      const transport = server.entry.url ? "HTTP" : "stdio";
      const scope = scopeLabel(server.scope);
      const tools = `${server.toolNames.length} tool${server.toolNames.length === 1 ? "" : "s"}`;
      const prefix = selected ? this.params.theme.fg("accent", "›") : " ";
      const name = selected ? this.params.theme.bold(this.params.theme.fg("accent", server.name)) : server.name;
      return fitLine(`${prefix} ${this.styledStatus(server.status)} ${name} · ${transport} · ${scope} · ${tools}`, width);
    });
  }

  private detailLines(server: McpManagerServerView | undefined, width: number): string[] {
    if (!server) return [this.params.theme.fg("warning", fitLine("No server selected", width))];
    const entry = server.entry;
    const lines = [
      fitLine(`${this.params.theme.bold(this.params.theme.fg("accent", server.name))}  ${this.styledStatus(server.status)}`, width),
      fitLine(`Transport  ${entry.url ? "HTTP" : "stdio"}`, width),
      fitLine(`Scope      ${scopeLabel(server.scope)}${server.readOnly ? " · read-only" : ""}`, width),
      fitLine(`Lifecycle  ${entry.lifecycle ?? "lazy"}`, width),
    ];
    if (entry.url) {
      lines.push(fitLine(`URL        ${entry.url}`, width));
      lines.push(fitLine(`Auth       ${authLabel(entry)}`, width));
      if (entry.headers) lines.push(fitLine(`Headers    ${displayRecord(entry.headers)}`, width));
    } else {
      lines.push(fitLine(`Command    ${entry.command ?? "not configured"}`, width));
      if (entry.args?.length) lines.push(fitLine(`Args       ${entry.args.join(" ")}`, width));
      if (entry.cwd) lines.push(fitLine(`Cwd        ${entry.cwd}`, width));
      if (entry.env) lines.push(fitLine(`Env        ${displayRecord(entry.env)}`, width));
    }
    lines.push(fitLine(`Direct     ${directToolsLabel(entry.directTools)}`, width));
    lines.push(fitLine(`Resources  ${entry.exposeResources ? "exposed" : "hidden"}`, width));
    lines.push(fitLine(`Timeout    ${entry.requestTimeoutMs ? `${entry.requestTimeoutMs} ms` : "default"}`, width));
    if (server.toolNames.length) {
      lines.push(this.params.theme.fg("dim", fitLine(`Tools      ${server.toolNames.slice(0, 4).join(", ")}${server.toolNames.length > 4 ? ` +${server.toolNames.length - 4}` : ""}`, width)));
    }
    lines.push(this.params.theme.fg("dim", fitLine(`Config     ${server.path}`, width)));
    return lines;
  }

  private filterLine(width: number, count: number): string {
    return this.params.theme.fg("dim", fitLine(`Filter: ${this.query || "type a server name"} · ${count} shown`, width));
  }

  private styledNotice(notice: string, width: number): string {
    const role = /(failed|error)/i.test(notice) ? "error"
      : notice.startsWith("Saved") || notice.startsWith("Deleted") ? "success"
      : notice.startsWith("Cannot") ? "warning" : "dim";
    return this.params.theme.fg(role, fitLine(notice, width));
  }

  private styledStatus(status: McpManagerStatus): string {
    const label = `${statusGlyph(status)} ${statusText(status)}`;
    if (status === "connected") return this.params.theme.fg("success", label);
    if (status === "needs-auth") return this.params.theme.fg("warning", label);
    if (status === "failed") return this.params.theme.fg("error", label);
    return this.params.theme.fg("dim", label);
  }

  private moveScope(delta: number): void {
    const index = SCOPES.indexOf(this.scope);
    this.scope = SCOPES[wrapIndex(index + delta, SCOPES.length)] ?? "all";
    this.selected = 0;
    this.detail = false;
    this.params.requestRender();
  }

  private moveSelection(delta: number): void {
    this.selected = wrapIndex(this.selected + delta, this.filteredServers().length);
    this.params.requestRender();
  }

  private clampSelection(): void {
    this.selected = clampIndex(this.selected, this.filteredServers().length);
  }

  private filteredServers(): McpManagerServerView[] {
    const terms = this.query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
    return this.params.servers.filter((server) => {
      if (this.scope !== "all" && server.scope !== this.scope) return false;
      if (terms.length === 0) return true;
      const haystack = [
        server.name,
        server.scope,
        server.entry.url ? "http" : "stdio",
        server.entry.command ?? "",
        server.entry.url ?? "",
        ...server.toolNames,
      ].join(" ").toLocaleLowerCase();
      return terms.every((term) => haystack.includes(term));
    });
  }

  private selectedServer(): McpManagerServerView | undefined {
    return this.filteredServers()[this.selected];
  }

  private finish(kind: McpManagerActionKind): void {
    const selected = this.selectedServer();
    this.params.done({
      kind,
      ...(selected ? { serverName: selected.name } : {}),
      uiState: {
        query: this.query,
        scope: this.scope,
        ...(selected ? { selectedName: selected.name } : {}),
        detail: this.detail,
      },
    });
  }
}

export function statusGlyph(status: McpManagerStatus): string {
  if (status === "connected") return "●";
  if (status === "needs-auth") return "!";
  if (status === "failed") return "×";
  return "○";
}

function statusText(status: McpManagerStatus): string {
  if (status === "connected") return "Connected";
  if (status === "needs-auth") return "Needs auth";
  if (status === "failed") return "Failed";
  return "Idle";
}

function scopeLabel(scope: McpManagerScope | McpManagedServer["scope"]): string {
  if (scope === "all") return "All";
  if (scope === "user") return "User";
  if (scope === "project") return "Project";
  return "Imported";
}

function authLabel(entry: McpManagedServer["entry"]): string {
  if (entry.auth === false) return "disabled";
  if (entry.auth === "bearer") return entry.bearerTokenEnv ? `bearer · env:${entry.bearerTokenEnv}` : "bearer";
  if (entry.auth === "oauth") return "OAuth";
  return entry.headers ? "headers" : "auto";
}

function directToolsLabel(value: McpManagedServer["entry"]["directTools"]): string {
  if (value === true) return "all tools";
  if (Array.isArray(value)) return value.length ? `${value.length} selected` : "none";
  return "proxy only";
}

function displayRecord(value: Record<string, string>): string {
  const entries = Object.entries(value);
  return entries.slice(0, 3).map(([key, raw]) => `${key}=${isSecretKey(key) ? "********" : raw}`).join(" · ")
    + (entries.length > 3 ? ` · +${entries.length - 3}` : "");
}

function isSecretKey(value: string): boolean {
  return /(token|secret|password|api.?key|authorization|cookie)/i.test(value);
}

const graphemeSegmenter = typeof Intl.Segmenter === "function"
  ? new Intl.Segmenter(undefined, { granularity: "grapheme" })
  : undefined;

function removeLastGrapheme(value: string): string {
  const parts = graphemeSegmenter
    ? [...graphemeSegmenter.segment(value)].map((entry) => entry.segment)
    : Array.from(value);
  parts.pop();
  return parts.join("");
}

function sanitizeSingleLineInput(value: string): string {
  return value.normalize("NFC").replace(/\r\n?|\n|\t/g, " ").replace(/[\x00-\x1f\x7f-\x9f]/g, "");
}

function visibleStart(selected: number, length: number, size: number): number {
  return Math.max(0, Math.min(selected - Math.floor(size / 2), Math.max(0, length - size)));
}

function wrapIndex(index: number, length: number): number {
  return length === 0 ? 0 : (index + length) % length;
}

function clampIndex(index: number, length: number): number {
  return length === 0 ? 0 : Math.max(0, Math.min(index, length - 1));
}

function fitLine(value: string, width: number): string {
  return truncateToWidth(value, Math.max(1, width), "…");
}

function fitSegments(width: number, segments: readonly string[]): string {
  const kept: string[] = [];
  for (const segment of segments) {
    const candidate = [...kept, segment].join(" · ");
    if (visibleWidth(candidate) > width) break;
    kept.push(segment);
  }
  return kept.length ? kept.join(" · ") : fitLine(segments[0] ?? "", width);
}

function pad(value: string, width: number): string {
  const fitted = fitLine(value, width);
  return `${fitted}${" ".repeat(Math.max(0, width - visibleWidth(fitted)))}`;
}

function rule(width: number): string {
  return "─".repeat(Math.max(1, width));
}

function frame(rows: readonly string[], width: number, theme: McpManagerTheme): string[] {
  if (width < 3) return rows.map((row) => fitLine(row, width));
  const inner = width - 2;
  const border = (value: string) => theme.fg("dim", value);
  return [
    border(`╭${"─".repeat(inner)}╮`),
    ...rows.map((row) => `${border("│")}${pad(row, inner)}${border("│")}`),
    border(`╰${"─".repeat(inner)}╯`),
  ];
}
