import {
  Key,
  type Component,
  type Focusable,
  matchesKey,
  truncateToWidth,
  visibleWidth,
} from "@earendil-works/pi-tui";
import type { McpManagedServer } from "./mcp-manager-store.ts";

export type McpManagerStatus = "connected" | "idle" | "needs-auth" | "failed" | "disabled";
export type McpManagerScreen = "menu" | "manage";
export type McpManagerActionKind =
  | "close"
  | "edit-config"
  | "toggle"
  | "delete"
  | "authenticate";

export interface McpManagerServerView extends McpManagedServer {
  status: McpManagerStatus;
  toolNames: string[];
  canAuthenticate: boolean;
}

export interface McpManagerUiState {
  query: string;
  selectedName?: string;
  detail: boolean;
  screen: McpManagerScreen;
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

const MAX_VISIBLE = 10;

export class McpManagerOverlay implements Component, Focusable {
  focused = false;
  private query: string;
  private selected = 0;
  private detail: boolean;
  private screen: McpManagerScreen;
  private menuSelected = 0;
  private filterActive = false;
  private lastWidth = 80;

  constructor(private readonly params: McpManagerParams) {
    this.query = params.initialState?.query ?? "";
    this.detail = params.initialState?.detail ?? false;
    this.screen = params.initialState?.screen ?? "menu";
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
    if (this.screen === "menu") return this.renderMenu(safeWidth);
    if (safeWidth >= 72) return this.renderWide(safeWidth);
    return this.detail ? this.renderDetail(safeWidth) : this.renderList(safeWidth);
  }

  handleInput(data: string): void {
    if (matchesKey(data, Key.escape)) {
      if (this.screen === "menu") {
        this.finish("close");
        return;
      }
      if (this.filterActive) {
        this.filterActive = false;
        this.query = "";
        this.selected = 0;
        this.params.requestRender();
        return;
      }
      if (this.detail && this.lastWidth < 72) {
        this.detail = false;
        this.params.requestRender();
        return;
      }
      this.screen = "menu";
      this.detail = false;
      this.query = "";
      this.selected = 0;
      this.params.requestRender();
      return;
    }

    if (this.screen === "menu") {
      this.handleMenuInput(data);
      return;
    }
    if (this.lastWidth < 20) return;
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
    if (this.filterActive) {
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
      return;
    }
    if (data === "/") {
      this.filterActive = true;
      this.params.requestRender();
      return;
    }
    if (matchesKey(data, Key.space) || data === " ") return this.finish("toggle");
    if (data === "a" || data === "A") {
      const server = this.selectedServer();
      if (server?.canAuthenticate) return this.finish("authenticate");
      return;
    }
    if (data === "d" || data === "D") return this.finish("delete");
  }

  private handleMenuInput(data: string): void {
    if (matchesKey(data, Key.up) || matchesKey(data, Key.left)) {
      this.menuSelected = wrapIndex(this.menuSelected - 1, 2);
      this.params.requestRender();
      return;
    }
    if (matchesKey(data, Key.down) || matchesKey(data, Key.right) || data === "\t") {
      this.menuSelected = wrapIndex(this.menuSelected + 1, 2);
      this.params.requestRender();
      return;
    }
    if (data === "1") {
      this.openManager();
      return;
    }
    if (data === "2") {
      this.finish("edit-config");
      return;
    }
    if (matchesKey(data, Key.enter)) {
      if (this.menuSelected === 0) this.openManager();
      else this.finish("edit-config");
    }
  }

  private openManager(): void {
    this.screen = "manage";
    this.detail = false;
    this.params.requestRender();
  }

  private renderCompact(width: number): string {
    if (this.screen === "menu") {
      const action = this.menuSelected === 0 ? "管理服务" : "编辑配置";
      return truncateToWidth(`Esc · MCP · ${action}`, width, "…");
    }
    const server = this.selectedServer() ?? this.filteredServers()[0];
    const value = server
      ? `Esc · MCP · ${statusText(server.status)} · ${server.name}`
      : "Esc · MCP · 没有匹配的服务";
    return truncateToWidth(value, width, "…");
  }

  private renderMenu(width: number): string[] {
    const inner = width - 2;
    const items = [
      ["管理服务", "查看服务状态，并启用、停用或删除。"],
      ["编辑配置", "粘贴或修改完整 MCP JSON 配置。"],
    ] as const;
    const rows = [fitLine(this.params.theme.bold("MCP"), inner), rule(inner)];
    for (let index = 0; index < items.length; index++) {
      const [label, description] = items[index];
      const selected = index === this.menuSelected;
      const prefix = selected ? this.params.theme.fg("accent", "›") : " ";
      const name = selected ? this.params.theme.bold(this.params.theme.fg("accent", `${index + 1}. ${label}`)) : `${index + 1}. ${label}`;
      rows.push(fitLine(`${prefix} ${name}`, inner));
      rows.push(this.params.theme.fg("dim", fitLine(`    ${description}`, inner)));
    }
    if (this.params.notice) rows.push(this.styledNotice(this.params.notice, inner));
    rows.push(fitSegments(inner, ["Esc 关闭", "↑↓ 选择", "Enter 打开", "1/2 快速进入"]));
    return frame(rows, width, this.params.theme);
  }

  private renderList(width: number): string[] {
    const inner = width - 2;
    const servers = this.filteredServers();
    const rows = [this.header(inner), rule(inner)];
    rows.push(...this.listRows(servers, inner));
    rows.push(this.filterLine(inner, servers.length));
    if (this.params.notice) rows.push(this.styledNotice(this.params.notice, inner));
    rows.push(fitSegments(inner, this.hintSegments(["Esc 菜单", "Enter 详情", "/ 筛选", "空格 开关", "A 认证", "D 删除"])));
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
    rows.push(fitSegments(inner, this.hintSegments(["Esc 菜单", "↑↓ 服务", "/ 筛选", "空格 开关", "A 认证", "D 删除"])));
    return frame(rows, width, this.params.theme);
  }

  private renderDetail(width: number): string[] {
    const inner = width - 2;
    const rows = [this.header(inner), rule(inner), ...this.detailLines(this.selectedServer(), inner)];
    if (this.params.notice) rows.push(this.styledNotice(this.params.notice, inner));
    rows.push(fitSegments(inner, this.hintSegments(["Esc 返回", "↑↓ 服务", "/ 筛选", "空格 开关", "A 认证", "D 删除"])));
    return frame(rows, width, this.params.theme);
  }

  private header(width: number): string {
    return fitLine(`${this.params.theme.bold("MCP 管理")} · ${this.params.servers.length} 个服务`, width);
  }

  private listRows(servers: readonly McpManagerServerView[], width: number): string[] {
    if (servers.length === 0) {
      return [this.params.theme.fg("warning", fitLine("○ 没有匹配的服务 · 返回菜单后编辑配置", width))];
    }
    const start = visibleStart(this.selected, servers.length, MAX_VISIBLE);
    return servers.slice(start, start + MAX_VISIBLE).map((server, offset) => {
      const selected = start + offset === this.selected;
      const transport = server.entry.url ? "HTTP" : "本地";
      const scope = scopeLabel(server.scope);
      const tools = `${server.toolNames.length} 个工具`;
      const prefix = selected ? this.params.theme.fg("accent", "›") : " ";
      const name = selected ? this.params.theme.bold(this.params.theme.fg("accent", server.name)) : server.name;
      return fitLine(`${prefix} ${this.styledStatus(server.status)} ${name} · ${transport} · ${scope} · ${tools}`, width);
    });
  }

  private detailLines(server: McpManagerServerView | undefined, width: number): string[] {
    if (!server) return [this.params.theme.fg("warning", fitLine("未选择服务", width))];
    const entry = server.entry;
    const lines = [
      fitLine(`${this.params.theme.bold(this.params.theme.fg("accent", server.name))}  ${this.styledStatus(server.status)}`, width),
      fitLine(`开关      ${entry.enabled === false ? "已停用" : "已启用"}`, width),
      fitLine(`传输      ${entry.url ? "HTTP" : "本地"}`, width),
      fitLine(`来源      ${scopeLabel(server.scope)}${server.readOnly ? " · 只读" : ""}`, width),
      fitLine(`连接策略  ${entry.lifecycle ?? "lazy"}`, width),
    ];
    if (entry.url) {
      lines.push(fitLine(`URL       ${entry.url}`, width));
      lines.push(fitLine(`认证      ${authLabel(entry)}`, width));
      if (entry.headers) lines.push(fitLine(`请求头    ${displayRecord(entry.headers)}`, width));
    } else {
      lines.push(fitLine(`命令      ${entry.command ?? "未配置"}`, width));
      if (entry.args?.length) lines.push(fitLine(`参数      ${entry.args.join(" ")}`, width));
      if (entry.cwd) lines.push(fitLine(`目录      ${entry.cwd}`, width));
      if (entry.env) lines.push(fitLine(`环境变量  ${displayRecord(entry.env)}`, width));
    }
    lines.push(fitLine(`直连工具  ${directToolsLabel(entry.directTools)}`, width));
    lines.push(fitLine(`资源      ${entry.exposeResources ? "已公开" : "已隐藏"}`, width));
    lines.push(fitLine(`超时      ${entry.requestTimeoutMs ? `${entry.requestTimeoutMs} ms` : "默认"}`, width));
    if (server.toolNames.length) {
      lines.push(this.params.theme.fg("dim", fitLine(`工具      ${server.toolNames.slice(0, 4).join(", ")}${server.toolNames.length > 4 ? ` +${server.toolNames.length - 4}` : ""}`, width)));
    }
    if (server.status === "needs-auth" && server.canAuthenticate) {
      lines.push(this.params.theme.fg("warning", fitLine("提示      按 A 进行 OAuth 认证", width)));
    }
    lines.push(this.params.theme.fg("dim", fitLine(`配置      ${server.path}`, width)));
    return lines;
  }

  private filterLine(width: number, count: number): string {
    const prompt = this.filterActive
      ? `筛选中：${this.query || "输入服务名"} · Esc 取消`
      : "筛选：按 / 输入服务名";
    return this.params.theme.fg("dim", fitLine(`${prompt} · 显示 ${count} 个`, width));
  }

  private styledNotice(notice: string, width: number): string {
    const role = /(失败|错误|failed|error)/i.test(notice) ? "error"
      : /^(已保存|已删除|已更新|Saved|Deleted)/.test(notice) ? "success"
      : /^(无法|Cannot)/.test(notice) ? "warning" : "dim";
    return this.params.theme.fg(role, fitLine(notice, width));
  }

  private styledStatus(status: McpManagerStatus): string {
    const label = `${statusGlyph(status)} ${statusText(status)}`;
    if (status === "connected") return this.params.theme.fg("success", label);
    if (status === "needs-auth") return this.params.theme.fg("warning", label);
    if (status === "failed") return this.params.theme.fg("error", label);
    if (status === "disabled") return this.params.theme.fg("dim", label);
    return this.params.theme.fg("dim", label);
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

  private hintSegments(segments: string[]): string[] {
    const server = this.selectedServer();
    if (!server?.canAuthenticate) {
      return segments.filter((s) => s !== "A 认证");
    }
    return segments;
  }

  private finish(kind: McpManagerActionKind): void {
    const selected = this.selectedServer();
    this.params.done({
      kind,
      ...(selected ? { serverName: selected.name } : {}),
      uiState: {
        query: this.query,
        ...(selected ? { selectedName: selected.name } : {}),
        detail: this.detail,
        screen: this.screen,
      },
    });
  }
}

export function statusGlyph(status: McpManagerStatus): string {
  if (status === "connected") return "●";
  if (status === "needs-auth") return "!";
  if (status === "failed") return "×";
  if (status === "disabled") return "○";
  return "○";
}

function statusText(status: McpManagerStatus): string {
  if (status === "connected") return "已连接";
  if (status === "needs-auth") return "需要认证";
  if (status === "failed") return "连接失败";
  if (status === "disabled") return "已停用";
  return "未连接";
}

function scopeLabel(scope: McpManagedServer["scope"]): string {
  if (scope === "user") return "用户";
  if (scope === "project") return "项目";
  return "导入";
}

function authLabel(entry: McpManagedServer["entry"]): string {
  if (entry.auth === false) return "未启用";
  if (entry.auth === "bearer") return entry.bearerTokenEnv ? `Bearer · 环境变量:${entry.bearerTokenEnv}` : "Bearer";
  if (entry.auth === "oauth") return "OAuth";
  return entry.headers ? "请求头" : "自动";
}

function directToolsLabel(value: McpManagedServer["entry"]["directTools"]): string {
  if (value === true) return "全部";
  if (Array.isArray(value)) return value.length ? `${value.length} 个已选` : "无";
  return "仅代理";
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
