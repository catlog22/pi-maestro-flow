---
title: "并行多智能体调度"
icon: "🤖"
---

`teammate` 是执行引擎的核心工具：一次派出多个子进程智能体并行工作，支持 DAG 依赖图、模型路由与结构化输出。

---

## 基本形态

所有调用统一使用必需的非空 `tasks[]`。单 Agent 是一个 task，多 Agent 是多个 task。每项 `prompt` 都是字面任务文本。

```javascript
// 单任务（前台，等待结果）
teammate({ tasks: [{
  agent: "explorer",
  taskType: "explore",
  prompt: "FIND: 认证入口\nSCOPE: src/"
}] })

// 多任务并行 + 模型覆盖
teammate({
  agent: "explorer",
  model: "provider/fast-model",
  tasks: [
    { name: "scan", prompt: "定位认证入口" },
    { name: "calls", prompt: "定位调用点" },
    { name: "review", agent: "analyst", taskType: "review",
      model: "provider/deep-model", prompt: "审查 {scan} 与 {calls}" }
  ],
  concurrency: 2,
  background: false
})
```

### 参数语义

| 参数 | 说明 |
|------|------|
| `agent` / `taskType` / `model` / `thinking` / `context` / `cwd` / `outputSchema` / `timeoutMs` | 顶层为 task 默认值，task 同名字段覆盖；未指定角色时默认 `general` |
| `{name}` / `{name.field}` | 注入上游任务输出（自动建立依赖） |
| `dependsOn` | 只声明顺序，不注入输出 |
| `background` | 默认 `false`；`true` 时立即确认并后台执行，完成时推送通知 |
| `todo` | 绑定 Todo 任务给被派发 Agent：启动时接管归属、自动激活首个可运行任务，并注入有序队列由其自行推进（首个优先） |
| `concurrency` | 最大并行任务数（默认 4） |
| `maxNestingDepth` | 限制子代理再派生子代理的层级（0 禁止嵌套）；顶层为默认值，task 同名字段可覆盖，均省略时取全局上限（2，实际生效 0/1） |

### 模型优先级

```
task model > 顶层 model > taskType 映射 > 角色 model > 父 Pi 模型
```

> `taskType` 只影响模型路由，不改变角色行为。自定义 Agent 可声明新的小写类型标识，Control Center（`Alt+M` / `/teammate-models` 模型映射覆盖层，见 [TUI 操作指南](/guides/tui-guide)）自动合并。

## DAG 依赖图

`{name}` 引用与 `dependsOn` 一起构成任务依赖图：引用注入输出，`dependsOn` 仅排序。示例：

```javascript
teammate({
  tasks: [
    { name: "defs", agent: "explorer", prompt: "FIND: Auth 导出\nSCOPE: src/auth/" },
    { name: "calls", agent: "explorer", prompt: "FIND: Auth 导入\nSCOPE: src/" },
    { name: "report", agent: "general", prompt: "合并 {defs} + {calls} 生成缺口报告" }
  ]
})
```

第三个任务自动等待前两个完成后执行——**一条指令搞定并行 + 依赖合并**。

## todo 绑定派发（v0.16.0+）

任务可通过 `tasks[].todo` 绑定到 Todo（单 id 或有序数组，首个优先级最高）：Agent 启动时接管任务归属（root → agent）、自动激活第一个可运行任务，并注入有序队列由其独立推进；每完成一个任务即 `todo update <id> status=completed summary=...`。干净退出时自动封存遗留任务；失败/取消则保留给 root 重新派发。

```javascript
teammate({
  tasks: [
    { name: "impl", agent: "general-executor", todo: "12",
      prompt: "实现 JWT 认证模块并完成绑定任务" }
  ]
})
```

## 结构化输出

用 `outputSchema` 要求 JSON Schema 校验的结构化结果：

```javascript
teammate({
  tasks: [{
    name: "audit",
    agent: "general",
    prompt: "审查 src/auth/ 并输出结构化发现",
    outputSchema: {
      type: "object",
      properties: {
        findings: { type: "array", items: { type: "string" } },
        severity: { type: "string", enum: ["low", "medium", "high"] }
      },
      required: ["findings", "severity"]
    }
  }]
})
```

下游任务可通过 `{audit.findings}` 引用结构化字段。

## 后台任务与观察

```javascript
// 后台执行
teammate({ tasks: [...], background: true })

// 观察（三态）
observe({ action: "status", targets: [{ kind: "teammate", id: "reviewer" }] })
observe({ action: "wait", targets: [{ kind: "teammate", id: "reviewer" }], until: "completed" })
observe({ action: "watch", targets: [{ kind: "teammate", id: "reviewer" }], timeoutMs: 30000 })
```

详见[bash_bg 与 observe](/guides/bash-bg-observe)。

## Agent 控制工具

| 工具 | 用途 |
|------|------|
| `teammate-list` | 列出 Agent（`view: active / named / all / roles`） |
| `teammate-watch` | 查看最近输出、工具活动、收件箱（`lines` 控制行数）——旧版工具，需 `PI_TEAMMATE_LEGACY_OBSERVATION_TOOLS=1`，新代码用 `observe` 替代 |
| `teammate-wait` | 事件驱动等待完成（`timeoutMs`）或固定延迟（`waitMs`）——旧版工具，需 `PI_TEAMMATE_LEGACY_OBSERVATION_TOOLS=1`，新代码用 `observe` 替代 |
| `teammate-send` | 发送消息（`follow_up` 排队 / `steer` 中断 / `abort` 终止） |

> v0.16.0 起，steer 控制面失败（未确认/拒绝的中断）降级为排队 follow-up，不再伪装成任务失败。

```javascript
teammate-send({ to: "my-agent", message: "请也检查边界情况", mode: "follow_up" })
teammate-send({ to: "my-agent", message: "停止当前方案，改用替代方案", mode: "steer" })
```

## 运行时保障（v0.25+）

- **来源可追溯**：agent 运行时 provenance 与中断投递状态可观测，取消的显式重置会清理等待与计时，不发布虚假失败；
- **恢复语义**：recovery failover 结算收敛，被取消后挂起的消息可在既有上下文中继续；
- **进程清理**：Windows 进程树清理会确认真实回收，不只凭 `taskkill` 退出码判断；完成消息 outbox GC 有界，reconcile 期间节流；
- **完成与停滞卡片**：completion / stalled 消息渲染为有界卡片，状态变化经事件通知，不要轮询。

## 结果记录（agent://）

完成任务的输出可通过协议资源读取：`agent://<correlationId>` 返回结构化输出（带 outputSchema 的任务）或最终答案文本（普通任务）；路径段可取嵌套字段，如 `agent://reviewer-1/findings/0/path`。

## 思考深度控制

逐任务控制推理深度：`off` → `minimal` → `low` → `medium` → `high` → `xhigh` → `max`。`xhigh` 与 `max` 是两个不同的 canonical 级别（`max` 与 Pi runtime 的 ThinkingLevel 一致，不再降级为 `xhigh`）。

```javascript
teammate({
  thinking: "high",
  tasks: [
    { name: "quick-scan", agent: "explorer", prompt: "...", thinking: "off" },
    { name: "deep-analysis", agent: "general", prompt: "...", thinking: "xhigh" }
  ]
})
```

优先级：任务级 `thinking` → 顶层 → `taskType` 映射 → Agent frontmatter → Pi 默认。

> 注意：不同模型支持的思考级别范围不同，且由运行时模型目录动态决定（见[模型路由](/guides/model-routing)）。

## maestro — 知识感知调度

`maestro` 工具连接外部 CLI 端点与知识系统，提供三个 action：

### explore — 并行代码搜索

```javascript
maestro({
  action: "explore",
  prompts: [
    "FIND: 所有 JWT 验证中间件\nSCOPE: src/middleware/\nEXPECTED: file:line + 控制流摘要",
    "FIND: 所有 auth.login() 调用点\nSCOPE: src/**/*.ts"
  ],
  concurrency: 3,
  maxTurns: 6
})
```

### delegate — 任务委派到外部工具

```javascript
maestro({
  action: "delegate",
  prompt: "PURPOSE: 实现密码重置流程\nMODE: write\nCONTEXT: @src/auth/",
  tool: "claude",   // gemini | claude | codex
  mode: "write"
})
```

> 外部 CLI 工具需在 `~/.maestro/cli-tools.json` 中启用，详见[API Provider 配置](/guides/api-provider-config)。

### moa — 混合智能体合成

```javascript
maestro({
  action: "moa",
  prompts: ["从安全和架构两个角度分析支付流程"],
  preset: "deep"
})
// 跨多个模型并行分析，然后合成为统一报告
```

## 下一步

- [Agent 角色体系](/guides/agents) — 7 内置 + 25 项目级角色
- [模型路由与思考深度](/guides/model-routing) — 路由优先级详解
- [权限系统](/guides/permissions) — 子进程权限中继
