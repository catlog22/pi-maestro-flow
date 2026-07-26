---
title: "Architecture Constraints"
readMode: required
priority: high
category: arch
keywords:
  - architecture
  - module
  - layer
  - boundary
  - dependency
  - structure
---

# Architecture Constraints

## Module Structure

## Layer Boundaries

## Dependency Rules

## Technology Constraints

## Entries



<spec-entry category="arch" keywords="todo,skill-loader,defaultresourceloader,state-transition" date="2026-07-10" sid="S-20260710-kwdz" title="Pi todo 的原生 skill 控制边界" description="定义 todo、Pi 原生 skill loader 与未来 Ralph 控制迁移的模块边界" source="planex-odyssey">

### Pi todo 的原生 skill 控制边界

Pi todo MUST 将 skill 作为可空任务配置并通过独立的 Pi 原生 loader 延迟加载。Discovery MUST 复用 DefaultResourceLoader，feature code MUST NOT 复制 skill 目录扫描，也 MUST NOT 依赖 Maestro/Ralph runtime。任何 skill/config/required-reading/budget 失败 MUST 发生在任务状态切换为 in_progress 之前。

</spec-entry>

<spec-entry category="arch" keywords="teammate session handoff lease epoch nonce switchsession" date="2026-07-11" sid="S-20260711-j1kq" title="Pi teammate session 单所有者接管协议" description="Pi teammate session 接管、回交与恢复的唯一 owner 约束" source="master@fe067a5">

### Pi teammate session 单所有者接管协议

Teammate session handoff MUST maintain exactly one writer. Handoff MUST wait for accepted prompt sequence, corresponding agent_end completion, and stable idle before transfer. Every RPC user message MUST carry epoch/nonce lease metadata and child input MUST reject stale tokens. Timeout recovery MUST send the old transaction cancel before publishing the new fenced lease. switchSession invalidates old extension context; handback MUST reload the child session and validate nonce, sessionId, and canonical sessionFile before restoring child ownership.

</spec-entry>

<spec-entry category="arch" keywords="依赖漂移,源码锁定,tarball,packed-consumer,runtime" date="2026-07-15" sid="S-20260715-j486" title="同版本依赖内容漂移的源码锁定" description="registry 与源码同版本异内容时的可复现集成和真实运行验收规则" source="odyssey:20260715-004-odyssey">

### 同版本依赖内容漂移的源码锁定

当 npm registry 包与目标源码具有相同 version 但命令或行为合同不一致时，禁止继续按 semver 或该 registry version 集成。必须锁定到可复现的 HTTPS source tarball + commit SHA，通过 package-local wrapper 调用，并在 packed consumer 中启用 install scripts 后实际执行至少一个代表性命令；仅 require.resolve、npm ls 或 --ignore-scripts 安装不足以证明 runtime 可用。

</spec-entry>

<spec-entry category="arch" keywords="api-key,login,provider,base-url,reasoning,deepseek" date="2026-07-17" sid="S-20260717-nxld" title="Custom API Provider 必须使用单入口 API-key 登录" description="Custom API provider 使用 /login 单入口并隔离其他 provider" source="master@3b0379dd" supersedes="S-20260717-bvo9" status="deprecated" superseded-by="S-20260717-wl3q">

### Custom API Provider 必须使用单入口 API-key 登录

OpenAI Responses 与 Anthropic custom provider MUST 位于 /login 的 API-key 分组，并通过 provider-specific apiKeyLogin 在同一流程采集 Base URL、model ID、reasoning capability 与 API key。公开连接配置 MUST 原子写入 models.json，secret MUST 仅由 Pi credential store 写入 auth.json。MUST NOT 注册额外 /api-provider 命令，MUST NOT 使用 OAuth modifyModels 模拟配置，且更新 MUST 保留 DeepSeek 等其他 provider。

</spec-entry>

<spec-entry category="arch" keywords="api-manager models.json provider api-key base-url reasoning deepseek crud" date="2026-07-17" sid="S-20260717-wl3q" title="Custom API Provider 统一由 API Manager 管理" description="通过 /api-manager 和 models.json 管理自定义 API provider CRUD" source="user:2026-07-17" supersedes="S-20260717-nxld" status="deprecated" superseded-by="S-20260717-en4p">

### Custom API Provider 统一由 API Manager 管理

OpenAI Responses 与 Anthropic custom provider MUST 由 Maestro 的 /api-manager 管理，并以 Pi 官方 models.json 作为持久化入口。命令 MUST 支持 list/show/set/delete/logout/reset；literal API key 或环境变量占位符与 Base URL、model ID、reasoning capability 一并保存在对应 provider 内。新增、更新和删除后 MUST 刷新 ModelRegistry，删除只移除目标 provider，且所有写入 MUST 原子化并保留 DeepSeek 等其他 provider。MUST NOT 依赖 Pi host patch、OAuth modifyModels 或未公开 apiKeyLogin hook。

</spec-entry>

<spec-entry category="arch" keywords="api-manager models.json settings.json defaultthinkinglevel thinkinglevelmap reasoning deepseek" date="2026-07-17" sid="S-20260717-en4p" title="API Manager 分层管理推理能力与默认思考强度" description="区分模型推理能力与 Pi 全局默认思考强度的持久化边界" source="user:2026-07-17" supersedes="S-20260717-wl3q" status="deprecated" superseded-by="S-20260717-s3f9">

### API Manager 分层管理推理能力与默认思考强度

OpenAI Responses 与 Anthropic custom provider MUST 由 /api-manager 管理。模型是否支持 reasoning 及 thinkingLevelMap MUST 写入 models.json；Pi 全局默认思考强度 MUST 通过公开 SettingsManager.setDefaultThinkingLevel() 写入 agent settings.json 的 defaultThinkingLevel，不得向 models.json 写入非官方 default 字段。set 流程 MUST 只展示目标模型支持的档位，list/show MUST 显示当前 Pi 全局默认值，reset MUST 恢复 medium；目标 provider 正在使用时 MAY 同步当前 session。Provider CRUD 写入仍须原子化并保留 DeepSeek 等其他 provider。

</spec-entry>

<spec-entry category="arch" keywords="api-manager max xhigh thinkinglevelmap defaultthinkinglevel compatibility deepseek" date="2026-07-17" sid="S-20260717-s3f9" title="API Manager 支持 Pi max 思考强度" description="将 max 作为独立且 capability-gated 的 Pi 思考强度" source="user:2026-07-17" supersedes="S-20260717-en4p" status="deprecated" superseded-by="S-20260719-qbpp">

### API Manager 支持 Pi max 思考强度

在支持 Pi max thinking level 的运行时，/api-manager MUST 将 max 作为独立档位展示和持久化，不得归一化为 xhigh。models.json 的 thinkingLevelMap MUST 显式写入 max: max，因为 xhigh 与 max 都是 opt-in extended levels；settings.json.defaultThinkingLevel MUST 允许 max。为兼容不识别 max 的旧 Pi，UI 与 models.json 写入 MUST 由当前 ModelRegistry 中的 max capability 门控。OpenAI Responses 与 Anthropic 的 max provider 映射均为 max；其他 CRUD、原子写入及 DeepSeek 隔离约束保持不变。

</spec-entry>

<spec-entry category="arch" keywords="api-manager multiple-models models.json upsert provider deepseek" date="2026-07-19" sid="S-20260719-qbpp" title="API Manager 支持同 Provider 多模型" description="同一 API provider 下的多模型增删查改契约" source="user:2026-07-19" supersedes="S-20260717-s3f9">

### API Manager 支持同 Provider 多模型

OpenAI Responses 与 Anthropic 的 Base URL、API 类型和 API key 属于 provider 级配置；models.json.models MUST 是按 model ID upsert 的多模型集合。新增不同 ID MUST 追加，更新相同 ID MUST 原位替换且保留其他 model；list/show MUST 展示全部 model，delete MUST 删除所选 model，只有删除最后一个 model 时才删除 provider。reset 默认 model 时 MUST 保留已有自定义 model。所有写入继续保持原子化并隔离 DeepSeek 等其他 provider。

</spec-entry>

<spec-entry category="arch" keywords="api-manager model-select per-model defaultthinkinglevel thinkinglevelmap" date="2026-07-19" sid="S-20260719-3czo" title="API Manager 每模型默认思考强度" description="每模型默认思考强度的持久化与切模应用契约" source="user:2026-07-19">

### API Manager 每模型默认思考强度

API Manager MUST 以 provider/modelId 为键持久化每模型 defaultThinkingLevel，并在 Pi model_select 完成后调用 setThinkingLevel 应用。settings.json.defaultThinkingLevel 仅作为全局 fallback。即时应用 MUST 同时匹配 provider 与 model ID，禁止配置同 provider 的其他模型时改变当前模型。删除模型 MUST 同步删除其默认强度。thinkingLevelMap 仍只表达 capability，不承载默认值。

</spec-entry>

<spec-entry category="arch" keywords="effort thinking-level provider model-defaults atomic" date="2026-07-22" sid="S-20260722-hxna" title="统一 /effort 的模型级思考强度边界" description="锁定 /effort 的统一 Provider 覆盖、canonical level 与原子提交语义" source="analyze:20260722-001-analyze">

### 统一 /effort 的模型级思考强度边界

单一 /effort 命令 MUST 以当前 ctx.model 的 provider/modelId 为键复用 modelDefaults，覆盖 API Manager 与 Pi 系统原生 provider；UI MUST 只展示当前模型支持的 Pi canonical levels（off/minimal/low/medium/high/xhigh），Provider wire value（如 max）只能由 thinkingLevelMap 映射，MUST NOT 作为 level 传给 setThinkingLevel。选择提交 MUST 先原子持久化再应用 runtime，取消或失败不得改变当前状态。

</spec-entry>

<spec-entry category="arch" keywords="effort selector thinking current" date="2026-07-22" sid="S-20260722-rkyp" title="标准 /effort selector 的当前值表达" description="记录用户 Choice A：canonical 顺序优先，当前值使用文本标记。" source="master@03709e70">

### 标准 /effort selector 的当前值表达

在 ExtensionAPI 的标准 ctx.ui.select 不提供 selectedIndex 时，/effort MUST 保持 capability-filtered canonical level 顺序；当前有效级别 MUST 通过 label 中的（当前）标记表达，MUST NOT 通过把当前项移动到首位来伪造预选，也不要求真正预选。

</spec-entry>

<spec-entry category="arch" keywords="provider retry teammate pi-core waiter" date="2026-07-23" sid="S-20260723-3tih" title="Provider 重试执行所有权与状态投影" description="统一重试策略，同时保持 Pi core 与 teammate 的执行所有权边界" source="master@a218c49e">

### Provider 重试执行所有权与状态投影

teammate 子进程的网络/Provider 重试由 teammate 执行器负责；Pi 主 Agent 的 provider 重试由 Pi core 负责。两端必须复用同一纯错误分类、重试上限与退避策略；Flow 只能投影主 Agent 的 retrying 状态，不得绕过或重复 Pi core 重试器。等待 teammate 终态必须使用事件驱动 waiter，禁止循环调用 teammate-watch。

</spec-entry>

<spec-entry category="arch" keywords="api-manager,contextwindow,models.json,provider" date="2026-07-23" sid="S-20260723-nsgh" title="API Manager 管理模型上下文窗口" description="API Manager 的模型上下文窗口编辑与兼容规则" source="run:20260723-001-maestro-impeccable">

### API Manager 管理模型上下文窗口

自定义 Provider 的 contextWindow 必须作为模型级正整数由 API Manager 显式查看和修改，并写入 models.json；更新已有模型时若调用方未提供该值，必须保留已有 contextWindow，避免兼容调用静默回退默认值。

</spec-entry>

<spec-entry category="arch" keywords="compaction,prune-invariant,cache-prefix,control-tool" date="2026-07-24" sid="S-20260724-cbhh" title="压缩剪除的三项不变量" source="master@d8c8ca96">

### 压缩剪除的三项不变量

pi-maestro-flow 压缩剪除必须保持：(1) isError 的 tool result 永不剪除；(2) 控制类工具(如 todo)输出永不驱逐——驱逐集合用 allowlist(REPLAYABLE + EVICTABLE_BULK)而非'所有非可重放'；(3) 剪除顺序保持 latest-first（先剪靠近 frontier 的安全输出）以保留更长的 prompt cache 前缀。recent keepRecentTokens 窗口受保护。冗余惩罚不能用作剪除排序（与 latest-first 缓存不变量冲突），只能作为遥测/重要性信号。

</spec-entry>

<spec-entry category="arch" keywords="cockpit ownership todo teammate shortcut" date="2026-07-26" sid="S-20260726-4t37" title="Cockpit 跨扩展 UI 所有权协议" description="Cockpit 完全替换原生 Todo 与 teammate 状态面板的单所有者事件协议" source="master@69b23ebf">

### Cockpit 跨扩展 UI 所有权协议

当 pi-cockpit 启用时，必须通过 cockpit:ui-ownership 事件让 pi-maestro-flow 与 pi-maestro-teammate 主动撤下原生 todo-panel 和 teammate-agents；不得由 Cockpit 跨扩展强删。Alt+T 仍由 Flow 唯一注册，并通过 cockpit:toggle-todo 将展开态同步给 Cockpit。Cockpit 禁用时原生面板必须恢复。

</spec-entry>

<spec-entry category="arch" keywords="cockpit,projection,spawnedby,blockedby,dependencies" date="2026-07-26" sid="S-20260726-t8pi" title="Cockpit 关系投影不得压平" description="Cockpit Todo 与 teammate 树投影的关系语义和降级规则" source="master@69b23ebf">

### Cockpit 关系投影不得压平

跨扩展 UI 投影必须保留源事件中的关系与生命周期字段。Agent 父子结构只由 spawnedBy/parentCorrelationId 建立；graph dependencies 只表示结果流，必须单独用依赖箭头显示，不能伪装成父子层级。Todo 投影必须保留 blockedBy、createdBy、assignee、skills；缺失或循环父引用必须降级为可见 root 且禁止无限递归；父 agent 完成时递归清理所有后代行。

</spec-entry>

<spec-entry category="arch" keywords="background,snapshot,event,cockpit" date="2026-07-26" sid="S-20260726-wdwp" title="后台工具状态通过权威快照事件投影" description="后台工具与 Cockpit 之间采用全量快照和 query 事件的解耦模式" source="master@69b23ebf">

### 后台工具状态通过权威快照事件投影

长生命周期工具由进程所有者维护唯一状态机，并通过稳定事件发布完整不可变快照；UI 插件只校验、排序和渲染快照，启动或手动刷新时发送 query 事件，不直接 import 工具内部注册表，也不通过轮询工具调用复制状态。终态必须保留 status、exitCode、finishedAt、输出尾部和完整日志路径；消费者按 id 保持选中项，避免实时重排导致详情跳转。

</spec-entry>

<spec-entry category="arch" keywords="prompt-cache,context-transform,prune,compaction,cache-invalidation,cost-model" date="2026-07-26" sid="S-20260726-8laz" title="Context transform 改写消息前必须核算 prompt cache 作废代价" description="剪枝/改写类 context transform 的收益门控：算清作废前缀的一次性成本，且必须两阶段而非贪心" source="odyssey:20260726-odyssey-improve-compact-cache">

### Context transform 改写消息前必须核算 prompt cache 作废代价

任何在"每次 provider 请求前应用、但不写回 session"的 context transform（剪枝、重写、注入位置变更），替换索引 N 处的消息会让 provider 的缓存前缀从 N 到结尾全部失效。只算"省了多少 token"是错的。

定价（Anthropic）：cache read ≈ 0.1× input，cache write ≈ 1.25× input。作废 T 个 token 一次性花 ~1.15T，省下 S 个 token 每轮回收 ~0.1S，因此盈亏平衡约在 11.5·T/S 轮之后。实测最坏形态（一次旧文件读取 + 12 轮大对话）省 2.2K / 作废 81K = 0.027，净亏约 37:1，而且剪完压力根本没解除。

关键：门控不能贪心。单条候选的边际收益是**递增**的——第一条候选独自承担整条后缀的作废成本，得分永远最差（实测 0.122），整段跑完才转正（0.664）。逐条判断会在第一条上就否掉整段本来盈利的操作。

正确形状是两阶段：
1. collect —— 按原有顺序只收集候选、不改写（遍历顺序保持与历史一致，便于证明等价）
2. trim —— 用后缀和一次 O(n) 求出 suffixTokens，取**累计**收益首次覆盖 `suffix[index] × minRatio` 的**最深**位置，只应用到该深度

实现见 packages/pi-maestro-flow/src/compaction/auto-compaction.ts 的 cacheWorthwhileDepth / suffixTokenSums / runPrunePass。门控关闭或压力已 critical 时跳过阶段 2，输出与历史逐字节一致——这条退化路径是安全边界，务必保留并测试。

推论：此类门控默认可以开，因为它只会**拒绝**操作、不会**触发**操作，失败模式是"上下文略满"而不是"意外压缩"。这与"提前触发压缩"类信号（如 velocity）的默认值取向相反。

</spec-entry>

<spec-entry category="arch" keywords="扩展,主题,settheme,所有权,pi,settings" date="2026-07-26" sid="S-20260726-sqp1" title="扩展 setTheme 写穿宿主设置，主题所有权归 pi" description="setTheme 写穿宿主设置，扩展不得自行持久化与重放主题" source="master@25cd8ea1" status="deprecated" superseded-by="S-20260726-cztp">

### 扩展 setTheme 写穿宿主设置，主题所有权归 pi

扩展 MUST NOT 自行持久化主题并在 session_start 重放。ctx.ui.setTheme(name) 不是会话级的——实现里在成功后调用 settingsManager.setTheme(name) 写回 pi 自己的设置，因此 pi 下次启动会自行恢复；扩展再放一次只会覆盖用户此后通过 /settings 做的修改。

pi 的主题设置有两种形态：单个主题名，或 Automatic 模式下的 "light/dark" 配对字符串（settings-selector.js getAutomaticThemeSetting）。扩展写入单个名字会把配对整体替换掉，而 ExtensionUIContext 只有 getAllThemes / getTheme / setTheme，**没有读取当前主题设置的方法**，因此扩展无法判断自己是否正在破坏一个配对，也无法把配对还给用户。

结论：主题的权威是 pi 的 settings，扩展至多提供一个快捷入口，并且 MUST 指向 /settings（内置选择器有实时预览、取消回滚 originalThemeSetting、明暗自动配对，扩展侧单键循环三样都没有）。内置斜杠命令中没有 /theme，主题在 /settings 子菜单下。

</spec-entry>

<spec-entry category="arch" keywords="嵌套,代理路径,handleproxyrequest,双实现,状态维护,teammate" date="2026-07-26" sid="S-20260726-5e59" title="嵌套派发的代理路径必须与 root execute 共享状态维护" description="嵌套 teammate 走 IPC 回根由 handleProxyRequest 执行，execute 里的状态维护必须在两处都做" source="run:20260726-001-odyssey-improve">

### 嵌套派发的代理路径必须与 root execute 共享状态维护

@
pi-maestro-teammate 的嵌套 teammate 调用**不是**"再走一遍 tool.execute"：子进程只注册 proxy 工具，嵌套调用经 IPC 回根进程，由 `handleProxyRequest` 执行。两条路径是两份独立的调度/状态实现。

因此：凡是在 root `execute` 里对 `ActiveAgent` 做的状态维护，MUST 同时在代理路径做，否则只在嵌套场景暴露。已实测的 4 类漂移后果：

- 不刷新 `lastActivityAt` → 嵌套 agent 30s 后被误判 stalled（ARCH-2）
- 不发 `TEAMMATE_COMPLETE_EVENT` → 跨扩展留永久幽灵行（ARCH-3）
- 不更新 `childCall` 快照 → 父级 TUI 恒显示 stalled（OBS-8）
- 不校验自报身份 → 子进程可伪造 parentCid、越权 send/abort（SEC-1/SEC-5）

新增任何"派发一个 agent 时要做的事"时，MUST 检查两处；只改一处即为缺陷。合并两份实现前，此约束是唯一防线（ISS-20260726-012）。
@

</spec-entry>

<spec-entry category="arch" keywords="env,子进程,pi_teammate_depth,深度守卫,身份,准入闸门" date="2026-07-26" sid="S-20260726-nqlg" title="读子进程作用域的 env 前必须先门控进程身份" description="根子进程共用同一份代码时，读子进程作用域 env 必须先门控进程身份；层级预算沿派发链传递而非读 env" source="run:20260726-001-odyssey-improve">

### 读子进程作用域的 env 前必须先门控进程身份

@
把身份或预算寄存在环境变量（`PI_TEAMMATE_DEPTH`、`PI_TEAMMATE_CORRELATION_ID`），而扩展代码在**根进程与子进程都会加载同一份**时，无条件读取该 env 是失效的：根进程里它根本不存在。

`checkDepthGuard()` 曾在根进程读 `PI_TEAMMATE_DEPTH`（未定义 → 0），而每次 spawn 都写 `DEPTH = current + 1` = 恒为 1，于是 `MAX_DEFAULT_DEPTH = 3` **从未生效**；叠加"并发上限只按单次调用的任务数计"，最坏 15³ = 3375 个 Pi 进程。

规则：
- 读子进程作用域 env 的代码 MUST 先证明自己就是那个进程 —— `if (isChild)`（`PI_TEAMMATE_CHILD === "1"`）或 `isTeammateChild()`（并检 `typeof process.send === "function"`）。
- 层级/预算这类**由派发者决定**的量，SHOULD 沿派发链在进程内数据结构上传递（`ActiveAgent.depth = parent.depth + 1`），env 只作为子进程的初始值，不作为守卫的读取源。
- 准入闸门 MUST 同时约束深度与跨层级总量，只有其中之一等于没有。

仓库现状（已扫描确认）：`PI_TEAMMATE_CORRELATION_ID` 的 6 个读取点全部被显式门控，深度守卫是唯一违例且已修。
@

</spec-entry>

<spec-entry category="arch" keywords="准入,并发闸门,live_agent_statuses,墓碑,失败保留,预算" date="2026-07-26" sid="S-20260726-r8dg" title="准入闸门的存活集合按持有活资源定义，墓碑不占预算" description="并发/嵌套预算按存活状态集合计数，终端态墓碑不占槽位，故无需为可见性另建侧表" source="run:20260726-001-odyssey-improve">

### 准入闸门的存活集合按持有活资源定义，墓碑不占预算

@
终端状态需要保留一段可见期（见 `ui-conventions` 的"失败状态不得与产生它的事件同帧消失"，那条管**渲染**），本条管**准入**：保留期内的墓碑 MUST NOT 消耗并发/嵌套预算。

做法：闸门计数不遍历整个注册表，而是按一个显式的存活状态集合过滤 —— `LIVE_AGENT_STATUSES = {pending, running, retrying, sleeping}`。`failed` 墓碑不在其中，因为它不持有子进程。

由此，"保留失败记录"与"占用槽位"这两件事解耦，不需要为可见性另建侧表（`recentFailures` 之类）。ISS-20260726-008 原本建议侧表，理由是"留在 activeRuns 会占槽位"——在存活集合已收窄的前提下该顾虑不成立，真实 `status: "failed"` 墓碑是更简单且让既有失败渲染分支真正生效的做法。

推论：任何新增的"注册表里存在即计入"式闸门都是缺陷；预算的语义 MUST 是"持有活资源",不是"在表里"。
@

</spec-entry>

<spec-entry category="arch" keywords="settheme,主题,预览,扩展,持久化,setthemeinstance,pi" date="2026-07-26" sid="S-20260726-cztp" title="扩展 setTheme 双形态：名字持久化，实例仅内存" description="setTheme 字符串形态写穿 settings，实例形态仅内存——扩展做预览/取消的前提" source="master@02a0c507" supersedes="S-20260726-sqp1">

### 扩展 setTheme 双形态：名字持久化，实例仅内存

ctx.ui.setTheme 的两个重载走不同代码路径，持久化语义相反，这是扩展能否做主题预览的唯一决定因素：

- setTheme(name: string) -> setThemeName：成功后扩展包装层额外调用 settingsManager.setTheme(name)，**写回 pi 自己的设置**（持久）。
- setTheme(theme: Theme) -> setThemeInstance：仅内存生效，activeThemeName 置为 "<in-memory>"，**不写 settings**（会话级）。

由此推出扩展侧主题选择器的正确形状：用 getTheme(name) 取实例、用实例形态预览，滚多少个主题都不碰用户已存设置；取消时把打开选择器那一刻的 Theme 实例再 set 回去即可还原；只有确认键走字符串形态落盘。参考实现 packages/pi-cockpit/src/theme-picker.ts。

两个无法回避的限制，按「是否造成用户可见的永久损失」分级处理：
1. ExtensionUIContext 只有 getAllThemes/getTheme/setTheme，**没有读取当前主题设置的方法**，所以显式确认写入单个名字时，无法判断自己是否正在把 Automatic 模式的 "light/dark" 配对压平成单名，也无法把配对还回去。这是永久损失且扩展无法补救，MUST 在 UI 上写明并指向 /settings，MUST NOT 猜测或静默。
2. setThemeInstance 会调用 setAutoSync(false)，预览一旦发生，本会话不再跟随终端明暗（OSC 11）；重启后由 applyFromSettings 自愈。会话级且自愈，记录在此即可，不必占用 UI 行。

仍然成立：扩展 MUST NOT 自行持久化主题并在 session_start 重放（会覆盖用户此后经 /settings 做的修改）。pi 内置斜杠命令中没有 /theme，主题在 /settings 子菜单下。

</spec-entry>