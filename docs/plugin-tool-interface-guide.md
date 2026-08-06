# pi-maestro-flow 工具接口对接开发指南

> 面向需要调用本插件对外暴露工具接口的开发者。
> 涵盖工具清单、调用机制、逐工具参数/返回/示例，以及编程式 `v1` API。
> 对应版本：`pi-maestro-flow@0.5.0` · `pi-maestro-teammate@0.4.6`

---

## 目录

1. [概述](#1-概述)
2. [安装与加载](#2-安装与加载)
3. [调用机制与返回约定](#3-调用机制与返回约定)
4. [工具接口详解](#4-工具接口详解)
   - 4.1 [teammate — 派发子代理](#41-teammate--派发子代理)
   - 4.2 [teammate-send — 向运行中的代理发消息](#42-teammate-send--向运行中的代理发消息)
   - 4.3 [teammate-list — 列出代理/角色](#43-teammate-list--列出代理角色)
   - 4.4 [teammate-watch — 查看代理输出](#44-teammate-watch--查看代理输出)
   - 4.5 [teammate-wait — 等待代理 settled](#45-teammate-wait--等待代理-settled)
   - 4.6 [maestro — 外部 CLI 端点路由](#46-maestro--外部-cli-端点路由)
   - 4.7 [goal — 自治目标管理](#47-goal--自治目标管理)
   - 4.8 [todo — 任务管理](#48-todo--任务管理)
   - 4.9 [run-control — 工作流 Run 控制](#49-run-control--工作流-run-控制)
   - 4.10 [ask-user-question — 结构化用户提问](#410-ask-user-question--结构化用户提问)
   - 4.11 [ffgrep — FFF 内容搜索](#411-ffgrep--fff-内容搜索)
   - 4.12 [fffind — FFF 文件路径搜索](#412-fffind--fff-文件路径搜索)
5. [编程式 API（v1）](#5-编程式-apiv1)
6. [GUI/UCL 侧车 HTTP API](#6-guiucl-侧车-http-api)
7. [压缩设置与仲裁编程式接口](#7-压缩设置与仲裁编程式接口)
8. [对接示例](#8-对接示例)
9. [错误处理与最佳实践](#9-错误处理与最佳实践)
10. [附录：参数速查表](#10-附录参数速查表)

---

## 1. 概述

本插件由两个 npm 包组成，均以 Pi 扩展（Extension）形式注册工具。工具在扩展加载后自动暴露给 Pi 代理，可通过 **LLM 工具调用** 或 **编程式 `v1` API** 两种方式对接。

| 包 | 版本 | 注册的工具 | 角色 |
|----|------|-----------|------|
| `pi-maestro-flow` | 0.5.0 | `maestro`、`goal`、`todo`、`run-control`、`ask-user-question`、`ffgrep`、`fffind` | 扩展包：流程命令、目标、任务、Run 控制、提问、FFF 搜索 |
| `pi-maestro-teammate` | 0.4.6 | `teammate`、`teammate-send`、`teammate-list`、`teammate-watch`、`teammate-wait` | 核心派发引擎：子代理 DAG 调度、RPC 消息 |

**工具总览（12 个对外工具）**：

| 工具 | 一句话功能 | 来源包 |
|------|-----------|--------|
| `teammate` | 派发一个或多个子代理，支持 DAG 任务图、模型路由、结构化输出 | teammate |
| `teammate-send` | 向运行中/休眠的子代理发送消息（follow_up / steer / abort） | teammate |
| `teammate-list` | 列出活跃代理、命名代理或可用角色 | teammate |
| `teammate-watch` | 查看某个代理的近期输出与工具活动 | teammate |
| `teammate-wait` | 事件驱动地等待代理 settled 或固定延时 | teammate |
| `maestro` | 将任务路由到外部 CLI 端点（explore / delegate / moa） | flow |
| `goal` | 读取/创建/更新自治目标，请求完成验证 | flow |
| `todo` | 任务管理（create/update/list/get/delete/clear/next） | flow |
| `run-control` | Maestro CLI 透传壳（Session/Run 生命周期，读写分类） | flow |
| `ask-user-question` | 通过键盘优先的 TUI 向导收集结构化用户答案 | flow |
| `ffgrep` | FFF 后端快速字面内容搜索 | flow |
| `fffind` | FFF 后端模糊文件路径搜索 | flow |

> **对接方式选择**
> - 在 Pi 代理 / LLM 上下文内调用 → 直接按工具名发起 JSON 工具调用（见 §3、§4）。
> - 在自己的 Node/TS 程序内编排子代理 → 使用 `pi-maestro-teammate/v1` 编程式 API（见 §5）。

---

## 2. 安装与加载

### 2.1 安装

```bash
npm install pi-maestro-flow pi-maestro-teammate
# 或全局
npm install -g pi-maestro-flow pi-maestro-teammate
```

两个包均声明 `peerDependencies` 于 Pi SDK（`@earendil-works/pi-coding-agent`、`@earendil-works/pi-agent-core`、`@earendil-works/pi-ai`），需保证宿主环境已安装 Pi。

### 2.2 扩展加载

每个包在 `package.json` 中声明扩展入口：

```json
{
  "pi": {
    "extensions": ["./src/extension/index.ts"]
  }
}
```

Pi 通过 settings 的 `packages[]` 发现并加载扩展。加载后，扩展默认函数 `export default function (pi: ExtensionAPI)` 被执行，内部调用 `pi.registerTool(...)` 注册上表所有工具。无需对接方手动注册。

### 2.3 编程式导入路径

`pi-maestro-teammate` 提供版本化公共 API（推荐），`./src/*` 仅为兼容保留：

```ts
import { runTeammate, sendRpcMessage, normalizeTeammateParams } from "pi-maestro-teammate/v1";
import type { RunTeammateParams, RunTeammateOptions, SingleResult } from "pi-maestro-teammate/v1";
```

可用子路径：`/v1`（聚合）、`/v1/agents`、`/v1/execution`、`/v1/extension`、`/v1/model-routing`、`/v1/progress-tree`、`/v1/retry`、`/v1/types`。

---

## 3. 调用机制与返回约定

### 3.1 工具调用形态

工具以标准 JSON 工具调用形式发起：工具名 + 一个 JSON 对象参数。参数对象必须符合该工具的 TypeBox schema（见 §4 各工具参数表）。参数在 `execute` 前经过 schema 校验，不合法会被运行时拒绝。

### 3.2 返回结构 `AgentToolResult`

所有工具返回统一的 `AgentToolResult<TDetails>`：

```ts
interface AgentToolResult<TDetails> {
  /** 返回给模型的文本/图片内容 */
  content: (TextContent | ImageContent)[];
  /** 结构化细节，用于日志或 UI 渲染（各工具不同，见各工具“返回”小节） */
  details: TDetails;
  /** 提示 agent 在当前工具批次后停止（可选） */
  terminate?: boolean;
  /** 约定俗成的错误标记（非 schema 字段，多数工具在出错时置 true） */
  isError?: boolean;
}
```

- `content[0]` 通常为 `{ type: "text", text: string }`，是人类与模型可读的结果正文。
- `isError === true` 表示逻辑失败（如未知 action、缺少必填字段、子代理非零退出）。**对接方应优先检查 `isError`，再解析 `content`/`details`。**
- `details` 是工具特定的结构化数据（如 `todo` 返回任务列表、`teammate` 返回 `SingleResult[]`），适合程序化消费。

### 3.3 通用约定

- **argv 分发**：`maestro`、`goal`、`todo` 以 `action` 字段分发子命令；`run-control` 以 `argv` 透传 Maestro CLI（不经过 shell，无注入面）。
- **枚举值大小写敏感**：如 `status`、`verdict`、`mode` 等枚举必须精确匹配小写值。
- **选择器（selector）**：`todo` 的 `assignee`/`filter.memberId` 与 `teammate-*` 的 `to`/`name` 接受多种写法：`self`、`root`、完整 id、唯一 id 前缀、`label`、`@label`、`label#id-prefix`。

---

## 4. 工具接口详解

### 4.1 `teammate` — 派发子代理任务

所有公开调用统一使用非空 `tasks[]`。单代理是一个 task，多代理是多个 task。`TaskSpec.prompt` 是必需的非空字面任务文本，不存在模板加载、`promptArgs` 或 `chain`。顶层与 task 参数对象都是封闭 schema，未声明字段（包括内部 `protocol_version`）会被拒绝。

**参数**（`TeammateParams`）：

| 参数 | 类型 | 必需 | 说明 |
|------|------|:---:|------|
| `tasks` | TaskSpec[] | ✅ | 非空任务数组 |
| `agent` | string | | task 默认角色；最终默认 `general` |
| `taskType` | string | | task 默认类型；支持内置或自定义 Agent 的小写类型标识，仅影响模型路由 |
| `reply_to` | enum | | `caller`（默认）/`main` |
| `concurrency` | integer≥1 | | 最大并发，默认 4 |
| `maxAgents` | integer≥1 | | 单次最大任务数，默认 15 |
| `outputSchema` | object | | task 默认结构化输出 schema |
| `background` | boolean | | 后台运行，默认 `false` |
| `context` | enum | | `fresh`（默认）/`fork` |
| `model` | string | | task 默认精确 `provider/model` |
| `thinking` | enum | | task 默认思考深度，`max` 等价 `xhigh` |
| `cwd` | string | | task 默认工作目录 |
| `timeoutMs` | integer≥1 | | task 默认超时 |

**TaskSpec**：必需非空 `prompt`；可选 `agent`、`taskType`、`name`、`dependsOn`、`context`、`model`、`thinking`、`cwd`、`outputSchema`、`timeoutMs`。task 同名字段覆盖顶层默认。`taskType` 可由当前发现的内置/项目/用户 Agent YAML 自动提供，也可由自定义 Agent 声明新的小写标识；Control Center 会自动纳入对应模型和 thinking 绑定。Thinking 优先级为 `task.thinking > 顶层 thinking > taskType 映射 > 角色 frontmatter > Pi 默认`。

**返回**：`AgentToolResult<Details>`。mode 由任务数量与依赖拓扑报告为 `single`/`parallel`/`chain`/`graph`；这只是结果分类，不是输入模式。

```js
teammate({ tasks: [{
  agent: "explorer",
  taskType: "explore",
  prompt: "FIND: 鉴权中间件
SCOPE: src/middleware/"
}] })

teammate({ background: false, tasks: [
  { name: "definitions", agent: "explorer", prompt: "定位导出定义" },
  { name: "calls", agent: "explorer", prompt: "定位调用点" },
  { name: "review", agent: "analyst", taskType: "review",
    prompt: "综合 {definitions} 与 {calls} 给出审查结论" }
] })
```

注意：`background` 默认 `false`；未匹配的 `{ref}` 按字面量透传并警告，近似任务名的拼写错误会被拒绝；嵌套深度有守卫。

---

### 4.2 `teammate-send` — 向运行中的代理发消息

按名称/ID 向运行中或休眠的子代理投递消息。

| 参数 | 类型 | 必需 | 说明 |
|------|------|:---:|------|
| `to` | string | ✅ | 目标代理：name、`@name`、`显示名#id前缀`、correlation ID 或唯一 ID 前缀（来自 `teammate-list`） |
| `message` | string | 条件 | 消息内容。`steer`/`follow_up` 必填；`abort` 可选 |
| `mode` | enum | | 投递模式（默认 `follow_up`）：`steer`（打断当前 turn 立即注入）/ `follow_up`（当前 turn 后排队）/ `abort`（终止代理） |

**返回**：`AgentToolResult<{ delivered: boolean }>`。`delivered` 表示是否成功写入子进程 stdin。

**示例**：

```js
teammate-send({ to: "review", message: "补充对错误处理的检查", mode: "follow_up" })
teammate-send({ to: "review", mode: "abort" })
```

---

### 4.3 `teammate-list` — 列出代理/角色

| 参数 | 类型 | 必需 | 说明 |
|------|------|:---:|------|
| `view` | enum | | `active`（活跃）/ `named`（命名）/ `all`（全部）/ `roles`（可用角色定义） |

**返回**：`AgentToolResult<{ agents: unknown[] }>`，`content[0].text` 为格式化清单。

---

### 4.4 `teammate-watch` — 查看代理输出

| 参数 | 类型 | 必需 | 说明 |
|------|------|:---:|------|
| `name` | string | ✅ | 代理名、`@name`、`显示名#id前缀` 或 correlation ID/前缀 |
| `lines` | integer≥1 | | 返回的近期输出行数（默认 20） |

**返回**：`AgentToolResult<{ output: string[] }>`。

---

### 4.5 `teammate-wait` — 等待代理 settled

事件驱动等待，避免轮询 `teammate-watch`。

| 参数 | 类型 | 必需 | 说明 |
|------|------|:---:|------|
| `name` | string | | 等待目标代理；不提供则配合 `waitMs` 做固定延时 |
| `timeoutMs` | integer≥1 | | 等待目标代理 settled 的最长时间 |
| `waitMs` | integer≥1 | | 无代理名时的固定延时毫秒 |

**返回**：`AgentToolResult<{ status: TeammateWaitStatus; output: string[] }>`。

---

### 4.6 `maestro` — 外部 CLI 端点路由

将任务路由到外部 CLI 端点（gemini/codex CLI 进程）。三个 action：`explore`（并行搜索）、`delegate`（委派分析/实现）、`moa`（多模型合成）。

> 在 Pi 代理内，常规的委派/探索/合成应优先用 `teammate`；`maestro` 仅用于直接路由到外部 CLI 端点的少见场景。知识检索走 `maestro search/load` bash CLI，不属于本工具。

**参数**（`MaestroParams`）：

| 参数 | 类型 | 必需 | 说明 |
|------|------|:---:|------|
| `action` | enum | ✅ | `explore` / `delegate` / `moa` |
| `prompts` | string[] | explore | 搜索 prompts（每个 = 一个并行代理） |
| `endpoint` | string | | explore 代理的指定模型/端点 |
| `all` | boolean | | 将每个 prompt 扇出到所有已注册端点 |
| `maxTurns` | integer≥1 | | 每个探索任务的最大代理 turn 数 |
| `concurrency` | integer≥1 | | 最大并发探索代理数（默认 4） |
| `prompt` | string | delegate | 委派任务 prompt |
| `tool` | string | delegate | 目标工具/provider（如 `gemini`/`claude`/`codex`） |
| `mode` | enum | delegate | `analysis` / `write` |
| `name` | string | | 稳定的委派任务名（用于嵌套追踪与 follow-up） |
| `model` | string | | delegate/explore 的模型覆盖 |
| `rule` | string | | delegate 的协议 + prompt 模板 |
| `preset` | string | moa | MOA preset 配置名（如 `deep`） |
| `cwd` | string | | 工作目录 |
| `timeoutMs` | integer≥1 | | 超时毫秒 |

**返回**：`AgentToolResult`。未知 action 返回 `isError: true` 与提示文本。

**示例**：

```js
maestro({ action: "explore", prompts: ["FIND: auth middleware\nSCOPE: src/"], model: "gemini" })
maestro({ action: "delegate", prompt: "分析鉴权流程", tool: "gemini", mode: "analysis" })
maestro({ action: "moa", prompts: ["对比鉴权策略"], preset: "deep" })
```

---

### 4.7 `goal` — 自治目标管理

读取/创建/更新自治目标，并请求独立的完成验证。生命周期控制（stop/resume/clear）归用户 `/goal` 命令所有，模型无法直接停止或清除。

**参数**（`GoalToolParams`，`additionalProperties: false`）：

| 参数 | 类型 | 必需 | 说明 |
|------|------|:---:|------|
| `action` | enum | ✅ | `get` / `create` / `update` / `complete` |
| `objective` | string | create/update ✅ | 目标描述 |
| `summary` | string | complete ✅ | 完成证据 |
| `tokenBudget` | string | | 显式 Token 预算（仅 create）；接受纯数字、`k`、`m`，如 `100000`/`100k`/`1.5m`。默认省略 |
| `planHandoffKey` | string | | 内部 approved-Plan 交接绑定（由 Plan gate 注入，对接方通常不填） |

**返回**：`AgentToolResult`，`content[0].text` 为状态文本（如 `Goal started: ...`、`A Goal already exists`、`No goal set.`）。`isError` 标记失败。

**示例**：

```js
goal({ action: "get" })
goal({ action: "create", objective: "实现 JWT 鉴权模块" })
goal({ action: "create", objective: "实现 JWT 鉴权模块", tokenBudget: "500k" })
goal({ action: "update", objective: "实现 JWT 鉴权模块（含刷新令牌）" })
goal({ action: "complete", summary: "所有模块实现并通过测试，证据见 …" })
```

**注意**：`create` 在已存在 Goal 时失败；`update` 替换 objective 并自动恢复循环。

---

### 4.8 `todo` — 任务管理

带纯文本上下文与可选 Pi skill 执行的任务管理，7 个 action。

**参数**（`TodoToolParams`）：

| 参数 | 类型 | 必需 | 说明 |
|------|------|:---:|------|
| `action` | enum | ✅ | `create`/`update`/`list`/`get`/`delete`/`clear`/`next` |
| `subject` | string | create ✅ | 任务标题 |
| `description` | string | | 任务详情（长文本）。注意：`subject` 是标题，`description` 是详情，勿混淆 |
| `status` | enum | | `pending`/`in_progress`/`completed`/`blocked` |
| `blockedBy` | string[] | | 依赖的任务 ID |
| `context` | string | | 纯文本执行上下文。update 时传空串清除 |
| `skills` | SkillBinding[] | | 有序 Pi skill 绑定。update 时传空数组清除 |
| `summary` | string | | 完成摘要，带入后续步骤 |
| `assignee` | string | | 受理者选择器：`self`/`root`/id/唯一前缀/`label`/`@label`/`label#id前缀` |
| `id` | string | get/update/delete ✅ | 任务 ID |
| `filter` | object | list | `{ status?, memberId? }` |
| `planHandoffKey` | string | | 内部 Plan 交接绑定 |
| `goalId` | string | | 质量门 Goal ID。绑定后任务仅在该 Goal 验证通过（`done`）后才能 `completed`。update 时传空串清除。批量 create 中也可在每个 task 指定 |

**`SkillBinding`**：`{ name: string(✅), role: "primary"|"guard"|"support"(✅), args?: string }`。skill 绑定需恰好一个 `primary`。

**返回**：`AgentToolResult<TodoResultDetails>`，`details.tasks` 为任务数组，`details.action` 为本次动作，`details.error` 标记错误。`content[0].text` 为摘要文本。

**示例**：

```js
todo({ action: "create", subject: "提取 schema", context: "源文件: src/extension/schemas.ts" })
todo({ action: "update", id: "6c9f6b39", status: "completed", summary: "已提取 10 个工具 schema" })
todo({ action: "list", filter: { status: "pending" } })
todo({ action: "next" })   // 激活下一个 pending 任务并返回其解析后的 context
```

**注意**：update 时省略的字段保持不变，`null` 清除，空数组替换。根会话同一时刻仅一个 `in_progress` 任务。`goalId` 绑定质量门后，`next` 会自动切换到该 Goal（`switchCurrentGoal` resume）；完成 task 时若 Goal 未 `done` 则拒绝并提示先调用 `goal complete`。

---

### 4.9 `run-control` — Maestro CLI 透传壳

`run-control` 是 canonical Maestro CLI 的透明壳（argv 透传，不经 shell），是 **Session/Run 生命周期的唯一 LLM 工具面**。读写由命令分类决定：

- **读命令**（`status`/`brief`/`prepare`/`check`/`recall`/`evidence`/`list`/`show`/`graph`/`skills`/`search`/`load`/`review`）无需 mutation lease。
- **写命令**（`next`/`done`/`decide`/`seal`/`edit`/`meta`/`recover`/`accept-reuse`/…）需当前 Pi session 持有 Flow host mutation lease，且 Plan 模式下被阻断。
- **入口命令**（`session/run create|start`）可在无 lease 时铸建新 Session；若已持有 lease 且目标 Session 不一致则拒绝。
- 未知命令默认按写命令保守处理。

**参数**（`RunControlParams`）：

| 参数 | 类型 | 必需 | 说明 |
|------|------|:---:|------|
| `argv` | string[] | ✅ | Maestro CLI 参数（不含可执行名），如 `["session","next","--json"]`；自动追加 `--workflow-root` |

**返回**：`AgentToolResult`，`content[0].text` 为底层 CLI stdout（读命令附 lease 归属标注）；`details` 含 `argv`/`classification`/`command`/`snapshot`（读命令另附 `ownership`）。

**示例**：

```js
runControl({ argv: ["session", "status"] })
runControl({ argv: ["run", "brief"] })
runControl({ argv: ["run", "check", "run-123"] })
runControl({ argv: ["session", "next"] })
runControl({ argv: ["run", "done", "run-123", "--verdict", "done", "--summary", "步骤完成"] })
runControl({ argv: ["run", "edit", "verify", "--after", "latest"] })
```

---

### 4.10 `ask-user-question` — 结构化用户提问

通过键盘优先的 TUI 向导收集结构化用户答案。一次 1–4 个问题。

**参数**（`AskUserQuestionParams`）：

| 参数 | 类型 | 必需 | 说明 |
|------|------|:---:|------|
| `questions` | Question[] | ✅ | 1–4 个问题 |

**`Question`**：

| 字段 | 类型 | 必需 | 说明 |
|------|------|:---:|------|
| `question` | string | ✅ | 问题文本 |
| `header` | string | | 短标签（≤16 字符） |
| `options` | Option[] | | 2–4 个选项 |
| `multiSelect` | boolean | | 允许多选（默认 false）；选项问题总是可附加额外说明 |

**`Option`**：`{ label: string(✅), description?: string }`。

**返回**：`AgentToolResult`，`content[0].text` 为结构化答案（JSON 形式，含每题的 `selected` 等）。无选项的问题为开放式，返回文本答案。

**示例**：

```js
askUserQuestion({ questions: [
  { question: "采用哪种方案？", header: "方案",
    options: [{ label: "A", description: "方案 A" }, { label: "B", description: "方案 B" }] }
] })
```

---

### 4.11 `ffgrep` — FFF 内容搜索

基于 [FFF](https://github.com/ff-labs/fff-node) 原生索引的快速字面内容搜索。仅注册在根 Pi 会话，不影响 Pi 内置 grep/find。

**参数**（`FffGrepParams`）：

| 参数 | 类型 | 必需 | 说明 |
|------|------|:---:|------|
| `pattern` | string | ✅ | 字面搜索文本（minLength 1） |
| `context` | integer | | 上下文行数（0–20，默认 0） |
| `limit` | integer | | 最大结果数（1–100，默认 20） |

**返回**：`AgentToolResult<unknown>`，`content[0].text` 为 `path:line: content` 格式的匹配行；无匹配时为 `No matches found`。

**示例**：

```js
ffgrep({ pattern: "CompactionArbiter", context: 2, limit: 10 })
```

**注意**：首次调用会触发 FFF 索引初始化（含初始扫描，超时 15s）；`cwd` 变化时自动重建索引。搜索使用 `smartCase`（全小写时不区分大小写）并启用 `classifyDefinitions`。

---

### 4.12 `fffind` — FFF 文件路径搜索

基于 FFF 原生索引的模糊文件路径搜索。

**参数**（`FffFindParams`）：

| 参数 | 类型 | 必需 | 说明 |
|------|------|:---:|------|
| `pattern` | string | ✅ | 模糊路径查询（minLength 1） |
| `limit` | integer | | 最大结果数（1–100，默认 30） |

**返回**：`AgentToolResult<unknown>`，`content[0].text` 为每行一个相对路径；无匹配时为 `No files found`。

**示例**：

```js
fffind({ pattern: "compaction arbiter", limit: 5 })
```

**注意**：与 `ffgrep` 共享同一个 `FileFinder` 实例和索引生命周期。两个工具均在权限白名单中（`ALWAYS_ALLOWED_TOOLS`），所有审批模式下自动放行。

---

## 5. 编程式 API（v1）

在自有 Node/TS 程序中编排子代理时，直接使用 `pi-maestro-teammate/v1`，无需经过 LLM 工具层。

### 5.1 `runTeammate(params, options): Promise<SingleResult[]>`

编程式入口与工具层使用相同的必需 `tasks[]` 契约。它应用任务类型路由、统一规范化并执行一个或多个 task；单 task 也返回长度为 1 的结果数组。

```ts
import { runTeammate } from "pi-maestro-teammate/v1/execution";

const [result] = await runTeammate({
  agent: "explorer",
  model: "provider/model",
  tasks: [{ prompt: "FIND: 鉴权中间件
SCOPE: src/" }]
}, { baseCwd: process.cwd() });
console.log(result?.messages.at(-1)?.content);
```

`RunTeammateParams` 与工具 schema 同构：必需 `tasks: TaskSpec[]`，并可提供顶层 `agent/taskType/model/thinking/context/cwd/outputSchema/timeoutMs` 默认值和 `concurrency/maxAgents/background/reply_to` 调度字段。内部单子进程原语不属于 v1 公共调用契约。

**RunTeammateOptions** 保留 `baseCwd`、模型能力、correlation IDs、取消信号、进度/重试/子请求回调、父会话和测试 spawn seam 等运行时字段。

### 5.2 `SingleResult` 返回

```ts
interface SingleResult {
  agent: string;
  task: string;
  exitCode: number;                 // 0 = 成功
  messages: Array<{ role: string; content: string }>;  // 末条为最终输出
  usage: Usage;                     // { inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens, cost, turns }
  model: string;
  correlationId: string;
  durationMs: number;
  wakeable?: boolean;               // 子进程是否仍可被 teammate-send 唤醒
  lifecyclePending?: boolean;       // 结果就绪但生命周期确认未到
  structuredOutput?: unknown;       // outputSchema 校验后的结构化输出
  attemptedModels?: string[];
}
```

### 5.3 其他导出

| 导出 | 用途 |
|------|------|
| `runGraph` | 执行 DAG 任务图（多任务底层） |
| `normalizeTeammateParams(params)` | 将单/多任务参数归一化为 `NormalizedTask[]`，返回 `{ tasks }` 或 `{ error }` |
| `normalizeGraphConcurrency` | 规整图并发度 |
| `sendRpcMessage(stdin, message, mode, token?)` | 向子进程 stdin 写 RPC 消息；`mode: "prompt"\|"steer"\|"follow_up"\|"abort"` |
| `dispatchChildIpcMessage(message, onRequest, onEvent, reply)` | 分派子进程 IPC 消息（request / event） |
| `handleChildRpcUiRequest` / `handleChildInteractionRequest` | 处理子代理的 UI / 交互请求（`/v1/extension`） |
| `loadAgents` 等 | 代理发现（`/v1/agents`） |

### 5.4 RPC 线路协议（子进程 stdin）

`sendRpcMessage` 写入的 JSON 行协议（每行一个 JSON 对象，`\n` 分隔）：

| mode | 写入内容 |
|------|---------|
| `abort` | `{ "type": "abort" }` |
| `prompt` | `{ "type": "prompt", "message": <leased> }` |
| `steer` | `{ "type": "steer", "message": <leased> }` |
| `follow_up` | `{ "type": "follow_up", "message": <leased> }` |

子进程上行 IPC 消息类型包括 `teammate_proxy_request`/`teammate_proxy_result`、`teammate_interaction_request`/`teammate_interaction_response`。自定义 host 实现 `onChildRequest` 时须对 request 调用 `reply(...)`，否则引擎会回以默认 deny/cancel。

---

## 6. GUI/UCL 侧车 HTTP API

`pi-maestro-flow@0.5.0` 新增 **Unified Communication Layer (UCL)** 侧车：一个 loopback HTTP + SSE 服务，向外部 GUI 进程暴露工具发现/调用、聚合状态快照和变更事件。会话/消息/模型控制仍走 `pi --mode rpc`，UCL 仅覆盖工具、状态和事件三个面。

> **启用方式**：设置环境变量 `PI_GUI=1`（可选 `PI_GUI_PORT` 指定端口，默认 OS 分配）。未启用时零开销——不监听、不写发现文件。

### 6.1 发现与认证

启动后在 `<cwd>/.workflow/gui.json` 写入发现文件（`0o600`），关闭时自动删除：

```json
{
  "version": 1,
  "port": 54321,
  "token": "<uuid>",
  "sessionId": "<pi-session-id>",
  "url": "http://127.0.0.1:54321/?session=<uuid>",
  "eventsUrl": "http://127.0.0.1:54321/events?session=<uuid>",
  "pid": 12345,
  "startedAt": "2026-07-24T00:00:00.000Z"
}
```

所有请求须携带 session token（三选一）：`Authorization: Bearer <token>` 头、`?session=<token>` 查询参数、或 POST body 中的 `token` 字段。未通过认证返回 `403 { ok: false, code: "unauthorized" }`。

### 6.2 响应信封

所有 JSON 响应统一包装：

```ts
type GuiEnvelope<T> =
  | { ok: true; result: T }
  | { ok: false; error: string; code?: string };
```

### 6.3 内置端点

| 方法 | 路径 | 说明 |
|------|------|------|
| `GET` | `/health` | 健康检查，返回 `{ healthy, sessionId, ...extra }` |
| `GET` | `/events` | SSE 事件流（支持 `Last-Event-Id` 断线重连回放，最多 256 条） |

### 6.4 工具端点

| 方法 | 路径 | 说明 |
|------|------|------|
| `GET` | `/tools` | 工具发现：返回所有工具的 schema、来源、是否 GUI 可调用 |
| `POST` | `/tools/:name` | 工具调用（须经权限网关授权） |
| `POST` | `/cancel` | 取消进行中的调用（`{ invokeId }`) |

**`GET /tools` 响应**（`GuiToolView[]`）：

```ts
interface GuiToolView {
  name: string;
  description: string;
  parameters: unknown;      // JSON Schema
  sourceInfo: unknown;
  guiCallable: boolean;     // UCL 注册表是否持有 execute
  mutating: boolean;        // 咨询性标记（权限网关仍为强制门）
  owner: string;            // "pi-maestro-flow" | "pi-maestro-teammate" | "mcp" | "pi-core"
}
```

**`POST /tools/:name` 请求体**：

```json
{ "args": { "action": "get" }, "invokeId": "my-id", "timeoutMs": 30000 }
```

成功返回 `{ toolCallId, invokeId, content, details, terminate? }`。失败码：`403 permission_denied`、`404 not_invocable`、`429 rate_limited`（默认最多 16 并发）、`499 cancelled`、`500 tool_error`、`503 no_context`。

**GUI 可调用工具白名单**（通过 `globalThis[Symbol.for("pi-maestro.gui-tool-registry")]` 跨扩展注册）：

| 来源 | 允许的工具 |
|------|----------|
| `pi-maestro-flow` | `maestro`、`goal`、`todo`、`run-control`、`ask-user-question`、`plan-*` |
| `pi-maestro-teammate` | `teammate`、`teammate-*` |
| `mcp` | 所有动态注册的 MCP 工具 |

### 6.5 状态端点

| 方法 | 路径 | 说明 |
|------|------|------|
| `GET` | `/state` | 聚合快照（所有子系统并行读取） |
| `GET` | `/state/:sub` | 单个子系统快照 |

子系统：`workflow`、`todos`、`goal`、`plan`、`teammates`、`swarm`。聚合响应还包含 `approvalMode` 和 `sessionId`。所有值经 JSON round-trip 克隆，保证可序列化且不含活引用。

### 6.6 SSE 事件

通过 `GET /events` 订阅。事件类型：

| 事件名 | 触发时机 |
|--------|--------|
| `state.changed` | 任何子系统变更（去重后附带推送） |
| `todo.updated` | Todo 任务变更 |
| `goal.changed` | Goal 状态变更 |
| `run.transition` | Workflow Run 状态转换 |
| `teammate.started` / `teammate.progress` / `teammate.complete` | 子代理生命周期 |
| `plan.mode` | Plan/Act 模式切换 |
| `tool.invoked` / `tool.progress` | UCL 工具调用与进度 |
| `permission.request` | 权限请求 |
| `server-close` | 服务关闭 |

SSE 心跳间隔默认 15s。事件日志保留最近 256 条，支持 `Last-Event-Id` 断线重连回放。

### 6.7 参考客户端（Node）

```ts
import { GuiClient } from "pi-maestro-flow/gui/client";

// 从发现文件创建
const client = await GuiClient.fromDiscovery(".workflow/gui.json");

// 或直接指定
const client = new GuiClient({ port: 54321, token: "<uuid>" });

// 健康检查
const health = await client.health();

// 工具发现
const tools = await client.listTools();

// 工具调用
const result = await client.invoke("goal", { action: "get" });

// 取消调用
await client.cancel("my-invoke-id");

// 状态快照
const state = await client.getState();
const todos = await client.getStateSub("todos");

// SSE 订阅
const unsubscribe = client.subscribe(
  ({ name, data }) => console.log(name, data),
  (err) => console.error(err),
);
// 稍后取消
unsubscribe();
```

`GuiClientError` 携带 `status`（HTTP 状态码）和 `code`（业务错误码）。

### 6.8 编程式服务端 API

```ts
import { startGuiSubsystem, type GuiSubsystemOptions } from "pi-maestro-flow/gui";
import { createGuiEventForwarder, GUI_EVENTS } from "pi-maestro-flow/gui";
import { registerGuiTool, listGuiTools } from "pi-maestro-flow/gui";

// 启动侧车（PI_GUI 未启用时返回 null）
const server = await startGuiSubsystem({
  sessionId: "my-session",
  cwd: process.cwd(),
  listAllTools: () => pi.getAllTools(),
  gateway: permissionGateway,
  getCtx: () => currentCtx,
  stateProviders: { workflow: () => snapshot, todos: () => tasks, goal: () => goal },
});

// 事件转发器（去重 + 自动 state.changed）
const forwarder = createGuiEventForwarder();
forwarder.bind(server);
forwarder.emitDeduped(GUI_EVENTS.todoUpdated, taskKey, payload);
forwarder.emit(GUI_EVENTS.teammateStarted, { agent: "explorer" });
```

---

## 7. 压缩设置与仲裁编程式接口

`pi-maestro-flow@0.5.0` 将压缩设置和仲裁逻辑提取为独立模块，可通过 `exports` 子路径导入。

### 7.1 压缩设置（`pi-maestro-flow/compaction/settings`）

```ts
import {
  readEffectiveCompactionSettings,
  readCompactionSettingsSnapshot,
  writeCompactionSettings,
  validateCompactionPatch,
  DEFAULT_RESERVE_TOKENS,
  DEFAULT_KEEP_RECENT_TOKENS,
  DEFAULT_SOFT_COMPACTION,
  type EffectiveCompactionSettings,
  type CompactionConfigPatch,
  type CompactionScope,
} from "pi-maestro-flow/compaction/settings";
```

**配置层级**：项目级 `.pi/settings.json` 覆盖用户级 `~/.pi/agent/settings.json`，均覆盖默认值。`compaction` 字段：

```json
{
  "compaction": {
    "enabled": true,
    "reserveTokens": 16384,
    "keepRecentTokens": 20000,
    "soft": {
      "enabled": true,
      "nudgeRatio": 0.7,
      "pruneRatio": 0.8,
      "pruneTargetRatio": 0.7
    }
  }
}
```

| 字段 | 默认值 | 说明 |
|------|--------|------|
| `enabled` | `true` | 是否启用自动压缩 |
| `reserveTokens` | `16384` | 为输出预留的 Token 数；阈值 = contextWindow − reserveTokens |
| `keepRecentTokens` | `20000` | 保护最近 N Token 不被裁剪 |
| `soft.enabled` | `true` | 是否启用软压缩层（nudge + auto-prune） |
| `soft.nudgeRatio` | `0.7` | 上下文占比超过此值时发出 nudge 警告 |
| `soft.pruneRatio` | `0.8` | 超过此值时触发自动裁剪工具结果 |
| `soft.pruneTargetRatio` | `0.7` | 自动裁剪的目标占比 |

**`EffectiveCompactionSettings`** 还包含 `source` 字段，记录每个配置项的来源（`project` / `user` / `default`）。

**写入**：`writeCompactionSettings(scope, patch, cwd)` 原子写入（临时文件 + rename），`scope` 为 `"project"` 或 `"user"`。

### 7.2 压缩仲裁器（`pi-maestro-flow/compaction/arbiter`）

```ts
import {
  CompactionArbiter,
  compactionRequestFromInstructions,
  type CompactionLease,
  type CompactionOwner,
} from "pi-maestro-flow/compaction/arbiter";
```

防止 mid-turn 自动压缩、Plan handoff 压缩与 Pi 原生压缩竞态。会话级单例，由扩展入口创建并注入 `createMidTurnAutoCompaction` 和 `initPlan`。

**核心流程**：

```ts
const arbiter = new CompactionArbiter();

// 扩展请求压缩租约（已有活跃压缩时返回 undefined）
const lease = arbiter.request("mid-turn");
if (!lease) { /* 已有压缩在进行，跳过 */ }

// 标记压缩指令（嵌入 owner tag 供 observeStart 识别）
const tagged = lease.tagInstructions("Preserve the approved plan...");

// 压缩完成后释放
lease.release();

// Pi 原生压缩入口观测（session_before_compact hook）
const observed = arbiter.observeStart(request, signal);
if (observed.allowed) { /* 允许执行 */ }
observed.releaseIfNative();

// 压缩完成
arbiter.complete();
```

**仲裁规则**：
- 同一时刻最多一个活跃压缩（`request` 互斥）。
- Pi 原生压缩（无 request 参数）始终优先，会抢占扩展租约。
- `tagInstructions` 在指令头部嵌入 `[maestro-compaction-owner:<owner>:<id>]` 标记，`compactionRequestFromInstructions` 可反向解析。
- 原生压缩有 5 分钟安全超时自动释放。

---

## 8. 对接示例

### 6.1 LLM 工具调用（在 Pi 代理内）

工具加载后直接按名调用，参数为 JSON 对象：

```js
// 派发 explorer 做只读发现
teammate({ tasks: [{ agent: "explorer", taskType: "explore",
  prompt: "FIND: 所有导出函数\nSCOPE: src/auth/\nEXPECTED: 函数名 + file:line" }] })

// 创建并推进任务
todo({ action: "create", subject: "实现令牌校验" })
todo({ action: "next" })

// 请求目标完成验证
goal({ action: "complete", summary: "令牌校验已实现并通过 12 个测试" })
```

### 6.2 编程式编排（在自有服务内）

```ts
import { runTeammate, normalizeTeammateParams } from "pi-maestro-teammate/v1";

// 1) 校验参数合法性
const norm = normalizeTeammateParams({ tasks: [{ agent: "analyst", prompt: "分析模块" }] });
if (norm.error) throw new Error(norm.error);

// 2) 执行并消费结构化结果
const [res] = await runTeammate(
  { tasks: [{ agent: "analyst", prompt: "分析鉴权模块并给出风险清单",
    outputSchema: { type: "object", required: ["risks"],
      properties: { risks: { type: "array", items: { type: "string" } } } } }] },
  { baseCwd: process.cwd(),
    onProgress: (p) => console.log(`[${p.status}] ${p.agent} tools=${p.toolCount}`) },
);

if (!res || res.exitCode !== 0) {
  console.error("子代理失败:", res?.messages.at(-1)?.content);
  process.exit(1);
}
const risks = (res.structuredOutput as { risks: string[] })?.risks ?? [];
console.log("风险清单:", risks);
```

---

## 9. 错误处理与最佳实践

**错误识别**：
- 工具调用：检查 `AgentToolResult.isError === true`，错误描述在 `content[0].text`。
- 编程式：检查 `SingleResult.exitCode !== 0`，末条 `messages` 为错误信息；prompt 解析失败、嵌套深度超限等会返回 `exitCode: 1` 与说明文本。

**常见错误来源**：
- 未知 `action`（如 `maestro`/`goal`/`todo` 传了非法 action；`run-control` 传了空 `argv` 或非法命令）。
- 缺少某 action 的必填字段（如 `goal.complete` 缺 `summary`、`run-control` 写命令缺 `hostSessionId`/lease）。
- 枚举值拼写/大小写错误。
- `teammate` 的 `agent` 名不匹配任何 `agents/*.md`。
- `teammate-send`/`watch` 的 `to`/`name` 选择器无法解析到代理。

**最佳实践**：
- `teammate` 默认前台返回结果；仅独立任务使用 `background: true`，并依赖 `teammate-complete` 通知而非轮询。
- 所有调用使用非空 `tasks[]`；用 `{name}` 和 `dependsOn` 表达依赖。
- 需要程序化消费输出时提供 `outputSchema`，通过 `structuredOutput`/`{name.field}` 获取。
- `run-control` 写命令（next/done/decide/seal/edit/…）需已附着规范化 Session 且当前 Pi session 持有 mutation lease；读命令无需 lease。
- `goal`/`todo` 的 `planHandoffKey` 为内部字段，对接方不要手工填写。
- 编程式调用务必传 `baseCwd`，并用 `signal` 支持取消。

---

## 10. 附录：参数速查表

| 工具 | 必填参数 | 关键可选参数 | 返回 `details` |
|------|---------|-------------|----------------|
| `teammate` | `tasks`（非空，每项有 `prompt`） | 顶层 task 默认值、`concurrency`/`background`/`reply_to` | `{ mode, results: SingleResult[], structuredOutput? }` |
| `teammate-send` | `to` | `message`/`mode` | `{ delivered }` |
| `teammate-list` | — | `view` | `{ agents[] }` |
| `teammate-watch` | `name` | `lines` | `{ output[] }` |
| `teammate-wait` | — | `name`/`timeoutMs`/`waitMs` | `{ status, output[] }` |
| `maestro` | `action` | explore:`prompts`/`concurrency`；delegate:`prompt`/`tool`/`mode`；moa:`preset` | 文本结果 |
| `goal` | `action`（+`objective`/`summary` 视 action） | `tokenBudget` | 文本状态 |
| `todo` | `action`（+`subject`/`id` 视 action） | `status`/`context`/`skills`/`filter`/`summary`/`goalId` | `{ tasks[], action, error? }` |
| `run-control` | `argv`（Maestro CLI 参数） | — | CLI stdout + `{ argv, classification, command, snapshot, ownership? }` |
| `ask-user-question` | `questions` | `options`/`multiSelect`/`header` | 结构化答案文本 |
| `ffgrep` | `pattern` | `context`/`limit` | `path:line: content` 文本 |
| `fffind` | `pattern` | `limit` | 相对路径列表文本 |

---

*本指南基于源码 schema 提取：`packages/pi-maestro-flow/src/extension/schemas.ts`、`packages/pi-maestro-flow/src/tools/fff.ts`、`packages/pi-maestro-flow/src/gui/*`、`packages/pi-maestro-flow/src/compaction/compaction-settings.ts`、`packages/pi-maestro-flow/src/compaction/compaction-arbiter.ts`、`packages/pi-maestro-teammate/src/extension/schemas.ts`、`packages/pi-maestro-teammate/src/public/v1/*`、`packages/pi-maestro-teammate/src/shared/types.ts`、`packages/pi-maestro-teammate/src/shared/gui-registry.ts`。如与最新代码不一致，以源码为准。*
