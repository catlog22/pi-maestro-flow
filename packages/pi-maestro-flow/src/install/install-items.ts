import { existsSync, readFileSync, readdirSync } from "node:fs";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { normalizeGatewayConfig } from "../gateway/config.ts";
import { gatewayConfigPath } from "../gateway/state-paths.ts";
import { resolveOwnPackageJson, resolvePackageOrWorkspaceResource } from "../resources/maestro-package.ts";
import { ocrInstalled } from "../tools/ocr-review.ts";

/** An optional install item surfaced by `/install`. Mirrors the `OptionalSkill` pattern. */
export interface InstallItem {
  id: string;
  title: string;
  description: string;
  /** Path to the AI setup doc, relative to the package `optional/` dir. */
  docFile: string;
  category: "core" | "optional" | "external";
  /** Short user-visible, AI-readable lead-in prepended to the injected doc. */
  promptIntro: string;
}

export type InstallStatus = "not-installed" | "installed" | "partial" | "unknown";

/** Resolved item with a probed status and absolute doc path. */
export interface ResolvedInstallItem extends InstallItem {
  status: InstallStatus;
  docPath: string | undefined;
}

const AGENT_DIR = join(homedir(), ".pi", "agent");
const optionalRequire = createRequire(import.meta.url);

/** Built-in install registry. Ordered core → optional → external. */
export const INSTALL_ITEMS: readonly InstallItem[] = [
  {
    id: "init",
    title: "初始化安装（API / 模型回退 / cockpit）",
    description: "配置 API 凭证、模型回退路由、cockpit 显示。首次安装后必做。",
    docFile: "INIT-SETUP.md",
    category: "core",
    promptIntro:
      "这是首次安装后的初始化配置。请交互式询问用户必要的输入（API provider、key、偏好模型、cockpit 主题等），按文档写入对应配置文件，最后验证。",
  },
  {
    id: "teammate-models",
    title: "Teammate 模型配置",
    description: "配置 .pi/teammate-models.json 的模型映射、fallback、thinking level。",
    docFile: "TEAMMATE-MODELS-SETUP.md",
    category: "core",
    promptIntro:
      "配置 teammate 模型路由。请参考文档和当前可用模型清单，交互式确认每个 taskType 的主模型与 fallback，写入 .pi/teammate-models.json。",
  },
  {
    id: "computer-use",
    title: "Computer Use 原生桌面能力",
    description: "配置 Windows、macOS 和 Linux X11 的窗口、截图、鼠标、键盘与剪贴板 provider。",
    docFile: "COMPUTER-USE-SETUP.md",
    category: "optional",
    promptIntro:
      "配置 Computer Use 原生桌面能力。必须先向用户确认系统级安装和权限授予，再按文档探测当前平台；不要绕过 Wayland、macOS 隐私设置或 Windows UIA 依赖缺失的 fail-closed 语义。",
  },
  {
    id: "computer-use-weights",
    title: "Computer Use 视觉权重",
    description: "下载 OmniParser-v2 icon_detect 权重并转换为 ONNX，启用真实 UI 检测。",
    docFile: "COMPUTER-USE-WEIGHTS-SETUP.md",
    category: "optional",
    promptIntro:
      "安装 Computer Use 视觉权重（OmniParser-v2 icon_detect）。按文档下载官方权重、转换为 ONNX、更新 manifest，最后运行验证。转换是必须的：vision service 是 onnxruntime-node，只能加载 ONNX。",
  },
  {
    id: "self-evolve",
    title: "自进化配置",
    description: "配置 self-evolve 的启用/模式/评审门/语义 enrichment，自动采集可复用经验。",
    docFile: "SELF-EVOLVE-SETUP.md",
    category: "optional",
    promptIntro:
      "配置 self-evolve 自进化。按文档交互式确认启用、模式（dry-run/auto-deposit）、评审模型、captureMode（heuristic/hybrid），写入 .pi/self-evolve.json，最后验证采集与评审流程。",
  },
  {
    id: "browser-bridge",
    title: "浏览器扩展桥（显式 extension 通道）",
    description: "安装 Chrome 扩展，为 browser 工具提供保留登录态的有限 extension adapter；需显式选择，不会自动接管或回退。",
    docFile: "BROWSER-BRIDGE-SETUP.md",
    category: "optional",
    promptIntro:
      "安装浏览器扩展桥。在 chrome://extensions 或 edge://extensions 加载 optional/browser-bridge 目录，更新后由用户重载扩展。先用 browser status 启动并读取 authMode、实际端口和 transportReady；默认 paired 需使用 popup 配对码与 browser pair 确认，PI_BROWSER_BRIDGE_AUTH_MODE=none 无需 token 或配对，transportReady=true 且 authenticatedConnected=false 才是正常状态。默认发现 19222..19231，自定义 PI_BROWSER_BRIDGE_PORT 也需在 popup 高级设置填写（无需 token）。/install installed 仅是当前模式历史就绪证据，不是实时连接；用 browser status 验证实时状态。extension 仅在 app.channel='extension' 时使用，断连不回退 managed。",
  },
  {
    id: "smart-search",
    title: "Smart Search 配置",
    description: "配置 smart_search 的搜索 provider（Tavily/Exa/Jina 等）与凭证。",
    docFile: "SMART-SEARCH-SETUP.md",
    category: "external",
    promptIntro:
      "配置 Smart Search 外部搜索 provider。请交互式询问用户选择的 provider 和 API key，按文档写入配置，最后用 route 诊断验证。",
  },
  {
    id: "mcp",
    title: "MCP 服务器配置",
    description: "注册 MCP 服务器并完成 OAuth 认证流程。",
    docFile: "MCP-SETUP.md",
    category: "external",
    promptIntro:
      "配置 MCP 服务器。Pi 0.99+ 使用原生 `pi mcp add/list/login` 与 `/mcp`；0.87–0.98 才使用 Maestro legacy manager。已有 legacy 配置必须先按文档预览迁移，不复制 OAuth token。",
  },
  {
    id: "openai-tunnel",
    title: "OpenAI Secure MCP Tunnel（实验性）",
    description: "配置 tunnel-client 发现（binaryPath/PATH/managed）和仅含环境变量名的 Gateway OpenAI tunnel 引用；可选 auto_install 启用固定版本+SHA256 校验的托管下载，绝不预配 tunnel。",
    docFile: "OPENAI-TUNNEL-SETUP.md",
    category: "external",
    promptIntro:
      "配置实验性的 OpenAI Secure MCP Tunnel。只在原生 ~/.pi/agent/gateway/config.yaml 中写环境变量名称，绝不写入或索取 secret 值；不得创建或预配 tunnel。client 解析顺序为 binaryPath → PATH → managed install；只有用户显式确认后才可写 auto_install: true 启用固定版本+SHA256 校验的托管下载，否则不得自动下载 tunnel-client。按文档验证外部 client、Gateway doctor/start/status，并保留显式 opt-in 语义。",
  },
  {
    id: "ocr",
    title: "OpenCodeReview 代码评审 CLI",
    description: "安装 ocr CLI，为 open-code-review 工具与 reviewer agent 提供确定性 diff 范围/规则与托管评审；模型由 api-manager 的运行时网关配置注入，无需单独配置 OpenCodeReview provider。",
    docFile: "OCR-SETUP.md",
    category: "external",
    promptIntro:
      "安装 OpenCodeReview（ocr CLI）。先检测 PATH 是否已有 ocr；缺失时经用户确认后用 npm 全局安装固定版本。绝不写 ~/.opencodereview/config.json、不运行 ocr config provider——pi 调用时经 OCR_LLM_* 环境变量注入 api-manager 当前模型。最后按 VERIFY 验证。",
  },
];

function probeComputerUseStatus(): InstallStatus {
  const nodeProviders = ["@nut-tree-fork/nut-js", "active-win", "screenshot-desktop"];
  if (process.platform !== "linux") nodeProviders.push("node-window-manager");
  const nodeReady = nodeProviders.filter((name) => {
    try { optionalRequire.resolve(name); return true; } catch { return false; }
  }).length;
  if (nodeReady === 0) return "not-installed";
  const bridgePath = resolvePackageOrWorkspaceResource(["optional", "computer-use-windows-bridge.py"], resolveOwnPackageJson());
  if (process.platform === "win32") {
    if (!bridgePath || !probePythonBridge(bridgePath)) return "partial";
    return nodeReady === nodeProviders.length ? "installed" : "partial";
  }
  if (process.platform === "darwin") return nodeReady === nodeProviders.length ? "installed" : "partial";
  if (process.platform === "linux") {
    if ((process.env.XDG_SESSION_TYPE ?? "").toLowerCase() === "wayland" || process.env.WAYLAND_DISPLAY) return "partial";
    return nodeReady === nodeProviders.length && probeExecutable("xdotool") ? "installed" : "partial";
  }
  return "partial";
}

function probePythonBridge(scriptPath: string): boolean {
  try {
    const executable = process.env.PI_COMPUTER_USE_PYTHON?.trim() || "python";
    const result = spawnSync(executable, [scriptPath, "--action", "probe"], { encoding: "utf8", shell: false, windowsHide: true, timeout: 5_000, stdio: ["ignore", "pipe", "ignore"] });
    if (result.status !== 0 || typeof result.stdout !== "string") return false;
    const output = result.stdout.trim().split(/\r?\n/).filter(Boolean).at(-1);
    return output ? (JSON.parse(output) as { ok?: unknown }).ok === true : false;
  } catch {
    return false;
  }
}

function probeExecutable(executable: string): boolean {
  try {
    return spawnSync(executable, ["--version"], { encoding: "utf8", shell: false, windowsHide: true, timeout: 750, stdio: ["ignore", "ignore", "ignore"] }).status === 0;
  } catch {
    return false;
  }
}
function probeOpenAiTunnelStatus(): InstallStatus {
  const configPath = gatewayConfigPath();
  if (!existsSync(configPath)) return "not-installed";
  const raw = parseYaml(readFileSync(configPath, "utf8")) as unknown;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return "unknown";
  const tunnels = (raw as { tunnels?: unknown }).tunnels;
  if (!tunnels || typeof tunnels !== "object" || Array.isArray(tunnels)
    || !Object.prototype.hasOwnProperty.call(tunnels, "openai")) return "not-installed";

  const openai = normalizeGatewayConfig(raw).tunnels.openai;
  if (!openai.enabled) return "partial";
  const tunnelId = process.env[openai.tunnelIdEnv]?.trim();
  const runtimeKey = process.env[openai.runtimeKeyEnv]?.trim();
  return tunnelId && runtimeKey ? "installed" : "partial";
}

function resolveDocPath(docFile: string): string | undefined {
  return resolvePackageOrWorkspaceResource(["optional", docFile], resolveOwnPackageJson());
}

interface BrowserBridgeConfig {
  version?: unknown;
  port?: unknown;
  token?: unknown;
}

interface BrowserBridgeVerifiedMarker {
  version?: unknown;
  protocol?: unknown;
  port?: unknown;
  verifiedAt?: unknown;
}

function isValidBridgePort(value: unknown): value is number {
  return Number.isInteger(value) && Number(value) > 0 && Number(value) <= 65_535;
}

function isValidBrowserBridgeConfig(value: BrowserBridgeConfig | null): boolean {
  return value?.version === 1
    && isValidBridgePort(value.port)
    && typeof value.token === "string"
    && /^[A-Za-z0-9_-]{32,}$/.test(value.token);
}

function isValidBrowserBridgeVerifiedMarker(value: BrowserBridgeVerifiedMarker | null): boolean {
  return value?.version === 1
    && (value.protocol === "first-frame-token-v1" || value.protocol === "challenge-hmac-sha256-v1")
    && isValidBridgePort(value.port)
    && typeof value.verifiedAt === "string"
    && Number.isFinite(Date.parse(value.verifiedAt));
}

/** Probe an item's install status from its config files. */
export function probeInstallStatus(id: string): InstallStatus {
  try {
    switch (id) {
      case "init": {
        const authPath = join(AGENT_DIR, "auth.json");
        if (!existsSync(authPath)) return "not-installed";
        const auth = readJson(authPath) as Record<string, { type?: string; key?: unknown; access?: unknown }> | null;
        const hasProvider = auth && typeof auth === "object" && Object.values(auth).some((entry) =>
          entry && typeof entry === "object"
          && (entry.type === "oauth" ? Boolean(entry.access) : Boolean(entry.key)),
        );
        return hasProvider ? "installed" : "partial";
      }
      case "teammate-models": {
        const projectPath = join(process.cwd(), ".pi", "teammate-models.json");
        const globalPath = join(AGENT_DIR, "teammate-models.json");
        const path = existsSync(projectPath) ? projectPath : existsSync(globalPath) ? globalPath : undefined;
        if (!path) return "not-installed";
        const cfg = readJson(path) as { mappings?: unknown; overrides?: { mappings?: unknown }; profiles?: Record<string, { mappings?: unknown }> } | null;
        const mappings = cfg?.mappings ?? cfg?.overrides?.mappings;
        const profileMappings = cfg?.profiles && typeof cfg.profiles === "object"
          ? Object.values(cfg.profiles).some((p) => p && typeof p.mappings === "object" && Object.keys(p.mappings ?? {}).length > 0)
          : false;
        const hasMappings = (mappings && typeof mappings === "object" && Object.keys(mappings ?? {}).length > 0) || profileMappings;
        return hasMappings ? "installed" : "partial";
      }
      case "computer-use":
        return probeComputerUseStatus();
      case "computer-use-weights": {
        const manifestPath = resolvePackageOrWorkspaceResource(["optional", "computer-use-manifest.json"], resolveOwnPackageJson());
        if (!manifestPath || !existsSync(manifestPath)) return "not-installed";
        const manifest = readJson(manifestPath) as { model_artifacts?: Array<{ id?: string; status?: string; path?: string; sha256?: string }> } | null;
        const icon = manifest?.model_artifacts?.find((a) => a.id === "omniparser.v2.icon_detect");
        if (!icon) return "not-installed";
        if (icon.status !== "verified_local") return "partial";
        return icon.path && icon.sha256 && existsSync(icon.path) ? "installed" : "partial";
      }
      case "smart-search": {
        // SmartSearch config: %LOCALAPPDATA%/smart-search/config.json (Win) or
        // ~/.config/smart-search/config.json (others); SMART_SEARCH_CONFIG_DIR
        // overrides. NOT ~/.maestro/cli-tools.json (that's Maestro delegate CLI).
        const dir = process.env.SMART_SEARCH_CONFIG_DIR
          ?? (process.platform === "win32" && process.env.LOCALAPPDATA
            ? join(process.env.LOCALAPPDATA, "smart-search")
            : join(homedir(), ".config", "smart-search"));
        const configFile = join(dir, "config.json");
        if (!existsSync(configFile)) return "not-installed";
        const cfg = readJson(configFile) as Record<string, unknown> | null;
        const providerKeys = ["TAVILY_API_KEY", "EXA_API_KEY", "CONTEXT7_API_KEY", "JINA_API_KEY", "FIRECRAWL_API_KEY", "ZHIPU_API_KEY", "OPENAI_COMPATIBLE_API_KEY"];
        const configured = providerKeys.filter((k) => typeof (cfg as Record<string, unknown>)?.[k] === "string" && String((cfg as Record<string, unknown>)[k]).length > 0);
        return configured.length >= 3 ? "installed" : configured.length > 0 ? "partial" : "not-installed";
      }
      case "mcp": {
        // MCP config is multi-source; check for mcpServers in any source.
        const candidates = [
          join(homedir(), ".config", "mcp", "mcp.json"),
          join(AGENT_DIR, "mcp.json"),
          join(process.cwd(), ".mcp.json"),
          join(process.cwd(), ".pi", "mcp.json"),
        ];
        const anyConfigured = candidates.some((p) => {
          if (!existsSync(p)) return false;
          const cfg = readJson(p) as { mcpServers?: Record<string, unknown> } | null;
          return Boolean(cfg?.mcpServers && Object.keys(cfg.mcpServers ?? {}).length > 0);
        });
        return anyConfigured ? "installed" : "not-installed";
      }
      case "self-evolve": {
        // Project-scoped config at .pi/self-evolve.json.
        const configPath = join(process.cwd(), ".pi", "self-evolve.json");
        if (!existsSync(configPath)) return "not-installed";
        const cfg = readJson(configPath) as { enabled?: boolean; mode?: string; model?: string } | null;
        if (!cfg || typeof cfg !== "object") return "partial";
        if (!cfg.enabled) return "partial";
        // enabled but no model configured (inherits main-session model) is
        // acceptable for dry-run; auto-deposit needs a model for review.
        const hasMode = cfg.mode === "dry-run" || cfg.mode === "auto-deposit";
        return hasMode ? "installed" : "partial";
      }
      case "browser-bridge": {
        // Static install state is historical/configuration evidence only. The
        // legacy port file merely proves that a server once bound; it never
        // proves that an extension authenticated. Live state belongs solely to
        // browser action=status.
        const directory = process.env.PI_BROWSER_BRIDGE_DIR?.trim() || join(homedir(), ".pi");
        const mode = process.env.PI_BROWSER_BRIDGE_AUTH_MODE ?? "paired";
        if (mode === "none") {
          const historyDir = join(directory, "browser-bridge.none");
          if (!existsSync(historyDir)) return "not-installed";
          const records = readdirSync(historyDir).filter((name) => name.endsWith(".ready.json"));
          const valid = records.some((name) => {
            const value = readJson(join(historyDir, name));
            if (!value || typeof value !== "object" || Array.isArray(value)) return false;
            const record = value as Record<string, unknown>;
            return record.version === 1 && record.protocol === "probe-ready-v1"
              && record.authMode === "none" && record.authenticated === false
              && typeof record.serverInstanceId === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(record.serverInstanceId)
              && name === `${record.serverInstanceId}.ready.json`
              && typeof record.installationId === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(record.installationId)
              && Number.isInteger(record.generation) && Number(record.generation) > 0
              && isValidBridgePort(record.port) && typeof record.readyAt === "string" && Number.isFinite(Date.parse(record.readyAt));
          });
          return valid ? "installed" : records.length ? "partial" : "not-installed";
        }
        if (mode !== "paired") return "unknown";
        const markerPath = join(directory, "browser-bridge.verified");
        if (!existsSync(markerPath)) return "not-installed";
        const marker = readJson(markerPath) as BrowserBridgeVerifiedMarker | null;
        if (!isValidBrowserBridgeVerifiedMarker(marker)) return "partial";
        const config = readJson(join(directory, "browser-bridge.json")) as BrowserBridgeConfig | null;
        return isValidBrowserBridgeConfig(config) ? "installed" : "partial";
      }
      case "openai-tunnel":
        return probeOpenAiTunnelStatus();
      case "ocr":
        return ocrInstalled() ? "installed" : "not-installed";
      default:
        return "unknown";
    }
  } catch {
    return "unknown";
  }
}

/** Resolve all items with probed status and doc paths. */
export function resolveInstallItems(): ResolvedInstallItem[] {
  return INSTALL_ITEMS.map((item) => ({
    ...item,
    status: probeInstallStatus(item.id),
    docPath: resolveDocPath(item.docFile),
  }));
}

/** Read a setup doc; returns undefined when the doc is not shipped. */
export function readInstallDoc(docFile: string): string | undefined {
  const path = resolveDocPath(docFile);
  if (!path || !existsSync(path)) return undefined;
  return readFileSync(path, "utf8");
}

function readJson(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

export const STATUS_GLYPH: Record<InstallStatus, string> = {
  installed: "✓",
  partial: "○",
  "not-installed": "·",
  unknown: "?",
};
