# Smart Search Provider 配置指南

## 架构概览

Smart Search 采用双路径架构，自动降级：

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

当 Python CLI 因缺少配置报错 (`config_error`) 时，search/fetch 模式自动降级到 Native TS 路径。

---

## 快速开始

### 零配置 (开箱即用)

无需任何配置。以下 provider 自动可用：

| Provider | 说明 | 限制 |
|----------|------|------|
| **Exa** | 零配置，自动走 MCP 代理 | 免费额度有限 |
| **AnySearch** | 匿名搜索，无需 key | 仅搜索，无内容提取 |

直接调用即可：
```
smart_search(mode: "search", query: "your query")
```

### 配置 API Key (推荐)

打开 TUI 配置界面：
```
/smart-search config
```

在 TUI 中：
- **输入关键词** 过滤配置项 (如 `exa`、`gemini`、`brave`)
- **Enter** 编辑选中项
- **Tab** 切换配置源 (Smart Search ↔ web-search.json)
- **Ctrl+S** 同步配置到 `~/.pi/web-search.json`
- **Esc** 返回 / 关闭

---

## Provider 配置详解

### Native TS Providers (原生搜索引擎)

在 TUI 中搜索 `wa-` 前缀可查看所有原生 provider 配置组。

#### Perplexity
```
PERPLEXITY_API_KEY = pplx-xxxxxxxxxxxx
```
- 获取: https://www.perplexity.ai/settings/api
- 能力: 搜索 + AI 摘要回答
- 限速: 10 请求/分钟 (客户端滑窗)

#### OpenAI
```
OPENAI_API_KEY = sk-xxxxxxxxxxxx
```
- 获取: https://platform.openai.com/api-keys
- 能力: 搜索 (Responses API)
- 备选: 支持 Pi Codex 订阅自动认证 (无需 key)

#### Brave Search
```
BRAVE_API_KEY = BSA-xxxxxxxxxxxx
```
- 获取: https://brave.com/search/api/
- 能力: 搜索 + 域名过滤
- 免费: 2000 次/月

#### Exa
```
EXA_API_KEY = xxxxxxxxxxxx
```
- 获取: https://dashboard.exa.ai/api-keys
- 能力: 搜索 + 内容提取
- **零配置可用**: 无 key 时自动走 Exa MCP 代理

#### Parallel AI
```
PARALLEL_API_KEY = xxxxxxxxxxxx
```
- 能力: 搜索 + 内容提取 (双角色)

#### SERPdive
```
SERPDIVE_API_KEY = xxxxxxxxxxxx
SERPDIVE_MODEL = krill          # krill(免费) | mako(1credit) | moby(1.5credit)
```
- 能力: 搜索

#### SearXNG (自托管)
```
SEARXNG_BASE_URL = https://search.example.com
```
- 能力: 搜索 (自托管元搜索引擎)
- 优先级: auto 模式下最优先

#### Gemini Platform
```
GEMINI_API_KEY = AIzaxxxxxxxxxxxx
GEMINI_BASE_URL = https://generativelanguage.googleapis.com  # 可选，自定义网关
CLOUDFLARE_API_KEY = xxxxxxxxxxxx    # 可选，Cloudflare AI Gateway
ALLOW_BROWSER_COOKIES = true         # 启用 Gemini Web (cookie 认证)
CHROME_PROFILE = Default             # Chrome 配置文件名
```
- 获取: https://aistudio.google.com/apikey
- 能力: 搜索 + URL 提取 + 视频分析
- Gemini Web: 需 `ALLOW_BROWSER_COOKIES=true`，仅 macOS/Linux

#### Tavily
```
TAVILY_API_KEY = tvly-xxxxxxxxxxxx
```
- 获取: https://app.tavily.com
- 能力: 搜索 + 内容提取

#### Firecrawl
```
FIRECRAWL_API_KEY = fc-xxxxxxxxxxxx
FIRECRAWL_API_URL = https://api.firecrawl.dev  # 可选
```
- 获取: https://firecrawl.dev
- 能力: 网页抓取 + 搜索

### Python CLI Providers

在 TUI 中搜索对应组名 (如 `xai`、`zhipu`、`jina`) 查看。

#### xAI (Grok)
```
XAI_API_KEY = xai-xxxxxxxxxxxx
XAI_API_URL = https://api.x.ai/v1          # 可选
XAI_MODEL = grok-4                          # 可选
```

#### OpenAI Compatible (中继)
```
OPENAI_COMPATIBLE_API_URL = https://your-relay.com/v1
OPENAI_COMPATIBLE_API_KEY = sk-xxxxxxxxxxxx
OPENAI_COMPATIBLE_MODEL = gpt-4o
OPENAI_COMPATIBLE_FALLBACK_MODELS = gpt-4o-mini  # 可选
```

#### Zhipu (智谱)
```
ZHIPU_API_KEY = xxxxxxxxxxxx
ZHIPU_SEARCH_ENGINE = search_std            # 可选
```

#### Context7
```
CONTEXT7_API_KEY = xxxxxxxxxxxx
```

#### Jina Reader
```
JINA_API_KEY = jina_xxxxxxxxxxxx
JINA_READER_API_URL = https://r.jina.ai    # 可选
```

---

## 凭证源语法

API Key 字段支持三种格式：

| 格式 | 示例 | 说明 |
|------|------|------|
| 直接值 | `sk-abc123...` | 明文存储 (文件权限 0o600) |
| 环境变量 | `$OPENAI_API_KEY` 或 `${OPENAI_API_KEY}` | 运行时从环境变量读取 |
| Shell 命令 | `!op read op://vault/api-key` | 运行时执行命令获取 (5s 超时) |

TUI 编辑时会自动识别并提示：
- `$VAR` → 显示 `(env var)`
- `!cmd` → 显示 `(shell command)`

---

## 配置文件位置

| 文件 | 用途 | 路径 |
|------|------|------|
| Smart Search 主配置 | Python CLI + TUI 编辑 | `%LOCALAPPDATA%/smart-search/config.json` (Win) / `~/.config/smart-search/config.json` |
| Web Access 配置 | Native TS providers | `~/.pi/web-search.json` |
| 环境变量覆盖 | 强制指定配置目录 | `SMART_SEARCH_CONFIG_DIR=/path/to/dir` |

### 配置同步

TUI 中 **Ctrl+S** 将 Smart Search 配置同步到 `~/.pi/web-search.json`，映射关系：

```
Smart Search 键          →  web-search.json 键
─────────────────────────────────────────────
PERPLEXITY_API_KEY       →  perplexityApiKey
OPENAI_API_KEY           →  openaiApiKey
BRAVE_API_KEY            →  braveApiKey
EXA_API_KEY              →  exaApiKey
GEMINI_API_KEY           →  geminiApiKey
TAVILY_API_KEY           →  tavilyApiKey
FIRECRAWL_API_KEY        →  firecrawlApiKey
SEARXNG_BASE_URL         →  searxngBaseUrl
WEB_SEARCH_PROVIDER      →  provider
SSRF_ALLOW_RANGES        →  ssrf.allowRanges
...                      →  (共 31 条映射)
```

同步状态在 TUI 中显示：
- `✓` 两源一致
- `⚠` 两源冲突
- `→` 仅 Smart Search 有值
- `←` 仅 web-search.json 有值

---

## 安全配置

### SSRF 防护
```
SSRF_ALLOW_RANGES = 198.18.0.0/16,100.64.0.0/10   # CIDR 白名单 (fake-IP 代理)
SSRF_TRUST_ENV_PROXY = true                         # 信任 HTTP_PROXY 环境变量
FETCH_DOMAIN_ALLOW = github.com,stackoverflow.com   # 域名白名单
FETCH_DOMAIN_DENY = evil.com                        # 域名黑名单 (优先于白名单)
```

### 视频分析
```
VIDEO_MAX_SIZE_MB = 50          # 本地视频大小上限
VIDEO_ENABLED = true
YOUTUBE_ENABLED = true
YOUTUBE_PREFERRED_MODEL = gemini-3-flash-preview
```

---

## 搜索策略配置

```
SMART_SEARCH_VALIDATION_LEVEL = balanced    # fast | balanced | strict
SMART_SEARCH_FALLBACK_MODE = auto           # auto | off
SMART_SEARCH_MINIMUM_PROFILE = standard     # 最低配置要求
SMART_SEARCH_RESEARCH_PREFERRED_PROVIDERS = exa,perplexity
SMART_SEARCH_RESEARCH_DISABLED_PROVIDERS = anysearch
```

### Intent Router (语义路由)
```
SMART_SEARCH_INTENT_ROUTER = true
INTENT_EMBEDDING_API_URL = https://api.openai.com/v1
INTENT_EMBEDDING_API_KEY = $OPENAI_API_KEY
INTENT_EMBEDDING_MODEL = text-embedding-3-small
INTENT_EMBEDDING_THRESHOLD = 0.7
INTENT_CLASSIFIER_API_URL = https://api.openai.com/v1
INTENT_CLASSIFIER_API_KEY = $OPENAI_API_KEY
INTENT_CLASSIFIER_MODEL = gpt-4o-mini
```

---

## 常见场景

### 场景 1: 仅用免费搜索
无需配置。Exa (零配置) + AnySearch (匿名) 自动可用。

### 场景 2: 配置主力搜索 + 内容提取
```
/smart-search config
→ 填入 EXA_API_KEY (搜索 + 提取)
→ 填入 JINA_API_KEY (网页提取)
→ Ctrl+S 同步
```

### 场景 3: 自托管 SearXNG + Gemini
```
SEARXNG_BASE_URL = https://search.myserver.com
GEMINI_API_KEY = AIza...
```
SearXNG 在 auto 模式下最优先，Gemini 作为提取后备。

### 场景 4: 使用原生搜索 (跳过 Python CLI)
```
smart_search(mode: "search", query: "...", native: true)
```
直接走 Native TS 路径，使用 `~/.pi/web-search.json` 配置。
