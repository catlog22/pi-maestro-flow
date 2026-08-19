---
title: "模型路由与思考深度"
icon: "🎚️"
---

teammate 支持逐任务的模型覆盖与思考深度控制。模型定义与故障转移配置见[API Provider 配置](/guides/api-provider-config)。

---

## 模型路由优先级

```
task model > 顶层 model > taskType 映射 > 角色 model > 父 Pi 模型
```

| 层级 | 说明 |
|------|------|
| `task.model` | 单个任务显式指定模型 |
| 顶层 `model` | dispatch 级默认值 |
| `taskType` 映射 | 按任务类型（explore/analysis/debug/...）配置模型，Control Center（`Alt+M` / `/teammate-models`）管理 |
| 角色 model | Agent frontmatter 中声明的模型 |
| 父 Pi 模型 | 继承主会话模型 |

```javascript
teammate({
  model: "provider/fast-model",              // 顶层默认
  tasks: [
    { name: "quick", agent: "explorer", prompt: "..." },
    { name: "deep", agent: "analyst", model: "provider/deep-model", prompt: "..." }
  ]
})
```

## 思考深度级别

| 级别 | 说明 |
|------|------|
| `off` | 关闭扩展思考，最快响应 |
| `minimal` | 最小思考开销 |
| `low` | 低深度推理 |
| `medium` | 中等深度（平衡速度和质量） |
| `high` | 高深度推理 |
| `xhigh` | 极高深度（最慢但最彻底） |
| `max` | `xhigh` 的别名 |

### 使用方式

```javascript
teammate({
  thinking: "high",
  tasks: [
    { name: "quick-scan", agent: "explorer", prompt: "...", thinking: "off" },
    { name: "deep-analysis", agent: "general", prompt: "...", thinking: "xhigh" }
  ]
})
```

### 优先级

```
任务级 thinking > 顶层 thinking > taskType 映射 > Agent frontmatter > Pi 默认
```

> 不同模型支持的思考级别范围不同，且由运行时模型目录（`<available_teammate_models>`）动态决定——同一模型在不同环境可能支持不同的级别集。超出范围的级别会被模型拒绝或降级，以实际输出为准。

## taskType 与路由

`taskType` 只影响模型路由，不改变角色行为。Control Center 自动合并内置类型、当前发现的内置/项目/用户 Agent YAML 类型及已有映射类型；自定义 Agent 可声明新的小写类型标识。

```javascript
teammate({ tasks: [{ agent: "security-auditor", taskType: "review", prompt: "..." }] })
```

## Fallback 链

任务可通过 `fallbackModels` 声明有序回退模型：

```javascript
teammate({
  tasks: [{
    agent: "general",
    model: "provider/model-a",
    fallbackModels: ["provider/model-b", "provider/model-c"],
    prompt: "..."
  }]
})
```

配置了[模型故障转移](/guides/api-provider-config)时，熔断触发后自动按 fallback 链切换；切换可不重启 run，经 `set_model` RPC 在进程内热切换，手动切换模型会重置该模型的熔断器。

## 下一步

- [API Provider 与模型故障转移](/guides/api-provider-config) — 模型定义、熔断器、故障转移配置
- [Agent 角色体系](/guides/agents) — 角色与模型的配合
- [并行多智能体调度](/guides/teammate-dispatch) — 调度参数总览
