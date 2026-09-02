# Changelog

## 2.3.0

### Teammate model routing templates

- Existing v3 routing Profiles are now documented as the saved-template system: multiple named configurations remain global, while each project persists its active template and preserved compatibility overrides.
- Added `/teammate-model [profile-id-or-name]` with completion for direct project switching. `/teammate-model` without arguments opens the Control Center on **Profiles**; `/teammate-models` and `Alt+M` continue to open the full control center.
- Added public list, resolve, and atomic activate helpers for Profile/template consumers. Name matching is case-insensitive, stable IDs win, and duplicate display names fail closed with the candidate IDs.
- Managed SSH host references preserve the OpenSSH default port without materializing an inline override; runtime-broker mailbox recovery exposes awaitable client prewarm for deterministic startup ordering.

### Session history and durable resources

- Added bounded host-authorized session history inventory and `session://` entry reads for exact, visible active-chain entries; thinking, hidden rows, abandoned branches, and tool arguments remain excluded.



### pi-teammate-models CLI 与 DSH 直连 SSH（新增）

- 新增独立 CLI `pi-teammate-models`（`list`/`path`/`edit`/`add`）：`list` 用与运行时相同的 parser 静态编译路由表，不加载任何 backend 模块；`edit` 按声明字段逐项编辑部署配置；`add` 引导完成 家族 → 传输变体 → 唯一部署 id → 类型校验字段（空输入应用默认值，credential-ref 只收变量名）→ 模型注册。写入前整份候选 manifest 重新编译，编号的编译错误（重复 selector、争夺部署默认、selector/拓扑不匹配）全部列出并重新提示；确认后走统一的验证 + 备份轮换 + 原子发布写路径。
- 并发语义为文档化的后写入者胜：发布前重读文件，外部修改以脱敏 diff 展示并需显式确认（`--yes` 可预确认）。每次写入轮换 `<file>.bak` / `<file>.bak.1`，撤销即 `cp <file>.bak <file>`。支持 `--file` 替代路径与 `--locale en|zh-CN`。legacy/backend-registry 文档渲染计算出的 v2 升级骨架且绝不写入；唯一出口是 `[E] 显式写出升级副本`（写到 `<file>.upgraded.json`），默认 `[A] 中止`。
- DSH 后端新增 `mode: "ssh"` 直连传输：通过 OpenSSH 在远端主机启动运行时（远端要求 POSIX shell）。`host`/`user` 在 ssh 下必填，可选 `port`、`identityFile`（附带 `IdentitiesOnly`）、`hostKeySha256` 指纹预检固定（启动前 `ssh-keyscan` 对照，非握手时验证）。认证走 `BatchMode=yes` + `StrictHostKeyChecking=yes`，永不提示；`envPassthrough` 以尽力而为的 `SetEnv` 转发（受远端 `AcceptEnv` 限制）；`todoBridge` 与 `mode: ssh` 互斥并在加载时拒绝；`requestTimeoutMs` 按单个 JSON-RPC 请求计，低于 300000 时给出告警。`cordisConfig`/`cwd` 为远端路径，仅做形态校验、不验证存在性。

### Control Center Connections tab（新增）

- Teammate Control Center 新增单一 **Connections**（zh-CN：**连接**）tab，把 v2 model-registry 部署的列表/编辑/新增嵌入现有 worker hosts/targets 视图；稳定 tab 顺序、统一筛选列表、窄屏降级及原有 host/target 命令与快捷键保持不变，部署不提供 TUI 删除操作。
- TUI 与 CLI 共享声明式字段表单和部署/注册向导；字段校验失败在当前字段就地重新提示，整份 manifest 编译失败则显示编号错误并重新提示对应注册区块。部署写入复用同一 D12 发布管线，包括 parser 校验、外部修改确认、`.bak`/`.bak.1` 轮换与原子发布。
- legacy/backend-registry 文档在 Connections tab 中进入显式升级预览流程，确认后只以排他创建方式写出 `<file>.upgraded.json`，不修改原文档；保存后重新加载 model catalog 并返回 Connections tab。

### model-registry v2（新增模式）

- 新增显式 `version: 2` + `mode: "model-registry"` manifest：`backends` 定义部署，`models` 定义 canonical 模型注册，`defaultModel` 必须指向默认部署上唯一的 `deploymentDefault` 注册。Pi、DSH、ACP、remote-worker 的 harness/transport/selector 拓扑由同一份投影编译，调度与目录共享 revision/hash 身份。
- DSH 模型选择现在可在 manifest 中明确写成 `adapter-model` selector；teammate 的 `model` 选择注册 id，而 DSH 接收 selector value。`remote-workers` 使用 `fixed`，仅在当前 root Monitor session 中可选。
- `model-availability` 保留旧输出字段，并新增无密钥的注册身份/拓扑与 `registered`、`resolvable`、`sessionAvailable`、`healthy` 四道门。Monitor 外的远端路由不再从诊断中消失，而是以确定性原因保留；backend config、命令、SSH target、selector 与凭据值不对外输出。
- CLI 兼容投影必须由 `compatibility.teammateCliToolsProjection.enabled` 显式开启，且一个 `cli/<tool>` 必须恰好由一个 ACP 部署拥有；`teammate-cli-tools.json` 只提供兼容目录输入，不恢复启动权威。
- Flow Settings 按 document key 与 module 精确匹配自定义部署，只修改目标 config path；round-trip 保留 `version`、`defaultModel`、`models`、`compatibility`、未知第三方部署/配置/顶层字段，并继续使用 etag CAS 与仓库外凭据文件。没有新增模型注册编辑器。
- 迁移：备份原文件，保留部署 id/config，加入 v2 字段与显式模型注册，reload extension 后检查四道门。回滚只改 `mode` 为 `backend-registry` 或 `legacy` 并 reload；保留 v2-only 区段只是 round-trip 保留，不保证有效重进，严格 v2 parser 仍可能拒绝不支持或未知的字段。旧模式读缓存直到 invalidation，model-registry 激活后则按语义 revision 刷新。
- 已知限制保持不变：task 级 `timeoutMs` 在 `backend-registry` 与 `model-registry` 都不会进入 `TeammateRunSpec`，也没有 host watchdog；需使用部署级超时（如 ACP `runTimeoutMs`）。

> 下方“迁移两步”是 2.0.0 最初引入 **旧 `backend-registry` 模式**时的历史记录，原文保留；它不是 model-registry v2 的完整迁移说明。

### 行为变化（Breaking）

- **`cli/<tool>` 只能由 `.pi/teammate-backends.json` 里的注册项派发，不再从 `teammate-cli-tools.json` 单独起跑。** 该文件缺失或仍是 legacy 模式时，任何 `cli/<tool>` 任务被当场拒绝而不再回落到 pi 子进程；模型 id 里的工具名即注册名，注册表按名字找不到就按名字报错。升级前只靠 `teammate-cli-tools.json` 跑 `cli/gemini` 的部署会在升级后停止派发。

  迁移两步：

  1. 把 `.pi/teammate-backends.json` 改成 `"mode": "backend-registry"`（缺省仍是 `legacy`，写了注册项本身不改变任何行为，开关是这一处显式编辑）。
  2. 每个要跑的 CLI 工具加一条注册项，`module` 指向通用 ACP-CLI 后端，`command` 等启动字段从 `teammate-cli-tools.json` 搬进 `config`：

  ```json
  {
    "mode": "backend-registry",
    "default": "pi-subprocess",
    "backends": {
      "gemini": {
        "module": "pi-maestro-teammate/v1/acp-cli",
        "config": { "command": "gemini", "args": ["--acp"], "modelId": "cli/gemini" }
      }
    }
  }
  ```

  两个文件的分工从此是：注册项决定 `cli/<tool>` **能不能跑**，`teammate-cli-tools.json` 决定它 **出不出现在模型选择器里**，各自充要、互不代替。因此 `teammate-cli-tools.json` 里的 `enabled: false` 不再阻止一个已注册工具执行——它只把工具从目录里摘掉。完整契约见 [docs/teammate-backend-adapter-contract.md](../../docs/teammate-backend-adapter-contract.md)。

- **远端 journal 格式 `REMOTE_JOURNAL_VERSION` 1 → 2，不提供迁移代码。** worker 标识、run 记录、command 记录三处版本硬拒同时指名记录版本与本守护进程版本；持久化的 `capabilities` 字段一并移除。守护进程读到 v1 的 `worker.json` 时在构造函数里直接抛错，`markInterruptedRunsLost` 尚未执行，旧数据一个字节都不会被改写。

### 操作员补救步骤（远端 journal）

守护进程报 `Unsupported remote worker identity version 1` 时：

1. 停掉远端的 `pi-teammate-remote serve`。
2. 整体移走或备份状态目录（默认 `~/.pi/agent/remote`，或 `PI_TEAMMATE_REMOTE_STATE_DIR` 指向的目录），例如 `mv ~/.pi/agent/remote ~/.pi/agent/remote.v1.bak`。
3. 重新启动 serve；新的 v2 目录从空开始，备份里保留着全部 v1 证据。

不要只删 `worker.json`：守护进程会在旧目录上启动，其余 v1 run 记录逐条进 `corrupt-runs/`，故障现场变成一个与真因无关的所有权错配错误。

## 1.14.0

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
