# Release v0.4.3 — 2026-07-12

## 概述

v0.4.3 是 `pi-maestro-flow` 的 patch 版本，聚焦交互消息的单次交付语义：Plan 批准后不再把当前会话执行 handoff 额外排队为 follow-up，同时 Codex-compatible command hook 的输出会以可见、限长且不触发新 turn 的消息展示。

## 修复

### Plan 批准 handoff 去重

- 当前会话中的 `plan-confirm` 通过 tool result 交付执行约束，不再额外调用 `sendUserMessage(..., { deliverAs: "followUp" })`。
- 避免 agent 已开始创建 Goal/Todo 后，又收到同一 approved Plan handoff 的重复注入。
- Compact 和新会话执行仍保持一次必要的消息投递。
- 增加非 idle、compact、新会话三条生命周期回归断言。

## 改进

### Codex Hook 输出可见性

- 每个已执行 command hook 都生成可见的 `codex-hook-output` 消息。
- 输出消息使用 `triggerTurn: false`，不会意外启动新的 agent turn。
- 命令和输出均设置长度上限，超长内容会明确标记为 truncated。
- 支持 plain text、JSON、stdout、stderr、error 和 exit code 的统一展示。

## 验证

- Plan 生命周期：40/40 通过。
- Goal：1/1 通过。
- Hooks：9/9 通过。
- Compaction：15/15 通过。
- Todo 与 skill loader：20/20 通过。
- 合计：85/85 通过。

## 版本

| 包 | 旧版本 | 新版本 |
|---|---:|---:|
| `pi-maestro-flow` | 0.4.2 | 0.4.3 |

`pi-maestro-teammate` 本次没有代码变更，继续保持 0.4.2。

## 安装

```bash
npm install pi-maestro-flow@0.4.3
```

## 升级说明

这是向后兼容的 patch 更新，无需迁移配置或持久化状态。使用 Plan Mode 的用户升级后，批准当前上下文执行时将只收到一次 handoff。
