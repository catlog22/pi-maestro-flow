---
title: "Mailbox 消息队列与会话导出"
icon: "📬"
---

**Mailbox** 是工作区级隔离的持久消息队列；**会话导出**导出当前会话上下文信息，用于调试与审计。

---

## 1. Mailbox 消息队列（pi-maestro-teammate）

持久化、工作区级隔离的消息队列；冷恢复时以 mailbox 为权威源同步，防消息丢失/重复。

### 设计要点

- **状态机**：`staging → ready → claimed → accepted`（原子写入 + 幂等回执）；
- **可靠性**：Windows 下重命名自动重试，孤儿状态记录由 GC 回收；
- **外部接入**：外部消费者通过 `pi-maestro-teammate/v1/mailbox` 子路径接入（含能力协商）。

> 普通用户无需配置；属内部集成能力，供跨会话、跨进程的可靠消息投递使用。

## 2. 会话导出

导出当前会话上下文信息，用于调试与审计。

```javascript
// 模型侧调用（由会话桥接能力提供）
session-export({ ... })
```

| 能力 | 说明 |
|------|------|
| 上下文导出 | 导出当前会话的关键上下文信息 |
| 调试与审计 | 用于问题定位与合规记录 |
| 会话桥接 | 跨会话状态投影与恢复 |

> 具体用法以当前运行时注册的工具 schema 为准（`search_tool_bm25({ query: "session export" })` 可发现对应工具）。

## 3. 其他会话增强

| 能力 | 说明 |
|------|------|
| run-control 所有权 | run 绑定发起它的 Pi session；其他会话只读，防误操作 |
| 会话压缩续行 | 压缩后自动注入续行提示，Agent 从中断点继续 |
| 状态持久化 | 修剪状态持久化，跨会话保持 |
| Session 覆盖层 | `/maestro-session` 工作流会话控制中心 |

## 下一步

- [Compaction 容量管理](/guides/compaction-config) — 会话上下文窗口管理
- [Pi Cockpit 可视化](/guides/cockpit) — 终端标题与会话摘要
- [Goal 目标 · Plan 计划 · todo 任务](/guides/goal-plan-todo) — 会话内的目标生命周期
