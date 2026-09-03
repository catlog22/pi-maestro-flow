# Pi 工具 Schema 参考文档

> 生成时间：2026-01-22 · 修订于 2026-09-03（对应 pi-maestro-flow ≥ 0.27.0 / pi-maestro-teammate ≥ 2.5.0）| 共 21 个系统工具

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
18. [run-control](#18-run-control---maestro-sessionrun-生命周期)
19. [session_history](#19-session_history---有界会话历史)
20. [new-context](#20-new-context---确定性上下文重置)
21. [resource](#21-resource---精确协议资源读取)

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
| `maxNestingDepth` | integer | | 嵌套派发深度预算（0..2），0 禁止子代理再派发 teammate；默认全局天花板 |
| `outputSchema` | object | | 默认 JSON Schema |
| `background` | boolean | | 后台运行，默认 `false` |
| `context` | enum | | `fresh`（默认）/`fork` |
| `model` | string | | 精确 `provider/model` 默认值 |
| `fallbackModels` | string[] | | 默认的按序 fallback 链 |
| `thinking` | enum | | 默认思考深度（`off`/`minimal`/`low`/`medium`/`high`/`xhigh`/`max`；`xhigh` 与 `max` 为不同 canonical 级别） |
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
| `fallbackModels` | string[] | | fallback 链覆盖 |
| `thinking` | enum | | 思考深度覆盖 |
| `cwd` | string | | 工作目录覆盖 |
| `outputSchema` | object | | 结构化输出 JSON Schema |
| `timeoutMs` | integer | | 超时覆盖 |
| `maxNestingDepth` | integer | | 嵌套深度预算覆盖（0..2，0 禁止嵌套） |

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

> ⚠️ **默认隐藏的 legacy 工具**：仅当 `PI_TEAMMATE_LEGACY_OBSERVATION_TOOLS=1` 时注册。公开的观察面是 `observe`（状态/等待/屏障，targets 为 `{kind,id}` 对象数组）；`teammate-wait`/`teammate-monitor` 同为 legacy。

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
| `action` | enum | ✅ | `get`/`create`/`update`/`complete` |
| `objective` | string | create 时 ✅ | 目标描述（update 时为替换后的新目标） |
| `summary` | string | complete 时 ✅ | 完成证据说明 |
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
goal({ action: "update", objective: "实现认证模块 + 刷新令牌" })
goal({ action: "complete", summary: "全部实现并通过测试" })
```

Workflow Session/Run 绑定的 Goal 由 Run lifecycle 驱动，其他会话只读，防止误操作。

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
| `action` | enum | ✅ | `create`/`update`/`list`/`get`/`delete`/`clear`/`next`/`advance` |
| `id` | string | | 单任务 ID（get/单 update/单 delete 用） |
| `ids` | string[] | | 批量原子删除；不可与 `id` 同用 |
| `subject` | string | | 标题（单 create 必需） |
| `tasks` | Task[] | | 非空批量创建；`blockedBy` 用同批下标构成 DAG，原子提交 |
| `updates` | Update[] | | 非空批量原子更新；不可与 `id`/顶层更新字段同用 |
| `description` | string | | 详情 |
| `status` | enum | | `pending`/`in_progress`/`completed`/`blocked` |
| `blockedBy` | string[] | | 依赖 ID |
| `context` | string | | 执行上下文 |
| `skills` | Skill[]/null | | skill 绑定 |
| `summary` | string | | 完成摘要（会注入后续任务上下文） |
| `resourceUris` | string[] | | 持久化资源引用（如 `agent://<publication-id>`），随任务持久化 |
| `goalId` | string | | 作为质量门的 Goal；空字符串清除 |
| `transition` | enum | | 仅 `advance` 可用：`new_context` 在提交后调度确定性上下文重置 |
| `filter` | object | | `{ status, memberId? }` |
| `planHandoffKey` | string | | 已批准 Plan 的 handoff key |

**Skill 结构：** `{ name, role: "primary"|"guard"|"support", args? }`

`advance` 是 live 状态机完成动作：无活动任务时激活调用者自己的下一可运行任务；有活动任务时完成当前项并推进下一项，按调用 actor 隔离归属。`tasks[].todo` 可把 Todo 绑定给派发的 teammate Agent，由其自行推进。任务携带计时元数据（开始/完成时间、耗时），同 generation Workflow mirror 对账时保留本地计时与 skill 激活状态。

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

---

## 18. `run-control` - Maestro Session/Run 生命周期

canonical Maestro CLI 的 argv 透传壳，是 Session/Run 生命周期的唯一 LLM 工具面。读命令（`status`/`brief`/`check`/`recall`/`evidence`/`list`/`show`/`graph`/`search`/`load`/`review` 等）无需 mutation lease；写命令（`next`/`done`/`decide`/`seal`/`edit`/`meta`/`recover` 等）需当前 Pi session 持有 lease，Plan 模式阻断。

```js
run-control({ argv: ["session", "status"] })
run-control({ argv: ["run", "done", "run-123", "--verdict", "done", "--summary", "完成"] })
```

---

## 19. `session_history` - 有界会话历史

始终可用、宿主授权的只读工具，在 current / workspace / teammate 三种 scope 中有界列举会话、字面搜索、读取精确 turn。仅暴露 active-chain 可见消息（user/assistant/visible_custom/compaction），`tool_result` 须显式 opt-in；不接受 transcript 路径，不暴露隐藏行、thinking 与工具调用参数。

| 参数 | 类型 | 必需 | 说明 |
|------|------|:---:|------|
| `action` | enum | ✅ | `list_sessions`/`search`/`read_turn` |
| `scope` | enum | | `current_session`/`workspace_sessions`/`teammates` |
| `query` | string | search 时 ✅ | 字面大小写不敏感搜索文本 |
| `sessionId` / `turn` | string/integer | read_turn 时 ✅ | 精确会话与 1-based turn（0 为 preamble） |
| `include` | string[] | | 默认不含 `tool_result` |
| `limit` | integer | | 单结果上限 |

```js
session_history({ action: "search", scope: "workspace_sessions", query: "migration", limit: 5 })
```

---

## 20. `new-context` - 确定性上下文重置

在 Todo 完成边界调度确定性同会话上下文重置（默认启用，`compaction.newContext.enabled` 可关）。新上下文只携带 Todo/Goal/Plan/Workflow 状态派生的有界 recovery capsule，不做模型摘要。

```js
todo({ action: "advance", id: "abc123", summary: "阶段完成", transition: "new_context" })
```

只在当前阶段已完整持久化、下一阶段弱耦合时使用；普通 token 压力仍由 automatic compact 处理。

---

## 21. `resource` - 精确协议资源读取

按 URI 读取协议资源（与本地文件读取互补）：`pr://`/`issue://`（GitHub）、`skill://`、`rule://`、`agent://<id>`（teammate 产出，支持子路径取嵌套字段）、`session://<sessionId>/entry/<entryId>`（经 `compact_history` 或 `session_history` 发现的授权条目，每次读取重校验 active chain）。

```js
resource({ uri: "agent://reviewer-1/findings/0/path" })
```

---

> 本文档基于系统提示词中的工具定义生成，覆盖全部 21 个工具的参数 schema。
