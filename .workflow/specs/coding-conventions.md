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