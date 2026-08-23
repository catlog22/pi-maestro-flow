# Smart Search 配置（AI 可执行）

本文档面向 AI agent，配置 `smart_search` 工具的外部搜索 provider 与凭证。Smart Search 提供 web 搜索、深度研究、URL 抓取、路由诊断。

## PURPOSE

配置 Smart Search 的 provider 凭证，满足最低能力档案：
1. **main_search** 至少一个 provider（openai-compatible / xai-responses）
2. **docs_search** 至少一个 provider（context7 / exa）
3. **web_fetch** 至少一个 provider（tavily / jina / firecrawl / zhipu-mcp）

成功标准：`smart_search` 的 `route` 诊断模式返回 `minimum_profile_ok: true`，三类能力各有可用 provider。

## PREREQUISITES

- 至少一个搜索 provider 账号（推荐组合：Tavily（web_fetch+web_search）+ Exa 或 Context7（docs）+ 一个 OpenAI 兼容端点（main_search））
- 知道配置文件位置（见下，勿写错位置）

## 配置文件位置（重要）

配置**不是** `~/.maestro/cli-tools.json`（那是 Maestro delegate CLI 的配置）。Smart Search 有独立的配置文件，解析规则（见 `src/tools/smart-search-config.ts` 的 `resolveSmartSearchConfigPath`）：

| 平台 | 路径 |
|---|---|
| Windows | `%LOCALAPPDATA%\smart-search\config.json` |
| macOS/Linux | `~/.config/smart-search/config.json` |
| 环境变量覆盖 | `SMART_SEARCH_CONFIG_DIR` 指定的目录下 `config.json` |

格式为扁平 JSON，env 风格键：
```json
{
  "TAVILY_API_KEY": "tvly-...",
  "EXA_API_KEY": "...",
  "OPENAI_COMPATIBLE_API_URL": "https://...",
  "OPENAI_COMPATIBLE_API_KEY": "sk-...",
  "OPENAI_COMPATIBLE_MODEL": "..."
}
```

## TASK

### 1. 交互式收集 provider 与 key

向用户询问要启用的 provider 与对应 key（见 INTERACTIVE INPUTS）。按能力缺口优先补齐：先探测当前配置（步骤 2），缺哪类能力就先配哪类。

各 provider 的键（来自 `SMART_SEARCH_CONFIG_GROUPS`）：

| Provider | 能力 | 键 |
|---|---|---|
| openai-compatible | main_search | `OPENAI_COMPATIBLE_API_URL` / `OPENAI_COMPATIBLE_API_KEY` / `OPENAI_COMPATIBLE_MODEL` / `OPENAI_COMPATIBLE_FALLBACK_MODELS` / `OPENAI_COMPATIBLE_STREAM` |
| exa | docs_search | `EXA_API_KEY` / `EXA_BASE_URL` / `EXA_TIMEOUT_SECONDS` |
| context7 | docs_search | `CONTEXT7_API_KEY` / `CONTEXT7_BASE_URL` / `CONTEXT7_TIMEOUT_SECONDS` |
| tavily | web_fetch + web_search | `TAVILY_API_KEY` / `TAVILY_API_URL` / `TAVILY_ENABLED` / `TAVILY_TIMEOUT_SECONDS` |
| jina | web_fetch | `JINA_API_KEY` / `JINA_READER_API_URL` / `JINA_RESPOND_WITH` / `JINA_TIMEOUT_SECONDS` |
| firecrawl | web_fetch + web_search | `FIRECRAWL_API_KEY` / `FIRECRAWL_API_URL` |
| zhipu | web_search | `ZHIPU_API_KEY` / `ZHIPU_API_URL` / `ZHIPU_SEARCH_ENGINE` / `ZHIPU_TIMEOUT_SECONDS` |
| anysearch | vertical_search | `ANYSEARCH_API_KEY` / `ANYSEARCH_API_URL` / `ANYSEARCH_TIMEOUT_SECONDS` |

### 2. 探测当前配置并写入

先定位现有配置文件（按上面的平台规则），读取已有键，合并写入新键（不覆盖未提及的键）：

```bash
node -e '
const fs=require("fs"),os=require("os"),p=require("path");
const dir=process.env.SMART_SEARCH_CONFIG_DIR
  || (process.platform==="win32"&&process.env.LOCALAPPDATA ? p.join(process.env.LOCALAPPDATA,"smart-search") : p.join(os.homedir(),".config","smart-search"));
fs.mkdirSync(dir,{recursive:true});
const file=p.join(dir,"config.json");
const cfg=fs.existsSync(file)?JSON.parse(fs.readFileSync(file,"utf8")):{};
Object.assign(cfg,JSON.parse(process.env.PI_SS_KEYS));
fs.writeFileSync(file,JSON.stringify(cfg,null,2)+"\n");
console.log("wrote",file);
'
```

`PI_SS_KEYS` 是要写入的键值 JSON（如 `{"TAVILY_API_KEY":"tvly-..."}`）。API key 属于敏感值：从 `ctx.ui.input` 收集后直接传入环境变量，不落日志。

**校验点**：`cat <config文件>` 含新增的 provider 键且非空。

### 3. 推荐路径：/smart-search 命令（可选）

插件自带 `/smart-search` 设置命令（settings TUI），可交互式编辑上述同一份配置（含 secret 占位处理）。若用户偏好图形化配置，引导运行：

```
/smart-search
```

脚本化写入（本文档步骤 2）与该命令操作的是同一份文件，二者等价。

## INTERACTIVE INPUTS

1. **main_search 方式**（`ctx.ui.select`）：
   - 选项：`OpenAI 兼容端点（URL+KEY+MODEL）` / `已有中继（xai-responses 等）` / `跳过`
   - 若选 OpenAI 兼容：依次 `ctx.ui.input` 问 URL、KEY、MODEL → 写入 `OPENAI_COMPATIBLE_*`
2. **docs_search provider**（`ctx.ui.select`）：`exa` / `context7` / `跳过`
   - 对应 `ctx.ui.input` 问 API KEY
3. **web_fetch provider**（`ctx.ui.select`）：`tavily` / `jina` / `firecrawl` / `跳过`
   - 对应 `ctx.ui.input` 问 API KEY
4. 把所有收集到的键值组装为 JSON 写入 `PI_SS_KEYS`

**不得臆测 key**；用户选"跳过"的能力若导致最低档案不满足，在报告中明确指出缺口。

## VERIFY

用 smart_search 工具的 route 模式诊断（read-only）。它是 AI 工具而非 CLI——在 pi 会话里让 AI 调用：

```
smart_search { mode: "route", query: "diagnostics" }
```

或用户运行 `/smart-search` 打开设置 TUI 查看 provider 状态。

**预期**：`minimum_profile_ok: true`；`capability_status` 中 `main_search` / `docs_search` / `web_fetch` 三类 `ok: true`。若有缺口，报告缺失的能力类别和建议的 provider。

## ROLLBACK

- 从配置文件删除本次写入的键（保留原有键）
- 或删除整个 `config.json`（恢复无配置状态，route 诊断返回 `minimum_profile_ok: false`）
