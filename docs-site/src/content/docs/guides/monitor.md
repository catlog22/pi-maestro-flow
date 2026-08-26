---
title: "Monitor 跨会话协调"
icon: "📊"
---

Monitor 是由根 Agent 操作的控制模式，用于协调**其他 Pi 会话和 worker**。执行 `/monitor` 后，当前根会话成为控制窗口：Agent 根据用户在 `#control` 中给出的策略发现目标、观察状态、发送指令并管理 worker。

Monitor 模式不会在后台运行评估器，也没有面向指定目标的监督模式、自动分析周期或持久评估状态。只需读取一次状态时直接使用 `observe`；需要根 Agent 协调多个本地或远端 worker 并按证据干预时使用 `/monitor`。

已删除运行时遗留在 `.pi` 下的文件不会生效。Monitor 不读取这些文件，也不会自动删除它们。

---

## 1. 最短上手流程

打开控制窗口，然后用自然语言描述协调任务：

```text
/monitor

创建 backend、frontend 和 tests 三个可交互工作窗口，
分别实现接口、页面和集成测试，持续协调到全部完成，
收集结果后关闭不再需要的窗口。
```

根 Monitor Agent 会使用当前可用的协调工具。它把项目实现交给 worker，而不是在控制窗口中直接修改项目。

对于同一工作区中已经打开的 Pi 窗口，直接给 Agent 协调指令：

```text
查找当前工作区中的 backend 和 tests 窗口，检查它们的进度；
backend 报告完成后，让 tests 开始集成验证。
```

Agent 使用 `teammate-list({ view: "windows" })` 发现窗口，通过 `observe` 检查状态，并按需发送 `follow_up` 或 `steer`。消息进入队列或被接收只证明已经入队；再次发送前，Agent 会等待目标侧或状态变化的证据。

## 2. 根控制模式

直接执行 `/monitor` 会进入根控制模式，并开放跨窗口协调能力。`#control` 中的消息代表监督策略、优先级或干预要求。

控制 Agent 可以：

- 用有界 `observe` 调用检查一个或多个本地工作区窗口；
- 用 `follow_up` 发送非紧急工作，用 `steer` 发送时效性强的纠正；
- 创建和关闭当前 Monitor 会话拥有的本地 worker；
- 创建和取消已配置的 SSH 远端任务；
- 用 Flow Schedule 在已有 managed window 中安排有序工作；
- 在用户明确需要持续监督时创建有界 prompt `loop`。

控制 Agent 不应自己实现项目工作。需要把当前根会话用于无关实现前，应先退出 Monitor 模式。

## 3. 命令速查

| 命令 | 作用 |
|------|------|
| `/monitor` | 进入根 Monitor 控制模式 |
| `/monitor status` | 查看模式是否启用，以及 Monitor 拥有的本地和远端 worker |
| `/monitor doctor` | 只读健康摘要：模式/工具开放状态，以及可见的本地、managed 和远端资源 |
| `/monitor exit` / `/monitor stop` | 退出 Monitor 模式 |
| `/monitor spawn <name> <objective>` | 兼容/调试命令：启动 managed headless Pi worker，并返回精确 owner 目标 |
| `/monitor spawn status` | 列出 managed window |
| `/monitor spawn stop <name>` | 停止指定 managed window |

`/monitor exit` 只结束控制模式，不会取消通用 `loop` 任务。不再需要持续监督时，应先列出并取消对应 loop。

## 4. 本地工作区窗口

Agent 通过两条路径处理本地窗口。

### 已有窗口

`teammate-list({ view: "windows" })` 用于发现同一工作区中的 Pi 根会话。每个窗口都通过精确的 `owner:<ownerId>` 身份寻址。Agent 以 workspace 目标观察该 owner，并向同一个精确 owner 发送消息。

Owner 身份是安全边界。窗口关闭或被替换后，Agent 必须重新发现目标；同名窗口不会被视为原来的 owner。已有窗口可以被观察和发送消息，但 Monitor 不能关闭自己未创建的窗口。

### Monitor 拥有的窗口

用户用自然语言要求创建 worker 时，Agent 使用 `workspace-window`：

1. `create` 默认打开可交互终端，并且只投递一次任务目标；
2. 调用等待精确 workspace owner 注册成功后，返回 `owner:<ownerId>`；
3. 返回的 owner 可直接用于 `observe` 和 `teammate-send`；
4. 可选 completion handle 指向不可变的 `agent://` 结果，worker 退出后仍可读取；
5. `close` 仅能操作当前 Monitor 会话创建的窗口，并验证进程确实已经回收。

`create` 后不要重复发送初始目标；后续消息只应携带新约束、纠正或明确的回复请求。完成结果尚未收集或工作尚未取消时，应保留 completion handle。

Monitor 不能关闭用户手工打开的 peer，也不能关闭其他 Monitor 会话拥有的 worker。无法证明所有权或进程回收时，关闭操作会报告错误，不会对陈旧的进程身份执行操作。

Worker 名称必须以字母或数字开头，只能包含 `A-Z`、`a-z`、`0-9`、`.`、`_`、`-`，最长 64 个字符。单个 Monitor 会话最多拥有 8 个 managed window。

可交互 worker 在 Windows 使用 Windows Terminal（`wt.exe`），在 macOS 通过 `osascript` 使用 Terminal，在 Linux 使用 `PI_TEAMMATE_TERMINAL` 或 `x-terminal-emulator`。终端不可用或精确 owner 注册未在 15 秒内完成时，创建会失败并尝试清理。根会话关闭或 reload 时，也会尝试回收仍由该会话拥有的窗口。

### Headless 兼容命令

`/monitor spawn` 继续作为兼容和调试入口：

```text
/monitor spawn migration 完成数据库迁移并运行针对性测试
/monitor spawn status
/monitor spawn stop migration
```

该命令会等待精确 owner 注册并报告 `owner:<ownerId>` 目标。由 Agent 通过 `workspace-window` 执行自然语言协调仍是主要工作流。

## 5. 使用 Loop 持续监督

单次状态查询或有界等待不需要 loop。用户明确要求在没有后续消息时继续监督，Monitor Agent 才为完整目标集合创建一个有界 prompt `loop`。

创建前，Agent 会先列出已有 loop，复用或取消现有监督 loop，避免重复。每次执行应当：

1. 重新发现指定的工作区窗口；
2. 在一次调用中观察全部目标；
3. 对比本次与上次的证据；
4. 仅在新证据显示失败、阻塞、进展丢失或偏离既定任务时干预；
5. 每个目标最多发送一条干预；
6. 所有目标结束或不再要求持续监督时取消 loop。

Monitor 监督使用 prompt loop，不使用 shell loop。通用 loop 不归 `/monitor exit` 管理，退出 Monitor 不会停止它。

## 6. 远端 Worker

Monitor 模式中的 `remote-worker` 用于管理已配置的 SSH 远端任务，同时不会暴露 SSH 凭据或可信命令。

- `targets` 列出已配置的 target ID；
- `create` 仅在 SSH 握手、能力协商、远端启动和本地所有权接纳全部成功后返回；
- `list` 显示当前 Monitor 会话拥有的远端任务；
- `close` 执行所有权校验后的生命周期取消。

远端任务使用稳定的 `remote:<runId>` 目标。观察时使用 `kind: "remote"`，后续纠正通过 `teammate-send` 发送。不要把远端任务当作 workspace owner，也不要将其传给 `workspace-window`。跨目标 abort 不可用；收集所需结果后，使用 `remote-worker close` 取消任务。

## 7. Flow Schedule

Flow Schedule 是 Monitor 专用的有序执行界面，目标必须是**已经由 Monitor 管理的本地工作区窗口**。当工作步骤稳定，并且必须依据 worker 返回的精确关联报告推进时使用它。

Flow Schedule 不替代其他能力：

- `workspace-window` 管理 worker 进程；
- `observe` 提供当前状态；
- `teammate-send` 处理临时指令；
- `loop` 处理重复检查；
- Flow Schedule 管理有序派发和精确结果关联。

创建 schedule 不会发送工作；Agent 会先创建、再启动，并通过 schedule 状态区分传输接收与精确完成证据。可选 Todo 完成门禁和冲突门禁只有在 worker 声明所需能力时才生效；未声明时不会协商这些门禁，精确关联报告仍是完成依据。

## 8. Monitor、Advisor 与 Observe 的区别

| 能力 | 对象 | 触发方式 | 主动操作 | 推荐用途 |
|------|------|----------|----------|----------|
| Monitor | 其他工作区窗口，以及 Monitor 拥有的本地或远端 worker | 根 Agent 操作；可选有界 prompt loop | 观察、发消息、创建、协调和回收 owned worker | 多窗口执行和跨会话协调 |
| Advisor | 当前主会话 | 回合/工具检查点 | 向当前 Agent 提供质量建议 | 推理与约束审查 |
| `observe` | Agent、命令、工作区窗口或远端任务 | 单次或有界等待/观察 | 无 | 状态和完成检查 |
| Goal verifier | Goal 完成结果 | 完成时 | 独立验证 | 验收审计 |

Advisor 与 Monitor 可以同时启用。Advisor 审查当前 Agent 的推理质量；Monitor 为根 Agent 提供协调其他 worker 的控制界面。Monitor 不会在后台独立判断 worker 的工作质量。

## 9. 排障

### 无法创建本地 Worker

1. 确认 `/monitor` 已启用；`workspace-window` 在 Monitor 模式外不可用；
2. 检查平台终端：Windows 使用 Windows Terminal，macOS 使用 Terminal，Linux 使用 `PI_TEAMMATE_TERMINAL` 或 `x-terminal-emulator`；
3. 确认 worker 名称有效，且未达到 managed-window 数量上限；
4. 注册超时时，确认新 Pi 窗口打开了同一工作区并加载当前扩展；
5. 让 Agent 列出 Monitor 拥有的窗口并检查生命周期状态。

### 找不到已有窗口

1. 确认它是同一工作区中的 Pi 根窗口；
2. 让 Agent 再次执行 `teammate-list({ view: "windows" })`；
3. 窗口重启后使用新发布的精确 owner 身份；
4. 用 `observe` 检查存活状态；仅有 inbox 历史不能证明窗口仍在运行。

### 消息没有明显效果

消息被接收不代表目标模型已经消费它。观察目标，并等待下一个 turn boundary 注入队列消息。只有新证据要求纠正或新增约束时才再次发送。

### 旧 Monitor 文件仍然存在

已删除评估运行时遗留的文件可能仍位于 `.pi` 下。根 Monitor 模式不会加载它们，因此它们不会产生作用。仅在正常仓库清理确有需要时手工删除；Monitor 不会自动清理这些文件。

## 10. 相关指南

- [Advisor 逐轮监督](/guides/advisor) — 当前会话的质量审查
- [Pi Cockpit 可视化](/guides/cockpit) — 工作区与会话视图
- [并行多智能体调度](/guides/teammate-dispatch) — 派发、跨会话消息和 `observe`
- [Goal 目标 · Plan 计划 · todo 任务](/guides/goal-plan-todo) — 完成与验收工作流
