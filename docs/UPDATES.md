# 更新说明 — v0.13.0 → 当前（2026-08-02）

> 记录自上个发布版本 `v0.13.0`（tag）以来的全部提交变更。正式发版时合并进 `RELEASE.md`。

## 概览

本阶段共 **17 个提交**，聚焦三条主线：

1. **teammate** — 新增 Mailbox 持久消息队列（工作区级隔离、冷恢复同步）与 observe `watch`/`until=completed` 阻塞观察；
2. **cockpit** — 新增 Claude Code 风格终端标题（可选 LLM 生成），版本升至 0.8.0；
3. **flow** — vision 委托补强（reasoning effort 透传）、run-control 绑定会话所有权、compaction 租约与 bridge 故障转移加固、内存边界。

## 版本对照

| 包 | v0.13.0 | 当前 |
|---|---|---|
| pi-maestro-flow | 0.13.0 | 0.13.0 |
| pi-maestro-teammate | 1.5.0 | 1.5.0 |
| pi-cockpit | 0.7.0 | **0.8.0** |

## 变更明细（按包分组）

### pi-maestro-teammate — Mailbox 消息队列

- 新增 mailbox 消息队列、workspace peers 与生命周期加固（`80070431`）
- 工作区级 mailbox 隔离（`57dcc5fc`）
- mailbox 为权威状态时冷恢复保持同步（`04222a0c`）
- Windows 文件锁下重命名自动重试 + 孤儿状态记录 GC（`9c372a53`）
- 外部消费者入口：`pi-maestro-teammate/v1/mailbox`（`46f8886d`）

### pi-maestro-teammate — observe 阻塞观察

- 新增 `watch` action 与 `until=completed` 终态阻塞等待（`b0a92eae`）
- wait schema 强制 `name` 或 `waitMs` 二选一（`5569d8e1`）
- 拒绝自引用依赖（`2584b77e`）；依赖守卫与计划修订语义文档化（`e31558c3`）

### pi-cockpit — 终端标题与状态渲染（0.7.0 → 0.8.0）

- Claude Code 风格终端 Tab 标题，支持 LLM 生成会话摘要（`66e6a88d`）
- agents-store 状态所有权与渲染优化（`4031ff36`）

### pi-maestro-flow — 稳定性与运维

- run-control 绑定发起它的 Pi session 所有权（`2d8701b0`）
- compaction 租约加固、api-provider ops、vision 委托补强、effort 展示（`e39bf4db`）
- bridge 故障转移重试缺口修复：terminated/timeout 分类与回合续跑（`2857e95c`）

### 内存边界

- 限制 GUI 事件回放字节数（`d4ce62f0`）
- MCP 连接身份租约，防长会话膨胀（`5927d5c3`）

## 统计

- **17 commits · 122 files · +10,887 / −466**
- pi-maestro-teammate：70 files（+8,444 / −222）
- pi-maestro-flow：26 files（+1,132 / −202）
- pi-cockpit：20 files（+982 / −37）

## 使用入口

新特性的完整使用说明见 **[docs/new-features-usage.md](new-features-usage.md)**。
