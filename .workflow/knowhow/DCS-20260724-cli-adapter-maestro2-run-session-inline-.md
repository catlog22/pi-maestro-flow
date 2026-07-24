---
title: cli-adapter 依赖 maestro2 的 run/session 命令路由契约（含 --inline-brief 归属）
description: "插件 cli-adapter 依赖的真实 maestro CLI 在 D:\\maestro2；next/done 在 session 与 run 双家族下都有，按 --help 探测路由；--inline-brief 仅 session next 声明，run next 回退不可带。核实 CLI 契约必须去 maestro2，不能在插件仓库搜。"
type: decision
created: 2026-07-24T04:21:32.412Z
keywords:
  - cli-adapter
  - maestro2
  - run-control
  - session-next
  - run-complete
  - inline-brief
  - 命令路由
  - 探测
  - 回退
  - 踩坑
  - 核实
  - workflow-coordinator
  - debug
status: accepted
specCategory: arch
---

## 背景

插件 `pi-maestro-flow` 的 `src/session/cli-adapter.ts` 通过 spawn maestro CLI 推进 Workflow Run/Session。该 CLI 的**真实源码在独立仓库 `D:\maestro2`**（package `maestro-flow`，命令注册在 `src/commands/`），**不在插件仓库内**——插件只是消费方。

## 命令拓扑（maestro2 实测：`src/commands/session.ts` + `src/commands/run.ts`）

- 推进/完成在**两套子命令家族**下都存在：
  - `session next`（session.ts:748）、`session done [run-id]`（session.ts:786）
  - `run next`（run.ts:612）、`run complete [run-id]`（run.ts:787）
- read/编辑类（`brief`/`check`/`prepare`/`edit`）在 `run` 下。
- `--inline-brief` **仅声明在 `session next`**（session.ts:751；实现见 `src/run/next.ts:737`：把 birth brief 内联进 next 响应，**省一次单独的 `run brief` 往返**）。`run next` **没有**该 option。
- `session done` 与 `run complete` 的 option 契约一致：`--session --verdict --summary --reason --note --decision --evidence --artifact --json --workflow-root`。

## 路由策略（cli-adapter 已实现）

- `capabilities()` 解析 `run --help` 与 `session --help`，把 session 解析出的命令**单独**记入 `RunCliCapabilities.sessionCommands`（同时并入 `commands`）。
- `next()`：`sessionCommands.has("next")` 为真 → `session next --inline-brief ...`；否则回退 `run next ...` 且**不带** `--inline-brief`（`run next` 未声明，带上会 unknown-option 报错）。
- `done()`：`sessionCommands.has("done")` 为真 → `session done`；否则回退 `run complete`。`requireCommand("done", "complete")` 支持备选名，避免回退场景误抛 `UnsupportedRunCapabilityError`。
- 判据用「session 帮助是否**解析出**该命令」，而非「`session --help` 是否抛错」——mock 或旧 CLI 可能返回非错误但无命令的文本，靠抛错判断会误判。

## 踩坑教训（debug）

曾在**插件仓库**搜 `--inline-brief` 搜不到，误判为「编造的 flag」并删除，还用测试把「不带 `--inline-brief`」锁成断言——实为引入回归（丢掉了省一次 brief 往返的优化）。根因：flag/命令定义在 maestro2，插件仓库搜不到是正常的。**核实 CLI 契约必须去 `D:\maestro2/src/commands/`，不能在被测插件仓库搜。**

## 相关代码

- 插件侧：`src/session/cli-adapter.ts`；`test/workflow-coordinator.test.ts` 双场景覆盖（run-only mock → 回退 `run next`/`run complete` 无 inline-brief；session+run mock → `session next` 带 inline-brief / `session done`）。
- `run-control` 工具描述刻意保持**抽象语义层**（「allocate the next chain Run」「seal a Run」），不写死子命令名，与此路由解耦——CLI 拓扑变化时无需改工具描述。
