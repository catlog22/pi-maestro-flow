# Pi 工具 Schema 参考文档

> 生成时间：2026-01-22 · teammate 章节修订于 2026-07-15（对应 pi-maestro-teammate ≥ 0.4.4 的 schema）| 共 17 个系统工具

## 目录

1. [read](#1-read---读取文件)
2. [bash](#2-bash---执行-shell-命令)
3. [edit](#3-edit---编辑文件)
4. [write](#4-write---写入文件)
5. [teammate](#5-teammate---派发-teammate-代理)
6. [teammate-send](#6-teammate-send---向运行中的-teammate-发消息)
7. [teammate-list](#7-teammate-list---列出-teammate)
8. [teammate-watch](#8-teammate-watch---查看-teammate-输出)
9. [maestro](#9-maestro---maestro-流程命令)
10. [goal](#10-goal---自治目标管理)
11. [ask-user-question](#11-ask_user_question---结构化用户提问)
12. [todo](#12-todo---任务管理)
13. [lsp](#13-lsp---language-server-protocol-查询)
14. [browser](#14-browser---浏览器控制)
15. [search_tool_bm25](#15-search_tool_bm25---工具搜索)
16. [smart_search](#16-smart_search---智能搜索)
17. [plan-enter](#17-plan-enter---进入-plan-模式)

---

## 1. `read` - 读取文件

读取文本或图片。文本截断至 2000 行 / 50KB。图片以附件发送。

| 参数 | 类型 | 必需 | 说明 |
|------|------|:---:|------|
| `path` | string | ✅ | 相对/绝对路径。支持 jpg/png/gif/webp/bmp |
| `offset` | number | | 起始行号 (1-indexed) |
| `limit` | number | | 最大读取行数 |

```js
read({ path: "src/main.ts" })
read({ path: "src/main.ts", offset: 2001, limit: 1000 })
```

---

## 2. `bash` - 执行 Shell 命令

| 参数 | 类型 | 必需 | 说明 |
|------|------|:---:|------|
| `command` | string | ✅ | Bash 命令，`cd` 用 `&&` 串联 |
| `timeout` | number | | 超时秒数 |
| `workdir` | string | | 工作目录 |
| `description` | string | | 用途说明 |
| `stream` | boolean | | 后台运行时启用实时流 |

```js
bash({ command: "cd D:/project && npm test", timeout: 120 })
```

---

## 3. `edit` - 编辑文件

精确文本替换。`oldText` 必须唯一。

| 参数 | 类型 | 必需 | 说明 |
|------|------|:---:|------|
| `path` | string | ✅ | 文件路径 |
| `edits` | Edit[] | ✅ | 编辑数组 |

**Edit 结构：**

| 字段 | 类型 | 必需 | 说明 |
|------|------|:---:|------|
| `oldText` | string | ✅ | 精确匹配的原始文本 |
| `oldText.replace` | regex | | 替换 oldText 中匹配的部分 |
| `newText` | string | ✅ | 替换后文本 |
| `replaceAll` | boolean | | 替换所有匹配位置 |

```js
edit({
  path: "src/config.ts",
  edits: [
    { oldText: "const PORT = 3000;", newText: "const PORT = 8080;" }
  ]
})
```

---

## 4. `write` - 写入文件

创建或覆盖，自动创建父目录。

| 参数 | 类型 | 必需 | 说明 |
|------|------|:---:|------|
| `path` | string | ✅ | 文件路径 |
| `content` | string | ✅ | 文件内容 |

---

## 5. `teammate` - 派发 Teammate 任务

所有调用统一使用非空 `tasks[]`。单 Agent 是一个 task，多 Agent 是多个 task；不存在公开的 single/chain 模式。每个 task 的 `prompt` 是必需的字面任务文本，系统不会加载或展开 Prompt 模板。

**核心语义**：顶层 `agent`/`taskType`/`context`/`model`/`thinking`/`cwd`/`outputSchema`/`timeoutMs` 是 task 默认值，task 同名字段优先。未提供有效 agent 时默认 `general`。公共参数对象是封闭 schema，未声明字段（包括内部 `protocol_version`）会被拒绝。

### 顶层参数

| 参数 | 类型 | 必需 | 说明 |
|------|------|:---:|------|
| `tasks` | Task[] | ✅ | 非空任务数组 |
| `agent` | string | | 默认角色；最终默认 `general` |
| `taskType` | string | | 默认任务类型；可使用内置类型或自定义 Agent 声明的小写标识，仅影响模型路由 |
| `reply_to` | enum | | `caller`（默认）/`main`，控制结果路由 |
| `concurrency` | integer | | 最大并发，默认 4 |
| `maxAgents` | integer | | 单次派发允许的最大任务数，默认 15 |
| `outputSchema` | object | | 默认 JSON Schema |
| `background` | boolean | | 后台运行，默认 `false` |
| `context` | enum | | `fresh`（默认）/`fork` |
| `model` | string | | 精确 `provider/model` 默认值 |
| `thinking` | enum | | 默认思考深度；`max` 是 `xhigh` 别名 |
| `cwd` | string | | 默认工作目录 |
| `timeoutMs` | integer | | 默认超时毫秒数 |

### Task 结构

| 字段 | 类型 | 必需 | 说明 |
|------|------|:---:|------|
| `prompt` | string | ✅ | 非空字面任务文本 |
| `agent` | string | | 角色覆盖 |
| `taskType` | string | | 内置或自定义 Agent 任务类型；格式为小写标识，仅模型路由 |
| `name` | string | | 任务标识符，用于引用和寻址 |
| `dependsOn` | string[] | | 显式依赖任务名；未知名称直接报错 |
| `context` | enum | | `fresh`/`fork` 覆盖 |
| `model` | string | | 模型覆盖 |
| `thinking` | enum | | 思考深度覆盖 |
| `cwd` | string | | 工作目录覆盖 |
| `outputSchema` | object | | 结构化输出 JSON Schema |
| `timeoutMs` | integer | | 超时覆盖 |

### 依赖与变量引用

- `{name}` 注入上游最终输出；`{name.field}` / `{name[0].field}` 访问结构化输出。
- 依赖边 = `prompt` 中的引用 ∪ `dependsOn`。上游失败时下游跳过。
- 未匹配引用按字面文本传递并警告；近似已有任务名的引用按拼写错误拒绝。
- 循环依赖和重名任务在派发前被拒绝。

```js
teammate({ tasks: [{ agent: "analyst", taskType: "analysis", prompt: "分析认证流程" }] })

teammate({ tasks: [
  { name: "scan", agent: "explorer", prompt: "定位认证入口" },
  { name: "review", agent: "analyst", prompt: "审查 {scan}" }
], background: false })
```

内置角色为 `general`、`explorer`、`planner`、`analyst`、`research`、`verifier`、`workflow`。`verifier` 仅在 Goal 没有 acceptance commands 时作为独立只读备用验证器。旧 `delegate`、`goal-verifier` 和 `coordinator` 不再是内置名称。

模型优先级：`task.model > 顶层 model > taskType 映射 > 角色 model > 父 Pi 模型`。Thinking 优先级：`task.thinking > 顶层 thinking > taskType 映射 > 角色 frontmatter > Pi 默认`。Control Center 自动合并内置类型、当前发现的内置/项目/用户 Agent YAML 类型和已有路由配置类型；自定义 Agent 可用 `taskType: security-audit` 声明新类型。

### teammate vs maestro（§9）如何选

两者共用同一执行引擎（maestro 的三个 action 是 `runTeammate` 的包装）。选择判据：派发 **pi agent 角色**（agents/*.md，含 DAG/结构化输出/会话 fork）→ `teammate`；调用**外部 CLI endpoint**（gemini/codex 等）做并行搜索、委托或 MoA 聚合 → `maestro`。

---

## 6. `teammate-send` - 向运行中 Teammate 发消息

| 参数 | 类型 | 必需 | 说明 |
|------|------|:---:|------|
| `to` | string | ✅ | 目标 agent：名称、correlation ID 或唯一 ID 前缀（来自 teammate-list） |
| `message` | string | | 消息内容。`steer`/`follow_up` 必需；`abort` 可省略 |
| `mode` | enum | | `steer`(打断当前轮)/`follow_up`(默认，排队)/`abort`(终止) |

---

## 7. `teammate-list` - 列出 Teammate

| 参数 | 类型 | 必需 | 说明 |
|------|------|:---:|------|
| `view` | enum | | `active`(默认)/`named`/`all`/`roles`。`roles` 列出可用 agent 角色定义（builtin/project/user），其余列运行中实例 |

---

## 8. `teammate-watch` - 查看 Teammate 输出

| 参数 | 类型 | 必需 | 说明 |
|------|------|:---:|------|
| `name` | string | ✅ | Agent 名称或 correlation ID/前缀（与 teammate-send 寻址规则一致） |
| `lines` | integer | | 返回行数(默认20) |

---

## 9. `maestro` - Maestro 流程命令

三合一：并行搜索 / 委托 / Mixture-of-Agents。与 teammate 共用执行引擎，面向**外部 CLI endpoint**（选择判据见 §5 末尾）。

explore 提示词结构（explorer 类 agent 通用）：`FIND:`(目标+条件) `SCOPE:`(有界路径) `EXCLUDE:` `ATTENTION:`(框架/约定/陷阱) `EXPECTED:`(输出格式)。

| 参数 | 类型 | 必需 | 说明 |
|------|------|:---:|------|
| `action` | enum | ✅ | `explore`/`delegate`/`moa` |
| `prompts` | string[] | | explore/moa 的 prompt 数组 |
| `prompt` | string | | delegate 的任务 prompt |
| `endpoint` | string | | explore 的 model/endpoint |
| `all` | boolean | | explore 扇出到所有 endpoint |
| `maxTurns` | integer | | explore 最大轮次 |
| `concurrency` | integer | | explore 最大并发(默认4) |
| `tool` | string | | delegate 目标 provider |
| `mode` | enum | | delegate: `analysis`/`write` |
| `name` | string | | delegate 任务名 |
| `rule` | string | | delegate 协议+模板 |
| `preset` | string | | moa preset 配置 |
| `model` | string | | 模型覆盖 |
| `cwd` | string | | 工作目录 |
| `timeoutMs` | integer | | 超时毫秒数 |

---

## 10. `goal` - 自治目标读取与创建

| 参数 | 类型 | 必需 | 说明 |
|------|------|:---:|------|
| `action` | enum | ✅ | `get`/`create` |
| `objective` | string | create 时 ✅ | 目标描述 |
| `tokenBudget` | string | | 可选的显式 Token 预算；默认省略即无预算。接受纯数字、`k`、`m`，仅用于 create |

预算不是 Goal 的默认属性：只有调用方显式传入 `tokenBudget`，或用户在 `/goal create|resume` 中使用 `--tokens` 后才存在。`/goal` 使用 Pi 原生参数补全显示无预算创建和 `--tokens 100k` 两种 hint；function schema 不添加 provider 不兼容的非标准 `hint` 字段。

Goal 生命周期由用户命令控制：`/goal stop`、`/goal resume`、`/goal clear`。正常 agent loop 结束后自动验证，无需完成动作。

Session 隔离：Goal 持久化条目绑定当前 `sessionId`。`/new` 与 `/fork` 不继承旧 Goal；同 session 的 `/resume` 可恢复为 `WAITING`。普通输入不会取得 Goal loop ownership，只有 create、`/goal resume` 或内部 continuation 启动的 loop 才会在 `agent_end` 进入 Goal verifier。

`session_start(reason:"startup")` 只表示 Pi 进程启动，不等于 Goal 恢复。只有当前 sessionId 存在自己的 Goal entry 时才恢复并 attach Workflow；仅在 cwd 中发现 running Workflow 时保持只读，不自动投影 Goal。

兼容性约束：函数 schema 必须保持单一 `type: "object"` 根节点，不使用根级 `anyOf`。因此 `objective` 在 JSON Schema 中是 optional，但执行层会拒绝缺少或为空的 `create` 请求。

排障：若 provider 返回 `Invalid schema for function 'goal' ... got 'type: null'`，说明当前进程仍加载了旧的根级 union schema。更新后需重启 Pi 或 reload extension；若原 Goal 因该 400 被暂停，再执行 `/goal resume`。

```js
goal({ action: "create", objective: "实现认证模块" })
goal({ action: "create", objective: "实现认证模块", tokenBudget: "500k" }) // 显式预算
goal({ action: "get" })
```

---

## 11. `ask_user_question` - 结构化用户提问

| 参数 | 类型 | 必需 | 说明 |
|------|------|:---:|------|
| `questions` | Question[] | ✅ | 1-4 个问题 |

**Question 结构：**

| 字段 | 类型 | 必需 | 说明 |
|------|------|:---:|------|
| `question` | string | ✅ | 问题文本 |
| `header` | string | | 短标签(≤16字符) |
| `options` | Option[] | | 2-4 个选项 |
| `multiSelect` | boolean | | 允许多选 |

```js
ask_user_question({ questions: [{ question: "选择语言", options: [{ label: "TS" }, { label: "Rust" }] }] })
```

---

## 12. `todo` - 任务管理

| 参数 | 类型 | 必需 | 说明 |
|------|------|:---:|------|
| `action` | enum | ✅ | `create`/`update`/`list`/`get`/`delete`/`clear`/`next` |
| `id` | string | | 任务 ID |
| `subject` | string | | 标题(create 必需) |
| `description` | string | | 详情 |
| `status` | enum | | `pending`/`in_progress`/`completed`/`blocked` |
| `blockedBy` | string[] | | 依赖 ID |
| `context` | string | | 执行上下文 |
| `skills` | Skill[]/null | | skill 绑定 |
| `summary` | string | | 完成摘要 |
| `filter` | object | | `{ status }` |

**Skill 结构：** `{ name, role: "primary"|"guard"|"support", args? }`

---

## 13. `lsp` - Language Server Protocol 查询

| 参数 | 类型 | 必需 | 说明 |
|------|------|:---:|------|
| `action` | enum | ✅ | `diagnostics`/`definition`/`references`/`hover`/`symbols`/`rename`/`rename_file`/`code_actions`/`type_definition`/`implementation`/`status`/`reload`/`capabilities`/`request` |
| `file` | string | | 文件路径，`*` 工作区 |
| `line` | integer | | 行号(1-indexed) |
| `symbol` | string | | 符号名，支持 `name#N` |
| `query` | string | | 符号/code-action 查询 |
| `new_name` | string | | 新名称/路径 |
| `apply` | boolean | | 应用编辑 |
| `timeout` | number | | 超时(5-60s) |
| `limit` | integer | | 最大结果(默认50, 最大200) |
| `offset` | integer | | 偏移量 |
| `payload` | string | | request 的 JSON payload |

---

## 14. `browser` - 浏览器控制

| 参数 | 类型 | 必需 | 说明 |
|------|------|:---:|------|
| `action` | enum | ✅ | `open`/`close`/`run` |
| `name` | string | | Tab ID(默认 main) |
| `url` | string | | 导航 URL |
| `app` | object | | `{ path, cdp_url, args, target }` |
| `viewport` | object | | `{ width, height, scale? }` |
| `wait_until` | enum | | `load`/`domcontentloaded`/`networkidle0`/`networkidle2` |
| `dialogs` | enum | | `accept`/`dismiss` |
| `code` | string | | JS 函数体，可用 page/browser/tab |
| `timeout` | number | | 超时(1-300s) |
| `all` | boolean | | 关闭全部 Tab |
| `kill` | boolean | | 兼容标志 |

---

## 15. `search_tool_bm25` - 工具搜索

| 参数 | 类型 | 必需 | 说明 |
|------|------|:---:|------|
| `query` | string | ✅ | 自然语言查询 |
| `limit` | integer | | 最大匹配(1-50) |

---

## 16. `smart_search` - 智能搜索

| 参数 | 类型 | 必需 | 说明 |
|------|------|:---:|------|
| `mode` | enum | ✅ | `search`/`research`/`fetch`/`route` |
| `query` | string | ✅ | 查询或 URL |
| `platform` | string | | 搜索平台 |
| `model` | string | | 模型覆盖 |
| `extra_sources` | integer | | 额外来源(0-20) |
| `validation` | enum | | `fast`/`balanced`/`strict` |
| `fallback` | enum | | `auto`/`off` |
| `providers` | string | | 逗号分隔 provider |
| `timeout` | integer | | 超时(1-600s) |
| `budget` | enum | | `quick`/`standard`/`deep` |
| `evidence_dir` | string | | 证据目录 |
| `router_mode` | enum | | `hybrid`/`rules`/`off` |
| `max_output_bytes` | integer | | 最大输出(1024-10000000) |

---

## 17. `plan-enter` - 进入 Plan 模式

| 参数 | 类型 | 必需 | 说明 |
|------|------|:---:|------|
| `prompt` | string | | 排队规划请求 |

---

> 本文档基于系统提示词中的工具定义生成，覆盖全部 17 个工具的参数 schema。
