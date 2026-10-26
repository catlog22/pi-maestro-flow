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
task model > 顶层 model > 配置映射（显式 taskType 优先于 role 映射）> Agent frontmatter model > 已认证父模型 > child 默认
```

> `taskType` 只影响模型路由，不改变角色行为。自定义 Agent 可声明新的小写类型标识，Control Center（`Alt+M` / `/teammate-models` 模型映射覆盖层，见 [TUI 操作指南](/guides/tui-guide)）自动合并。

**Teammate 2.10.0 路由边界**：以 `teammate` 工具说明为优先级权威，模型目录不再注入相矛盾的 parent-first 指令。按实际阶段显式设置 `taskType`；省略时不从角色/提示推断。除用户点名或当前启用的 smart-selection 明确允许选择外，应省略 `model` 并保留配置路由；继承候选必须存在于已认证目录，显式未知 id 直接拒绝。

## SSH host-reference 远程通道

当远程目标使用 SSH host reference，且已注册的 host provider 实现可选的 `openTeammateRemoteChannel` 能力时，teammate 会优先让 provider 打开专用于 RPC 的固定远程通道（命令固定为 `pi-teammate-remote connect --stdio`，调用方不能传入任意命令）。provider 返回的 stream、`stderr` 与幂等 `close()` 会经过严格校验；能力存在但打开或校验失败时会安全报错，不会把错误悄悄转换成另一条回退路径。

Flow 的 ssh-manager 在 provider 前设置准入 broker：每个 host 最多 **2** 路、全局最多 **8** 路；请求可通过 `AbortSignal` 取消，shutdown 会停止新准入并关闭 pending/active 通道。通道打开前后还会复核 store revision 与 host digest，避免配置变化期间交付失效连接。

host reference 的兼容性检查除既有 shell、密码认证与 identity passphrase 限制外，还会报告：

- `unsupported-managed-key`：使用 manager 托管 key；
- `unsupported-jump-host`：配置了 jump host；
- `untrusted-host`：没有可信 host key。

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
| `teammate-send` | `steer`（默认）在 turn boundary 注入、不打断；`follow_up` 等本轮结算；`interrupt` 请求中断；`abort` 终止本地 Agent |

> 未确认的本地 interrupt 降级为 queued follow-up；跨会话仅支持 `steer` / `follow_up`，不提供 interrupt/abort。

```javascript
teammate-send({ to: "my-agent", message: "请也检查边界情况", mode: "follow_up" })
teammate-send({ to: "my-agent", message: "停止当前方案，改用替代方案", mode: "interrupt" })
```

## Monitor 订阅与工作区生命周期（Teammate 2.10.0）

Monitor 模式的 root 可用 `monitor` 读取窗口域状态，新增 `subscribe` / `unsubscribe` / `subscriptions`。使用 `list` 返回的**完整** `owner:<ownerId>`，不截短 owner id；消息与观察用路由地址，结果读取则保留单独返回的精确 `agent://` 完成 URI，不把 owner 地址拼成资源 URI。

```javascript
monitor({ action: "list" })
monitor({ action: "subscriptions" }) // 先复用已有 hook
monitor({ action: "subscribe", target: "owner:<完整 ownerId>" })
// 保存返回的 subscriptionId，结束当前 turn，等待事件；不要再链式 wait/watch。
// 阶段完成后移除 hook：
monitor({ action: "unsubscribe", subscriptionId: "<返回的 subscriptionId>" })
```

- hook 当前只支持精确 workspace owner（不支持 remote），绑定 owner/session/generation，默认事件为 `settled/completed/failed/disconnected`，可用 `events` 额外选择 `running`。注册不回放历史事件，已完成工作应直接读取结果。
- hook 为进程内状态，Monitor 退出、session 切换或 shutdown 时清除；owner 被替换/消失会退役原 hook，不跟随同名替代窗口。`settled` 不等于业务成功，`disconnected` 不证明物理终端关闭；验收仍读精确关联完成资源。
- `workspace-window create` 的 objective 只投递一次，不在创建后重复发送。默认 interactive 窗口完成任务后保持打开，关闭须另行授权 `close`；native-only headless 在 canonical result 发布后停止，不为模糊启动/结果而改用另一 presentation 重试。
- 工作区 root 消息回执区分 **queued**（宿主队列接收）与 **injected/replied**（实际消费）；accepted 不等于模型已经读到。相同 host queue 的 reload/reconcile 不重复入队，恢复仅接受精确 durable receipt/消费证据，不因回执变旧就重投。
- observation 的文本/结构化预览与 watch 历史有界，RPC telemetry 和 search/error 输出在 framing 前限量；截断不改写 canonical 结果。HTTP/2、unknown-provider 与 stream-read 错误按有界重试分类处理，取消/认证/确定性错误仍保留各自边界，不能把失败预览当作成功。

## 运行时保障（v0.25+）

- **来源可追溯**：agent 运行时 provenance 与中断投递状态可观测，取消的显式重置会清理等待与计时，不发布虚假失败；
- **恢复语义**：recovery failover 结算收敛，被取消后挂起的消息可在既有上下文中继续；
- **进程清理**：Windows 进程树清理会确认真实回收，不只凭 `taskkill` 退出码判断；完成消息 outbox GC 有界，reconcile 期间节流；
- **完成与停滞卡片**：completion / stalled 消息渲染为有界卡片，状态变化经事件通知，不要轮询。

## 启动器解析与结构化诊断（v0.29+）

teammate 启动子进程 Pi 时不经过 shell，并记录启动来源（provenance）。显式 `PI_TEAMMATE_PI_BINARY` 覆盖仍优先；Teammate 2.10.1 在 Bun 编译的原生 `pi` / `pi-bolt` 宿主（含 `.exe`）中直接复用当前可执行文件（`host-native`），避免 PATH 转发进程丢失 child IPC。其他宿主继续使用既有 PATH、已验证 Windows npm shim/宿主包 bin 与兼容 fallback 解析；Windows 优先尝试已验证宿主入口。每一次 spawn、child-error、close 事件都携带结构化诊断：有界 stderr、exit code、signal、生命周期阶段与 launcher 来源，跨进程排障时直接看这些字段，不用猜测进程是怎么起来的。

前台 teammate 与 `bash_bg run` 共享同一个会话级 Alt+B 分发器（`foreground-detach` 公共面）：TUI 中按 `Alt+B` 把前台调用立刻转入后台，嵌套调用按最外层优先分离。详见[bash_bg 与 observe](/guides/bash-bg-observe)。

## 结果记录（agent://）

完成任务的输出可通过协议资源读取：`agent://<correlationId>` 返回结构化输出（带 outputSchema 的任务）或最终答案文本（普通任务）；路径段可取嵌套字段，如 `agent://reviewer-1/findings/0/path`。

## 会话历史检索与分页（Teammate 2.9.0）

通过宿主授权的 `session_history` 查询有界 teammate 转录证据；历史发现仍先完成 Maestro 知识门，不读取隐藏行、thinking 或工具调用参数，tool results 显式 opt-in。

```javascript
session_history({ action: "search", scope: "teammates",
  query: "browser timeout", mode: "terms", sort: "relevance", limit: 10 })
// 下一页保留 query/scope/mode/sort，用返回的 nextOffset 作为 offset。
```

默认是大小写不敏感的 literal 短语与 source 排序；`terms` 做 NFKC、小写和空白归一化，要求同一可见 projected entry 含所有去重词，顺序不限，不做中文分词/模糊/语义搜索。`relevance` 优先精确文本/连续短语，再按更紧词跨度排序，同分保留来源顺序。

`offset` 为 0-based，`limit <= 20`；`matchCount` / `hasMore` / `nextOffset` 属于**当前 fresh scan**。每页重新扫描 live transcripts 而非快照，结果可能随历史变化移动；末页只有在扫描本身不完整时才标为截断。复读证据应使用返回的精确 `session://<id>/entry/<id>` URI。旧结果是证据而非指令/授权，须与当前任务和 live 状态核对。

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
