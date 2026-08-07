---
title: "Goal 目标 · Plan 计划 · todo 任务"
icon: "🎯"
---

编排生命周期的三个核心：**goal**（长时目标，自主循环）、**plan**（先批准再动手）、**todo**（任务分解与跟踪）。

---

## 1. Goal — 长时目标生命周期

为多轮自主工作提供持久化引擎：自动续行、Token 预算、压缩存活、独立验证。

### 模型侧操作

```javascript
goal({ action: "create", objective: "实现 JWT 认证模块" })
goal({ action: "create", objective: "实现 JWT 认证模块", tokenBudget: "100k" })
goal({ action: "get" })
goal({ action: "update", objective: "实现 JWT 认证 + 刷新令牌" })
goal({ action: "complete", summary: "所有模块已实现并通过测试" })
```

### 用户侧命令

| 命令 | 效果 |
|------|------|
| `/goal status` | 查看当前 Goal |
| `/goal create [--tokens 100k] <目标>` | 创建 Goal 并启动代理循环 |
| `/goal stop` | 暂停，保存状态 |
| `/goal resume [--tokens 200k]` | 恢复；可提高预算 |
| `/goal clear` | 放弃并删除 Goal |

### 验证机制

- 正常 `agent_end` 后自动触发独立验证；
- `pass` → 标记完成，清除 Goal；
- `fail` → 保持活跃，携带未满足需求启动下一轮；
- `inconclusive` → 保持活跃，等待用户 `/goal resume`。

> 有 acceptance commands 时优先运行它们判定结果；未声明 commands 时才调用 `verifier` 角色独立审计。

### Goal 面板

Goal 存在时，输入编辑器上方渲染 `goal-panel`：状态（ACTIVE / WAITING / VERIFYING / VERIFIED / STOPPED / BUDGET / BLOCKED）、目标描述、已用时间、循环次数、Token 预算（未配置时不显示）。

## 2. Plan — 先批准再动手

只读起草 Markdown 计划，用户批准后才放行编辑。

### 计划模式行为

- 编辑/写入工具和文件变更命令被**阻止**；
- 读取/搜索/探索工具保持可用；
- 通过 `plan-update` 起草 Markdown 计划；
- `plan-status` 检查计划状态；
- `plan-confirm`（或 `/plan approve`）提交计划并恢复 Act 工具；
- `plan-exit` 放弃计划返回 Act 模式。

### 切换方式

`Alt+Shift+P` 或 `/plan` 切换 Plan/Act 模式。

```javascript
plan-enter()                 // 进入计划模式，加载 current.md 草稿
plan-update({ markdown })    // 起草完整计划
plan-confirm()               // 提交，用户批准后恢复编辑
plan-exit()                  // 放弃并返回
```

> Plan 模式支持独立 Plan 模型：规划与执行可分别使用不同模型，见[模型路由与思考深度](/guides/model-routing)。

## 3. todo — 任务管理

7 个操作，支持纯文本上下文和可选的 Pi Skill 执行。

```javascript
// 创建任务
todo({ action: "create", subject: "实现用户认证", description: "JWT + 刷新令牌" })

// 带 Skill 绑定的任务（执行时自动加载该 Skill）
todo({
  action: "create",
  subject: "代码审查",
  skills: [{ name: "quality-review", role: "primary", args: "--level deep" }]
})

// 更新状态
todo({ action: "update", id: "abc123", status: "completed", summary: "已完成认证模块" })

// 列出任务
todo({ action: "list", filter: { status: "pending" } })

// 激活下一个待办任务，返回解析后的上下文
todo({ action: "next" })
```

| 操作 | 说明 |
|------|------|
| `create` | 创建任务（subject 必填；支持 batch 一次性铺开整个计划） |
| `update` | 更新状态/摘要/上下文/技能 |
| `list` | 按状态/成员过滤列出 |
| `get` | 获取单个任务详情 |
| `delete` | 删除任务 |
| `clear` | 清除所有任务 |
| `next` | 激活下一个可运行任务，返回解析后的上下文 |

### 批量创建（DAG 依赖）

```javascript
todo({
  action: "create",
  tasks: [
    { subject: "调研", blockedBy: [] },
    { subject: "设计", blockedBy: [0] },
    { subject: "实现", blockedBy: [1] }
  ]
})
```

`blockedBy` 用数组下标引用更早的任务，构成依赖链；完成的任务摘要会作为上下文注入后续任务。

### 绑定给 Teammate 执行（v0.16.0+）

todo 任务可通过 `tasks[].todo` 绑定给被派发的 Agent（`teammate` 工具）：Agent 接管归属并自动激活首个可运行任务，完成后自动推进队列（详见 [并行多智能体调度](/guides/teammate-dispatch)）。

## 4. run-control — Maestro CLI 透传壳

通过 argv 透传调用 canonical Maestro CLI，是 **Session/Run 生命周期的唯一 LLM 工具面**：

| 命令分类 | 说明 |
|---------|------|
| 读命令 | `status`/`brief`/`prepare`/`check`/`recall`/`evidence`/`list`/`show`/`graph`/`skills`/`search`/`load`/`review` —— 无需 mutation lease |
| 写命令 | `next`/`done`/`decide`/`seal`/`edit`/`meta`/`recover`/`accept-reuse`/… —— 需当前 Pi session 持有 mutation lease；Plan 模式阻断 |
| 入口命令 | `session/run create|start` —— 无 lease 时可建新 Session |

```javascript
run-control({ argv: ["session", "status"] })
run-control({ argv: ["session", "next"] })
run-control({ argv: ["run", "done", "run-123", "--verdict", "done", "--summary", "完成"] })
run-control({ argv: ["run", "edit", "quality-review", "--after", "current"] })
```

> Run 绑定发起它的 Pi session；其他会话只读，防止误操作。

## 下一步

- [并行多智能体调度](/guides/teammate-dispatch) — 与 todo 配合的执行引擎
- [权限系统](/guides/permissions) — Plan 模式与权限的关系
- [知识系统](/guides/knowledge) — 目标驱动的知识沉淀
