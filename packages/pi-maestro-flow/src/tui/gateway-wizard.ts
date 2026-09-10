/**
 * GatewayWizardOverlay — guided configuration for the built-in Pi Maestro Gateway:
 *
 *   1. listen address (host + port)
 *   2. command policy default (allow | confirm | deny) — README recommends
 *      tightening to confirm/deny for shared or public deployments
 *   3. pi allow-rule (`^pi\b`) so pi_window/pi_execute work under strict policies
 *   4. skill discovery dirs (append the pi plugin skills dir when present)
 *   5. register the current workspace (lease-based via the /gateway panel; here
 *      the write step just merges config sections)
 *   6. public tunnel (Cloudflare Quick Tunnel; OpenAI is shown as experimental)
 *   7. write confirmation (section-preserving merge into the native Gateway config)
 *
 * Keys: ↑↓/jk select · Enter confirm · Esc back/close · g start tunnel · x stop tunnel
 */
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Key, type Component, type Focusable, matchesKey, truncateToWidth } from "@earendil-works/pi-tui";
import { readTunnelState, startQuickTunnel as startCloudflareQuickTunnel, stopQuickTunnel as stopCloudflareQuickTunnel, writeGatewayConfigChanges } from "../gateway/workspace-client.ts";
import { gatewayConfigPath } from "../gateway/state-paths.ts";

export interface GatewayWizardParams {
  cwd: string;
  requestRender: () => void;
  close: () => void;
}

export interface GatewayConfigChanges {
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
  /** server.disable_localhost_protection / trust_proxy_headers (inline editor). */
  disableLocalhostProtection?: boolean;
  trustProxyHeaders?: boolean;
  /** security.commands allow/confirm/deny rule lists (inline editor). */
  commandsAllow?: string[];
  commandsConfirm?: string[];
  commandsDeny?: string[];
  commandsAutoReadonly?: boolean | null;
  /** security.files permission limits and rule lists (inline editor). */
  filesMaxReadBytes?: number;
  filesMaxPatchFiles?: number;
  filesAllow?: string[];
  filesConfirm?: string[];
  filesDeny?: string[];
  /** Experimental OpenAI tunnel provider configuration. Values are env names, never secrets. */
  openAiTunnelEnabled?: boolean;
  openAiTunnelBinaryPath?: string;
  openAiTunnelIdEnv?: string;
  openAiRuntimeKeyEnv?: string;
  openAiMinimumVersion?: string;
  openAiCredentialTtlMs?: number;
}

type WizardStep =
  | "listen"
  | "policy"
  | "pi"
  | "skills"
  | "workspace"
  | "tunnel"
  | "write";

const STEP_LABEL: Record<WizardStep, string> = {
  listen: "1/7 监听地址",
  policy: "2/7 命令策略",
  pi: "3/7 Pi 白名单",
  skills: "4/7 Skill 发现目录",
  workspace: "5/7 工作区注册",
  tunnel: "6/7 公网隧道（Cloudflare / OpenAI experimental）",
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
    // Scalar sections such as `version: 2` must survive canonical rewrites too.
    const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*):(?:\s.*)?$/);
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

/** Extract the `files:` sub-block (indented under security) as a standalone text
 *  blob so its allow/confirm/deny lists can be parsed independently of the
 *  sibling `commands:` lists that share the same list keys. */
function extractFilesBlock(securityRaw: string): string {
  const lines = securityRaw.split(/\r?\n/);
  const start = lines.findIndex((line) => /^    files:\s*$/.test(line));
  if (start < 0) return "";
  let end = start + 1;
  while (end < lines.length
    && !/^    [A-Za-z_]/.test(lines[end])
    && !/^[A-Za-z_]/.test(lines[end])) {
    end++;
  }
  return lines.slice(start, end).join("\n");
}

/** Parse a `- item` list anchored under a given key inside a sub-block blob. */
function parseSubList(block: string, key: string): string[] {
  if (!block) return [];
  const items: string[] = [];
  const pattern = new RegExp(`^\\s*${key}:\\s*$`, "m");
  const start = block.search(pattern);
  if (start < 0) return [];
  const rest = block.slice(start).split(/\r?\n/).slice(1);
  for (const line of rest) {
    const match = line.match(/^\s{2,}-\s+(.+?)\s*$/);
    if (match) {
      items.push(match[1]!.trim());
    } else if (/^\s*[A-Za-z_][A-Za-z0-9_]*:\s*$/.test(line)) {
      break;
    } else if (/^\S/.test(line)) {
      break;
    }
  }
  return items;
}

function indentLines(text: string, indent: string): string {
  return text.split("\n").map((line) => (line === "" ? line : indent + line)).join("\n");
}

/** Escape a string for a YAML double-quoted scalar (backslash, quote, newline). */
function yamlDoubleQuote(value: string): string {
  return '"' + String(value ?? '').replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\r?\n/g, '\\n') + '"';
}

function readYamlScalar(section: string, key: string, indent: number): string | undefined {
  const patterns = [
    new RegExp(`^[ \\t]{${indent}}${key}:\\s*(.*)$`, "m"),
    new RegExp(`^[ \\t]{2,}${key}:\\s*(.*)$`, "m"),
  ];
  const match = patterns.map((pattern) => section.match(pattern)).find(Boolean);
  if (!match) return undefined;
  const raw = match[1]!.trim();
  if (raw.startsWith("\"") && raw.endsWith("\"")) {
    try { return JSON.parse(raw); } catch { return raw.slice(1, -1); }
  }
  return raw.replace(/\s+#.*$/, "").trim();
}

function patchYamlScalar(section: string, key: string, value: string, fallbackIndent = "    "): string {
  const pattern = new RegExp(`^([ \\t]{2,})${key}:.*$`, "m");
  const match = section.match(pattern);
  if (match) return section.replace(pattern, `${match[1]}${key}: ${value}`);
  const childLine = section.split(/\r?\n/).find((line) => /^[ \t]{2,}\S/.test(line));
  const childIndent = childLine?.match(/^[ \t]+/)?.[0] ?? fallbackIndent;
  return `${section}\n${childIndent}${key}: ${value}`;
}

export function buildGatewayChangesYaml(existing: string, changes: GatewayConfigChanges, cwd: string): { yaml: string; summary: string[] } {
  const sections = splitSections(existing);
  if (!sections.some((section) => section.key === "version")) sections.unshift({ key: "version", raw: "version: 2" });
  const summary: string[] = [];
  const get = (key: string) => sections.find((section) => section.key === key);
  const existingAuth = get("auth")?.raw ?? "";
  const existingAuthToken = readYamlScalar(existingAuth, "token", 4) ?? "";
  const existingOauthPassword = readYamlScalar(existingAuth, "password", 8) ?? "";
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
    const current = get("server")?.raw ?? "server:";
    const host = changes.host ?? readYamlScalar(current, "host", 4) ?? "127.0.0.1";
    const port = changes.port ?? (Number(readYamlScalar(current, "port", 4)) || 9090);
    let next = patchYamlScalar(current, "host", yamlDoubleQuote(host));
    next = patchYamlScalar(next, "port", String(port));
    set("server", next);
    summary.push(`监听: ${host}:${port}`);
  }

  // 2. auth
  if (changes.authMode) {
    const lines = ["auth:", `    mode: ${changes.authMode}`];
    if (changes.authMode === "bearer") {
      lines.push(`    token: ${yamlDoubleQuote(changes.authToken ?? existingAuthToken)}`);
    } else if (changes.authMode === "oauth") {
      lines.push(`    token: ""`);
      lines.push("    oauth:");
      lines.push(`        password: ${yamlDoubleQuote(changes.oauthPassword ?? existingOauthPassword)}`);
      lines.push(`        server_url: ${yamlDoubleQuote(changes.oauthServerURL ?? "")}`);
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
      set("server", patchYamlScalar(current, flag, value));
    };
    patch("disable_localhost_protection", "true");
    patch("trust_proxy_headers", "true");
    summary.push("已启用隧道代理标志（disable_localhost_protection + trust_proxy_headers）");
  }
  // Inline-editor overrides for the two server flags. These run AFTER the
  // derived block above so an explicit inline edit wins over the tunnel-derived
  // default (e.g. user can turn trust_proxy_headers back off while keeping oauth).
  if (changes.disableLocalhostProtection !== undefined) {
    const current = get("server")?.raw ?? "server:";
    set("server", patchYamlScalar(current, "disable_localhost_protection", String(changes.disableLocalhostProtection)));
    summary.push(`disable_localhost_protection: ${changes.disableLocalhostProtection}`);
  }
  if (changes.trustProxyHeaders !== undefined) {
    const current = get("server")?.raw ?? "server:";
    set("server", patchYamlScalar(current, "trust_proxy_headers", String(changes.trustProxyHeaders)));
    summary.push(`trust_proxy_headers: ${changes.trustProxyHeaders}`);
  }

  // A public tunnel with open auth would be exposed unauthenticated: upgrade to
  // oauth with the tunnel URL as server_url (password stays editable later).
  if (changes.tunnelUrl && (!changes.authMode || changes.authMode === "open")) {
    set("auth", [
      "auth:",
      "    mode: oauth",
      `    token: ""`,
      "    oauth:",
      `        password: ${yamlDoubleQuote(changes.oauthPassword ?? existingOauthPassword)}`,
      `        server_url: ${yamlDoubleQuote(changes.tunnelUrl)}`,
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

  // 4. security.commands allow/confirm/deny lists + auto_allow_readonly (inline editor)
  if (changes.commandsAllow !== undefined || changes.commandsConfirm !== undefined || changes.commandsDeny !== undefined || changes.commandsAutoReadonly !== undefined) {
    const allow = changes.commandsAllow !== undefined ? changes.commandsAllow : parseListItems(get("security"), "allow");
    const confirm = changes.commandsConfirm !== undefined ? changes.commandsConfirm : parseListItems(get("security"), "confirm");
    const deny = changes.commandsDeny !== undefined ? changes.commandsDeny : parseListItems(get("security"), "deny");
    const defaultLine = changes.commandsDefault
      ?? (get("security")?.raw.match(/^\s{8}default:\s*(.+)$/m)?.[1]?.trim() ?? "allow");
    // auto_allow_readonly: null/true/false all valid YAML; undefined = preserve existing.
    const autoReadonly = changes.commandsAutoReadonly !== undefined
      ? (changes.commandsAutoReadonly === null ? "null" : String(changes.commandsAutoReadonly))
      : (get("security")?.raw.match(/^\s{8}auto_allow_readonly:\s*(.+)$/m)?.[1]?.trim() ?? "null");
    const commands = [
      "    commands:",
      `        default: ${defaultLine}`,
      allow.length > 0 ? `        allow:\n${listBlock(allow, "            ")}` : "        allow: []",
      confirm.length > 0 ? `        confirm:\n${listBlock(confirm, "            ")}` : "        confirm: []",
      deny.length > 0 ? `        deny:\n${listBlock(deny, "            ")}` : "        deny: []",
      `        auto_allow_readonly: ${autoReadonly}`,
    ].join("\n");
    // Replace the commands block inside the security section, preserving other security children.
    const securityLines = (get("security")?.raw ?? "security:").split(/\r?\n/);
    const commandsStart = securityLines.findIndex((line) => /^    commands:\s*$/.test(line));
    let restLines: string[];
    let filesBlockLines: string[] = [];
    if (commandsStart >= 0) {
      let end = commandsStart + 1;
      while (end < securityLines.length
        && !/^    [A-Za-z_]/.test(securityLines[end])
        && !/^[A-Za-z_]/.test(securityLines[end])) {
        end++;
      }
      restLines = [...securityLines.slice(0, commandsStart), ...securityLines.slice(end)];
    } else {
      restLines = securityLines;
    }
    set("security", [...restLines.filter((line) => line.trim() !== ""), commands].join("\n"));
    if (changes.commandsAllow !== undefined) summary.push(`commands.allow: ${changes.commandsAllow.length} 条`);
    if (changes.commandsConfirm !== undefined) summary.push(`commands.confirm: ${changes.commandsConfirm.length} 条`);
    if (changes.commandsDeny !== undefined) summary.push(`commands.deny: ${changes.commandsDeny.length} 条`);
    if (changes.commandsAutoReadonly !== undefined) summary.push(`auto_allow_readonly: ${changes.commandsAutoReadonly === null ? "null" : changes.commandsAutoReadonly}`);
  }

  // 4b. security.files permission limits + rule lists (inline editor)
  if (changes.filesMaxReadBytes !== undefined || changes.filesMaxPatchFiles !== undefined
      || changes.filesAllow !== undefined || changes.filesConfirm !== undefined || changes.filesDeny !== undefined) {
    const security = get("security")?.raw ?? "security:";
    const existingMaxRead = security.match(/^\s{8}max_read_bytes:\s*(.+)$/m)?.[1]?.trim() ?? "1048576";
    const existingMaxPatch = security.match(/^\s{8}max_patch_files:\s*(.+)$/m)?.[1]?.trim() ?? "20";
    const filesAllow = changes.filesAllow !== undefined ? changes.filesAllow : parseListItems(get("security"), "allow");
    // files allow/confirm/deny share the same list key shape as commands but live
    // under security.files — parseListItems reads the first `allow:` in the section,
    // so for files we re-parse the files sub-block directly.
    const filesBlock = extractFilesBlock(security);
    const fAllow = changes.filesAllow !== undefined ? changes.filesAllow : parseSubList(filesBlock, "allow");
    const fConfirm = changes.filesConfirm !== undefined ? changes.filesConfirm : parseSubList(filesBlock, "confirm");
    const fDeny = changes.filesDeny !== undefined ? changes.filesDeny : parseSubList(filesBlock, "deny");
    const maxRead = changes.filesMaxReadBytes !== undefined ? String(changes.filesMaxReadBytes) : existingMaxRead;
    const maxPatch = changes.filesMaxPatchFiles !== undefined ? String(changes.filesMaxPatchFiles) : existingMaxPatch;
    const filesLines = [
      "    files:",
      `        max_read_bytes: ${maxRead}`,
      `        max_patch_files: ${maxPatch}`,
      fAllow.length > 0 ? `        allow:\n${listBlock(fAllow, "            ")}` : "        allow: []",
      fConfirm.length > 0 ? `        confirm:\n${listBlock(fConfirm, "            ")}` : "        confirm: []",
      fDeny.length > 0 ? `        deny:\n${listBlock(fDeny, "            ")}` : "        deny: []",
    ].join("\n");
    // Replace or append the files block within security, preserving commands + other children.
    const securityLines = security.split(/\r?\n/);
    const filesStart = securityLines.findIndex((line) => /^    files:\s*$/.test(line));
    if (filesStart >= 0) {
      let end = filesStart + 1;
      while (end < securityLines.length
        && !/^    [A-Za-z_]/.test(securityLines[end])
        && !/^[A-Za-z_]/.test(securityLines[end])) {
        end++;
      }
      const rebuilt = [...securityLines.slice(0, filesStart), filesLines, ...securityLines.slice(end)];
      set("security", rebuilt.join("\n"));
    } else {
      set("security", [security.trimEnd(), filesLines].join("\n"));
    }
    if (changes.filesMaxReadBytes !== undefined) summary.push(`files.max_read_bytes: ${changes.filesMaxReadBytes}`);
    if (changes.filesMaxPatchFiles !== undefined) summary.push(`files.max_patch_files: ${changes.filesMaxPatchFiles}`);
    if (changes.filesAllow !== undefined) summary.push(`files.allow: ${changes.filesAllow.length} 条`);
    if (changes.filesConfirm !== undefined) summary.push(`files.confirm: ${changes.filesConfirm.length} 条`);
    if (changes.filesDeny !== undefined) summary.push(`files.deny: ${changes.filesDeny.length} 条`);
  }

  // 4c. skill discovery dirs
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

export class GatewayWizardOverlay implements Component, Focusable {
  focused = false;
  private step: WizardStep = "listen";
  private selected = 0;
  private editing = false;
  private draft = "";
  private status = "";
  private tunnelPort: number | undefined;
  private tunnelGeneration: number | undefined;
  private tunnelStarting = false;
  private tunnelOwnedHere = false;
  private configCommitted = false;
  private changes: GatewayConfigChanges = {};
  private readonly existingConfig: string;

  constructor(private readonly params: GatewayWizardParams) {
    let existing = "";
    try {
      existing = readFileSync(this.configPath(), "utf8");
    } catch {
      // first-run: no config yet
    }
    this.existingConfig = existing;
  }

  private configPath(): string {
    return gatewayConfigPath();
  }

  invalidate(): void {}

  dispose(): void {
    if (this.configCommitted || !this.tunnelOwnedHere) return;
    const generation = this.tunnelGeneration;
    this.tunnelOwnedHere = false;
    void stopCloudflareQuickTunnel(generation).catch(() => undefined);
  }

  render(width: number): string[] {
    const safeWidth = Math.max(1, Math.min(width, 120));
    const inner = safeWidth - 2;
    const rows = [fitLine(`Pi Maestro Gateway 配置向导 · ${STEP_LABEL[this.step]}`, inner), rule(inner)];
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
          fitLine("窗口注册独立于本向导", inner),
          fitLine(`  本向导只写 ${this.configPath()}（监听/认证/策略/隧道）。`, inner),
          fitLine("  注册当前工作区到 Pi Maestro Gateway（绑定 lease）请在 /gateway 看板按 e。", inner),
          fitLine("  未完成初始配置时按 e 会自动回到本向导。", inner),
          option(0, "继续"),
        ];
      case "tunnel": {
        const cloudflared = fg("2", "由 Gateway supervisor doctor 检测显式配置/PATH");
        const running = this.tunnelStarting || this.tunnelGeneration !== undefined
          ? fg("32", `${this.tunnelStarting ? "启动探活中" : "运行中"}${this.changes.tunnelUrl ? ` · ${this.changes.tunnelUrl}` : "（等待分层 readiness…）"}`)
          : fg("2", "未运行");
        return [
          fitLine(`公网隧道（Cloudflare Quick Tunnel）— cloudflared ${cloudflared}`, inner),
          fitLine(`  唯一模式：启动后自动绑定本地端口并生成公网 URL，无需手动填写`, inner),
          fitLine(`  状态: ${running}`, inner),
          fitLine("  OpenAI Secure MCP Tunnel: experimental；需显式配置受支持 tunnel-client + env 凭据，向导不下载/创建资源", inner),
          option(0, this.tunnelGeneration ? "隧道已就绪" : "启动隧道", "Enter/g 由 Gateway supervisor 探活"),
          option(1, "→ 下一步（写入确认）", "需隧道已启动"),
          fitLine("  提示: Enter/g 启动 · x 停止 · Esc 返回", inner),
        ];
      }
      case "write": {
        const { summary } = this.build();
        const rows = [
          fitLine(`将写入 ${this.configPath()}（保留未修改的 section）：`, inner),
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
    const port = this.tunnelPort ?? (this.changes.port ?? 9090);
    const tunnelUrl = this.changes.tunnelUrl?.trim();
    const baseUrl = tunnelUrl ?? `http://127.0.0.1:${port}`;
    const auth = tunnelUrl
      ? (this.changes.authMode === "bearer" ? "Bearer" : "OAuth（自动升级）")
      : (this.changes.authMode === "bearer" ? "Bearer" : (this.changes.authMode === "oauth" ? "OAuth" : "open（仅本机）"));
    const rows = [fitLine("云端 MCP 连接信息（照此填入 ChatGPT / Claude 新建连接）：", inner)];
    rows.push(fitLine("  名称: Pi Maestro Gateway", inner));
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
      case "workspace": return 1;
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
        // The wizard is one-time initial config; window registration is an
        // independent per-window action done from the /gateway board (e key).
        this.step = "tunnel";
        break;
      case "tunnel":
        if (this.selected === 1) {
          const url = this.changes.tunnelUrl?.trim() ?? "";
          if (!/^https?:\/\//.test(url)) {
            this.status = "请先启动隧道获取公网 URL（Enter/g）";
            this.params.requestRender();
            return; // keep the message visible (confirm() tail would clear it)
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

  /** Start through the canonical Gateway control plane and native supervisor state. */
  private async startQuickTunnel(): Promise<void> {
    const port = this.changes.port ?? 9090;
    if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
      this.status = "无效的隧道端口（必须为 1-65535）";
      this.params.requestRender();
      return;
    }
    if (this.tunnelStarting) {
      this.status = "Cloudflare Quick Tunnel 正在进行本地/provider/公网分层探活…";
      this.params.requestRender();
      return;
    }
    if (this.tunnelGeneration !== undefined && this.changes.tunnelUrl) {
      this.status = `隧道运行中: ${this.changes.tunnelUrl}`;
      this.params.requestRender();
      return;
    }
    this.tunnelStarting = true;
    this.tunnelPort = port;
    this.status = "正在通过 Pi Maestro Gateway 启动 Cloudflare Quick Tunnel 并进行分层探活…";
    this.params.requestRender();
    try {
      const before = await readTunnelState();
      if (before.phase === "ready" && before.url) {
        this.tunnelGeneration = before.generation;
        this.changes.tunnelUrl = before.url;
        this.tunnelOwnedHere = false;
        this.status = `隧道已在运行（generation ${before.generation}）: ${before.url}`;
        return;
      }
      const state = await startCloudflareQuickTunnel(port);
      const endpoint = state.observed.endpoint;
      if (state.observed.phase !== "ready" || !endpoint) throw new Error(state.observed.detail ?? "Cloudflare Quick Tunnel 未就绪");
      this.tunnelGeneration = state.generation;
      this.changes.tunnelUrl = endpoint;
      this.tunnelOwnedHere = true;
      this.status = `隧道已就绪（generation ${state.generation}）: ${endpoint}`;
    } catch (error) {
      this.tunnelGeneration = undefined;
      this.changes.tunnelUrl = undefined;
      this.tunnelOwnedHere = false;
      this.status = `隧道启动失败: ${error instanceof Error ? error.message : String(error)}`;
    } finally {
      this.tunnelStarting = false;
      this.params.requestRender();
    }
  }

  /** Explicit stop is generation-fenced by the native supervisor. */
  private async stopTunnel(): Promise<void> {
    if (this.tunnelStarting) {
      this.status = "隧道仍在启动探活，请稍后再停止";
      this.params.requestRender();
      return;
    }
    if (this.tunnelGeneration === undefined) {
      this.status = "未找到受 Gateway supervisor 管理的 cloudflared 进程";
      this.params.requestRender();
      return;
    }
    try {
      await stopCloudflareQuickTunnel(this.tunnelGeneration);
      this.status = "已停止 Cloudflare Quick Tunnel";
      this.tunnelGeneration = undefined;
      this.tunnelPort = undefined;
      this.tunnelOwnedHere = false;
      this.changes.tunnelUrl = undefined;
    } catch (error) {
      this.status = `停止隧道失败: ${error instanceof Error ? error.message : String(error)}`;
    }
    this.params.requestRender();
  }

  /** Read an already configured URL for display only; never invent one. */
  private configuredTunnelUrl(): string | undefined {
    const match = this.existingConfig.match(/^\s{2,}server_url:\s*"?([^"\n#]+)"?/m);
    const value = match?.[1]?.trim();
    if (!value || !/^https?:\/\//.test(value)) return undefined;
    try {
      const parsed = new URL(value);
      return parsed.protocol === "http:" || parsed.protocol === "https:" ? parsed.href.replace(/\/$/, "") : undefined;
    } catch {
      return undefined;
    }
  }

  private build(): { yaml: string; summary: string[] } {
    return buildGatewayChangesYaml(this.existingConfig, this.changes, this.params.cwd);
  }

  private async write(): Promise<void> {
    if (this.status === "写入中…") return;
    this.status = "写入中…";
    this.params.requestRender();
    try {
      const path = this.configPath();
      await writeGatewayConfigChanges(this.changes, this.changes.tunnelUrl && this.tunnelGeneration !== undefined
        ? { generation: this.tunnelGeneration, endpoint: this.changes.tunnelUrl }
        : undefined);
      this.configCommitted = true;
      this.status = "已写入 " + path + " — 重启 Pi Maestro Gateway 后生效（可用 /gateway 查看）";
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

function isExecutableOnPath(command: string): boolean {
  return resolveExecutable(command) !== undefined;
}

/**
 * Resolve `command` to the concrete executable path to spawn directly.
 *
 * The caller uses shell:false for concrete executables and shell:true only for
 * .cmd/.bat shims that genuinely need a shell; `where`/`which` returns matches
 * in PATH order and the first match is used.
 */
function resolveExecutable(command: string): string | undefined {
  const probe = spawnSync(process.platform === "win32" ? "where.exe" : "which", [command], {
    encoding: "utf8",
    timeout: 5_000,
    shell: false,
    windowsHide: true,
  });
  if (probe.status !== 0) return undefined;
  const lines = String(probe.stdout || "").split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (lines.length === 0) return undefined;
  // `where`/`which` returns matches in PATH order. Respect that order so a
  // test-shim prepended to PATH (or a user's intended install) wins over a
  // later system install. We only need the *first* match; the caller decides
  // whether to use a shell based on that path's extension.
  return lines[0];
}

export const _gatewayWizardInternals = {
  splitSections,
  parseListItems,
  parseSubList,
  extractFilesBlock,
  buildGatewayChangesYaml,
  resolveExecutable,
};
