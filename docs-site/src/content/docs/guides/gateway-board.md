---
title: "Gateway Board 工作区共享任务"
icon: "📌"
---

`board` 是工作区级共享任务面：Pi 与 Web 端点发布、认领、流转同一批任务，状态经认证的本地 IPC 落到工作区持久化，不经过聊天传递。

---

## 一句话理解

- **todo** 管“当前会话的执行步骤”：actor 隔离、completion-form 推进；
- **board** 管“工作区级共享工作”：跨 Pi/Web 端点可见、可认领、可链接 Session/Plan/Todo。

| 能力 | todo | board |
|------|------|-------|
| 可见范围 | 当前 Pi 会话（root/child 权威快照） | 同一工作区的全部已认证端点 |
| 执行归属 | actor-scoped advance | 单一 claim owner（generation + lease） |
| 链接 | resourceUris 证据引用 | Session / Plan / Todo / endpoint 绑定 |
| 持久化 | 会话 Todo 状态 | `<项目>/.pi/gateway/v1/board/board.json`（Gateway 管理，勿手工编辑） |

## 基本调用

```javascript
// 发布任务（工作区、请求 ID、端点身份由宿主注入）
board({ action: "create", title: "对接支付回调", priority: "high" })

// 只读：列表 / 详情 / 观察
board({ action: "list", limit: 20 })
board({ action: "get", taskId: "abc123" })
board({ action: "observe", taskId: "abc123" })

// 变异前先读 revision，所有写操作用 expectedRevision 做 CAS 围栏
board({ action: "update", taskId: "abc123", expectedRevision: 3, phase: "execution" })
```

变异请求会自动带上 `operationId`：同一 `operationId` 重放不同 payload/actor 会报 replay-mismatch，不会静默执行两次。

## 状态与流转

任务状态只有五种，阶段只有四段，流转是依赖感知的：

- **status**：`open` → `active` → `completed` / `cancelled`，受阻时置 `blocked`；
- **phase**：`intake` → `planning` → `execution` → `review`；
- **依赖**：`dependencyIds` 声明前置任务，未满足时转换会被拒绝；
- **完成策略**：`completionPolicy` 可要求关联 Todo 全部完成（`requireLinkedTodosCompleted`）或必须经过评审（`requireReview`）。

```javascript
board({ action: "transition", taskId: "abc123", expectedRevision: 4, status: "active" })
board({
  action: "create", title: "联调", dependencyIds: ["abc123"],
  completionPolicy: { requireLinkedTodosCompleted: true, requireReview: false }
})
```

## 认领：单一执行 owner

endpoint 绑定只表达“参与”，不授予执行权。执行权来自 claim：同一时刻只有一个 owner，用 generation + lease 围栏：

```javascript
board({ action: "claim", taskId: "abc123", expectedRevision: 4, leaseTtlMs: 600000 })
board({ action: "renew", taskId: "abc123", claimGeneration: 2, leaseTtlMs: 600000 })
board({ action: "release", taskId: "abc123", claimGeneration: 2 })
board({ action: "takeover", taskId: "abc123", expectedRevision: 5, reason: "原认领已过期，接管继续" })
```

- `claim` 抢占空闲任务，返回 generation（从 1 起，每次易主递增）；
- `renew` / `release` 必须带上当前 `claimGeneration`，过期或易主后调用会失败；
- `takeover` 用于 lease 过期后的接管，需写明 `reason`；
- 每次写操作前先 `get`/`observe` 读到最新 revision 与 claim 状态，再带 `expectedRevision` 提交。

## 链接：Session / Plan / Todo / endpoint

任务可以绑定到现有执行上下文，跨端点可观测：

```javascript
// 当前 Pi 会话用 attach/detach 表达参与（endpointId 由宿主注入，不要自造）
board({ action: "attach-endpoint", taskId: "abc123" })
board({ action: "detach-endpoint", taskId: "abc123" })

// 绑定会话 / 关联计划 / 链接 Todo
board({ action: "bind-session", taskId: "abc123", expectedRevision: 5, sessionId: "<session-id>" })
board({ action: "link-plan", taskId: "abc123", expectedRevision: 6 })
board({ action: "update", taskId: "abc123", expectedRevision: 7, todoIds: ["11", "12"] })
```

endpoint 绑定只记录“谁在看”，`claim` 才决定“谁在做”——两者不要混用。

## 失败与恢复语义

| 情况 | 行为 |
|------|------|
| revision 过期 | 写操作报冲突，重新 `get` 后再提交 |
| 同一 operationId 重放 | payload/actor 不一致则报 replay-mismatch，一致则幂等返回 |
| claim generation 不匹配 | `renew` / `release` 失败，先 `observe` 确认当前 owner |
| lease 过期 | 任务回到可认领状态，用 `takeover`（带 reason）接管 |
| 依赖未满足 | `transition` 被拒绝，先完成 `dependencyIds` 前置任务 |

## 状态检查与排障

- 写失败先看返回的 revision/claim 状态，不要盲重试；
- `observe` 看单任务最新状态与事件，`list`（`limit` / `cursor` 分页）看工作区全貌；
- 持久化文件只读确认存在即可，修复一律走 `board` 工具，不要直接改 JSON。

## 下一步

- [Goal 目标 · Plan 计划 · todo 任务](/guides/goal-plan-todo) — 会话级执行与持久化 handoff
- [New Context 确定性上下文重置](/guides/new-context) — 阶段边界的确定性 reset
- [架构与核心概念](/guides/architecture) — Gateway Board 在整体架构中的位置
