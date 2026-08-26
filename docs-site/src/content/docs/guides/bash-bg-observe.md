---
title: "bash_bg 自适应 Shell 与 observe 观察"
icon: "⏱️"
---

**bash_bg** 让长命令不阻塞对话：超时自动转后台、完成时推送通知；**observe** 提供 status / wait / watch 三态观察，支持终态阻塞等待。

---

## 1. bash_bg — 自适应 Shell

```javascript
// 前台执行：命令足够快时直接返回输出
bash_bg({ action: "run", command: "npm run build", timeout: 60 })

// 显式后台：立即确认，完成时通知
bash_bg({ action: "start", command: "npm run dev", cwd: "packages/app" })

// 状态快照
bash_bg({ action: "status", jobId: "bg-1" })

// 阻塞等待
bash_bg({ action: "wait", jobId: "bg-1", timeout: 30 })

// 终止进程树
bash_bg({ action: "kill", jobId: "bg-1" })

// 列出全部任务
bash_bg({ action: "list" })
```

### 行为规则

| 场景 | 行为 |
|------|------|
| 命令在 `timeout` 内完成 | 前台直接返回完整输出 |
| 超过 `timeout` 仍运行 | 自动转入后台，返回 jobId |
| 后台完成 | 推送 bash-bg-complete 通知（新回合） |
| 常驻进程（dev server 等） | 用 `action: "start"` 立即后台化 |

### 与 observe 配合

后台任务完成后会有通知；如需阻塞等待，用 observe：

```javascript
observe({ action: "wait", targets: [{ kind: "bash_bg", id: "bg-1" }], until: "completed" })
```

## 2. observe — 三态阻塞观察

```javascript
// status — 一次性快照
observe({ action: "status", targets: [{ kind: "teammate", id: "reviewer" }] })

// wait — 屏障等待（all / any / count）
observe({
  action: "wait",
  targets: [
    { kind: "teammate", id: "reviewer" },
    { kind: "bash_bg", id: "bg-1" }
  ],
  waitMode: "all",          // all | any | count
  timeoutMs: 600000
})

// watch — 持续观察直到超时，记录完整进展
observe({ action: "watch", targets: [{ kind: "teammate", id: "reviewer" }], timeoutMs: 30000 })
```

### 关键参数

| 参数 | 说明 |
|------|------|
| `until` | `"result-ready"`（默认，出结果即返回）或 `"completed"`（终态生命周期） |
| `waitMode` | `all`（全部到达）、`any`（任一到达）、`count`（到达 N 个） |
| `detail` | `summary` / `tail` / `full` 输出详情级别 |
| `lines` | 每个 target 的最近输出行数 |

> `wait` 的目标统一为 `{ kind, id }` 形式；`name` / `waitMs` 二选一约束仅适用于旧版 `teammate-wait` 工具。

### 观察目标类型

| kind | 说明 |
|------|------|
| `teammate` | 子进程智能体（按 name 或 correlation-id） |
| `bash_bg` | 后台 Shell 任务（按 jobId） |

## 3. 实用模式

### 长命令不阻塞

```javascript
// 60 秒内没跑完自动转后台，期间可继续其他工作
bash_bg({ action: "run", command: "npm run test:e2e", timeout: 60 })
```

### 多目标屏障

```javascript
// 等待"全部"后台任务完成后再继续
observe({
  action: "wait",
  targets: [
    { kind: "bash_bg", id: "lint" },
    { kind: "teammate", id: "reviewer" }
  ],
  waitMode: "all",
  until: "completed"
})
```

### 防轮询

后台任务的完成状态通过事件驱动（bash-bg-complete / teammate-complete 通知），**不要轮询**；若当前回合必须等待，调用一次 `observe wait` 即可。

### lastResult 摘要（区分“完成”与“未开始”）

observe 输出会无条件渲染 target 的 `lastResult`：非 verbose 显示一行扁平摘要（`result: <截断文本…>`），verbose 仍显示 `--- last result ---` 完整多行块。这样轮询观察者无需请求 detail 即可区分“已完成所请”与“尚未开始”——`nativeStatus`/`summary` 由 agent 计数与空闲时间推断，单独不足以分辨这两种状态，`lastResult` 是 run 自己的陈述。

工作区窗口侧同步保留一个 `mainLastSettle` 单槽投影，跨轮次保存最近一次 `agent_settled` 的结果，避免心跳轮询错过被 progress 环冲掉的 settle 事件。

## 下一步

- [并行多智能体调度](/guides/teammate-dispatch) — teammate 后台执行
- [Pi Cockpit 可视化](/guides/cockpit) — 后台任务在界面上的呈现
- [环境变量速查](/guides/env-vars) — bash_bg 相关配置
