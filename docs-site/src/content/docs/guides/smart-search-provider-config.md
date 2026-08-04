---
title: "Smart Search Provider 配置"
icon: "🔎"
---

Smart Search 双路径架构的完整配置：原生 TS Providers、Python CLI Providers、凭证源语法、TUI 操作与安全配置。

---

## 架构概览

```
smart_search("query")
  ├─ Python CLI 路径 (默认)
  │   配置: %LOCALAPPDATA%/smart-search/config.json (Win)
  │         ~/.config/smart-search/config.json (Linux/macOS)
  │   要求: 至少配置 main_search + docs_search + web_fetch 各一个 provider
  │
  └─ Native TS 路径 (自动降级 / native:true 强制)
      配置: ~/.pi/web-search.json
      优势: Exa/AnySearch 零配置可用，无需任何 API key
```

当 Python CLI 因缺少配置报错（`config_error`）时自动降级到 Native TS 路径。

## 零配置（开箱即用）

| Provider | 说明 | 限制 |
|----------|------|------|
| **Exa** | 零配置，自动走 MCP 代理 | 免费额度有限 |
| **AnySearch** | 匿名搜索，无需 key | 仅搜索，无内容提取 |

```javascript
smart_search({ mode: "search", query: "your query" })
```

## Native TS Providers（原生搜索引擎）

在 TUI 中搜索 `wa-` 前缀可查看所有原生 provider 配置组。

| Provider | 环境变量 | 能力 |
|----------|---------|------|
| Perplexity | `PERPLEXITY_API_KEY` | 搜索 + AI 摘要（10 req/min 滑窗） |
| OpenAI | `OPENAI_API_KEY` | 搜索（Responses API）；支持 Pi Codex 订阅自动认证 |
| Brave | `BRAVE_API_KEY` | 搜索 + 域名过滤（2000 次/月免费） |
| Exa | `EXA_API_KEY` | 搜索 + 内容提取；零配置走 MCP 代理 |
| Parallel AI | `PARALLEL_API_KEY` | 搜索 + 内容提取（双角色） |
| SERPdive | `SERPDIVE_API_KEY` + `SERPDIVE_MODEL` | 搜索（krill 免费 / mako / moby） |
| SearXNG | `SEARXNG_BASE_URL` | 自托管搜索；auto 模式最优先 |
| Gemini | `GEMINI_API_KEY`（+ `GEMINI_BASE_URL` / `CLOUDFLARE_API_KEY`） | 搜索 + URL 提取 + 视频分析；Gemini Web 需 `ALLOW_BROWSER_COOKIES=true` |
| Tavily | `TAVILY_API_KEY` | 搜索 + 内容提取 |
| Firecrawl | `FIRECRAWL_API_KEY`（+ `FIRECRAWL_API_URL`） | 网页抓取 + 搜索 |

## Python CLI Providers

在 TUI 中搜索对应组名（如 `xai`、`zhipu`、`jina`）查看：

| Provider | 环境变量 | 说明 |
|----------|---------|------|
| xAI (Grok) | `XAI_API_KEY`（+ `XAI_API_URL` / `XAI_MODEL`） | grok-4 |
| OpenAI Compatible | `OPENAI_COMPATIBLE_API_URL` / `_KEY` / `_MODEL` / `_FALLBACK_MODELS` | 中继 |
| Zhipu (智谱) | `ZHIPU_API_KEY`（+ `ZHIPU_SEARCH_ENGINE`） | search_std |
| Context7 | `CONTEXT7_API_KEY` | 文档搜索 |
| Jina Reader | `JINA_API_KEY`（+ `JINA_READER_API_URL`） | 网页提取 |

## 凭证源语法

API Key 字段支持三种格式：

| 格式 | 示例 | 说明 |
|------|------|------|
| 直接值 | `sk-abc123...` | 明文存储（文件权限 0o600） |
| 环境变量 | `$OPENAI_API_KEY` 或 `${OPENAI_API_KEY}` | 运行时读取 |
| Shell 命令 | `!op read op://vault/api-key` | 运行时执行获取（5s 超时） |

TUI 编辑时自动识别：`$VAR` → `(env var)`，`!cmd` → `(shell command)`。

## TUI 操作

`Alt+S` 或 `/smart-search-config` 打开：

- **输入关键词** 过滤配置项（如 `exa`、`gemini`、`brave`）；
- **Enter** 编辑选中项；
- **Tab** 切换配置源（Smart Search ↔ web-search.json）；
- **Ctrl+S** 同步配置到 `~/.pi/web-search.json`（31 条映射，含 `WEB_SEARCH_PROVIDER` → `provider`、`SSRF_ALLOW_RANGES` → `ssrf.allowRanges`）；
- **Esc** 返回。

> 该 TUI 的完整按键（筛选/PgUp/PgDn/Ctrl+U 清空）见 [TUI 操作指南](/guides/tui-guide)。

同步状态标注（展示性，非复选框）：`✓ synced` 一致 / `⚠ conflict` 冲突 / `→ smart-only` / `← web-only`。

## 搜索策略与安全

```bash
SMART_SEARCH_VALIDATION_LEVEL = balanced    # fast | balanced | strict
SMART_SEARCH_FALLBACK_MODE = auto           # auto | off
SMART_SEARCH_RESEARCH_PREFERRED_PROVIDERS = exa,perplexity
SMART_SEARCH_RESEARCH_DISABLED_PROVIDERS = anysearch
```

### SSRF 防护

```bash
SSRF_ALLOW_RANGES = 198.18.0.0/16,100.64.0.0/10   # CIDR 白名单 (fake-IP 代理)
SSRF_TRUST_ENV_PROXY = true                         # 信任 HTTP_PROXY
FETCH_DOMAIN_ALLOW = github.com,stackoverflow.com   # 域名白名单
FETCH_DOMAIN_DENY = evil.com                        # 域名黑名单 (优先于白名单)
```

### 视频分析

```bash
VIDEO_MAX_SIZE_MB = 50
VIDEO_ENABLED = true
YOUTUBE_ENABLED = true
YOUTUBE_PREFERRED_MODEL = gemini-3-flash-preview
```

### Intent Router（语义路由）

```bash
SMART_SEARCH_INTENT_ROUTER = true
INTENT_EMBEDDING_API_URL / _KEY / _MODEL = ...     # text-embedding-3-small, 阈值 0.7
INTENT_CLASSIFIER_API_URL / _KEY / _MODEL = ...    # gpt-4o-mini
```

## 配置文件位置

| 文件 | 用途 | 路径 |
|------|------|------|
| Smart Search 主配置 | Python CLI + TUI 编辑 | `%LOCALAPPDATA%/smart-search/config.json` (Win) / `~/.config/smart-search/config.json` |
| Web Access 配置 | Native TS providers | `~/.pi/web-search.json` |
| 环境变量覆盖 | 强制指定配置目录 | `SMART_SEARCH_CONFIG_DIR=/path/to/dir` |

## 常见场景

| 场景 | 操作 |
|------|------|
| 仅免费搜索 | 无需配置，Exa + AnySearch 自动可用 |
| 主力搜索 + 提取 | `/smart-search config` → 填 EXA_API_KEY + JINA_API_KEY → Ctrl+S |
| 自托管 SearXNG + Gemini | `SEARXNG_BASE_URL` + `GEMINI_API_KEY` |
| 跳过 Python CLI | `smart_search({ mode: "search", query: "...", native: true })` |

## 下一步

- [网络搜索与深度研究](/guides/smart-search) — 三种模式与用法
- [环境变量速查](/guides/env-vars) — 完整环境变量清单
- [知识系统](/guides/knowledge) — 内部知识检索
