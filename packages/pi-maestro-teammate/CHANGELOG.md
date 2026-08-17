# Changelog

## 1.14.0

### 行为变化（Breaking）

- **远端 journal 格式 `REMOTE_JOURNAL_VERSION` 1 → 2，不提供迁移代码。** worker 标识、run 记录、command 记录三处版本硬拒同时指名记录版本与本守护进程版本；持久化的 `capabilities` 字段一并移除。守护进程读到 v1 的 `worker.json` 时在构造函数里直接抛错，`markInterruptedRunsLost` 尚未执行，旧数据一个字节都不会被改写。

### 修复

- **隔离不再无声**：`RemoteRunJournal` 构造函数接受可选的 `onQuarantine(directory, error)`，在 run 目录被移进 `corrupt-runs/` 之后触发；`RemoteBridgeServer` 自建 journal 时默认把它接到守护进程的 stderr，写一行点名被隔离的 run 目录与条件它的错误（含 cause，用以区分记录版本过期与写入截断）。`pi-teammate-remote serve` 不传 journal，走的正是这条默认路径，所以发布出去的守护进程也不再静默隔离。回调抛出的异常被吞掉——隔离发生在 `getRun` / `listRuns` 的错误恢复路径上，此时 rename 与两次 fsync 已经落盘，观测失败既不能把恢复变成崩溃，也无法回退隔离。
- **v1 拒绝消息点名整个状态目录**并给出正确补救动作，而不是只点名 `worker.json`。旧文本会诱导操作员删掉标识文件：守护进程随即在旧目录上启动，其余 v1 run 记录被逐条移进 `corrupt-runs/`，宿主 run/attach 撞上的是与真因无关的 `-32003 Remote run ownership capture mismatch`。

- **v1 守护进程的握手拒绝被诊断为版本偏斜**。`remote/1` 守护进程在自己的版本检查之前就先做参数校验，因缺少 `capabilities` 数组以 `-32602 Invalid capabilities` 拒绝 `remote/2` 握手，操作员原本只拿到这句话。现在 `-32602 + capabilities` 与 `-32002` 一起读作版本偏斜，消息点名本地的 `remote/2`、对端疑似的 `remote/1`、目标主机与补救动作。判据是选择性的：握手 catch 同样看得到请求超时、传输故障、`Remote worker manager closed during setup` 与 `validateHello` 拒绝，这些原对象原样透传，不加诊断。

- **`modelSelection` 声明为 unsupported 的后端不再触发模型 failover**。省下的不是远端进程也不是 token——后续候选一个都不会启动，本就不花。省下的是诊断：每个后续候选都带显式模型，能力裁决会在启动前拒掉它，而那条「关于从未运行的候选」的拒绝会顶掉本次运行自己观测到的失败。该分支只在调用方没点名模型时可达（调用方点名时第一个候选就带模型，整个任务在能力门被当场拒绝），恰是那些有真实 provider 诊断值得保住的运行。被拦下的 failover 以 `capabilityDeliveries` 的 `modelSelection: withheld` 记录，结果因此与「无候选可试」区分得开。

- **远端 reclamation 区分「流结束但通道还在」与「通道断了」**。`wait` 正常返回终态快照、而事件流里始终没有 `run/result` 时，理由不再声称连接断开——那条通道从未断过。两种形态与「远端自报 run lost」共三条理由各自独立，操作员据此知道该查传输还是查远端运行时。

### 更正 be0871e6 记录的前提

be0871e6 以「本 fork 不发布包」为「不写迁移代码」作论据，该前提不成立：

- `pi-maestro-teammate` 是已发布包——`package.json` 无 `private: true`，声明了 `exports`、`files` 与 `bin`（`pi-teammate-remote`），版本 1.14.0。
- 远端 journal 默认落在 `~/.pi/agent/remote`（可由 `PI_TEAMMATE_REMOTE_STATE_DIR` 覆盖），属于远端主机而非宿主仓库，不随宿主一起升级。
- upstream 1.14.0 的发布早于本 fork 的版本 bump 约 15 小时，远端主机上完全可能存在 upstream 守护进程写下的 v1 journal。

决策本身不变：仍然拒绝启动而不是写迁移代码——半懂旧格式的风险高于拒绝启动，且拒绝发生在任何写入之前。变的是论据与操作员看到的补救文本。

### 操作员补救步骤

守护进程报 `Unsupported remote worker identity version 1` 时：

1. 停掉远端的 `pi-teammate-remote serve`。
2. 整体移走或备份状态目录（默认 `~/.pi/agent/remote`，或 `PI_TEAMMATE_REMOTE_STATE_DIR` 指向的目录），例如 `mv ~/.pi/agent/remote ~/.pi/agent/remote.v1.bak`。
3. 重新启动 serve；新的 v2 目录从空开始，备份里保留着全部 v1 证据。

不要只删 `worker.json`：守护进程会在旧目录上启动，其余 v1 run 记录逐条进 `corrupt-runs/`，故障现场变成一个与真因无关的所有权错配错误。

## 1.0.0

### Breaking

- Public `teammate` and programmatic `runTeammate` calls now require a non-empty `tasks[]`; one task represents single-agent work.
- `tasks[].prompt` is the only task text and is always literal. Removed `task`, `promptArgs`, top-level `prompt`, `chain`, prompt discovery, bundled prompt templates, and `./v1/prompts`.
- Built-in roles are `general`, `explorer`, `planner`, `analyst`, `research`, `verifier`, and `workflow`. The dedicated `verifier` is the Goal fallback when no acceptance commands are declared. Removed the built-in `delegate`, `goal-verifier`, and `coordinator` names.
- Public parameter objects reject unknown fields.

### Added

- Top-level role, task type, model, thinking, context, cwd, output schema, and timeout values act as task defaults with per-task overrides.
- Custom role YAML accepts built-in or custom `taskType` identifiers; the Control Center discovers them automatically. Explicit task/top-level values override role metadata, followed by role-name or prompt inference.
- The `research` role can query Maestro project/architecture knowledge through `maestro search/load` and external sources through `smart_search`/`source_check`.
- End-to-end task model and thinking propagation is covered through proxy parsing, normalization, DAG execution, and child CLI arguments.
- Custom role YAML tool lists are normalized into executable Pi tool IDs.

### Changed

- Goal completion verification uses the read-only `analyst` role with an explicit fail-closed verification policy and structured verdict contract.
- `runTeammate` is the tasks-only public programmatic entry; the single-subprocess primitive is internal.

## 0.5.0 (2026-07-25)

### 行为变化（Breaking）

- **`background` 默认值由 `true` 翻转为 `false`（前台/阻塞）**：此前省略 `background` 时单任务与多任务均在后台运行（先回 ack，稍后 teammate-complete 通知）；现在默认前台阻塞直到完成并直接返回结果。需要后台运行必须显式传 `background: true`。
  - 动机：多数调用方需要子结果后才能继续，后台默认导致"省略 background 却拿到 ack 而非结果"的脚枪。翻转后与系统提示词中所有示例（均传 `background: false`）的语义一致。
  - 实现：默认在共享的 `normalizeTeammateParams()` 单点解析（`params.background = params.background === true`），root execute 与子进程 proxy 两条派发路径共享同一默认；所有 `=== false` / `!== false` 分支逻辑与源匹配测试保持不变。
  - 同步更新：schema `default: false` 及描述、TUI 渲染（`isBg = args.background === true`，省略时显示为前台 "Alt+B to detach"）、`TEAMMATE_PROMPT_GUIDELINES` 指引、`.pi/SYSTEM.md` 散文。

### 测试

- `test/normalize.test.ts` 新增 3 个用例：`background` 省略解析为 `false`、`true` 保留、`false` 保留。

## 0.4.4 (2026-07-15)

Teammate 工具审计修复（详见 `docs/teammate-tool-fix-plan.md`）。

### 修复

- **reply_to 死锁检测死代码移除**：原检测条件在 schema 枚举约束下永不生效，且命中路径声称 fallback 却不派发 agent。整段移除（`detectReplyCycle` 及调用点）。
- **`{name}` 未知引用不再静默降级**：与现有任务名编辑距离相近的引用视为拼写错误，派发前报错；其余未知引用按字面文本传递并返回 `[warn]` 警告。原 `runGraph` 中不可达的 unknown-name throw 被真正的派发前校验取代。
- **normalize 逻辑统一**：根路径 `execute` 与子进程代理路径 `handleProxyRequest` 的任务归一化收敛为共享的 `normalizeTeammateParams()`，消除两份实现的漂移（含错误消息不一致）。
- **代理路径 teammate-send 寻址对齐**：与根路径一致，支持名称 / correlation ID / 唯一前缀（原来只认名称）。

### 行为变化（Breaking）

- **多任务模式 `context: "fork"` 现在真正生效**：此前被静默丢弃（全部 fresh）。现在顶层 `context` 作为所有任务的默认值、per-task 可覆盖——fork N 个任务会复制 N 份父会话，注意 token 成本。
- **空任务派发前报错**：单任务模式 `task`/`prompt` 均缺失、或多任务中某任务两者均缺失时，返回错误而非空跑。
- **`tasks` 优先于已废弃的 `chain`**：两者同给时此前 chain 生效，现在 tasks 生效并对 chain 发出弃用警告。任何 chain 使用都会收到弃用警告；chain 将在后续 minor 版本移除。
- **`protocol_version` 从对外 schema 移除**：运行时仍兼容旧调用方传入（TypeBox 默认允许未知属性），`resolveReplyTo` 逻辑不变。

### 新增

- **`dependsOn` 显式依赖**（TaskSpec）：与 `{name}` 引用推导取并集构成依赖边，适合只需顺序、无需注入输出的场景；未知任务名严格报错。`inferGraphMode`、进度树、`runGraph` 统一经 `taskDependencyNames()` 计算依赖。
- **TaskSpec 级 `context` 覆盖**：单个任务可独立选择 `fresh`/`fork`。
- **teammate-send `message` 对 `abort` 可选**；`mode` 默认值（`follow_up`）与寻址规则写入 schema 描述。
- 多任务顶层 `agent`/`task` 被忽略、`promptArgs` 缺 `prompt` 等情况现在返回 `[warn]` 警告。

### 测试

- 新增 `test/normalize.test.ts`（18 个用例）：模式选择、fail-fast、默认值下沉、chain 弃用优先级、拼写检测/字面量区分、dependsOn、context 透传。
- `graph-status-and-structured-output.test.ts` 的 normalize 守护测试改为断言共享实现（防止重复被重新引入）。
