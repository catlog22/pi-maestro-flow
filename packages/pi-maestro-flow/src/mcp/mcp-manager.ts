import {
  Key,
  type Component,
  type Focusable,
  matchesKey,
  visibleWidth,
} from "@earendil-works/pi-tui";
import type { SupportedSettingsLocale } from "pi-maestro-settings-core/v1";
import {
  fit,
  frame,
  headerLine,
  helpLine,
  pad,
  rule,
  type FrameTheme,
} from "pi-cockpit/src/settings/ui-primitives.ts";
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

interface McpManagerTheme extends FrameTheme {}

export interface McpManagerParams {
  servers: readonly McpManagerServerView[];
  theme: McpManagerTheme;
  notice?: string;
  initialState?: Partial<McpManagerUiState>;
  /** UI language; defaults to zh-CN when the host exposes no locale signal. */
  locale?: SupportedSettingsLocale;
  requestRender: () => void;
  done: (action: McpManagerAction) => void;
}

const CATALOGS = {
  en: {
    "compact.manage": "Manage services",
    "compact.edit": "Edit config",
    "compact.noMatch": "no matching services",
    "menu.item.manage": "Manage services",
    "menu.item.manage.desc": "View service status, enable, disable, or delete.",
    "menu.item.edit": "Edit configuration",
    "menu.item.edit.desc": "Paste or edit the full MCP JSON configuration.",
    "footer.close": "Esc close",
    "footer.select": "Up/Down select",
    "footer.open": "Enter open",
    "footer.quick": "1/2 quick enter",
    "footer.backMenu": "Esc menu",
    "footer.detail": "Enter details",
    "footer.filter": "/ filter",
    "footer.toggle": "Space toggle",
    "footer.auth": "A auth",
    "footer.delete": "D delete",
    "footer.navigate": "Up/Down service",
    "footer.backDetail": "Esc back",
    "header.title": "MCP Manager",
    "header.count": "{count} services",
    "empty.list": "○ No matching services · back to menu to edit config",
    "transport.local": "local",
    "tools.count": "{count} tools",
    "status.connected": "connected",
    "status.needsAuth": "needs auth",
    "status.failed": "connection failed",
    "status.disabled": "disabled",
    "status.idle": "idle",
    "scope.user": "user",
    "scope.project": "project",
    "scope.import": "import",
    "detail.toggle": "toggle",
    "detail.transport": "transport",
    "detail.source": "source",
    "detail.lifecycle": "lifecycle",
    "detail.url": "URL",
    "detail.auth": "auth",
    "detail.headers": "headers",
    "detail.command": "command",
    "detail.args": "args",
    "detail.cwd": "cwd",
    "detail.env": "environment",
    "detail.directTools": "direct tools",
    "detail.resources": "resources",
    "detail.timeout": "timeout",
    "detail.tools": "tools",
    "detail.config": "config",
    "detail.hint": "hint",
    "detail.noServer": "no server selected",
    "detail.authHint": "press A for OAuth auth",
    "value.enabled": "enabled",
    "value.disabled": "disabled",
    "value.readonly": "read-only",
    "value.unset": "unset",
    "value.exposed": "exposed",
    "value.hidden": "hidden",
    "value.default": "default",
    "auth.none": "not enabled",
    "auth.bearerEnv": "Bearer · env:{env}",
    "auth.bearer": "Bearer",
    "auth.oauth": "OAuth",
    "auth.headers": "headers",
    "auth.auto": "auto",
    "tools.all": "all",
    "tools.selected": "{count} selected",
    "tools.none": "none",
    "tools.proxy": "proxy only",
    "filter.prompt": "Filter: press / to search",
    "filter.active": "filter",
    "filter.placeholder": "type a server name",
    "filter.escCancel": "Esc cancel",
    "filter.count": "showing {count}",
  },
  "zh-CN": {
    "compact.manage": "管理服务",
    "compact.edit": "编辑配置",
    "compact.noMatch": "没有匹配的服务",
    "menu.item.manage": "管理服务",
    "menu.item.manage.desc": "查看服务状态，并启用、停用或删除。",
    "menu.item.edit": "编辑配置",
    "menu.item.edit.desc": "粘贴或修改完整 MCP JSON 配置。",
    "footer.close": "Esc 关闭",
    "footer.select": "↑↓ 选择",
    "footer.open": "Enter 打开",
    "footer.quick": "1/2 快速进入",
    "footer.backMenu": "Esc 菜单",
    "footer.detail": "Enter 详情",
    "footer.filter": "/ 筛选",
    "footer.toggle": "空格 开关",
    "footer.auth": "A 认证",
    "footer.delete": "D 删除",
    "footer.navigate": "↑↓ 服务",
    "footer.backDetail": "Esc 返回",
    "header.title": "MCP 管理",
    "header.count": "{count} 个服务",
    "empty.list": "○ 没有匹配的服务 · 返回菜单后编辑配置",
    "transport.local": "本地",
    "tools.count": "{count} 个工具",
    "status.connected": "已连接",
    "status.needsAuth": "需要认证",
    "status.failed": "连接失败",
    "status.disabled": "已停用",
    "status.idle": "未连接",
    "scope.user": "用户",
    "scope.project": "项目",
    "scope.import": "导入",
    "detail.toggle": "开关",
    "detail.transport": "传输",
    "detail.source": "来源",
    "detail.lifecycle": "连接策略",
    "detail.url": "URL",
    "detail.auth": "认证",
    "detail.headers": "请求头",
    "detail.command": "命令",
    "detail.args": "参数",
    "detail.cwd": "目录",
    "detail.env": "环境变量",
    "detail.directTools": "直连工具",
    "detail.resources": "资源",
    "detail.timeout": "超时",
    "detail.tools": "工具",
    "detail.config": "配置",
    "detail.hint": "提示",
    "detail.noServer": "未选择服务",
    "detail.authHint": "按 A 进行 OAuth 认证",
    "value.enabled": "已启用",
    "value.disabled": "已停用",
    "value.readonly": "只读",
    "value.unset": "未配置",
    "value.exposed": "已公开",
    "value.hidden": "已隐藏",
    "value.default": "默认",
    "auth.none": "未启用",
    "auth.bearerEnv": "Bearer · 环境变量:{env}",
    "auth.bearer": "Bearer",
    "auth.oauth": "OAuth",
    "auth.headers": "请求头",
    "auth.auto": "自动",
    "tools.all": "全部",
    "tools.selected": "{count} 个已选",
    "tools.none": "无",
    "tools.proxy": "仅代理",
    "filter.prompt": "筛选：按 / 输入服务名",
    "filter.active": "筛选",
    "filter.placeholder": "输入服务名",
    "filter.escCancel": "Esc 取消",
    "filter.count": "显示 {count} 个",
  },
} as const;

type CatalogKey = keyof (typeof CATALOGS)["zh-CN"];

const MAX_VISIBLE = 10;

export class McpManagerOverlay implements Component, Focusable {
  focused = false;
  private readonly locale: SupportedSettingsLocale;
  private query: string;
  private selected = 0;
  private detail: boolean;
  private screen: McpManagerScreen;
  private menuSelected = 0;
  private filterActive = false;
  private lastWidth = 80;

  constructor(private readonly params: McpManagerParams) {
    this.locale = params.locale ?? "zh-CN";
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

  /** Translate a catalog key with optional {var} substitution. */
  private t(key: CatalogKey, vars?: Readonly<Record<string, string | number>>): string {
    const catalog = CATALOGS[this.locale] ?? CATALOGS["zh-CN"];
    const template: unknown = catalog[key];
    const text = typeof template === "string" ? template : CATALOGS["zh-CN"][key] as string;
    if (!vars) return text;
    return text.replace(/\{(\w+)\}/g, (_match, name: string) =>
      vars[name] !== undefined ? String(vars[name]) : `{${name}}`);
  }

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
      // 忽略导航/功能键，避免转义序列残渣混入筛选文本。
      if (data.startsWith("\x1b")) return;
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
      const action = this.t(this.menuSelected === 0 ? "menu.item.manage" : "menu.item.edit");
      return fit(`Esc · MCP · ${action}`, width);
    }
    const server = this.selectedServer() ?? this.filteredServers()[0];
    const value = server
      ? `Esc · MCP · ${this.statusText(server.status)} · ${server.name}`
      : `Esc · MCP · ${this.t("compact.noMatch")}`;
    return fit(value, width);
  }

  private renderMenu(width: number): string[] {
    const inner = width - 2;
    const items = [
      [this.t("menu.item.manage"), this.t("menu.item.manage.desc")],
      [this.t("menu.item.edit"), this.t("menu.item.edit.desc")],
    ] as const;
    const rows = [headerLine(this.params.theme, "MCP", [], inner), rule(inner)];
    for (let index = 0; index < items.length; index++) {
      const [label, description] = items[index];
      const selected = index === this.menuSelected;
      const prefix = selected ? this.params.theme.fg("accent", "›") : " ";
      const name = selected ? this.params.theme.bold(this.params.theme.fg("accent", `${index + 1}. ${label}`)) : `${index + 1}. ${label}`;
      rows.push(fit(`${prefix} ${name}`, inner));
      rows.push(helpLine(this.params.theme, `    ${description}`, inner));
    }
    if (this.params.notice) rows.push(this.styledNotice(this.params.notice, inner));
    rows.push(fitSegments(inner, [this.t("footer.close"), this.t("footer.select"), this.t("footer.open"), this.t("footer.quick")]));
    return frame(rows, width, this.params.theme);
  }

  private renderList(width: number): string[] {
    const inner = width - 2;
    const servers = this.filteredServers();
    const rows = [this.header(inner), rule(inner)];
    rows.push(...this.listRows(servers, inner));
    rows.push(this.filterLine(inner, servers.length));
    if (this.params.notice) rows.push(this.styledNotice(this.params.notice, inner));
    rows.push(fitSegments(inner, this.hintSegments(["footer.backMenu", "footer.detail", "footer.filter", "footer.toggle", "footer.auth", "footer.delete"])));
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
    rows.push(fitSegments(inner, this.hintSegments(["footer.backMenu", "footer.navigate", "footer.filter", "footer.toggle", "footer.auth", "footer.delete"])));
    return frame(rows, width, this.params.theme);
  }

  private renderDetail(width: number): string[] {
    const inner = width - 2;
    const rows = [this.header(inner), rule(inner), ...this.detailLines(this.selectedServer(), inner)];
    if (this.params.notice) rows.push(this.styledNotice(this.params.notice, inner));
    rows.push(fitSegments(inner, this.hintSegments(["footer.backDetail", "footer.navigate", "footer.filter", "footer.toggle", "footer.auth", "footer.delete"])));
    return frame(rows, width, this.params.theme);
  }

  private header(width: number): string {
    return headerLine(this.params.theme, this.t("header.title"), [
      this.t("header.count", { count: this.params.servers.length }),
      this.filterActive ? `${this.t("filter.active")}: ${this.query || this.t("filter.placeholder")}` : "",
    ], width);
  }

  private listRows(servers: readonly McpManagerServerView[], width: number): string[] {
    if (servers.length === 0) {
      return [this.params.theme.fg("warning", fit(this.t("empty.list"), width))];
    }
    const start = visibleStart(this.selected, servers.length, MAX_VISIBLE);
    return servers.slice(start, start + MAX_VISIBLE).map((server, offset) => {
      const selected = start + offset === this.selected;
      const transport = server.entry.url ? "HTTP" : this.t("transport.local");
      const scope = this.scopeLabel(server.scope);
      const tools = this.t("tools.count", { count: server.toolNames.length });
      const prefix = selected ? this.params.theme.fg("accent", "›") : " ";
      const name = selected ? this.params.theme.bold(this.params.theme.fg("accent", server.name)) : server.name;
      return fit(`${prefix} ${this.styledStatus(server.status)} ${name} · ${transport} · ${scope} · ${tools}`, width);
    });
  }

  private detailLines(server: McpManagerServerView | undefined, width: number): string[] {
    if (!server) return [this.params.theme.fg("warning", fit(this.t("detail.noServer"), width))];
    const entry = server.entry;
    const label = (key: CatalogKey, value: string): string => fit(`${this.detailLabel(this.t(key))}${value}`, width);
    const lines = [
      fit(`${this.params.theme.bold(this.params.theme.fg("accent", server.name))}  ${this.styledStatus(server.status)}`, width),
      label("detail.toggle", entry.enabled === false ? this.t("value.disabled") : this.t("value.enabled")),
      label("detail.transport", entry.url ? "HTTP" : this.t("transport.local")),
      label("detail.source", `${this.scopeLabel(server.scope)}${server.readOnly ? ` · ${this.t("value.readonly")}` : ""}`),
      label("detail.lifecycle", entry.lifecycle ?? "lazy"),
    ];
    if (entry.url) {
      lines.push(label("detail.url", entry.url));
      lines.push(label("detail.auth", this.authLabel(entry)));
      if (entry.headers) lines.push(label("detail.headers", this.displayRecord(entry.headers)));
    } else {
      lines.push(label("detail.command", entry.command ?? this.t("value.unset")));
      if (entry.args?.length) lines.push(label("detail.args", entry.args.join(" ")));
      if (entry.cwd) lines.push(label("detail.cwd", entry.cwd));
      if (entry.env) lines.push(label("detail.env", this.displayRecord(entry.env)));
    }
    lines.push(label("detail.directTools", this.directToolsLabel(entry.directTools)));
    lines.push(label("detail.resources", entry.exposeResources ? this.t("value.exposed") : this.t("value.hidden")));
    lines.push(label("detail.timeout", entry.requestTimeoutMs ? `${entry.requestTimeoutMs} ms` : this.t("value.default")));
    if (server.toolNames.length) {
      lines.push(helpLine(this.params.theme, fit(
        `${this.detailLabel(this.t("detail.tools"))}${server.toolNames.slice(0, 4).join(", ")}${server.toolNames.length > 4 ? ` +${server.toolNames.length - 4}` : ""}`,
        width,
      ), width));
    }
    if (server.status === "needs-auth" && server.canAuthenticate) {
      lines.push(this.params.theme.fg("warning", fit(
        `${this.detailLabel(this.t("detail.hint"))}${this.t("detail.authHint")}`,
        width,
      )));
    }
    lines.push(helpLine(this.params.theme, fit(`${this.detailLabel(this.t("detail.config"))}${server.path}`, width), width));
    return lines;
  }

  private filterLine(width: number, count: number): string {
    const prompt = this.filterActive
      ? `${this.t("filter.active")}: ${this.query || this.t("filter.placeholder")} · ${this.t("filter.escCancel")}`
      : this.t("filter.prompt");
    return helpLine(this.params.theme, `${prompt} · ${this.t("filter.count", { count })}`, width);
  }

  private detailLabel(label: string): string {
    const column = this.locale === "zh-CN" ? 10 : 12;
    return `${label}${" ".repeat(Math.max(1, column - visibleWidth(label)))}`;
  }

  private styledNotice(notice: string, width: number): string {
    const role = /(失败|错误|failed|error)/i.test(notice) ? "error"
      : /^(已保存|已删除|已更新|Saved|Deleted)/.test(notice) ? "success"
      : /^(无法|Cannot)/.test(notice) ? "warning" : "dim";
    return this.params.theme.fg(role, fit(notice, width));
  }

  private styledStatus(status: McpManagerStatus): string {
    const label = `${statusGlyph(status)} ${this.statusText(status)}`;
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

  private hintSegments(keys: readonly CatalogKey[]): string[] {
    const server = this.selectedServer();
    if (!server?.canAuthenticate) {
      return keys.filter((key) => key !== "footer.auth").map((key) => this.t(key));
    }
    return keys.map((key) => this.t(key));
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

  private statusText(status: McpManagerStatus): string {
    if (status === "connected") return this.t("status.connected");
    if (status === "needs-auth") return this.t("status.needsAuth");
    if (status === "failed") return this.t("status.failed");
    if (status === "disabled") return this.t("status.disabled");
    return this.t("status.idle");
  }

  private scopeLabel(scope: McpManagedServer["scope"]): string {
    if (scope === "user") return this.t("scope.user");
    if (scope === "project") return this.t("scope.project");
    return this.t("scope.import");
  }

  private authLabel(entry: McpManagedServer["entry"]): string {
    if (entry.auth === false) return this.t("auth.none");
    if (entry.auth === "bearer") return entry.bearerTokenEnv ? this.t("auth.bearerEnv", { env: entry.bearerTokenEnv }) : this.t("auth.bearer");
    if (entry.auth === "oauth") return this.t("auth.oauth");
    return entry.headers ? this.t("auth.headers") : this.t("auth.auto");
  }

  private directToolsLabel(value: McpManagedServer["entry"]["directTools"]): string {
    if (value === true) return this.t("tools.all");
    if (Array.isArray(value)) return value.length ? this.t("tools.selected", { count: value.length }) : this.t("tools.none");
    return this.t("tools.proxy");
  }

  private displayRecord(value: Record<string, string>): string {
    const entries = Object.entries(value);
    return entries.slice(0, 3).map(([key, raw]) => `${key}=${isSecretKey(key) ? "********" : raw}`).join(" · ")
      + (entries.length > 3 ? ` · +${entries.length - 3}` : "");
  }
}

export function statusGlyph(status: McpManagerStatus): string {
  if (status === "connected") return "●";
  if (status === "needs-auth") return "!";
  if (status === "failed") return "×";
  if (status === "disabled") return "○";
  return "○";
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

function fitSegments(width: number, segments: readonly string[]): string {
  const kept: string[] = [];
  for (const segment of segments) {
    const candidate = [...kept, segment].join(" · ");
    if (visibleWidth(candidate) > width) break;
    kept.push(segment);
  }
  return kept.length ? kept.join(" · ") : fit(segments[0] ?? "", width);
}
