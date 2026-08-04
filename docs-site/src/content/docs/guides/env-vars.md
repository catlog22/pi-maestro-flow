---
title: "环境变量速查"
icon: "🌿"
---

套件读取的环境变量速查。按子系统分组；`set` 标记为内部传递（由父进程注入子进程，勿手动设置）。

---

## 核心

| 变量 | 说明 |
|------|------|
| `PI_CODING_AGENT_DIR` | 覆盖 agent 目录（默认 `~/.pi/agent`）——settings.json、cockpit.json、vision-delegation.json、model-failover.json 均位于此 |
| `PI_GUI` | 设为 `1` 启用 GUI sidecar（UCL——Unified Communication Layer 统一通信层：`GET /tools` 工具发现、`POST /tools/:name` 工具调用、SSE 状态事件）；未启用时零侵入 |
| `PI_GUI_PORT` | GUI sidecar 端口 |
| `PI_GUI_DEBUG` | GUI 调试输出 |

## Teammate 调度

| 变量 | 默认 | 说明 |
|------|------|------|
| `PI_TEAMMATE_MAX_AGENTS` | `15` | 单次 dispatch 的最大任务数上限 |
| `PI_TEAMMATE_MAX_ACTIVE_AGENTS` | `32` | 整个 dispatch 树中活跃 Agent 的运行时预算 |
| `PI_TEAMMATE_MAX_DISPATCH_DEPTH` | — | 子代理嵌套派发层级上限 |
| `PI_TEAMMATE_LEGACY_OBSERVATION_TOOLS` | — | 启用旧版观察工具（teammate-watch/wait 等） |
| `PI_TEAMMATE_CHILD` | — | `set` 子进程标记（由父进程注入） |
| `PI_TEAMMATE_CORRELATION_ID` | — | `set` 关联 ID |
| `PI_TEAMMATE_DEPTH` | — | `set` 嵌套深度 |
| `PI_TEAMMATE_PARENT_SESSION` | — | `set` 父会话标识 |
| `PI_TEAMMATE_PI_BINARY` | — | `set` 子进程使用的 Pi 二进制路径 |
| `PI_TEAMMATE_STRUCTURED_OUTPUT_PATH` / `PI_TEAMMATE_STRUCTURED_SCHEMA_PATH` | — | `set` 结构化输出/JSON Schema 传递路径 |

## MCP

| 变量 | 说明 |
|------|------|
| `MCP_DIRECT_TOOLS` | 直接注册 MCP 工具模式（绕过统一 `mcp` 代理） |
| `MCP_OAUTH_DIR` | OAuth 令牌存储目录 |
| `MCP_OAUTH_CALLBACK_PORT` | OAuth 回调端口 |
| `MCP_UI_DEBUG` | MCP UI 调试 |
| `MCP_UI_VIEWER` | MCP UI 查看器 |

## Cockpit / 界面

| 变量 | 说明 |
|------|------|
| `MAESTRO_NERD_FONT` | 设为 `1` 使用 Nerd Font 图标 |
| `MAESTRO_STATUSLINE_THEME` | 状态栏主题名（默认 `notion`） |
| `LC_TERMINAL` / `TERM_PROGRAM` / `WT_SESSION` / `TERM` | 终端环境检测（图标/标题能力） |
| `PI_ALLOW_BROWSER_COOKIES` / `FEYNMAN_ALLOW_BROWSER_COOKIES` | 允许浏览器 cookie 认证（Gemini Web 等） |

## Smart Search / Web Access

| 变量 | 说明 |
|------|------|
| `SMART_SEARCH_CONFIG_DIR` | 强制指定 Smart Search 配置目录 |
| `SMART_SEARCH_VALIDATION_LEVEL` | `fast` / `balanced` / `strict` |
| `SMART_SEARCH_FALLBACK_MODE` | `auto` / `off` |
| `SMART_SEARCH_RESEARCH_PREFERRED_PROVIDERS` / `_DISABLED_PROVIDERS` | 研究模式 provider 偏好/禁用 |
| `SMART_SEARCH_INTENT_ROUTER` | 语义路由开关 |
| `PI_WEB_ACCESS_DISABLE_NODE_SQLITE` | 禁用 node-sqlite（Web Access） |
| `PERPLEXITY_API_KEY` / `OPENAI_API_KEY` / `BRAVE_API_KEY` / `EXA_API_KEY` / `GEMINI_API_KEY` / `TAVILY_API_KEY` / `FIRECRAWL_API_KEY` / `PARALLEL_API_KEY` / `SERPDIVE_API_KEY` / `SERPDIVE_MODEL` / `SEARXNG_BASE_URL` / `ANYSEARCH_API_KEY` | 搜索 Provider 凭证（完整说明见 [Smart Search Provider 配置](/guides/smart-search-provider-config)） |
| `XAI_API_KEY` / `XAI_API_URL` / `XAI_MODEL`、`ZHIPU_API_KEY`、`CONTEXT7_API_KEY`、`JINA_API_KEY`、`OPENAI_COMPATIBLE_*` | Python CLI Providers 凭证 |
| `SSRF_ALLOW_RANGES` / `SSRF_TRUST_ENV_PROXY` / `FETCH_DOMAIN_ALLOW` / `FETCH_DOMAIN_DENY` | SSRF 防护与域名白/黑名单 |
| `VIDEO_MAX_SIZE_MB` / `VIDEO_ENABLED` / `YOUTUBE_ENABLED` / `YOUTUBE_PREFERRED_MODEL` | 视频分析 |

## 浏览器（browser 工具）

| 变量 | 说明 |
|------|------|
| `CHROME_PATH` / `PUPPETEER_EXECUTABLE_PATH` | Chromium/Chrome/Edge 可执行文件路径（browser 工具 `app.path` 的备用来源） |
| `BROWSER` | 默认浏览器提示 |

## 说明

- **内部传递变量**（`set` 标记）由父进程在派生子智能体时注入，手动设置可能破坏调度契约；
- 各子系统完整配置见对应指南：[设置系统总览](/guides/settings-overview)、[Smart Search Provider 配置](/guides/smart-search-provider-config)、[Pi Cockpit 可视化](/guides/cockpit)、[MCP 集成](/guides/mcp)。
