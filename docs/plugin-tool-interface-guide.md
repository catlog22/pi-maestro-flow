# pi-maestro-flow 工具接口对接开发指南

> 面向需要调用本插件对外暴露工具接口的开发者。
> 涵盖工具清单、调用机制、逐工具参数/返回/示例，以及编程式 `v1` API。
> 对应版本：`pi-maestro-flow@0.4.14` · `pi-maestro-teammate@0.4.6`

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
5. [编程式 API（v1）](#5-编程式-apiv1)
6. [对接示例](#6-对接示例)
7. [错误处理与最佳实践](#7-错误处理与最佳实践)
8. [附录：参数速查表](#8-附录参数速查表)

---

## 1. 概述

本插件由两个 npm 包组成，均以 Pi 扩展（Extension）形式注册工具。工具在扩展加载后自动暴露给 Pi 代理，可通过 **LLM 工具调用** 或 **编程式 `v1` API** 两种方式对接。

| 包 | 版本 | 注册的工具 | 角色 |
|----|------|-----------|------|
| `pi-maestro-flow` | 0.4.14 | `maestro`、`goal`、`todo`、`run-control`、`ask-user-question` | 扩展包：流程命令、目标、任务、Run 控制、提问 |
| `pi-maestro-teammate` | 0.4.6 | `teammate`、`teammate-send`、`teammate-list`、`teammate-watch`、`teammate-wait` | 核心派发引擎：子代理 DAG 调度、RPC 消息 |

**工具总览（10 个对外工具）**：

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
| `run-control` | 读写规范化 Maestro Workflow Run（status/brief/check/next/done/edit） | flow |
| `ask-user-question` | 通过键盘优先的 TUI 向导收集结构化用户答案 | flow |

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

可用子路径：`/v1`（聚合）、`/v1/agents`、`/v1/execution`、`/v1/extension`、`/v1/model-routing`、`/v1/prompts`、`/v1/progress-tree`、`/v1/retry`、`/v1/types`。

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

- **action 分发**：`maestro`、`goal`、`todo`、`run-control` 以 `action` 字段分发子命令；不同 action 的必填字段不同（见各工具说明）。
- **枚举值大小写敏感**：如 `status`、`verdict`、`mode` 等枚举必须精确匹配小写值。
- **选择器（selector）**：`todo` 的 `assignee`/`filter.memberId` 与 `teammate-*` 的 `to`/`name` 接受多种写法：`self`、`root`、完整 id、唯一 id 前缀、`label`、`@label`、`label#id-prefix`。

---

## 4. 工具接口详解

### 4.1 `teammate` — 派发子代理

派发一个或多个子代理（Pi 子进程）。支持单代理、多任务 DAG、（已弃用的）chain 流水线三种模式。顶层字段作为默认值，`tasks[]` 内的同名字段覆盖顶层。

**参数**（`TeammateParams`）：

| 参数 | 类型 | 必需 | 说明 |
|------|------|:---:|------|
| `agent` | string | 单模式✅ | 代理名（匹配 `agents/*.md` 文件名）。单模式必填；`tasks` 模式可省 |
| `task` | string | | 任务描述。多任务模式支持 `{name}` 变量引用 |
| `prompt` | string | | 固定 prompt 模板名（项目/用户/内置）。任务级优先 |
| `promptArgs` | string[] | | 附加位置参数。`task` 是 `$1`，`promptArgs` 从 `$2` 开始 |
| `taskType` | enum | | 仅用于自动模型路由：`explore`/`analysis`/`debug`/`planning`/`development`/`review`/`testing`。不改变代理行为 |
| `name` | string | | 可寻址名称，启用 `{name}` 引用与 `teammate-send` 寻址 |
| `reply_to` | enum | | 结果路由：`caller`（默认，返回派发上下文）/ `main`（路由到主会话） |
| `tasks` | TaskSpec[] | | 多任务数组。依赖来自 `{name}`/`{name.field}` 引用 + 显式 `dependsOn`；有依赖的被等待，无依赖的并行 |
| `chain` | object[] | | **已弃用**，改用带 `{name}` 的 `tasks`。串行流水线，每步接收 `{previous}` |
| `concurrency` | integer≥1 | | 最大并发任务数（默认 4） |
| `outputSchema` | object | | 结构化输出 JSON Schema。多任务模式下作为无自身 schema 任务的默认值 |
| `background` | boolean | | 后台运行（默认 **true**）。后台完成会发 `teammate-complete` 通知；需直接拿结果时置 `false` |
| `context` | enum | | `fresh`（默认，空白会话）/ `fork`（继承当前会话完整历史） |
| `model` | string | | 精确 `provider/model` 默认值。任务级优先 |
| `thinking` | enum | | 思考深度：`off`/`minimal`/`low`/`medium`/`high`/`xhigh`/`max`（`max` 等价 `xhigh`）。任务级优先 |
| `cwd` | string | | 默认工作目录。任务级优先 |
| `timeoutMs` | integer≥1 | | 默认超时毫秒。任务级优先 |

**`TaskSpec`（`tasks[]` 元素）字段**：`agent`(✅)、`task`、`prompt`、`promptArgs`、`taskType`、`name`、`dependsOn`(string[])、`context`、`model`、`thinking`、`cwd`、`outputSchema`、`timeoutMs`。语义与顶层同名字段一致，且覆盖顶层默认。

**返回**：`AgentToolResult<Details>`

```ts
interface Details {
  mode: "single" | "parallel" | "chain" | "graph";
  results: SingleResult[];      // 每个子代理一个结果
  structuredOutput?: unknown;   // outputSchema 校验后的结构化输出
  progress?: AgentProgressSnapshot[];
  childCalls?: ChildAgentCallSnapshot[];
}
```

`content[0].text` 为最后一个子代理的最终消息；`isError` 在子代理非零退出时为 `true`。后台 detach 时 `results` 为空数组，结果稍后经 `teammate-complete` 消息送达。

**示例**：

```js
// 单代理前台（直接拿结果）
teammate({ agent: "explorer", taskType: "explore", background: false,
  task: "FIND: 鉴权中间件\nSCOPE: src/middleware/\nEXPECTED: file:line 列表" })

// 多任务 DAG（definitions 与 calls 并行，review 依赖二者）
teammate({ taskType: "explore", background: false, tasks: [
  { name: "definitions", agent: "explorer", task: "FIND: 导出定义\nSCOPE: src/auth/" },
  { name: "calls", agent: "explorer", task: "FIND: import 调用点\nSCOPE: src/**/*.ts" },
  { name: "review", agent: "delegate", taskType: "review",
    task: "综合 {definitions} 与 {calls} 给出审查结论" }
] })
```

**注意**：
- `background` 默认 `true`；单任务需要结果时务必显式 `background: false`。
- `{ref}` 匹配不到任何任务名时按字面量透传；接近已有名的拼写错误会被拒绝。
- 嵌套深度有守卫，防止递归 fork-bomb。

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

**`SkillBinding`**：`{ name: string(✅), role: "primary"|"guard"|"support"(✅), args?: string }`。skill 绑定需恰好一个 `primary`。

**返回**：`AgentToolResult<TodoResultDetails>`，`details.tasks` 为任务数组，`details.action` 为本次动作，`details.error` 标记错误。`content[0].text` 为摘要文本。

**示例**：

```js
todo({ action: "create", subject: "提取 schema", context: "源文件: src/extension/schemas.ts" })
todo({ action: "update", id: "6c9f6b39", status: "completed", summary: "已提取 10 个工具 schema" })
todo({ action: "list", filter: { status: "pending" } })
todo({ action: "next" })   // 激活下一个 pending 任务并返回其解析后的 context
```

**注意**：update 时省略的字段保持不变，`null` 清除，空数组替换。根会话同一时刻仅一个 `in_progress` 任务。

---

### 4.9 `run-control` — 工作流 Run 控制

通过单一类型化外壳读写规范化 Maestro Workflow Run。读动作：`status`/`brief`/`prepare`/`check`；写动作：`next`/`done`/`edit`（写动作需已附着规范化 Session 与 Flow host mutation lease）。

**参数**（`RunControlParams`）：

| 参数 | 类型 | 必需 | 说明 |
|------|------|:---:|------|
| `action` | enum | ✅ | 读：`status`/`brief`/`prepare`/`check`；写：`next`/`done`/`edit` |
| `runId` | string | done ✅ | Run ID。`brief`/`check` 可选（默认活跃 Run） |
| `step` | string | prepare ✅ | 要预览的工作流步骤/命令 |
| `pick` | string | | `next` 的待选 chain-step 选择器 |
| `verdict` | enum | | `done` 的完成裁决：`done`（默认）/`done-with-concerns`/`needs-retry`/`blocked` |
| `summary` | string | | `done` 的完成摘要 |
| `reason` | string | | `done` 的完成原因 |
| `notes` | string[] | | `done` 的备注（每条 → `--note`） |
| `decisions` | string[] | | `done` 的决策记录（每条 → `--decision`） |
| `evidence` | string[] | | `done` 的证据路径（每条 → `--evidence`） |
| `artifacts` | string[] | | `done` 的制品路径（每条 → `--artifact`） |
| `commands` | string[] | | `edit` 要插入的命令；replace 时供一条；仅删除时可省 |
| `after` | string | | `edit` 插入位置：`current`/`latest`/`start`/步骤 ID/索引（默认 `current`） |
| `replace` | string | | 用首条 edit 命令替换的待处理步骤 ID |
| `remove` | string | | 标记为 skipped 移除的待处理步骤 ID |
| `args` | string | | `edit` 步骤参数（仅当 `commands` 恰含一条时有效） |
| `stage` | string | | 插入 edit 步骤的可选 stage 标签 |
| `goalRef` | string | | 插入 edit 步骤的可选 goal 引用 |
| `insertedBy` | string | | 记录的插入者（Maestro 默认 `manual`） |

**返回**：`AgentToolResult`，`content[0].text` 为底层 CLI stdout；`details` 含结构化结果（snapshot / brief / check / command 等）。

**示例**：

```js
runControl({ action: "status" })
runControl({ action: "brief" })
runControl({ action: "check" })
runControl({ action: "done", runId: "run-123", verdict: "done", summary: "步骤完成" })
runControl({ action: "edit", commands: ["maestro run validate"], after: "current" })
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

## 5. 编程式 API（v1）

在自有 Node/TS 程序中编排子代理时，直接使用 `pi-maestro-teammate/v1`，无需经过 LLM 工具层。

### 5.1 `runTeammate(params, options): Promise<SingleResult>`

核心执行函数。解析 prompt 模板、应用模型路由、派发子进程并收集结果。

```ts
import { runTeammate } from "pi-maestro-teammate/v1";
import type { RunTeammateParams, RunTeammateOptions, SingleResult } from "pi-maestro-teammate/v1";

const result: SingleResult = await runTeammate(
  { agent: "explorer", task: "FIND: 鉴权中间件\nSCOPE: src/", model: "provider/model" },
  { baseCwd: process.cwd(), correlationId: "my-task-1" },
);
console.log(result.messages.at(-1)?.content);
```

**`RunTeammateParams`**（与 `teammate` 工具参数同构）：

```ts
interface RunTeammateParams {
  agent: string;
  task?: string;
  prompt?: string;
  promptArgs?: string[];
  taskType?: TeammateTaskType;
  name?: string;
  reply_to?: "caller" | "main";
  protocol_version?: number;
  background?: boolean;
  context?: "fresh" | "fork";
  model?: string;
  thinking?: TeammateThinkingInput;
  cwd?: string;
  timeoutMs?: number;
  outputSchema?: Record<string, unknown>;
  tasks?: Array<{ agent: string; task?: string; prompt?: string; promptArgs?: string[];
    taskType?: TeammateTaskType; name?: string; dependsOn?: string[]; context?: "fresh"|"fork";
    model?: string; thinking?: TeammateThinkingInput; cwd?: string;
    outputSchema?: Record<string, unknown>; timeoutMs?: number }>;
  chain?: Array<{ agent: string; task?: string; prompt?: string; promptArgs?: string[];
    taskType?: TeammateTaskType; model?: string; thinking?: TeammateThinkingInput }>;
  concurrency?: number;
}
```

**`RunTeammateOptions`**（运行时上下文与回调）：

| 字段 | 类型 | 说明 |
|------|------|------|
| `baseCwd` | string(✅) | 基准工作目录 |
| `modelCapabilities` | readonly | 可用模型能力清单 |
| `correlationId` | string | 关联 ID（缺省随机 UUID） |
| `taskCorrelationIds` | string[] | 多任务的关联 ID |
| `signal` | AbortSignal | 取消信号 |
| `onProgress` | `(data: AgentProgress) => void` | 进度回调 |
| `onRetry` | `(retry) => void` | 重试回调（attempt/maxRetries/delayMs/error…） |
| `onChildRequest` | `(event, reply) => void` | 子代理请求回调（需 `reply`） |
| `onChildEvent` | `(event) => void` | 子代理事件回调 |
| `parentSessionFile` | string | 父会话文件（fork 源） |
| `initialLeaseToken` | LeaseToken \| fn | 初始租约 token |
| `onChildSpawned` | `(stdin, sendControl, sessionDir?, correlationId?) => void` | 子进程生成回调 |
| `onTurnComplete` | `(result: SingleResult) => void` | 单 turn 完成回调 |

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

## 6. 对接示例

### 6.1 LLM 工具调用（在 Pi 代理内）

工具加载后直接按名调用，参数为 JSON 对象：

```js
// 派发 explorer 做只读发现
teammate({ agent: "explorer", taskType: "explore", background: false,
  task: "FIND: 所有导出函数\nSCOPE: src/auth/\nEXPECTED: 函数名 + file:line" })

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
const norm = normalizeTeammateParams({ agent: "delegate", task: "分析模块" });
if ("error" in norm) throw new Error(norm.error);

// 2) 执行并消费结构化结果
const res = await runTeammate(
  { agent: "delegate", task: "分析鉴权模块并给出风险清单",
    outputSchema: { type: "object", required: ["risks"],
      properties: { risks: { type: "array", items: { type: "string" } } } } },
  { baseCwd: process.cwd(),
    onProgress: (p) => console.log(`[${p.status}] ${p.agent} tools=${p.toolCount}`) },
);

if (res.exitCode !== 0) {
  console.error("子代理失败:", res.messages.at(-1)?.content);
  process.exit(1);
}
const risks = (res.structuredOutput as { risks: string[] })?.risks ?? [];
console.log("风险清单:", risks);
```

---

## 7. 错误处理与最佳实践

**错误识别**：
- 工具调用：检查 `AgentToolResult.isError === true`，错误描述在 `content[0].text`。
- 编程式：检查 `SingleResult.exitCode !== 0`，末条 `messages` 为错误信息；prompt 解析失败、嵌套深度超限等会返回 `exitCode: 1` 与说明文本。

**常见错误来源**：
- 未知 `action`（如 `maestro`/`goal`/`todo`/`run-control` 传了非法 action）。
- 缺少某 action 的必填字段（如 `goal.complete` 缺 `summary`、`run-control.done` 缺 `runId`、`run-control.prepare` 缺 `step`）。
- 枚举值拼写/大小写错误。
- `teammate` 的 `agent` 名不匹配任何 `agents/*.md`。
- `teammate-send`/`watch` 的 `to`/`name` 选择器无法解析到代理。

**最佳实践**：
- `teammate` 单任务需结果时显式 `background: false`；后台任务依赖 `teammate-complete` 通知而非轮询。
- 多任务用 `tasks[]` + `{name}` 引用表达依赖，避免已弃用的 `chain`。
- 需要程序化消费输出时提供 `outputSchema`，通过 `structuredOutput`/`{name.field}` 获取。
- `run-control` 写动作（next/done/edit）需已附着规范化 Session；只读动作（status/brief/check）无此要求。
- `goal`/`todo` 的 `planHandoffKey` 为内部字段，对接方不要手工填写。
- 编程式调用务必传 `baseCwd`，并用 `signal` 支持取消。

---

## 8. 附录：参数速查表

| 工具 | 必填参数 | 关键可选参数 | 返回 `details` |
|------|---------|-------------|----------------|
| `teammate` | `agent`（单模式） | `task`/`tasks`/`prompt`/`model`/`background`/`context`/`outputSchema` | `{ mode, results: SingleResult[], structuredOutput? }` |
| `teammate-send` | `to` | `message`/`mode` | `{ delivered }` |
| `teammate-list` | — | `view` | `{ agents[] }` |
| `teammate-watch` | `name` | `lines` | `{ output[] }` |
| `teammate-wait` | — | `name`/`timeoutMs`/`waitMs` | `{ status, output[] }` |
| `maestro` | `action` | explore:`prompts`/`concurrency`；delegate:`prompt`/`tool`/`mode`；moa:`preset` | 文本结果 |
| `goal` | `action`（+`objective`/`summary` 视 action） | `tokenBudget` | 文本状态 |
| `todo` | `action`（+`subject`/`id` 视 action） | `status`/`context`/`skills`/`filter`/`summary` | `{ tasks[], action, error? }` |
| `run-control` | `action`（+`runId`/`step` 视 action） | `verdict`/`summary`/`commands`/`after` | CLI stdout + 结构化结果 |
| `ask-user-question` | `questions` | `options`/`multiSelect`/`header` | 结构化答案文本 |

---

*本指南基于源码 schema 提取：`packages/pi-maestro-flow/src/extension/schemas.ts`、`packages/pi-maestro-teammate/src/extension/schemas.ts`、`packages/pi-maestro-teammate/src/public/v1/*`、`packages/pi-maestro-teammate/src/shared/types.ts`。如与最新代码不一致，以源码为准。*
