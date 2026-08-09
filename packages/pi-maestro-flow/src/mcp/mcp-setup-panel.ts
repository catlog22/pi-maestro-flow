import { matchesKey, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { SupportedSettingsLocale } from "pi-maestro-settings-core/v1";
import { getTuiLocale } from "../tui/locale.ts";
import { createPanelKeys, type PanelKeybindings, type PanelKeys } from "./panel-keys.ts";
import type { ImportKind } from "./types.ts";
import type { ConfigWritePreview, McpDiscoverySummary } from "./config.ts";
import type { McpOnboardingState } from "./onboarding-state.ts";

interface SetupTheme {
  border: string;
  title: string;
  selected: string;
  hint: string;
  success: string;
  warning: string;
  muted: string;
}

const DEFAULT_THEME: SetupTheme = {
  border: "2",
  title: "36",
  selected: "32",
  hint: "2",
  success: "32",
  warning: "33",
  muted: "2;3",
};

function fg(code: string, text: string): string {
  return code ? `\x1b[${code}m${text}\x1b[0m` : text;
}

function wrapText(text: string, width: number): string[] {
  if (width <= 8) return [text];
  const words = text.split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let current = "";
  for (const word of words) {
    const candidate = current ? `${current} ${word}` : word;
    if (visibleWidth(candidate) <= width) {
      current = candidate;
      continue;
    }
    if (current) lines.push(current);
    current = word;
  }
  if (current) lines.push(current);
  return lines.length > 0 ? lines : [""];
}

export interface SetupPanelCallbacks {
  previewImports: (imports: ImportKind[]) => ConfigWritePreview;
  previewStarterProject: () => ConfigWritePreview;
  previewRepoPrompt: () => ConfigWritePreview | null;
  adoptImports: (imports: ImportKind[]) => Promise<{ added: ImportKind[]; path: string }>;
  scaffoldProjectConfig: () => Promise<{ path: string }>;
  addRepoPrompt: () => Promise<{ path: string; serverName: string }>;
  openPath: (path: string) => Promise<void>;
  markSetupCompleted: () => void;
}

export interface SetupPanelOptions {
  mode: "empty" | "setup";
  onboardingState: McpOnboardingState;
  keybindings?: PanelKeybindings;
  /** Explicit UI language; otherwise follows the shared runtime TUI locale. */
  locale?: SupportedSettingsLocale;
}

type Screen = "empty" | "setup" | "imports" | "paths";

type ActionId =
  | "run-setup"
  | "adopt-imports"
  | "view-example"
  | "show-precedence"
  | "open-paths"
  | "add-repoprompt"
  | "scaffold-project"
  | "close";

interface Action {
  id: ActionId;
  label: string;
  description: string;
}

const CATALOGS = {
  en: {
    "action.runSetup": "Run setup",
    "action.runSetup.desc": "Inspect detected configs, adopt imports, and scaffold a minimal `.mcp.json`.",
    "action.adoptImports": "Adopt detected compatibility imports",
    "action.adoptImports.desc": "Choose which host-specific MCP configs Pi should import into its own override file. {count} sources found.",
    "action.viewExample": "View example `.mcp.json`",
    "action.viewExample.desc": "Preview a working shared MCP config you can paste or adapt.",
    "action.scaffold": "Scaffold project `.mcp.json`",
    "action.scaffold.desc": "Write a minimal project config using the standard shared MCP file path, then reload Pi.",
    "action.precedence": "Explain config precedence",
    "action.precedence.desc": "Show the read order and where Pi writes compatibility settings.",
    "action.openPaths": "Open detected config paths",
    "action.openPaths.desc": "Browse the actual config files that Pi discovered on this machine.",
    "action.addRepoPrompt": "Add RepoPrompt to shared MCP config",
    "action.addRepoPrompt.desc": "Write a standard MCP entry for RepoPrompt to the recommended shared target, then reload MCP in-session.",
    "action.close": "Close",
    "action.close.desc": "Exit the onboarding flow.",
    "notice.opened": "Opened {path}",
    "notice.wroteStarter": "Wrote starter config to {path}. Pi will reload after this panel closes.",
    "notice.addedRepoPrompt": "Added {name} to {path}. Pi will reload after this panel closes.",
    "notice.review": "Review the details below. Press Enter on an action with a side effect to apply it.",
    "notice.selectImport": "Select at least one compatibility import first.",
    "notice.importsAdded": "Added {imports} to {path}. Pi will reload after this panel closes.",
    "notice.noChanges": "No changes needed in {path}.",
    "notice.working": "Working...",
    "title": "MCP setup",
    "footer.actions": "Enter selects, Esc goes back, Ctrl+C closes.",
    "imports.instructions": "Select compatibility imports. Space toggles, Enter saves, Esc goes back.",
    "imports.preview": "Compatibility import write preview",
    "paths.instructions": "Select a detected config path to open. Enter opens it, Esc goes back.",
    "summary.noServers": "No MCP servers are active right now.",
    "summary.noConfig": "No MCP config is active yet.",
    "summary.optionsInactive": "Pi found MCP-related setup options, but none are active in Pi yet.",
    "summary.detected": "Detected {servers} configured servers across {shared} shared and {piOwned} Pi-owned sources.",
    "secondary.create": "Create a shared `.mcp.json`, adopt host imports, or quick-add RepoPrompt from this screen.",
    "secondary.imports": "Detected {count} compatibility import sources. Adopt them into Pi or inspect the underlying files.",
    "secondary.shared": "Shared MCP files are preferred. Pi-owned files are only for compatibility imports and adapter-specific overrides.",
    "preview.runSetup": "Run setup to adopt host-specific imports, inspect detected paths, and scaffold a minimal `.mcp.json` if needed.",
    "preview.detectedImports": "Detected imports: {imports}",
    "preview.selectedImports": "Selected imports are written into the Pi agent dir config as Pi-owned compatibility state.",
    "preview.example": "Example shared `.mcp.json`:",
    "preview.exampleHint": "Use Scaffold project `.mcp.json` when you want a safe empty shell instead of a live example server.",
    "preview.readOrder": "Read order:",
    "preview.precedenceWrite": "Pi writes compatibility imports and adapter-only overrides to Pi-owned files.",
    "preview.detectedPaths": "Detected paths:",
    "preview.noPaths": "No config paths were detected.",
    "preview.repoUnavailable": "RepoPrompt is not available to add from this setup screen.",
    "preview.repoTitle": "RepoPrompt write preview",
    "preview.executable": "Executable: {value}",
    "preview.target": "Target: {value}",
    "preview.serverName": "Server name: {value}",
    "preview.notFound": "not found",
    "preview.notApplicable": "n/a",
    "preview.starterTitle": "Starter project `.mcp.json` write preview",
    "preview.starterDetail": "This writes a minimal `.mcp.json` in the current project using the shared MCP layout.",
    "preview.starterSafe": "It intentionally avoids adding a fake placeholder server that would fail on first reload.",
    "preview.close": "Close the setup flow.",
    "write.existing": "Existing file detected. Showing exact before/after diff.",
    "write.new": "New file will be created. Showing exact content diff.",
    "write.more": "… {count} more diff lines",
  },
  "zh-CN": {
    "action.runSetup": "运行设置",
    "action.runSetup.desc": "检查检测到的配置、采用导入，并创建最小 `.mcp.json`。",
    "action.adoptImports": "采用检测到的兼容导入",
    "action.adoptImports.desc": "选择要导入 Pi 覆盖文件的宿主 MCP 配置。找到 {count} 个来源。",
    "action.viewExample": "查看 `.mcp.json` 示例",
    "action.viewExample.desc": "预览可粘贴或调整的共享 MCP 配置。",
    "action.scaffold": "创建项目 `.mcp.json`",
    "action.scaffold.desc": "在标准共享 MCP 路径写入最小项目配置，然后重载 Pi。",
    "action.precedence": "说明配置优先级",
    "action.precedence.desc": "显示读取顺序以及 Pi 写入兼容设置的位置。",
    "action.openPaths": "打开检测到的配置路径",
    "action.openPaths.desc": "浏览此机器上 Pi 检测到的实际配置文件。",
    "action.addRepoPrompt": "将 RepoPrompt 添加到共享 MCP 配置",
    "action.addRepoPrompt.desc": "将标准 RepoPrompt MCP 条目写入推荐的共享目标，并在会话内重载 MCP。",
    "action.close": "关闭",
    "action.close.desc": "退出设置流程。",
    "notice.opened": "已打开 {path}",
    "notice.wroteStarter": "已将初始配置写入 {path}。面板关闭后 Pi 将重载。",
    "notice.addedRepoPrompt": "已将 {name} 添加到 {path}。面板关闭后 Pi 将重载。",
    "notice.review": "查看下方详情。对会产生修改的操作按 Enter 执行。",
    "notice.selectImport": "请先选择至少一个兼容导入。",
    "notice.importsAdded": "已将 {imports} 添加到 {path}。面板关闭后 Pi 将重载。",
    "notice.noChanges": "{path} 无需更改。",
    "notice.working": "处理中...",
    "title": "MCP 设置",
    "footer.actions": "Enter 选择，Esc 返回，Ctrl+C 关闭。",
    "imports.instructions": "选择兼容导入。Space 切换，Enter 保存，Esc 返回。",
    "imports.preview": "兼容导入写入预览",
    "paths.instructions": "选择要打开的配置路径。Enter 打开，Esc 返回。",
    "summary.noServers": "当前没有活动的 MCP 服务。",
    "summary.noConfig": "尚无活动的 MCP 配置。",
    "summary.optionsInactive": "Pi 找到了 MCP 设置选项，但尚未在 Pi 中启用。",
    "summary.detected": "检测到 {servers} 个已配置服务，来自 {shared} 个共享来源和 {piOwned} 个 Pi 自有来源。",
    "secondary.create": "可在此创建共享 `.mcp.json`、采用宿主导入或快速添加 RepoPrompt。",
    "secondary.imports": "检测到 {count} 个兼容导入来源。可导入 Pi 或检查底层文件。",
    "secondary.shared": "优先使用共享 MCP 文件。Pi 自有文件仅保存兼容导入和适配器专用覆盖。",
    "preview.runSetup": "运行设置以采用宿主导入、检查检测路径，并在需要时创建最小 `.mcp.json`。",
    "preview.detectedImports": "检测到的导入：{imports}",
    "preview.selectedImports": "所选导入会作为 Pi 自有兼容状态写入 Pi agent 目录配置。",
    "preview.example": "共享 `.mcp.json` 示例：",
    "preview.exampleHint": "需要安全空壳而非真实示例服务时，请使用“创建项目 `.mcp.json`”。",
    "preview.readOrder": "读取顺序：",
    "preview.precedenceWrite": "Pi 将兼容导入和适配器专用覆盖写入 Pi 自有文件。",
    "preview.detectedPaths": "检测到的路径：",
    "preview.noPaths": "未检测到配置路径。",
    "preview.repoUnavailable": "此设置界面无法添加 RepoPrompt。",
    "preview.repoTitle": "RepoPrompt 写入预览",
    "preview.executable": "可执行文件：{value}",
    "preview.target": "目标：{value}",
    "preview.serverName": "服务名：{value}",
    "preview.notFound": "未找到",
    "preview.notApplicable": "不适用",
    "preview.starterTitle": "项目 `.mcp.json` 初始写入预览",
    "preview.starterDetail": "将在当前项目按共享 MCP 布局写入最小 `.mcp.json`。",
    "preview.starterSafe": "不会添加会在首次重载时失败的虚假占位服务。",
    "preview.close": "关闭设置流程。",
    "write.existing": "检测到现有文件。显示精确的修改前后差异。",
    "write.new": "将创建新文件。显示精确的内容差异。",
    "write.more": "… 还有 {count} 行差异",
  },
} as const;

type CatalogKey = keyof (typeof CATALOGS)["en"];

export class McpSetupPanel {
  private readonly locale: SupportedSettingsLocale;
  private screen: Screen;
  private actionCursor = 0;
  private importCursor = 0;
  private pathCursor = 0;
  private selectedImports = new Set<ImportKind>();
  private busy = false;
  private notice: { text: string; tone: "success" | "warning" | "muted" } | null = null;
  private tui: { requestRender(): void };
  private t = DEFAULT_THEME;
  private keys: PanelKeys;
  private inactivityTimeout: ReturnType<typeof setTimeout> | null = null;
  private static readonly INACTIVITY_MS = 60_000;

  constructor(
    private discovery: McpDiscoverySummary,
    private callbacks: SetupPanelCallbacks,
    private options: SetupPanelOptions,
    tui: { requestRender(): void },
    private done: () => void,
  ) {
    this.locale = getTuiLocale(options.locale);
    this.tui = tui;
    this.keys = createPanelKeys(options.keybindings);
    this.screen = options.mode;
    for (const entry of discovery.imports) {
      this.selectedImports.add(entry.kind);
    }
    this.resetInactivityTimeout();
  }

  private text(key: CatalogKey, vars?: Readonly<Record<string, string | number>>): string {
    const template = CATALOGS[this.locale]?.[key] ?? CATALOGS.en[key];
    if (!vars) return template;
    return template.replace(/\{(\w+)\}/g, (_match, name: string) =>
      vars[name] !== undefined ? String(vars[name]) : `{${name}}`);
  }

  private resetInactivityTimeout(): void {
    if (this.inactivityTimeout) clearTimeout(this.inactivityTimeout);
    this.inactivityTimeout = setTimeout(() => {
      this.cleanup();
      this.done();
    }, McpSetupPanel.INACTIVITY_MS);
  }

  private cleanup(): void {
    if (this.inactivityTimeout) {
      clearTimeout(this.inactivityTimeout);
      this.inactivityTimeout = null;
    }
  }

  private getActions(): Action[] {
    const actions: Action[] = [];
    if (this.screen === "empty") {
      actions.push({ id: "run-setup", label: this.text("action.runSetup"), description: this.text("action.runSetup.desc") });
    }
    if (this.discovery.imports.length > 0) {
      actions.push({
        id: "adopt-imports",
        label: this.text("action.adoptImports"),
        description: this.text("action.adoptImports.desc", { count: this.discovery.imports.length }),
      });
    }
    actions.push({ id: "view-example", label: this.text("action.viewExample"), description: this.text("action.viewExample.desc") });
    if (!this.discovery.sources.some((source) => source.id === "shared-project" && source.exists)) {
      actions.push({ id: "scaffold-project", label: this.text("action.scaffold"), description: this.text("action.scaffold.desc") });
    }
    actions.push({ id: "show-precedence", label: this.text("action.precedence"), description: this.text("action.precedence.desc") });
    if (this.getDetectedPaths().length > 0) {
      actions.push({ id: "open-paths", label: this.text("action.openPaths"), description: this.text("action.openPaths.desc") });
    }
    if (!this.discovery.repoPrompt.configured && this.discovery.repoPrompt.executablePath && this.discovery.repoPrompt.targetPath && this.discovery.repoPrompt.entry && this.discovery.repoPrompt.serverName) {
      actions.push({ id: "add-repoprompt", label: this.text("action.addRepoPrompt"), description: this.text("action.addRepoPrompt.desc") });
    }
    actions.push({ id: "close", label: this.text("action.close"), description: this.text("action.close.desc") });
    return actions;
  }

  private getDetectedPaths(): string[] {
    const paths = [
      ...this.discovery.sources.filter((source) => source.exists).map((source) => source.path),
      ...this.discovery.imports.map((entry) => entry.path),
    ];
    return [...new Set(paths)];
  }

  private getSelectedAction(): Action | null {
    const actions = this.getActions();
    return actions[this.actionCursor] ?? null;
  }

  handleInput(data: string): void {
    this.resetInactivityTimeout();
    if (!this.busy) this.notice = null;

    if (matchesKey(data, "ctrl+c")) {
      this.cleanup();
      this.done();
      return;
    }

    if (matchesKey(data, "escape")) {
      if (this.screen === "imports" || this.screen === "paths") {
        this.screen = this.discovery.hasAnyConfig ? "setup" : "empty";
        this.tui.requestRender();
        return;
      }
      this.cleanup();
      this.done();
      return;
    }

    if (this.busy) return;

    if (this.screen === "imports") {
      this.handleImportsInput(data);
      return;
    }
    if (this.screen === "paths") {
      this.handlePathsInput(data);
      return;
    }

    const actions = this.getActions();
    if (this.keys.selectUp(data)) {
      this.actionCursor = Math.max(0, this.actionCursor - 1);
      this.tui.requestRender();
      return;
    }
    if (this.keys.selectDown(data)) {
      this.actionCursor = Math.min(actions.length - 1, this.actionCursor + 1);
      this.tui.requestRender();
      return;
    }
    if (this.keys.selectConfirm(data)) {
      const selected = this.getSelectedAction();
      if (selected) void this.runAction(selected.id);
    }
  }

  private handleImportsInput(data: string): void {
    const imports = this.discovery.imports;
    if (this.keys.selectUp(data)) {
      this.importCursor = Math.max(0, this.importCursor - 1);
      this.tui.requestRender();
      return;
    }
    if (this.keys.selectDown(data)) {
      this.importCursor = Math.min(imports.length - 1, this.importCursor + 1);
      this.tui.requestRender();
      return;
    }
    if (matchesKey(data, "space")) {
      const current = imports[this.importCursor];
      if (!current) return;
      if (this.selectedImports.has(current.kind)) {
        this.selectedImports.delete(current.kind);
      } else {
        this.selectedImports.add(current.kind);
      }
      this.tui.requestRender();
      return;
    }
    if (this.keys.selectConfirm(data)) {
      void this.applySelectedImports();
    }
  }

  private handlePathsInput(data: string): void {
    const paths = this.getDetectedPaths();
    if (this.keys.selectUp(data)) {
      this.pathCursor = Math.max(0, this.pathCursor - 1);
      this.tui.requestRender();
      return;
    }
    if (this.keys.selectDown(data)) {
      this.pathCursor = Math.min(paths.length - 1, this.pathCursor + 1);
      this.tui.requestRender();
      return;
    }
    if (this.keys.selectConfirm(data)) {
      const selected = paths[this.pathCursor];
      if (!selected) return;
      void this.runBusy(async () => {
        await this.callbacks.openPath(selected);
        this.notice = { text: this.text("notice.opened", { path: selected }), tone: "success" };
      });
    }
  }

  private async runAction(action: ActionId): Promise<void> {
    if (action === "run-setup") {
      this.screen = "setup";
      this.actionCursor = 0;
      this.tui.requestRender();
      return;
    }
    if (action === "adopt-imports") {
      this.screen = "imports";
      this.importCursor = 0;
      this.tui.requestRender();
      return;
    }
    if (action === "open-paths") {
      this.screen = "paths";
      this.pathCursor = 0;
      this.tui.requestRender();
      return;
    }
    if (action === "scaffold-project") {
      await this.runBusy(async () => {
        const result = await this.callbacks.scaffoldProjectConfig();
        this.callbacks.markSetupCompleted();
        this.notice = { text: this.text("notice.wroteStarter", { path: result.path }), tone: "success" };
      });
      return;
    }
    if (action === "add-repoprompt") {
      await this.runBusy(async () => {
        const result = await this.callbacks.addRepoPrompt();
        this.callbacks.markSetupCompleted();
        this.notice = { text: this.text("notice.addedRepoPrompt", { name: result.serverName, path: result.path }), tone: "success" };
      });
      return;
    }
    if (action === "close") {
      this.cleanup();
      this.done();
      return;
    }

    this.notice = { text: this.text("notice.review"), tone: "muted" };
    this.tui.requestRender();
  }

  private async applySelectedImports(): Promise<void> {
    const selected = this.discovery.imports.filter((entry) => this.selectedImports.has(entry.kind)).map((entry) => entry.kind);
    if (selected.length === 0) {
      this.notice = { text: this.text("notice.selectImport"), tone: "warning" };
      this.tui.requestRender();
      return;
    }

    await this.runBusy(async () => {
      const result = await this.callbacks.adoptImports(selected);
      this.callbacks.markSetupCompleted();
      this.notice = result.added.length > 0
        ? { text: this.text("notice.importsAdded", { imports: result.added.join(", "), path: result.path }), tone: "success" }
        : { text: this.text("notice.noChanges", { path: result.path }), tone: "muted" };
      this.screen = this.discovery.hasAnyConfig ? "setup" : "empty";
      this.actionCursor = 0;
    });
  }

  private async runBusy(fn: () => Promise<void>): Promise<void> {
    this.busy = true;
    this.notice = { text: this.text("notice.working"), tone: "muted" };
    this.tui.requestRender();
    try {
      await fn();
    } catch (error) {
      this.notice = {
        text: error instanceof Error ? error.message : String(error),
        tone: "warning",
      };
    } finally {
      this.busy = false;
      this.tui.requestRender();
    }
  }

  render(width: number): string[] {
    const innerW = Math.max(1, width - 2);
    const lines: string[] = [];
    const border = fg(this.t.border, "─".repeat(innerW));
    lines.push(`┌${border}┐`);
    lines.push(this.padLine(fg(this.t.title, this.text("title")), innerW));
    lines.push(this.padLine(this.discoverySummaryLine(), innerW));
    lines.push(this.padLine(fg(this.t.muted, this.secondarySummaryLine()), innerW));
    lines.push(this.padLine("", innerW));

    if (this.notice) {
      const tone = this.notice.tone === "success" ? this.t.success : this.notice.tone === "warning" ? this.t.warning : this.t.hint;
      for (const line of wrapText(this.notice.text, innerW - 6)) {
        lines.push(this.padLine(fg(tone, line), innerW));
      }
      lines.push(this.padLine("", innerW));
    }

    lines.push(`├${border}┤`);

    if (this.screen === "imports") {
      lines.push(...this.renderImports(innerW));
    } else if (this.screen === "paths") {
      lines.push(...this.renderPaths(innerW));
    } else {
      lines.push(...this.renderActions(innerW));
    }

    lines.push(`└${border}┘`);
    return lines;
  }

  private renderActions(innerW: number): string[] {
    const lines: string[] = [];
    const actions = this.getActions();
    for (let index = 0; index < actions.length; index++) {
      const action = actions[index];
      const selected = index === this.actionCursor;
      const cursor = selected ? fg(this.t.selected, "›") : " ";
      lines.push(this.padLine(`${cursor} ${truncateToWidth(action.label, innerW - 4)}`, innerW));
    }
    lines.push(this.padLine("", innerW));

    const preview = this.getActionPreview(this.getSelectedAction()?.id ?? "view-example");
    for (const line of preview) {
      lines.push(this.padLine(line, innerW));
    }
    lines.push(this.padLine("", innerW));
    lines.push(this.padLine(fg(this.t.muted, this.text("footer.actions")), innerW));
    return lines;
  }

  private renderImports(innerW: number): string[] {
    const lines: string[] = [];
    lines.push(this.padLine(this.text("imports.instructions"), innerW));
    lines.push(this.padLine("", innerW));
    for (let index = 0; index < this.discovery.imports.length; index++) {
      const entry = this.discovery.imports[index];
      const selected = this.selectedImports.has(entry.kind) ? "[x]" : "[ ]";
      const cursor = index === this.importCursor ? fg(this.t.selected, "›") : " ";
      lines.push(this.padLine(`${cursor} ${selected} ${entry.kind}  ${entry.path}`, innerW));
    }
    lines.push(this.padLine("", innerW));
    const selected = this.discovery.imports.filter((entry) => this.selectedImports.has(entry.kind)).map((entry) => entry.kind);
    const preview = this.callbacks.previewImports(selected);
    for (const line of this.formatWritePreview(this.text("imports.preview"), preview)) {
      lines.push(this.padLine(line, innerW));
    }
    return lines;
  }

  private renderPaths(innerW: number): string[] {
    const lines: string[] = [];
    lines.push(this.padLine(this.text("paths.instructions"), innerW));
    lines.push(this.padLine("", innerW));
    const paths = this.getDetectedPaths();
    for (let index = 0; index < paths.length; index++) {
      const cursor = index === this.pathCursor ? fg(this.t.selected, "›") : " ";
      lines.push(this.padLine(`${cursor} ${paths[index]}`, innerW));
    }
    return lines;
  }

  private discoverySummaryLine(): string {
    if (!this.discovery.hasAnyConfig) {
      return fg(this.t.warning, this.options.onboardingState.setupCompleted
        ? this.text("summary.noServers")
        : this.text("summary.noConfig"));
    }

    if (this.discovery.totalServerCount === 0 && (this.discovery.imports.length > 0 || !!this.discovery.repoPrompt.executablePath)) {
      return fg(this.t.warning, this.text("summary.optionsInactive"));
    }

    const shared = this.discovery.sources.filter((source) => source.kind === "shared" && source.serverCount > 0).length;
    const piOwned = this.discovery.sources.filter((source) => source.kind === "pi" && source.serverCount > 0).length;
    return fg(this.t.hint, this.text("summary.detected", {
      servers: this.discovery.totalServerCount,
      shared,
      piOwned,
    }));
  }

  private secondarySummaryLine(): string {
    if (!this.discovery.hasAnyConfig) {
      return this.text("secondary.create");
    }
    if (this.discovery.totalServerCount === 0 && this.discovery.imports.length > 0) {
      return this.text("secondary.imports", { count: this.discovery.imports.length });
    }
    return this.text("secondary.shared");
  }

  private getActionPreview(action: ActionId): string[] {
    switch (action) {
      case "run-setup":
        return this.formatPreview([this.text("preview.runSetup")]);
      case "adopt-imports":
        return this.formatWritePreview(
          this.text("imports.preview"),
          this.callbacks.previewImports(this.discovery.imports.filter((entry) => this.selectedImports.has(entry.kind)).map((entry) => entry.kind)),
          [
            this.text("preview.detectedImports", {
              imports: this.discovery.imports.map((entry) => `${entry.kind} (${entry.serverCount})`).join(", "),
            }),
            this.text("preview.selectedImports"),
          ],
        );
      case "view-example":
        return this.formatPreview([
          this.text("preview.example"),
          "{",
          '  "mcpServers": {',
          '    "chrome-devtools": {',
          '      "command": "npx",',
          '      "args": ["-y", "chrome-devtools-mcp@latest"]',
          "    }",
          "  }",
          "}",
          "",
          this.text("preview.exampleHint"),
        ]);
      case "show-precedence":
        return this.formatPreview([
          this.text("preview.readOrder"),
          "1. ~/.config/mcp/mcp.json",
          "2. <Pi agent dir>/mcp.json",
          "3. .mcp.json",
          "4. .pi/mcp.json",
          this.text("preview.precedenceWrite"),
        ]);
      case "open-paths":
        return this.formatPreview(this.getDetectedPaths().length > 0
          ? [this.text("preview.detectedPaths"), ...this.getDetectedPaths()]
          : [this.text("preview.noPaths")]);
      case "add-repoprompt": {
        const repoPrompt = this.discovery.repoPrompt;
        const preview = this.callbacks.previewRepoPrompt();
        if (!preview) {
          return this.formatPreview([this.text("preview.repoUnavailable")]);
        }
        return this.formatWritePreview(
          this.text("preview.repoTitle"),
          preview,
          [
            this.text("preview.executable", { value: repoPrompt.executablePath ?? this.text("preview.notFound") }),
            this.text("preview.target", { value: repoPrompt.targetPath ?? this.text("preview.notApplicable") }),
            this.text("preview.serverName", { value: repoPrompt.serverName ?? "repoprompt" }),
          ],
        );
      }
      case "scaffold-project":
        return this.formatWritePreview(
          this.text("preview.starterTitle"),
          this.callbacks.previewStarterProject(),
          [this.text("preview.starterDetail"), this.text("preview.starterSafe")],
        );
      case "close":
      default:
        return this.formatPreview([this.text("preview.close")]);
    }
  }

  private formatPreview(lines: string[]): string[] {
    const preview: string[] = [];
    for (const line of lines) {
      preview.push(...wrapText(line, 74));
    }
    return preview;
  }

  private formatWritePreview(title: string, preview: ConfigWritePreview, intro: string[] = []): string[] {
    const lines: string[] = [];
    for (const line of intro) {
      lines.push(...wrapText(line, 74));
    }
    if (intro.length > 0) lines.push("");
    lines.push(...wrapText(`${title}: ${preview.path}`, 74));
    lines.push(...wrapText(preview.existed ? this.text("write.existing") : this.text("write.new"), 74));
    lines.push("");
    const diffLines = preview.diffText.split("\n");
    const maxLines = 18;
    const shown = diffLines.slice(0, maxLines);
    for (const line of shown) {
      lines.push(...wrapText(line, 74));
    }
    if (diffLines.length > maxLines) {
      lines.push(...wrapText(this.text("write.more", { count: diffLines.length - maxLines }), 74));
    }
    return lines;
  }

  private padLine(text: string, innerW: number): string {
    const inset = 2;
    const contentW = Math.max(0, innerW - inset * 2);
    const fitted = truncateToWidth(text, contentW, "…", true);
    const plainWidth = visibleWidth(fitted);
    const padding = Math.max(0, contentW - plainWidth);
    return `│${" ".repeat(inset)}${fitted}${" ".repeat(padding)}${" ".repeat(inset)}│`;
  }

  invalidate(): void {}

  dispose(): void {
    this.cleanup();
  }
}

export function createMcpSetupPanel(
  discovery: McpDiscoverySummary,
  callbacks: SetupPanelCallbacks,
  options: SetupPanelOptions,
  tui: { requestRender(): void },
  done: () => void,
): McpSetupPanel & { dispose(): void } {
  return new McpSetupPanel(discovery, callbacks, options, tui, done);
}
