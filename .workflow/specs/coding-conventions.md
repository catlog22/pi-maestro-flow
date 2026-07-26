---
title: "Coding Conventions"
readMode: required
priority: high
category: coding
keywords:
  - style
  - naming
  - import
  - pattern
  - convention
  - formatting
---

# Coding Conventions

## Formatting

## Naming

## Imports

## Patterns

## Entries



<spec-entry category="coding" keywords="plan,hooks,chain,tool_call" date="2026-07-08" sid="S-20260708-40gp" title="Pi Plan Mode — hook 链式调用模式" source="master@709f5b7">

### Pi Plan Mode — hook 链式调用模式

plan hooks 在 index.ts 中与 goal hooks 链式调用: tool_call 中 plan 先拦截再 goal; before_agent_start 中 plan 先注入 systemPrompt 再传给 goal; agent_end 中 plan 先捕获文本再 goal 异步处理。plan 的 tool_call 返回 block 时直接 return，不再调用 goal。

</spec-entry>

<spec-entry category="coding" keywords="plan,bash,safety,patterns" date="2026-07-08" sid="S-20260708-5489" title="Pi Plan Mode — bash 命令安全过滤" source="master@709f5b7">

### Pi Plan Mode — bash 命令安全过滤

Plan 模式下 bash 工具本身允许（PLAN_ALLOWED_TOOLS），但通过 MUTATING_BASH_PATTERNS 和 SAFE_BASH_PATTERNS 双重 pattern 过滤具体命令。先检查是否匹配 mutating pattern（阻止），再检查是否匹配 safe pattern（放行），不匹配任何 pattern 默认阻止。参考 pi-extensions/pi-plan-mode 的 isSafeCommand 模式。

</spec-entry>

<spec-entry category="coding" keywords="todo,state-version,migration,contract-test" date="2026-07-10" sid="S-20260710-wz12" title="持久化 todo contract 的版本化迁移模式" description="通过版本化 read-boundary normalization 防止持久化任务字段漂移" source="planex-odyssey">

### 持久化 todo contract 的版本化迁移模式

Todo public schema 与 runtime model MUST 共享单一 canonical contract。持久化 shape 变化时 MUST 写入 state version，并在 read boundary 将 legacy inject/injection/load/completion 归一化为新模型；update MUST 区分 omitted、empty 与 null，且 focused tests MUST 覆盖 preserve、replace、clear 和 legacy migration。

</spec-entry>

<spec-entry category="coding" keywords="plan,approval,manifest,pending,lock,heartbeat,quarantine,transaction" date="2026-07-11" sid="S-20260711-zekz" title="Pi Plan Mode — Durable approval transaction pattern" description="可复用的 Plan 持久化批准事务与 lease lock 模式" source="planex:plan-mode-lifecycle">

### Pi Plan Mode — Durable approval transaction pattern

Durable Plan approval uses four ordered boundaries: save the exact draft under revision CAS; write an approval.pending.json marker; atomically write the immutable archive; commit manifest.json last. Before manifest commit, failure may remove the pending archive. After manifest commit, cleanup is best-effort and must never roll back committed history. Recovery strictly validates the complete manifest and archive checksum/path invariant, quarantines interrupted or invalid pending transactions, and rebuilds history by revision rather than timestamp. Cross-process workspace mutation uses owner token, PID/liveness, heartbeat, token-specific stale takeover, ownership checks before mutation and owner-only release.

</spec-entry>

<spec-entry category="coding" keywords="tui input paste visiblewidth width-matrix" date="2026-07-14" sid="S-20260714-t5qv" title="TUI Paste 输入与可见宽度矩阵" description="终端输入和宽度测试的可复用实现规则" source="master@4d76db9">

### TUI Paste 输入与可见宽度矩阵

自由文本 TUI 输入 MUST 接受 printable multi-character 与 paste，不得仅处理 data.length===1。宽度验证 MUST 使用 visibleWidth 而非字符串 length，并覆盖 1..120 列的 runtime matrix。

</spec-entry>

<spec-entry category="coding" keywords="thinking-depth routing-migration cli-boundary task-normalization teammate" date="2026-07-14" sid="S-20260714-1g63" title="Teammate thinking depth 全链路参数模式" description="Teammate thinking 参数跨 schema、routing、frontmatter、normalization 和 CLI 的统一优先级与迁移规则" source="odyssey-planex:20260714-002-odyssey-planex">

### Teammate thinking depth 全链路参数模式

Teammate 的多层运行参数必须复用单一 canonical enum，并在 tool schema、task normalization、taskType routing、agent frontmatter 与 child CLI boundary 保持同一类型。thinking 优先级固定为 per-task > top-level > taskType mapping > agent frontmatter > Pi default；CLI 仅在解析到值时从单一位置追加一次 --thinking。持久化 routing shape 升级时使用新 version 并将 thinkingLevels 与 model mappings 独立保存，读取边界兼容旧 string/null mappings，测试必须覆盖无损迁移、inherit null、保存失败重试、root/proxy 与 tasks/chain 传播。

</spec-entry>

<spec-entry category="coding" keywords="generation owner-identity single-flight lifecycle late-cleanup" date="2026-07-14" sid="S-20260714-hkwb" title="Generation-owned async resource cache" description="异步资源缓存使用 generation 与 owner identity 防止 shutdown/restart 后旧回调污染新代状态" source="planex:20260714-001-odyssey-planex">

### Generation-owned async resource cache

缓存 Promise 或可复用进程、浏览器资源时，创建方必须携带 generation 或 owner identity。then、catch、close callback 写共享 map 前必须确认仍持有当前 key；shutdown 顺序固定为 fencing 旧 lifecycle、清理可见 registry、取消并等待 in-flight work、回收 late resource。相同 key 的并发创建使用 single-flight reservation，旧代完成不得删除或覆盖新代资源。

</spec-entry>

<spec-entry category="coding" keywords="workspace-edit transaction multi-provider rollback rename" date="2026-07-14" sid="S-20260714-jboa" title="Collect-validate-commit workspace transaction" description="多 provider WorkspaceEdit 先收集校验，再与文件操作一次原子提交" source="planex:20260714-001-odyssey-planex">

### Collect-validate-commit workspace transaction

当多个 Language Server 或 provider 为一次文件操作返回 WorkspaceEdit 时，必须先收集全部响应，拒绝除明确 MethodNotFound 之外的错误，统一校验 URI、range、workspace 边界和操作顺序，再把引用编辑与最终 file rename 作为一次可回滚事务提交。禁止逐 provider 边请求边写入，以免后续失败留下部分修改。

</spec-entry>

<spec-entry category="coding" keywords="teammate,normalize,normalizeteammateparams,drift" date="2026-07-15" sid="S-20260715-o48y" title="teammate 参数归一化单一实现约束" description="teammate 归一化逻辑必须走共享 normalizeTeammateParams，禁止双路径内联重写" source="master@19a9519">

### teammate 参数归一化单一实现约束

teammate 工具的参数归一化（单/多任务/chain 判定、顶层默认值下沉、空任务校验、{name}/dependsOn 引用校验）必须且只能通过 packages/pi-maestro-teammate/src/runs/execution.ts 的 normalizeTeammateParams() 完成。禁止在 extension/index.ts 的 root execute 或 handleProxyRequest 内联重写归一化逻辑——历史上两份内联实现产生过漂移（含错误消息不一致、chain 默认值合并差异）。守护测试：test/graph-status-and-structured-output.test.ts 以源码正则断言两条路径均调用 normalizeTeammateParams 且不含内联 thinking 解析；行为测试见 test/normalize.test.ts。新增归一化规则时改共享函数并补 normalize.test.ts 用例。

</spec-entry>

<spec-entry category="coding" keywords="swarm,skill-runtime,事件投影,teammate,收敛" date="2026-07-16" sid="S-20260716-fcl4" title="Swarm Skill-runtime 权威边界" description="约束 Swarm Skill 动态编排、native runtime 执行与 dashboard 权威事件投影的职责边界" source="master@4e656d72" status="deprecated" superseded-by="S-20260717-uzgd">

### Swarm Skill-runtime 权威边界

内置 /swarm MUST 只负责激活 bundled swarm Skill 并打开观察面。Skill coordinator MUST 根据当前 objective 与 live teammate catalog 动态编译 dimensions、roles、taskType、missions 和 Prompt；native swarm_runtime MUST 只负责计划校验、teammate dispatch、ACO 数值计算、产物持久化与权威事件。Dashboard 与主消息流 MUST 仅投影 skill_phase、role_bound、prompt_compiled、teammate/tool delta、convergence_decision 和 artifact_produced 等真实事件，MUST NOT 推测阶段或收敛状态。未知 role 或 Prompt 必须 fail closed。验证至少覆盖定向测试、check:types、npm pack 和 fresh Pi 命令/Skill 发现。

</spec-entry>

<spec-entry category="coding" keywords="swarm private-ant role-binding catalog teammate" date="2026-07-17" sid="S-20260717-uzgd" title="Swarm 私有 Ant 与动态评审角色边界" description="固定 Ant 为不可公开选择的系统内建角色，仅 Judge/Analyst 由 Skill 从 live catalog 动态绑定" source="master@3b0379dd" supersedes="S-20260716-fcl4" status="deprecated" superseded-by="S-20260718-mn6g">

### Swarm 私有 Ant 与动态评审角色边界

内置 /swarm MUST 只激活 bundled swarm Skill 与观察面。swarm-ant MUST 是 runtime-private builtin：MUST NOT 出现在 live teammate catalog、teammate-list、父级 agent prompt 或普通 teammate dispatch 中，且项目/用户定义 MUST NOT 覆盖。Swarm plan MUST 仅从 live catalog 动态绑定 judge 与 analyst；Ant contract MUST 仅动态编译 taskType、mission、Prompt、证据和输出要求，不得包含 agent selector。native swarm_runtime MUST 固定加载私有 swarm-ant，并通过内部 capability dispatch；私有定义缺失时 fail closed，禁止回退到公开角色。Dashboard 仅投影真实 role_bound 与执行事件。验证至少覆盖 catalog 隐藏、直接 dispatch 拒绝、内部 dispatch、定向测试、check:types、npm pack 和 fresh Pi 命令/Skill 发现。

</spec-entry>

<spec-entry category="coding" keywords="swarm,manual-invocation,skill-runtime,sendusermessage,observability" date="2026-07-18" sid="S-20260718-mn6g" title="Swarm 手动 Skill 调用与观察面边界" description="约束 Swarm 由用户手动调用 Skill，/swarm 仅准备配置与观察面" source="master@6499957e" supersedes="S-20260717-uzgd" status="deprecated" superseded-by="S-20260718-nikf">

### Swarm 手动 Skill 调用与观察面边界

用户 MUST 手动执行 /skill:swarm <objective>、/skill:swarm resume 或 /skill:swarm continue；Extension MUST NOT 通过 sendUserMessage 自动注入 /skill:swarm。/swarm <options> <objective> MAY 仅准备自定义 controller 配置与观察面并提示等价手动命令；直接 /skill:swarm 使用 runtime 默认配置。swarm Skill 继续负责编译动态计划，swarm_runtime 继续负责校验、调度、ACO、产物和权威事件。

</spec-entry>

<spec-entry category="coding" keywords="team-swarm,json-projection,swarm-runtime,read-only,observability" date="2026-07-18" sid="S-20260718-nikf" title="Team Swarm 单一执行权与 JSON 只读投影边界" description="规定 team-swarm 独占执行，Maestro Flow 仅从 canonical JSON 提取只读显示" source="master@6499957e" supersedes="S-20260718-mn6g">

### Team Swarm 单一执行权与 JSON 只读投影边界

用户 MUST 通过 /skill:team-swarm <objective>、resume 或 continue 启动和恢复 Swarm；team-swarm coordinator 与 scripts/aco.py 是 worker dispatch、评分、pheromone、收敛和产物的唯一执行权威。Maestro Flow MUST NOT 注册 /swarm extension command、swarm_runtime tool，或维护 native Swarm controller、engine、private Ant 与独立 schema。Flow MAY 从最新 {run_dir}/work/team/team-session.json、swarm-config.json、task-space.json、pheromone/*.json、trails/*.jsonl、best.json 及 {run_dir}/outputs/swarm-report.json、best-solution.md 做 fail-soft 只读投影，用于 statusline 和 overlay；投影 MUST NOT 写入状态、推测 teammate live delta 或改变 team-swarm 生命周期。可保留未注册的 /swarm status|inspect 兼容入口，但只能读取并展示 JSON。验证至少覆盖定向测试、check:types、package resources、npm pack dry-run 以及仓库外 fresh Pi 的 command/Skill 发现。

</spec-entry>

<spec-entry category="coding" keywords="context-transform compaction prompt-cache auto-prune" date="2026-07-22" sid="S-20260722-zng4" title="Context transform 裁剪必须跨 turn 稳定" description="防止非持久裁剪恢复原文并反复击穿 prompt cache" source="master@5337efc8">

### Context transform 裁剪必须跨 turn 稳定

对 provider 发送的非持久 context transform 一旦裁剪历史，必须在同一 compaction epoch 持续应用相同 replacement。最新 provider usage 已包含旧裁剪，只能扣除本轮新增节省；在 session compaction 或 reset 时清理裁剪 manifest。

</spec-entry>

<spec-entry category="coding" keywords="mcp enabled tui" date="2026-07-23" sid="S-20260723-k228" title="MCP 服务开关的加载边界" description="管理态与运行态分离，保证停用服务可见且不参与运行时加载。" source="master@ac980ed6">

### MCP 服务开关的加载边界

MCP 服务管理必须从完整配置读取，以显示 enabled: false 的服务；运行时必须通过 loadMcpConfig 过滤 enabled: false，确保停用服务不会连接或注册工具。完整 JSON 编辑器应写入 Pi 用户级配置并在当前界面保留保存结果。

</spec-entry>

<spec-entry category="coding" keywords="skill tui disable-model-invocation group" date="2026-07-23" sid="S-20260723-pju8" title="Skill 管理的加载与调用边界" description="约束 Skill TUI、native resource 加载和模型调用权限的一致性" source="master@6a8cac5a">

### Skill 管理的加载与调用边界

Skill 管理 TUI 必须从 Pi DefaultPackageManager 的完整 ResolvedResource 列表读取，使 disabled Skill 仍可见；加载开关必须写入 Pi SettingsManager resource override 并在 reload 后从 native ResourceLoader 排除。disable-model-invocation 必须同时从系统提示的 available_skills 隐藏并拒绝新的 Todo 工具激活，但允许已有 Skill activation 恢复。未加入自定义组的 Skill 按名称首个连字符前缀自动分组，组级开关批量复用单项持久化边界。

</spec-entry>

<spec-entry category="coding" keywords="compaction,tui,threshold,reservetokens" date="2026-07-23" sid="S-20260723-dqb7" title="派生阈值 TUI 直接编辑与底层映射" description="压缩阈值直接编辑并保持 Pi 配置兼容" source="run:20260723-001-maestro-impeccable">

### 派生阈值 TUI 直接编辑与底层映射

当用户目标是修改压缩阈值，而持久化格式仅提供 reserveTokens 时，TUI 必须优先展示并直接编辑 thresholdTokens = contextWindow - reserveTokens，确认后再换算回 reserveTokens；不得新增重复的 thresholdTokens 配置字段。缺少有效 contextWindow 时，界面必须明确降级为编辑预留输出空间。

</spec-entry>

<spec-entry category="coding" keywords="compaction,token-estimate,graduated-eviction,cache" date="2026-07-24" sid="S-20260724-xmqe" title="压缩 token 估算应内容感知且分级驱逐" source="master@d8c8ca96">

### 压缩 token 估算应内容感知且分级驱逐

对话压缩的 token 估算不应使用扁平 length/4：fenced code 约 3.5 chars/token（token 密集），whitespace 占比>0.3 的日志/表格约 6 chars/token（token 稀疏），普通内容保持 /4 默认。驱逐应分级（cheapest-first）：先剪可重放工具(read/grep/glob/search/find)，压力持续再剪 bulk 数据工具(bash/shell/edit/write)；两级都走缓存稳定 prune manifest。

</spec-entry>

<spec-entry category="coding" keywords="sanitize,truncation,storage-key,collision,injective,hash-suffix,safetoken" date="2026-07-26" sid="S-20260726-gx3p" title="截断式净化函数不能直接当存储键：熵必须活过截断" description="safeToken 类净化+截断用作文件名/映射键时的碰撞判据，以及共同字面前缀的陷阱" source="odyssey:20260726-odyssey-improve-compact-cache">

### 截断式净化函数不能直接当存储键：熵必须活过截断

`value.replace(/[^a-zA-Z0-9_-]+/g,'-').slice(0, 16)` 这类净化函数是**有损**的。用作人类可读的展示文件名无妨，用作**键控存储**则可能是正确性缺陷——尤其当写入路径把"文件已存在"当作"内容已持久化"处理时（`flag:'wx'` + 吞掉 EEXIST，或 `if (exists) return path`）：碰撞不会报错，而是把**另一个调用的数据**当作本次结果交回。

判据不是"有没有截断"，而是**熵有没有活过截断**：
- 安全：maestro-compaction.ts 的 buildKnowhowPath —— 键里含 randomUUID()，截断后仍留约 56 bit，且文件名另带秒级时间戳。
- 致命：tool-result-spill.ts 曾用裸 callId —— provider 的 callId 带**共同字面前缀**（如 `toolu_01…`），16 字符窗口大半花在固定前缀上，随机部分还没开始就被砍掉，且无时间戳兜底。

同一个函数、同样的写入语义，结论相反，取决于**输入的形状**而不是代码的形状。

本仓库已有两种正确做法，优先复用而不要另发明：
- packages/pi-maestro-teammate/src/runs/execution.ts:160 —— 截断后追加 `-${sha256(raw).slice(0,8)}` 恢复单射
- packages/pi-maestro-flow/src/tools/todo.ts:1238 —— uniqueMirrorId() 在键被占用时重导

教训（比规则本身更重要）：这个缺陷是安全加固动作**自己引入**的——任务写的是"镜像兄弟模块的 safeToken"，而那个兄弟恰好是仓库里的异类。**镜像一个兄弟模块，不等于镜像一个正确的兄弟模块**；照抄之前先确认被抄的那份在你的输入形状下也成立。

</spec-entry>

<spec-entry category="coding" keywords="队列,超时,入队武装,head-of-line,交互,reply-once" date="2026-07-26" sid="S-20260726-xlt2" title="有界等待的超时必须在入队时武装，不是出队时" description="串行队列的超时在入队武装而非出队；配 queue limit + reply-once + 按发起方取消；根侧超时须短于子侧兜底" source="run:20260726-001-odyssey-improve">

### 有界等待的超时必须在入队时武装，不是出队时

@
串行队列上的请求若在**出队**（轮到队首）时才武装超时，则"排在一个挂死请求后面"这一恰恰最需要有界的场景永远不会触发超时 —— 队首不动，后面的定时器就永远不开始。

规则：
- 超时 MUST 在**入队**时武装（`setTimeout` + `timer.unref?.()`），与它在队列中的位置无关。
- 队列 MUST 有长度上限（`TEAMMATE_INTERACTION_QUEUE_LIMIT = 16`），超限立即拒绝而非无限堆积。
- 结算 MUST 是 reply-once：超时、取消、正常应答三条路径共用一个 `guardedReply`/`settled` 守卫，任一先到即封口；`tail = tail.then(async () => { if (settled) return; ... })` 保证已结算项不再执行处理器。
- 队列 SHOULD 支持按发起方批量取消（agent 被终止时一次清掉它所有在途请求），取消理由要能回到调用方。

跨进程配对方向：根侧队列超时 MUST 严格短于子侧兜底超时（本仓库 5min < 10min），否则会出现"子侧已放弃、根侧的应答被丢弃"。
@

</spec-entry>

<spec-entry category="coding" keywords="派发表,map,原型污染,__proto__,事件,不可信输入" date="2026-07-26" sid="S-20260726-nynn" title="以外部可控字符串索引的派发表必须用 Map" description="事件/命令派发表以不可信字符串索引时必须用 Map，对象字面量会命中 Object.prototype" source="run:20260726-001-odyssey-improve">

### 以外部可控字符串索引的派发表必须用 Map

@
用对象字面量做事件/命令派发表，再以外部可控的字符串索引它，会命中 `Object.prototype`：`table["__proto__"]`、`["constructor"]`、`["toString"]` 都返回真值并被当成处理器。子进程发来的 `event.type`、模型给出的工具名、配置文件里的键都算"外部可控"。

规则：派发表 MUST 是 `Map`（或 `Object.create(null)`，但 Map 更明确）。`Map.get(untrusted)` 对原型链上的名字返回 `undefined`，落到正常的"未知类型"分支。

本轮实例：`runSingleAttempt` 的 14 分支事件 switch 重构为派发表时首版用了对象字面量，键来自子进程 stdout 的 `event.type`。
@

</spec-entry>