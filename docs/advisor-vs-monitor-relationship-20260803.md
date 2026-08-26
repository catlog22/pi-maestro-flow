---
kind: analysis
---

# oh-my-pi Advisor（逐轮监督）与当前插件 Monitor 的关系

> 背景：分析 oh-my-pi（`G:\github_lib\oh-my-pi`，fork 自 Pi）的功能时，`advisor` 逐轮监督被列为插件扩展候选。本文基于两边源码，澄清它与插件当前 `/monitor` 根控制模式的关系：Advisor 审查当前主会话，Monitor 则由根 Agent 协调其他本地或远端 worker。二者对象不同，可以并存。
>
> 扩展阅读：三方（advisor/goal/monitor）统一性分析见 `docs/supervision-unification-analysis-20260803.md`。

## 1. 双方定位速览

| | oh-my-pi Advisor | pi-maestro-teammate Monitor |
|---|---|---|
| 实现 | `packages/coding-agent/src/advisor/*`（runtime/advise-tool/emission-guard/watchdog/transcript-recorder）+ `docs/advisor-watchdog.md` | `packages/pi-maestro-teammate/src/extension/monitor.ts`（根模式上下文与观察辅助）+ `extension/index.ts`（命令、本地/远端 worker 工具与跨会话路由）+ `extension/workspace-peers.ts`（工作区发现） |
| 一句话 | 挂在**主会话**上的第二模型，每轮结束后审查主 Agent 的推理并注入建议 | 把当前**根会话**切换成控制窗口，由根 Agent 观察、指挥和管理其他 worker |
| 对象 | 主 Agent 自己（当前会话） | 同工作区其他 Pi 根窗口、Monitor 创建的本地窗口和 SSH 远端任务 |
| 触发 | 事件驱动：每次 primary turn 结束 | 用户指令和根 Agent 工具调用；需要持续监督时可显式创建有界 prompt `loop` |

## 2. oh-my-pi Advisor（逐轮监督）机制要点

- **形态**：独立的第二模型（`modelRoles.advisor`），拥有自己的 `Agent` 实例、`-advisor` 后缀的独立 `ToolSession` 与**跨轮 append-only 上下文**（独立 promote/compact/re-prime）。不看主会话的 file snapshot/seen-lines/conflict 状态。
- **看到什么**：每轮只收新 transcript **增量**（`includeThinking: true` + tool intent），`plan-mode-context` 等注入约束按原样展开（XML 转义防逃逸），字节相同的重复注入去重为 `(unchanged)`；已注入的 advisory 不再回喂（防递归自审）。
- **如何输出**：`advise` 工具按严重度三档：
  - `nit`：不打断的旁注，在下一个 step boundary 批量入上下文；
  - `concern` / `blocker`：走 steering 通道打断，可在边界中止 in-flight 工具；
  - 统一渲染为 `<advisory severity="…" guidance="weigh, don't blindly obey">` 元素；主 Agent 系统提示不需要预先了解 advisory，标签本身提供解释。
- **守门（EmissionGuard）**：归一化去重（FIFO 4096）、空话过滤（`stop`/`lgtm` 等直接静默）、每轮最多 1 条、被压制的调用对模型不可见（仍回 `Recorded.`）。
- **频率控制**：`advisor.immuneTurns`（默认 3）；投递 concern/blocker 后，后续 N 轮降级为旁注。用户主动打断时不再自行恢复运行。
- **追赶**：`advisor.syncBacklog`（off/1/3/5）；主 Agent 最多等 30s 让 Advisor 追平积压，连续 3 次失败丢弃积压放行。
- **配置**：`WATCHDOG.md`（审查优先级清单）+ `WATCHDOG.yml`（多 Advisor 名册）。每项可独立指定 model/tools/instructions；工具默认只读 `read`/`grep`/`glob`。放宽到 `edit`/`write`/`bash` 等可变工具会绕过主 Agent 的审批链，需要明确的信任前提。
- **可观测性**：`__advisor.jsonl` 逐轮转写（归入 stats 用量与 Agent Hub）、`/advisor on|off|status|dump`。
- **边界**：Advisor **永远不是 peer**；它从 `irc` 名册、广播、`history://` 与协作聊天中排除，不可寻址、不可复活。
- **参考**：`docs/advisor-watchdog.md`；`src/advisor/runtime.ts`（537 行）、`emission-guard.ts`（172 行）、`transcript-recorder.ts`（159 行）。

## 3. 当前插件 Monitor 机制要点

- **形态**：`/monitor` 是用户控制的根模式，具有 enter/exit 生命周期和 `#control` 控制页。进入后，系统提示要求根 Agent 专注于协调，不在控制窗口中实现项目工作。
- **命令面**：保留 `/monitor`、`/monitor status`、`/monitor doctor`、`/monitor exit|stop` 和 `/monitor spawn ...`。`status` 显示当前会话拥有的本地/远端资源；`doctor` 只读报告模式、工具开放和可见资源。
- **已有本地窗口**：根 Agent 通过 `teammate-list({ view: "windows" })` 发现同工作区 Pi 根会话，以精确的 `owner:<ownerId>` 身份直接 `observe` 和 `teammate-send`。窗口被替换后必须重新发现，不能凭名称沿用旧身份。
- **新建本地窗口**：`workspace-window create` 默认打开交互终端，投递一次任务目标，并等待精确 workspace owner 注册。返回的 owner 可直接观察和发消息；completion handle 指向 worker 退出后仍可读取的不可变 `agent://` 结果。
- **所有权边界**：`workspace-window close` 只能回收当前 Monitor 会话创建的窗口。手工打开或由其他 Monitor 创建的 peer 只能观察和发消息，不能关闭。
- **远端任务**：`remote-worker` 在 SSH 握手、能力协商和所有权接纳成功后创建 `remote:<runId>`。远端任务以 `kind: "remote"` 观察，并由 `remote-worker close` 执行生命周期取消。
- **消息语义**：非紧急工作使用 `follow_up`，时效性纠正使用 `steer`。消息进入队列或被接收不代表模型已经消费；重复发送前要等待目标侧或状态变化证据。
- **持续监督**：单次查询使用有界 `observe`。用户明确要求持续监督时，根 Agent 先检查已有任务，再为完整目标集合创建一个有界 prompt `loop`；每次重新发现目标、批量观察、比较新证据，并只针对新问题干预。通用 loop 不由 `/monitor exit` 停止。
- **有序工作**：Flow Schedule 面向已有 managed workspace window，按精确关联报告推进稳定步骤。`workspace-window` 负责进程所有权，`observe` 负责状态，`teammate-send` 负责临时指令，`loop` 负责重复检查，Flow Schedule 负责有序派发。
- **遗留文件**：旧运行时留在 `.pi` 下的文件不会被根 Monitor 模式读取，也不会被自动删除。

## 4. 核心差异对比

| 维度 | Advisor（逐轮监督） | Monitor（根控制模式） |
|---|---|---|
| 对象 | **当前主 Agent** | **其他本地或远端 worker** |
| 控制者 | 独立第二模型 | 当前根 Agent，遵循用户在 `#control` 中的策略 |
| 触发 | primary turn 结束 | 用户指令、Agent 工具调用；持续需求可用有界 prompt `loop` |
| 输入 | transcript 增量，含 thinking/tool intent/注入约束 | `teammate-list`、`observe`、inbox、worker completion 和用户策略 |
| 判断重点 | 推理质量、约束遵循、幻觉和 API 误用 | 跨会话状态、任务协调、消息纠正和 worker 生命周期 |
| 操作载体 | `<advisory>` 注入；严重项走 steering | `observe`、`teammate-send`、`workspace-window`、`remote-worker`、Flow Schedule |
| 频率控制 | `immuneTurns` + EmissionGuard | 由根 Agent 按新证据决定；可选 loop 必须有界且覆盖完整目标集合 |
| 身份 | 永非 peer，不可寻址 | worker 是可寻址 workspace owner 或 `remote:<runId>` |
| 持久结果 | `__advisor.jsonl` 转写 | 本地 completion resource、跨窗口 inbox、远端结果或 Flow Schedule 精确报告，各自属于对应工具 |

## 5. 关系结论：对象不同、可以并存

Advisor 和 Monitor 都属于监督能力，但不是同一种运行机制：

- **Advisor = 当前会话质量审查**：第二模型读取主 Agent 的逐轮推理轨迹，指出方向、正确性或约束问题。
- **Monitor = 跨会话协调控制**：根 Agent 根据用户策略主动发现、观察、指挥和管理其他 worker；它本身不在后台独立评估 worker。

因此两者可以同时启用：Advisor 检查控制 Agent 的推理质量，Monitor 为该根 Agent 提供跨窗口和远端协调能力。Goal 完成验证、run-control 和 todo 则继续负责终点、Run 生命周期和任务状态，职责不需要合并。

## 6. 对插件扩展决策的启示

若后续实现或加强 Advisor 式逐轮监督（此前评分 Tier 3，适合从低频 `agent_end` 审查起步），应复用通用基础设施，但不要把它做成 Monitor 的隐式后台行为：

1. **复用消息与展示通道**：严重建议可以沿用现有 steering 和通知能力，但 Advisor 仍应保持独立身份与投递规则。
2. **模型调用走 teammate 路由**：使用现有模型路由 Profile，而不是新建 provider 调用链。
3. **保持上下文隔离**：Advisor 需要独立上下文、压缩和重置语义，不能把 worker 观察状态混入逐轮审查记忆。
4. **保留 Monitor 所有权边界**：Advisor 不应获得 `workspace-window` 或 `remote-worker` 生命周期权限；这些能力只属于用户启用的根 Monitor 控制模式。
5. **持续监督必须显式**：跨会话重复检查应由用户意图驱动并通过有界 prompt `loop` 表达，不能重新引入隐藏的评估运行时。

## 7. 结论

- **Advisor**：当前主会话的逐轮质量审查。
- **Monitor**：根 Agent 操作的跨会话协调与 worker 生命周期控制模式。
- **共同使用**：Advisor 可审查控制 Agent，Monitor 可协调其他 worker；二者对象与权限边界清晰。
- **Advisor 优先级**：该能力仍是价值 3/5、受成本与延迟约束的较低优先级扩展，适合从低频审查开始。
- **实现原则**：保持 Advisor 的独立模型语义，保持 Monitor 的显式根控制语义，持续工作通过现有 `loop` 和 Flow Schedule 等工具表达。
