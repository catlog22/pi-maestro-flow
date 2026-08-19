/**
 * McpxWizardOverlay — guided mcpx configuration based on the mcpx README
 * (configuration overview / security recommendations / client setup):
 *
 *   1. listen address (host + port)
 *   2. auth mode (open | bearer | oauth) — README: never `open` on public nets
 *   3. command policy default (allow | confirm | deny) — README recommends
 *      tightening to confirm/deny for shared or public deployments
 *   4. pi allow-rule (`^pi\b`) so pi_window/pi_execute work under strict policies
 *   5. skill discovery dirs (append the pi plugin skills dir when present)
 *   6. register the current workspace
 *   7. write confirmation (section-preserving merge into ~/.mcpx/config.yaml)
 *
 * Keys: ↑↓/jk select · ←→/1-3 pick · Enter confirm · Esc back/close · g regenerate token
 */
import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync, renameSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { Key, type Component, type Focusable, matchesKey, truncateToWidth } from "@earendil-works/pi-tui";
import { locateMcpx } from "../mcpx-bridge.ts";

export interface McpxWizardParams {
  cwd: string;
  requestRender: () => void;
  close: () => void;
}

export interface McpxConfigChanges {
  host?: string;
  port?: number;
  authMode?: "open" | "bearer" | "oauth";
  authToken?: string;
  oauthPassword?: string;
  oauthServerURL?: string;
  commandsDefault?: "allow" | "confirm" | "deny";
  allowPi?: boolean;
  skillDirs?: string[];
  registerWorkspace?: boolean;
  /** Public tunnel URL (Cloudflare or any reverse tunnel); enables the proxy flags. */
  tunnelUrl?: string;
}

type WizardStep =
  | "listen"
  | "policy"
  | "pi"
  | "skills"
  | "workspace"
  | "tunnel"
  | "write";

const STEP_ORDER: WizardStep[] = ["listen", "policy", "pi", "skills", "workspace", "tunnel", "write"];
const STEP_LABEL: Record<WizardStep, string> = {
  listen: "1/7 监听地址",
  policy: "2/7 命令策略",
  pi: "3/7 Pi 白名单",
  skills: "4/7 Skill 发现目录",
  workspace: "5/7 工作区注册",
  tunnel: "6/7 公网隧道（Cloudflare）",
  write: "7/7 写入确认",
};

interface Section {
  key: string;
  raw: string;
}

function splitSections(text: string): Section[] {
  const sections: Section[] = [];
  let current: Section | undefined;
  for (const line of text.split(/\r?\n/)) {
    // Top-level keys are anchored at column 0 (indented keys do not match).
    const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*):\s*$/);
    if (match) {
      if (current) sections.push(current);
      current = { key: match[1], raw: line };
      continue;
    }
    if (current) current.raw += "\n" + line;
  }
  if (current) sections.push(current);
  return sections;
}

function parseListItems(section: Section | undefined, key: string): string[] {
  if (!section) return [];
  const items: string[] = [];
  const pattern = new RegExp(`^\\s*${key}:\\s*$`, "m");
  const start = section.raw.search(pattern);
  if (start < 0) return [];
  const rest = section.raw.slice(start);
  const lines = rest.split(/\r?\n/).slice(1);
  for (const line of lines) {
    const match = line.match(/^\s{2,}-\s+(.+?)\s*$/);
    if (match) {
      items.push(match[1].trim());
    } else if (/^\s*[A-Za-z_][A-Za-z0-9_]*:\s*$/.test(line)) {
      // next mapping key (any indent) ends the list
      break;
    } else if (/^\s*\S/.test(line) && !/^\s{2,}/.test(line)) {
      // top-level key ends the section list
      break;
    }
  }
  return items;
}

function listBlock(items: string[], indent: string): string {
  return items.map((item) => `${indent}- ${item}`).join("\n");
}

function indentLines(text: string, indent: string): string {
  return text.split("\n").map((line) => (line === "" ? line : indent + line)).join("\n");
}

function buildChangesYaml(existing: string, changes: McpxConfigChanges, cwd: string): { yaml: string; summary: string[] } {
  const sections = splitSections(existing);
  const summary: string[] = [];
  const get = (key: string) => sections.find((section) => section.key === key);
  const set = (key: string, raw: string) => {
    const found = get(key);
    if (found) found.raw = raw;
    else sections.push({ key, raw });
  };
  const mergeList = (sectionKey: string, listKey: string, additions: string[]): string[] => {
    const current = parseListItems(get(sectionKey), listKey);
    for (const addition of additions) {
      if (!current.includes(addition)) current.push(addition);
    }
    return current;
  };

  // 1. server
  if (changes.host !== undefined || changes.port !== undefined) {
    const host = changes.host ?? (/^\s{4}host:\s*(.+)$/m.exec(get("server")?.raw ?? "")?.[1]?.trim() ?? "127.0.0.1");
    const port = changes.port ?? (Number(/^\s{4}port:\s*(\d+)/m.exec(get("server")?.raw ?? "")?.[1]) || 9090);
    set("server", [
      "server:",
      `    host: ${host}`,
      `    port: ${port}`,
    ].join("\n"));
    summary.push(`监听: ${host}:${port}`);
  }

  // 2. auth
  if (changes.authMode) {
    const lines = ["auth:", `    mode: ${changes.authMode}`];
    if (changes.authMode === "bearer") {
      lines.push(`    token: "${changes.authToken ?? ""}"`);
    } else if (changes.authMode === "oauth") {
      lines.push(`    token: ""`);
      lines.push("    oauth:");
      lines.push(`        password: "${changes.oauthPassword ?? ""}"`);
      lines.push(`        server_url: "${changes.oauthServerURL ?? ""}"`);
      lines.push(`        token_ttl: 86400`);
    } else {
      lines.push(`    token: ""`);
    }
    set("auth", lines.join("\n"));
    summary.push(`认证: ${changes.authMode}${changes.authMode === "bearer" ? `（token 已生成）` : changes.authMode === "oauth" ? "（password + server_url）" : ""}`);
  }

  // server flags for remote deployments (oauth or any public tunnel)
  if (changes.authMode === "oauth" || changes.tunnelUrl) {
    const patch = (flag: string, value: string) => {
      const current = get("server")?.raw ?? "server:";
      const pattern = new RegExp(`^\\s{4}${flag}:.*$`, "m");
      const next = pattern.test(current) ? current.replace(pattern, `    ${flag}: ${value}`) : `${current}\n    ${flag}: ${value}`;
      set("server", next);
    };
    patch("disable_localhost_protection", "true");
    patch("trust_proxy_headers", "true");
    summary.push("已启用隧道代理标志（disable_localhost_protection + trust_proxy_headers）");
  }

  // A public tunnel with open auth would be exposed unauthenticated: upgrade to
  // oauth with the tunnel URL as server_url (password stays editable later).
  if (changes.tunnelUrl && (!changes.authMode || changes.authMode === "open")) {
    set("auth", [
      "auth:",
      "    mode: oauth",
      `    token: ""`,
      "    oauth:",
      `        password: "${changes.oauthPassword ?? ""}"`,
      `        server_url: "${changes.tunnelUrl}"`,
      `        token_ttl: 86400`,
    ].join("\n"));
    summary.push(`公网暴露下认证已升级为 oauth（server_url: ${changes.tunnelUrl}）`);
  }

  // 3. security.commands default + pi allow rule
  if (changes.commandsDefault || changes.allowPi) {
    const securityLines = (get("security")?.raw ?? "security:").split(/\r?\n/);
    const commandsStart = securityLines.findIndex((line) => /^    commands:\s*$/.test(line));
    let commandsBlockLines: string[] = [];
    if (commandsStart >= 0) {
      let end = commandsStart + 1;
      while (end < securityLines.length
        && !/^    [A-Za-z_]/.test(securityLines[end])
        && !/^[A-Za-z_]/.test(securityLines[end])) {
        end++;
      }
      commandsBlockLines = securityLines.slice(commandsStart, end);
    }
    const defaultLine = changes.commandsDefault
      ?? (commandsBlockLines.find((line) => /^\s{8}default:/.test(line))?.match(/default:\s*(.+)/)?.[1]?.trim() ?? "allow");
    const allow = changes.allowPi
      ? mergeList("security", "allow", ["^pi\\b"])
      : parseListItems(get("security"), "allow");
    const confirm = parseListItems(get("security"), "confirm");
    const deny = parseListItems(get("security"), "deny");
    const autoReadonly = commandsBlockLines.find((line) => /^\s{8}auto_allow_readonly:/.test(line))
      ?.match(/auto_allow_readonly:\s*(.+)/)?.[1]?.trim();
    const commands = [
      "    commands:",
      `        default: ${defaultLine}`,
      allow.length > 0 ? `        allow:\n${listBlock(allow, "            ")}` : "        allow: []",
      confirm.length > 0 ? `        confirm:\n${listBlock(confirm, "            ")}` : "        confirm: []",
      deny.length > 0 ? `        deny:\n${listBlock(deny, "            ")}` : "        deny: []",
      autoReadonly !== undefined ? `        auto_allow_readonly: ${autoReadonly}` : "",
    ].filter(Boolean).join("\n");
    const restLines = commandsStart >= 0
      ? [...securityLines.slice(0, commandsStart), ...securityLines.slice(commandsStart + commandsBlockLines.length)]
      : securityLines;
    set("security", [...restLines.filter((line) => line.trim() !== ""), commands].join("\n"));
    if (changes.commandsDefault) summary.push(`命令默认策略: ${changes.commandsDefault}`);
    if (changes.allowPi) summary.push("已添加 Pi 白名单 ^pi\\b");
  }

  // 4. skill discovery dirs
  if (changes.skillDirs && changes.skillDirs.length > 0) {
    const discoveryRaw = get("discovery")?.raw ?? "discovery:";
    const existingDirs = parseListItems(get("discovery"), "dirs");
    const merged = [...existingDirs];
    for (const dir of changes.skillDirs) {
      if (!merged.includes(dir)) merged.push(dir);
    }
    const lines = [
      "discovery:",
      "    mcp:",
      `        enabled: ${/^\s{8}enabled:\s*(true|false)$/m.exec(discoveryRaw)?.[1] ?? "true"}`,
      "    skills:",
      "        enabled: true",
      merged.length > 0 ? `        dirs:\n${listBlock(merged, "            ")}` : "        dirs: []",
    ];
    set("discovery", lines.join("\n"));
    for (const dir of changes.skillDirs) {
      if (!existingDirs.includes(dir)) summary.push(`Skill 目录: ${dir}`);
    }
  }

  const yaml = sections.map((section) => section.raw.trimEnd()).join("\n").trim() + "\n";
  return { yaml, summary };
}

export class McpxWizardOverlay implements Component, Focusable {
  focused = false;
  private step: WizardStep = "listen";
  private selected = 0;
  private editing = false;
  private draft = "";
  private status = "";
  private tunnelProcess: ReturnType<typeof spawn> | undefined;
  private tunnelOutput = "";

  private tunnelPidPath(): string {
    return join(homedir(), ".mcpx", "cloudflared.pid");
  }
  private changes: McpxConfigChanges = {};
  private generatedToken = "";
  private readonly existingConfig: string;

  constructor(private readonly params: McpxWizardParams) {
    let existing = "";
    try {
      existing = readFileSync(this.configPath(), "utf8");
    } catch {
      // first-run: no config yet
    }
    this.existingConfig = existing;
    this.generatedToken = this.newToken();
  }

  private configPath(): string {
    return join(homedir(), ".mcpx", "config.yaml");
  }

  private newToken(): string {
    return `mcpx_${randomBytes(18).toString("hex")}`;
  }

  invalidate(): void {}
  dispose(): void {}

  render(width: number): string[] {
    const safeWidth = Math.max(1, Math.min(width, 120));
    const inner = safeWidth - 2;
    const rows = [fitLine(`MCPX 配置向导 · ${STEP_LABEL[this.step]}`, inner), rule(inner)];
    rows.push(...this.renderStep(inner));
    if (this.status) rows.push(fitLine(fg("33", this.status), inner));
    rows.push(fitSegments(inner, this.controls()));
    return frame(rows, safeWidth);
  }

  private controls(): string[] {
    if (this.editing) return ["Enter 确认输入", "Esc 取消输入"];
    const base = ["↑↓/jk 选择", "Enter 确认", "Esc 返回"];
    if (this.step === "tunnel") base.push("g 启动隧道", "x 停止隧道");
    if (this.step === "write") base.push("w 写入配置");
    return base;
  }

  private renderStep(inner: number): string[] {
    const option = (index: number, label: string, hint = "") =>
      fitLine(`${this.selected === index && !this.editing ? "›" : " "} ${label}${hint ? `  ${fg("2", hint)}` : ""}`, inner);
    switch (this.step) {
      case "listen":
        return [
          fitLine("监听地址（默认 127.0.0.1:9090；公网部署勿直接暴露）", inner),
          option(0, `host: ${this.editing && this.selected === 0 ? this.draft + "▌" : (this.changes.host ?? "127.0.0.1")}`),
          option(1, `port: ${this.editing && this.selected === 1 ? this.draft + "▌" : (this.changes.port ?? 9090)}`),
          option(2, "→ 下一步（命令策略）"),
        ];
      case "policy":
        return [
          fitLine("命令默认策略 — README：共享/公网环境建议 confirm 或 deny", inner),
          option(0, "allow", "默认宽松（出厂默认）"),
          option(1, "confirm", "未知命令需确认（保守推荐）"),
          option(2, "deny", "未知命令拒绝（最严）"),
        ];
      case "pi":
        return [
          fitLine("Pi 白名单：向 security.commands.allow 添加 ^pi\\b（pi_window/pi_execute 需要）", inner),
          option(0, "添加", "推荐"),
          option(1, "不添加"),
        ];
      case "skills": {
        const detected = this.detectPiSkillsDir() ?? "未检测到 .pi/skills";
        return [
          fitLine(`Skill 发现目录：追加 Pi 插件 skill 目录（detected: ${detected}）`, inner),
          option(0, "追加", detected === "未检测到 .pi/skills" ? "（未检测到目录，可跳过）" : `追加 ${detected}`),
          option(1, "跳过"),
        ];
      }
      case "workspace":
        return [
          fitLine(`注册当前工作区到 mcpx（${this.params.cwd}）`, inner),
          option(0, "注册", "推荐"),
          option(1, "跳过"),
        ];
      case "tunnel": {
        const hasCloudflared = isExecutableOnPath("cloudflared");
        const cloudflared = hasCloudflared ? fg("32", "✓ 已安装") : fg("31", "✗ 未安装");
        const running = this.tunnelProcess
          ? fg("32", `运行中${this.changes.tunnelUrl ? ` · ${this.changes.tunnelUrl}` : "（等待 URL…）"}`)
          : fg("2", "未运行");
        return [
          fitLine(`公网隧道（Cloudflare Quick Tunnel）— cloudflared ${cloudflared}`, inner),
          fitLine(`  唯一模式：启动后自动绑定本地端口并生成公网 URL，无需手动填写`, inner),
          fitLine(`  状态: ${running}`, inner),
          option(0, this.tunnelProcess ? "重启隧道" : "启动隧道", "Enter/g 自动获取 URL"),
          option(1, "→ 下一步（写入确认）", "需隧道已启动"),
          fitLine("  提示: Enter/g 启动 · x 停止 · Esc 返回", inner),
        ];
      }
      case "write": {
        const { summary } = this.build();
        const rows = [
          fitLine("将写入 ~/.mcpx/config.yaml（保留未修改的 section）：", inner),
          ...summary.map((line) => fitLine(`  · ${line}`, inner)),
        ];
        rows.push(rule(inner));
        rows.push(...this.renderConnectPreview(inner));
        rows.push(rule(inner));
        rows.push(fitLine("Enter 回到步骤 · w 写入并保存", inner));
        return rows;
      }
    }
  }

  /** Cloud/MCP client connection card (ChatGPT 'new plugin' style fields). */
  private renderConnectPreview(inner: number): string[] {
    const port = this.changes.port ?? 9090;
    const tunnelUrl = this.changes.tunnelUrl?.trim();
    const baseUrl = tunnelUrl ?? `http://127.0.0.1:${port}`;
    const auth = tunnelUrl
      ? (this.changes.authMode === "bearer" ? "Bearer" : "OAuth（自动升级）")
      : (this.changes.authMode === "bearer" ? "Bearer" : (this.changes.authMode === "oauth" ? "OAuth" : "open（仅本机）"));
    const rows = [fitLine("云端 MCP 连接信息（照此填入 ChatGPT / Claude 新建连接）：", inner)];
    rows.push(fitLine(`  名称: mcpx for pmf`, inner));
    rows.push(fitLine(`  连接: ${tunnelUrl ? "服务器 URL" : "服务器 URL（本机调试）"}`, inner));
    rows.push(fitLine(`  服务器 URL: ${baseUrl}/mcp`, inner));
    rows.push(fitLine(`  身份验证: ${auth}`, inner));
    if (tunnelUrl) {
      if (auth === "OAuth（自动升级）") {
        rows.push(fitLine("  → 填 URL 后 ChatGPT 会自动发现 OAuth（.well-known 端点已就绪），无需手动配置", inner));
      } else if (auth === "Bearer") {
        rows.push(fitLine("  → 需在客户端 Header 添加 Authorization: Bearer <token>", inner));
      }
      rows.push(fitLine("  → 名称/描述可自定义；风险提示确认后即可连接", inner));
    } else {
      rows.push(fitLine("  → 公网客户端不可达本机地址；启动隧道后 URL 自动变为 https://…/mcp", inner));
    }
    return rows;
  }

  private detectPiSkillsDir(): string | undefined {
    // Best-effort: the pi plugin skills live under {repo}/.pi/skills; the cwd is
    // the most likely repo root, otherwise fall back to known check.
    const candidates = [
      join(this.params.cwd, ".pi", "skills"),
      join(this.params.cwd, "..", ".pi", "skills"),
    ];
    return candidates.find((candidate) => existsSync(candidate));
  }

  handleInput(data: string): void {
    if (matchesKey(data, Key.escape)) {
      if (this.editing) {
        this.editing = false;
        this.draft = "";
      } else if (this.step === "write") {
        this.step = "workspace";
      } else if (this.step === "listen") {
        this.params.close();
      } else if (this.step === "tunnel") {
        this.step = "workspace";
      } else if (this.step === "workspace") {
        this.step = "skills";
      } else if (this.step === "skills") {
        this.step = "pi";
      } else if (this.step === "pi") {
        this.step = "policy";
      } else {
        this.step = "listen";
      }
      this.params.requestRender();
      return;
    }
    if (this.editing) {
      this.handleEditing(data);
      return;
    }
    if (matchesKey(data, Key.up) || matchesKey(data, "k")) {
      this.selected = Math.max(0, this.selected - 1);
      this.params.requestRender();
      return;
    }
    if (matchesKey(data, Key.down) || matchesKey(data, "j")) {
      this.selected = Math.min(this.stepOptions() - 1, this.selected + 1);
      this.params.requestRender();
      return;
    }
    if (data === "g" && this.step === "tunnel") {
      void this.startQuickTunnel();
      return;
    }
    if (data === "x" && this.step === "tunnel") {
      void this.stopTunnel();
      return;
    }
    if (isEnter(data)) {
      this.confirm();
      return;
    }
    if (data === "w" && this.step === "write") {
      void this.write();
    }
  }

  private stepOptions(): number {
    switch (this.step) {
      case "listen": return 3;
      case "policy": return 3;
      case "pi": return 2;
      case "skills": return 2;
      case "workspace": return 2;
      case "tunnel": return 2;
      default: return 1;
    }
  }

  private handleEditing(data: string): void {
    if (isEnter(data)) {
      if (this.step === "listen") {
        if (this.selected === 0) this.changes.host = this.draft || "127.0.0.1";
        else {
          const port = Number(this.draft);
          this.changes.port = Number.isInteger(port) && port > 0 && port < 65536 ? port : 9090;
        }
      }
      this.editing = false;
      this.draft = "";
      this.params.requestRender();
      return;
    }
    if (matchesKey(data, Key.backspace)) {
      this.draft = this.draft.slice(0, -1);
    } else if (data.length === 1 && data >= " " && data !== "\x7f") {
      this.draft = (this.draft + data).slice(0, 200);
    }
    this.params.requestRender();
  }

  private confirm(): void {
    switch (this.step) {
      case "listen":
        if (this.selected === 2) {
          this.step = "policy";
          break;
        }
        if (this.selected === 0) {
          this.editing = true;
          this.draft = this.changes.host ?? "127.0.0.1";
        } else {
          this.editing = true;
          this.draft = String(this.changes.port ?? 9090);
        }
        break;
      case "policy":
        this.changes.commandsDefault = (["allow", "confirm", "deny"] as const)[this.selected];
        this.step = "pi";
        break;
      case "pi":
        this.changes.allowPi = this.selected === 0;
        this.step = "skills";
        break;
      case "skills":
        this.changes.skillDirs = this.selected === 0 ? [this.detectPiSkillsDir()].filter((dir): dir is string => Boolean(dir)) : [];
        this.step = "workspace";
        break;
      case "workspace":
        this.changes.registerWorkspace = this.selected === 0;
        this.step = "tunnel";
        break;
      case "tunnel":
        if (this.selected === 1) {
          const url = this.changes.tunnelUrl?.trim() ?? "";
          if (!/^https?:\/\//.test(url)) {
            this.status = "请先启动隧道获取公网 URL（Enter/g）";
            this.params.requestRender();
            break;
          }
          this.step = "write";
          break;
        }
        // Quick Tunnel (selected 0): Enter starts cloudflared, parses the URL.
        void this.startQuickTunnel();
        break;
      case "write":
        this.step = "workspace";
        break;
    }
    // Editing branches keep the selected row so the draft cursor stays visible.
    if (!this.editing) this.selected = 0;
    this.status = "";
    this.params.requestRender();
  }

  /** Start a Cloudflare quick tunnel bound to the local mcpx port and parse the generated URL. */
  private async startQuickTunnel(): Promise<void> {
    if (this.tunnelProcess) {
      this.status = this.changes.tunnelUrl ? `隧道运行中: ${this.changes.tunnelUrl}` : "隧道正在启动…";
      this.params.requestRender();
      return;
    }
    if (!isExecutableOnPath("cloudflared")) {
      this.status = "未找到 cloudflared — 安装: winget install --id Cloudflare.cloudflared（Windows）/ brew install cloudflared（macOS）/ 官网安装包（Linux）";
      this.params.requestRender();
      return;
    }
    this.status = "正在启动 cloudflared 隧道…";
    this.tunnelOutput = "";
    this.params.requestRender();
    try {
      const child = spawn("cloudflared", ["tunnel", "--url", `http://127.0.0.1:${this.changes.port ?? 9090}`], {
        detached: true,
        stdio: ["ignore", "pipe", "pipe"],
        shell: process.platform === "win32",
      });
      child.unref();
      this.tunnelProcess = child;
      child.stdout?.on("data", (chunk: Buffer) => this.onTunnelOutput(chunk.toString()));
      child.stderr?.on("data", (chunk: Buffer) => this.onTunnelOutput(chunk.toString()));
      try {
        writeFileSync(this.tunnelPidPath(), String(child.pid ?? ""), "utf8");
      } catch {
        // best-effort
      }
      const deadline = Date.now() + 30_000;
      while (Date.now() < deadline && !this.changes.tunnelUrl && this.tunnelProcess) {
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
      if (this.changes.tunnelUrl) {
        this.status = `隧道已就绪: ${this.changes.tunnelUrl}`;
      } else {
        this.status = "隧道已启动但未取得 URL（检查 cloudflared 输出；可稍后在 URL 项手动填写）";
      }
    } catch (error) {
      this.status = `隧道启动失败: ${error instanceof Error ? error.message : String(error)}`;
    }
    this.params.requestRender();
  }

  private onTunnelOutput(chunk: string): void {
    this.tunnelOutput = (this.tunnelOutput + chunk).slice(-16_384);
    const match = this.tunnelOutput.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/);
    if (match && !this.changes.tunnelUrl) {
      this.changes.tunnelUrl = match[0];
      this.params.requestRender();
    }
  }

  /** Stop the cloudflared tunnel and clear its PID file. */
  private async stopTunnel(): Promise<void> {
    let pid: number | undefined = this.tunnelProcess?.pid;
    if (!pid) {
      try {
        const raw = readFileSync(this.tunnelPidPath(), "utf8").trim();
        const parsed = Number(raw);
        if (Number.isInteger(parsed) && parsed > 0) pid = parsed;
      } catch {
        // no pid file
      }
    }
    if (!pid) {
      this.status = "未找到 cloudflared 进程";
      this.params.requestRender();
      return;
    }
    try {
      if (process.platform === "win32") {
        spawnSync("taskkill", ["/pid", String(pid), "/T", "/F"], { stdio: "ignore" });
      } else if (this.tunnelProcess && !this.tunnelProcess.killed) {
        this.tunnelProcess.kill();
      } else {
        process.kill(pid, "SIGTERM");
      }
      this.status = "已停止 cloudflared 隧道";
    } catch (error) {
      this.status = `停止隧道失败: ${error instanceof Error ? error.message : String(error)}`;
    }
    this.tunnelProcess = undefined;
    try {
      rmSync(this.tunnelPidPath(), { force: true });
    } catch {
      // best-effort
    }
    this.params.requestRender();
  }

  private build(): { yaml: string; summary: string[] } {
    return buildChangesYaml(this.existingConfig, this.changes, this.params.cwd);
  }

  private async write(): Promise<void> {
    if (this.status === "写入中…") return;
    this.status = "写入中…";
    this.params.requestRender();
    try {
      const { yaml } = this.build();
      const path = this.configPath();
      const temp = `${path}.wizard.tmp`;
      writeFileSync(temp, yaml, "utf8");
      renameSync(temp, path);
      if (this.changes.registerWorkspace) {
        const binary = locateMcpx();
        if (binary) {
          spawnSync(binary, ["workspace", "register", this.params.cwd], {
            encoding: "utf8", timeout: 15_000, shell: process.platform === "win32",
          });
        }
      }
      this.status = "已写入 " + path + " — 重启 mcpx 后生效（窗口/wizard 亦可用 /mcpx 查看）";
      this.params.requestRender();
    } catch (error) {
      this.status = `写入失败: ${error instanceof Error ? error.message : String(error)}`;
      this.params.requestRender();
    }
  }
}

// --- private TUI helpers (sibling-overlay convention) ---

function fitLine(value: string, width: number): string {
  return truncateToWidth(value, width, "…").padEnd(width, " ");
}

function rule(width: number): string {
  return "─".repeat(Math.max(0, width));
}

function frame(rows: readonly string[], width: number): string[] {
  return [`┌${"─".repeat(Math.max(0, width))}┐`, ...rows.map((row) => `│${row}│`), `└${"─".repeat(Math.max(0, width))}┘`];
}

function fitSegments(width: number, segments: readonly string[]): string {
  return fitLine(segments.join("  ·  "), width);
}

function fg(code: string, text: string): string {
  return `\x1b[${code}m${text}\x1b[0m`;
}

function isEnter(data: string): boolean {
  return matchesKey(data, Key.enter);
}

/** Fold duplicated URL schemes (https://https://…) and trim. */
function normalizeUrl(value: string): string {
  const trimmed = value.trim();
  const scheme = trimmed.match(/^(https?:\/\/)/)?.[1] ?? "";
  const rest = trimmed.replace(/^(https?:\/\/)+/, "");
  return rest ? `${scheme}${rest}` : "";
}

function isExecutableOnPath(command: string): boolean {
  const probe = spawnSync(process.platform === "win32" ? "where" : "which", [command], {
    encoding: "utf8",
    timeout: 5_000,
    shell: process.platform === "win32",
  });
  return probe.status === 0;
}

export const _mcpxWizardInternals = {
  splitSections,
  parseListItems,
  buildChangesYaml,
};
