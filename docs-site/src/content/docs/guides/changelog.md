---
title: "版本更新日志"
icon: "🔄"
---

这里记录 pi maestro flow 套件从上一稳定版本到当前版本的用户可见变化、行为调整、问题修复和升级要求。

> **当前稳定版本：v0.24.0（2026-08-28）。** 子进程树回收与取消语义加固、`steer`/`interrupt` 明确分离、completion-outbox 运维 CLI、跨窗口 teammate 协调、Cockpit 用量手动刷新与 Todo 事件投影；引擎保持 `maestro-flow@0.5.82`；搭配 Teammate 2.2.0、Cockpit 0.19.0、Settings-Core 0.2.1、Backend-Core 0.1.1 与 Backends 0.1.1。

## v0.24.0（2026-08-28）

> 本版发布 Flow 0.24.0、Teammate 2.2.0 与 Cockpit 0.19.0；Settings-Core 0.2.1、Backend-Core 0.1.1、Backends 0.1.1 及引擎范围 `maestro-flow@^0.5.82` 保持不变。

- **Flow 进程生命周期**：Maestro CLI、self-evolve stage 与 SmartSearch 共用 fail-closed 进程树回收；CLI runner 支持 `AbortSignal`，FFF 初始化随会话取消，SmartSearch 增加宿主墙钟期限。
- **Flow Plan 与 Provider**：批准后的 Plan 分解/压缩 handoff 保留 Goal continuation；`/api-manager` 与 settings shell 的 managed provider registry 保持同步并覆盖显式空列表与 legacy fallback。
- **Teammate 消息语义**：`steer` 改为不打断当前 turn 的原生队列；新增显式 `interrupt`（abort + prompt），并在无法确认中断时安全降级为 `follow_up`。
- **Teammate durability 与协调**：新增 `pi-teammate-outbox` CLI 和 remnant cleanup 锁竞态覆盖；teammate-send 可定位 workspace-peer agent，dispatch 支持 `steeringMode` 覆盖。
- **Teammate 资源与终态**：终态结果先发布再触发 completion callback；流式 progress 有界；睡眠 runtime 默认预算降低且可用环境变量覆盖；损坏的 outbox GC 索引自动修复。
- **Cockpit 响应性**：`/usage` 新增手动刷新与轮询开关；Todo state-change 事件实时投影；输入历史保存具备崩溃一致性与瞬态重试；ambient 写入去重并统一 500ms 动画节拍。
- **MCPX**：quick tunnel 改用 HTTP/2。

升级：`pi install npm:pi-maestro-flow@0.24.0`

## v0.23.0（2026-08-27）

> 本版发布 Flow 0.23.0、Teammate 2.1.0、Cockpit 0.18.0、Settings-Core 0.2.1、Backend-Core 0.1.1 与 Backends 0.1.1；引擎 pin `maestro-flow` 0.5.79 → 0.5.82（caret）。121 commits / 789 文件 / +135,044 −12,784。

- **Teammate 运行时身份与 runtime-broker v3**：workspace 身份集中到 `getRuntimeWorkspaceIdentity`（canonical 路径 + 稳定 `workspaceId` + 旧 id 列表），flow-schedule、completion 投递、workspace peers、mailbox 共享同一解析路径并仍能匹配 realpath 规范化前的旧 id。runtime-broker 协议升至 schema v3：新增 `broker.probe` 握手、分页 `stream.events.page`（带稳定 `throughRevision` 上界，避免无限重放快照）、readiness challenge。completion-outbox / mailbox file store 增加崩溃一致 replace 顺序与 GC；workspace peers 增加不可变 per-session owner claim（锁保护 acquire + 陈旧接管）。
- **Fork / wait-cycle / todo-context 公开契约**：新增 `fork-snapshot`（`context: "fork"` 子会话从祖先链快照启动）、`wait-cycle` 自等待死锁检测（observe wait 屏障要求循环 target 时拒绝）、版本化 `todo-context` 公开 API（`./v1/todo-context` 导出，forked/spawned 子智能体在 prompt 中直接获得紧凑 Todo 状态，无额外 IPC）。
- **completion-manifest 提取 + 压缩状态中继**：把 completion-intent manifest 抽成独立 `completion-manifest` 模块（版本、目录、字节上限、canonical-name 解析、有序 replace、summary 截断），durability provider 与 agent output store 共用同一校验器，manifest 经 revision 围栏持久化与重放、无效事务隔离。新增 `teammate-compaction-relay`：检测 fork-context 子进程启动并通过 Pi 子进程 IPC 发布压缩阶段事件（pending/continuation/completed/failed），父 Cockpit 无需轮询即可追踪中途压缩恢复。
- **plan-decompose 工具**：新增 `plan-decompose`——给定已批准 Plan 的 handoff key，返回自包含分解 prompt，由主流程转成一份完整、拓扑有序的 Todo batch（简化版的 Maestro decomposition.goals）。Plan 执行引导现对复杂已批准工作先走 plan-decompose 再建 Todo。Plan 确认面板简化：不再承载完整 refine 输出与 R 切换预览，只保留 refine-attached 元数据 + Apply/Discard 动作。Plan review 接入 notify user-attention，阻塞提示触发桌面提醒。
- **桌面通知 + user-attention 提醒**：`/notify` 优先使用原生桌面通知（`desktop-notifier`，回落 `ctx.ui.notify` toast），新增 `onInput` 类别——Pi 被阻塞等待用户决策时触发。共享 `user-attention` handler 把权限提示与 ask 工具接入同一路径。`/notify` 切换扩展为 `on|off|error|complete|input|status`。
- **浏览器扩展桥（可选真实浏览器接管）**：新增可选 Chrome MV3 扩展桥，经 WebSocket 接管用户日常浏览器（保留登录态、CAPTCHA、真指纹、扩展级能力），未安装时 `browser` 工具自动回退既有 puppeteer CDP attach/launch 路径，行为不变。扩展随包发布在 `optional/browser-bridge/`，`/install` 新增 `browser-bridge` 安装项（含 probe），配套 `BROWSER-BRIDGE-SETUP.md`。环境变量 `PI_BROWSER_BRIDGE_PORT` 自定义 WS 端口（默认 `19222`）。
- **flow-schedule 工作区身份 + Todo mutation 门控**：flow-schedule actor runtime 经 `getRuntimeWorkspaceIdentity` 解析身份，并接受 `todoMutationSupported`，工具据此门控 Todo 变更（仅 managed-worker 窗口）。
- **Cockpit 会话投影围栏 + CLI agent 徽章 + 用量条**：agents-store 与 endpoint-store 携带 `SessionProjectionIdentity`（workspaceId/sessionId/sourceId/generation），行与端点围栏到当前 root session，连接时拒绝陈旧 registry 代际。外部 CLI 后端（`cli/*` 模型前缀）渲染专用徽章，stall 超时改由本地持有（30s，不再导入 broker 常量）。新增 usage 模块（`usage/core.ts` + `extension.ts`）轮询 provider 配额/余额/消费并在 footer 专用行渲染进度条，经 Cockpit config（`usage.enabled/footer/pollIntervalMs/barWidth/commandKey`）与设置 provider 配置。
- **observe lastResult 无条件渲染**：observe 输出现在无条件渲染 `lastResult`——非 verbose 显示一行扁平摘要、verbose 仍显示完整多行块，使轮询观察者无需请求 detail 即可区分“已完成所请”与“尚未开始”。配套窗口侧 `mainLastSettle` 单槽投影，跨轮次保留最近一次 `agent_settled` 结果。
- **Teammate 运行时核心升级——model-registry 模型注册**：以 canonical 模型注册 id + 部署拓扑 + 四道门（registered/resolvable/sessionAvailable/healthy）替代 backend-registry 的 v2 模式；DSH 部署用 adapter-model selector；远端路由仅在当前 root Monitor session 可用并给出确定性 `unavailableReason`；共享模型健康协调器与熔断策略（`model-circuit-breaker`）；`model-routing` 接入注册 id 解析与 circuit 策略同步；`registry-host` 读取 model-registry 模式并投影 pair 发布、mode 三态切换。新增 `pi-teammate-models` CLI（list/edit/add）与 connection TUI 向导（`connection-forms` / `connection-wizards` 复用 cli-edit/cli-add），`model-mapping-overlay` / `remote-config-pane` / `locale-catalog-model` 适配。
- **completion-durability 投递（teammate 输出不再因中断/压缩丢失）**：`completion-outbox`（coordinator/file-store/registry/types）落盘 outbox + 重投；`public/v1/completion-durability` 注册表符号与 provider 契约；`runs/execution` + `extension/index` + `extension/teammate-proxy` 子会话绑定、`receiveMessageEnd` 回放、`reply_to`/`correlationId` 投递种子；flow 侧 `FlowCompletionDurabilityProvider` + `agent-output-capture`/`store` 元数据。后续多轮审查修复（崩溃一致性、向后兼容与 pin 语义、WAL 恢复与 caller 通知、聚合 import 路径）。
- **briefing 装配**：`runs/briefing.assembleTaskPrompt` 将 `agent://` / `file:` 引用懒拼入子任务 prompt，`execution` 在使用 `params.task` 前统一装配。
- **DSH 远程 ssh 启动模式**：`dsh/driver.composeDshLaunch` 支持 ssh 远程启动，local 子进程白名单补 `SSH_AUTH_SOCK`；`DSH_CONFIG_FIELDS` 导出供 models CLI edit 复用，新增 `mode`/`host`/`user`/`port` ssh 启动面字段；`resolveBackendConfig` 透出 backend 的 advisory warnings（避免风险提示在 resolution 边界被静默丢弃）。
- **backend-core 契约暴露**：`TeammateExecutionMode` 新增 `model-registry`（teammate 先解析稳定模型注册到既有 v1 backend 注册）；新增 `TeammateExecutionTransport` 描述性传输元数据（local-process / acp-direct-ssh / dsh-direct-ssh / remote-worker），供 settled 结果安全暴露；`ResolveConfigResult` 新增可选 `warnings` 承载 advisory 风险提示。
- **computer-use / 本地视觉（OCR）**：新增 computer-use 工具——平台抽象（windows/macos/linux bridge-process）、坐标转换、artifacts bound、manifest schema 与 optional notices；本地视觉 `local-vision` provider + `computer-use/vision` 模块（OCR/detect/worker/image/model-assets），`tesseract.js` 为可选依赖，缺失时返回 `{ok:false,hint}`。
- **Browser stealth + attach + visible**：`stealth.ts` 注入 navigator.webdriver/plugins/chrome/permissions 反指纹补丁与 `--disable-blink-features=AutomationControlled` 启动参数；`BrowserOpenOptions` 新增 `visible` 与 `attachUserProfile`/`userProfileDir`，支持接管用户日常浏览器（保留登录态与真实指纹）；`browser-tool` 暴露 `visible`/`app.attach_user_profile`/`app.user_profile_dir` 参数与 CAPABILITY MAP 说明，明确纯 stealth 不足以通过 Cloudflare managed challenge。
- **abort/cancel 语义修正**：`stopReason="error"` 但消息含 abort 字样时归为 cancelled/non-retryable，不消耗熔断、不切换模型，避免用户 ESC 后系统换模型重跑（`model-failover` 与 `retry-classifier` 新增 ABORT 诊断正则）。
- **路由可观测性**：`model-routing` 新增 `unreachableRoutingTargets()` 与 `formatModelRoutingConfig(..., availableModels)`，task-type/role 映射指向当前 catalog 不可达的模型时在路由表输出警告；空 catalog 不报。
- **manifest 写入前置校验**：cli-edit/connection-wizards 镜像 add 流程的 ssh host/user 必填校验；cli-write 解析后再跑 `compileModelRegistryManifest`，把拓扑/selector 失败提前到写入时。
- **MCPX 面板增强**：`E` 键一键永久注册/注销工作空间（无租约，窗口关闭后保留；`e` 仍为 TTL 租约注册）；`collectWindows`/`collectThread` 扫描全部 peer 工作空间，oauth 模式 runtime 401 时回退列表也能看到其他工作空间的窗口与工具调用；quick tunnel 进程发现与 adopt（向导可接管既有隧道并校验端口）；修复 `sanitizeTerminalText` 误剥 ESC 致颜色码退化成乱码。
- **Cockpit 跨平台快捷键显示**：`Alt` 快捷键在 macOS 显示为 `Option`——`key-labels.altLabel()` 返回平台显示名，渲染态显示 Option+X，匹配令牌全平台仍为 `alt+X`。
- **Flow loop 状态行 + 终态回调**：loop 状态行改用状态字形与相对时间，新增终态 `onTerminal` 回调与 `loopId` 前缀解析。
- **teammate 输出桶写入 `.workspace` 元数据并支持 cwd 子树发现**；**压缩后中断任务不再搁浅**——zombie 迟到完成补发续跑 + 统一恢复策略；**未知模型失败默认可重试** + agent 输出短 id 前缀寻址。
- **plan 修复**：`teammate-send` 放行 steer/follow_up + planner 子派发边界澄清。
- **ACP 接入完善（PR #18 合并）**：ACP-CLI backend 新增 catalog/snapshot/registry 刷新脚本，`acp-driver` 与 `acp-config-options` 增强；`registry-host` 叠加全局回退（workspace-root + global 复合键）兼容本地 model-registry 模式；`teammate-backends-settings-provider` 融合 PR catalog 文案与本地 deploymentDescriptors document-driven join，补全 DSH ssh 字段 catalog、新增 pi-subprocess backend catalog。
- **文档与规范**：新增 `packages/pi-maestro-flow/AGENTS.md` 包级编码规范；teammate 2.0.0 发布文档（README/CHANGELOG + 包内 agents 角色重写 + adapter 契约补 model-registry）；`.pi/agents` 角色定义结构化重写 + `.pi/SYSTEM.md` 补 agent 结果复用规则；skills 中 `maestro-session-seal` 重命名为 `maestro-session-manage`；用户文档同步 `pi-teammate-models` CLI、DSH ssh、model-registry 模式与 macOS Alt/Option；浏览器控制能力差距分析与 attach/stealth 使用文档；Windows Git Bash 环境高频工具失败模式 tip。

## v0.22.0（2026-08-20）

> 本版发布 Flow 0.22.0、Teammate 2.0.0（破坏性）、Cockpit 0.17.0、Settings-Core 0.2.0，并首次公开发布契约包 `pi-maestro-backend-core@0.1.0` 与 `pi-maestro-backends@0.1.0`；引擎 pin `maestro-flow` 0.5.75 → 0.5.79。

- **Teammate 2.0.0（破坏性大版本）**：远端 journal 格式 `REMOTE_JOURNAL_VERSION` 1 → 2，**无迁移路径**——旧 v1 journal 在解析时硬失败，需删除重建；远端协议词汇 `RemoteCapability` 移除、协议升至 `remote/2`；删除内联 `cli/<tool>` 派发，路由统一改走 backend registry，第三方适配器须实现 backend 契约。新增通用 ACP-CLI TeammateBackend（事实经 `outcome.recovery` 返回、`settleAcpRun` 观测工具事件并带出已完成/在飞计数、ACP 握手超时改为可配不再写死 15 秒、failover 门按观测活动判定）；`optionsSource` 从声明字段变为可用机制、模型命名空间归执行者所有、`backendOptionsOf` 下发真实 `host.proxyToolCall`。新增纯契约包 `pi-maestro-backend-core`（能力表穷举至 12 项、凭据以引用建模而非遮罩值）+ registry 路由 + Pi subprocess backend 适配器 + dsh backend（每 run 托管 loopback MCP todo endpoint、`outputSchema` 宿主侧补偿由 unsupported 升为 emulated）。多个 remote/teammate 鲁棒性修复（订阅随 start 建立、单派发能力裁决、失败诊断不再渲染两遍等）。**升级注意：旧 v1 远端 journal 不可读、需重建；第三方后端须实现 backend 契约而非内联 `cli/<tool>` 派发。**
- **MCPX 配置向导与连接监视器**：新增 `/mcpx` 配置向导（README 引导式 setup），含 Cloudflare quick tunnel 步骤（仅保留 quick tunnel、auto-start、cloud MCP 连接预览、surface cloudflared 退出/超时原因）、动态工作区注册与心跳租约、向导步骤导航（Enter 前进 / Esc 返回 / `c` 快捷进监视器）。新增 MCPX 连接监视器 TUI（展示 MCP 服务器与客户端连接、start/stop 控制）。
- **动态模型发现与进程内 failover**：API Manager 支持动态模型发现（查询 provider 拉取实时模型列表），**仅在已保存 API key 时提供**；进程内模型 failover 经 `set_model` RPC 热切换模型而非重启 run；手动切换模型时重置该模型的熔断器以便自动 failover 重试。
- **`/notify` 提醒开关**：新增 `/notify [on|off|error|complete|status]` 切换 toast 提醒（模型出错 / 回合完成）；出错回合抑制完成提醒，每回合至多一条 toast；状态持久化。
- **下一步建议（next-suggest）**：每回合结束后在编辑器下方渲染下一步提示 widget，F2（可配）填充编辑器、任意输入即消失；经 API Manager（`/api-manager nextsuggest`）配置，持久化于 `api-manager.json` 的 `nextSuggest` 段。
- **API Manager 配置导入/导出 + 暴露 teammate CLI 工具可用性 + 显示被阻塞的知识候选**。
- **`.pi/SYSTEM.md` 单一权威迁移**：项目系统指令仅来自 `.pi/SYSTEM.md`，内联打包 `AGENTS.md` 注入退役；依赖旧注入的用户须迁移内容到 `.pi/SYSTEM.md`。
- **防御性编程修复（DEF-001..004）**：修正 false-success 上报（DEF-001/002）与 silent eviction 重排（DEF-003/004），补回归测试。
- **MCPX 看板增强（任务编排闭环 Phase 4）**：隧道健康监控与异常按键指引、T 键一键重启隧道并自动同步新 URL 到 config + 重启 mcpx、OAuth 运维口令显示并持久化、W 键 Workspace 管理子模式（列出/选中/移除任意 workspace）、看板展示委派任务状态与结果、检测 mcpx-for-pmf fork 并提醒、auth 模式 401 不再误判为离线、隧道 URL 带 `/mcp` 后缀并给出客户端填写提示、看板客户端化（`mcpx-client.ts`）。
- **提示词增强（prompt-enhance）**：新增提示词增强功能，快捷键 `Alt+Shift+E`（已移除 Ctrl+Shift+E，避免与 Pi `app.thinking.cycle` 冲突）。
- **submit-gate 提交闸门**：新增 submit-gate 扩展。
- **用量洞察**：statusline 用量历史、用量图表（usage-chart）与历史回填。
- **Cockpit Todo 覆层**：`Alt+Shift+T` Todo overlay；blocked todo 优先级降级、可见上限提高。
- **Browser**：移植 GenericAgent DOM 探针、列表折叠与导航检测。
- **加固波次（odyssey-review）**：高竞争信任场景锁重试提升至 64、统一 `serializeMutation` 锁、event-bus 清理与回放上限、usage-history 性能与索引原子性、mcpx tunnel/pid/yaml 加固、运维口令遮罩、备份模式/上限、PID 身份校验。
- 其他：cockpit 同文件批量编辑并原子拒绝相同编辑；知识 promote 3 条防御性编程 spec。

## v0.21.6（2026-08-16）

- **Teammate 1.14.0 — 远程工作器（`pi-teammate-remote`）**：新增 `pi-teammate-remote` CLI 与公开 `./v1/remote` API 面（worker 协议、配置、bridge、journal、adapter 契约；`src/remote/` 下含 ACP driver、Pi RPC driver、SSH transport、child security 与进程树管理、worker-manager、remote state）。新增运行时依赖 `@agentclientprotocol/sdk@1.3.0`、`jiti@2.7.0`、`ssh2@1.17.0`、`zod@4.4.3`（settings-core 不变）。Monitor 控制窗口经 `MonitorToolExposureController` 在本地与 Monitor 工具变体间切换（`workspace-window`、`remote-worker` 独占工具，admission 前不授予跨窗口权限）；`teammate-list` 合并本地 workspace peers 与远程 runs；monitor 模式覆盖 SSH 远程 worker 监督。**Ask-before-dispatch 门禁**：模型路由配置（`~/.pi/agent/teammate-models.json` → `askBeforeDispatch: true`，经 `/teammate-models` 切换）下，root dispatch 在 spawn 前于 model-ask overlay 暂停确认每任务 model/thinking/location；嵌套/代理 dispatch 从不询问。投递加固：monitor 干预经进程内 `authorize` fence 后才外部发布；`ActiveAgent` 获得已解析 `cwd`（本地路径或 `remote:<targetId>`）。
- **Flow 0.21.6 — plan Knowledge Gate + 引擎同步**：已批准 plan 的执行契约以 Knowledge Gate 开启——指导执行 agent 在任何项目工作前运行 `maestro search "<1-3 task keywords>"`，并对每个命中的治理结果执行 `maestro load`（search 为 exposure、load 记录 consumption），随后在子系统/架构边界重新 search。核心引擎 pin `maestro-flow@0.5.74 → 0.5.75`（上游 v3 运行时更新；v2 分支不动）。
- **升级注意**：Teammate 需新运行时依赖（`ssh2`、`jiti`、`@agentclientprotocol/sdk`），请重装（`pi install npm:pi-maestro-teammate@1.14.0` 或干净 `npm install`）而非复制旧 node_modules。`askBeforeDispatch` 默认关闭，在 `/teammate-models`（Ctrl+A）启用；不支持 overlay UI 的上下文跳过门禁而非失败。`maestro-flow` 为精确 pin，升至 0.5.75。
- 安装：`pi install npm:pi-maestro-flow@0.21.6`。

## v0.21.5（2026-08-15）

- 引擎 pin 升级：`maestro-flow` 0.5.73 → **0.5.74**。0.5.74 为 v3 加固版本：`session migrate --to-v3` 接受 running Run（投影 run/3.0 running + active run 绑定）与 orphaned running/failed step（投影 pending），迁移不再死锁；`knowledge stage` 对 session/3.0 可用（sidecar v3 分支 + artifact 证据经 registry 解析）；`requireV3Session` CAS fence 从显式 `--session` 目标派生（stale state.json active 不再干扰）；`session unarchive` 成为 v3 orchestration target；publishPlanV3 重放幂等（open/insert already-exists 视为成功）。
- Pi skills 转换管线 v3 化：`sync-pi.mjs --also-pi` 重新生成 `.pi/skills`（194 文件）与 `.pi/agents`（35 文件）——convert-pi 移除全部活 v2 重写规则（run brief/next/complete 不再注入 `--platform pi`；`run create` 作为合法 v3 self-start 保留；run prepare/session create/start/done/run start/done/edit/skill 改写与 prepare 资产合成删除）；run-executor 角色与 skill-iter-tune/maestro-help 源 v2 残留清零；Pi-native `self-evolve` 改用 `run complete --advance` / `session complete`。
- 转换契约测试与 prompt 审计同步 v3 语义（convert-pi 33 用例 + skill-contract-lint 全绿）；teammate 包 window-inbox/listing 重构随附。
- 安装：`pi install npm:pi-maestro-flow@0.21.5`。

## v0.21.4（2026-08-15）

- 引擎 pin 升级：`maestro-flow` 0.5.72 → **0.5.73**。0.5.73 为 canonical v3 收敛版本：默认 workspace writer 改为 `session/3.0`（六键能力集、无 Execution writes）；`run next`/`run create` 输出完整 birth packet（run_dir/step_id/upstream/guidance/knowledge_context/brief.command/run_already_created，同 request 重放返回相同 packet）；`run brief` 返回 `brief-result/3.0` Resume Packet（含 orchestration_revision 与 suggest-only next）；canonical 文档/门禁/mirrors 全面 v3 化（v2 移入带标签的 Legacy 分支）。
- v3 适配更新：Pi 侧执行链全面 v3 化——`next/done` 走无 lease CAS 的 execV3、`run brief` 消费 v3 Resume Packet、`run complete --advance` 完成 Run；`publishPlan` 在 session-v3 模式打开 Session、持久化 plan 文档（`.workflow/plans/`）、插入 plan chain step 并返回合成 envelope；extension 的 v3 receipt（session-complete/run-complete-and-seal）驱动知识 review、Run-sealed 管线读取 run knowledge-delta；run-executor 角色全面 v3（无 session next/done/ralph-meta）。
- 真实 CLI 集成测试迁移到 v3 fixture（4 个既有 v2 基线失败消除）；新增 v3 全链路用例（open→chain→run next→brief→check→complete→decide→session complete）。
- 安装：`pi install npm:pi-maestro-flow@0.21.4`。

## v0.21.3（2026-08-15）

- 引擎 pin 升级：`maestro-flow` 0.5.71 → **0.5.72**。0.5.72 承载跨仓审查修复：run complete 在 receipt 同一事务内原子写入知识候选（`knowledge review` 立即可见）、`run next` 缺省 Run ID 从 request ID 确定性派生（同 request 重试可 replay 原 mutation）、artifact republish 改用 canonical `--expected-orchestration-revision`、transition receipt 强制 `participant_id = actor_id`、ResumeMap 移除 `identityRevision`/`paused`、resolved/escalated 决策不可再绑为新门、release 门禁 30 项证明全绿。
- v3 适配更新（跨仓审查 8 条）：`next/done` 委托无 lease CAS 的 `execV3`，`edit` 在 v3 下显式拒绝并指引 `session chain insert|skip|replace`；capability v3 选择增加 writer-scoped 严格校验（`session_schema_writes` 声明 `session/3.0`、无 execution writes、声明 `run-response/1.2`、v2 features 全 false 才选 v3）；execV3 响应绑定 operation/request-id 校验；ResumeMap 白名单严格校验（拒绝未知键含 `identityRevision`）；bridge 的 paused→running 显式映射与 decisions/retry lineage 投影；run-control/run-response v3 操作面收敛。
- 安装：`pi install npm:pi-maestro-flow@0.21.3`。

## v0.21.2（2026-08-14）

- 引擎 pin 升级：`maestro-flow` 0.5.70 → **0.5.71**。0.5.71 为 v3 简化版本：新增决策门（chain step `decision_ref`，未决门阻断 `run next`/`session complete`，escalated 以 concerns 通过，`decide escalate` 不再暂停 Session）；移除 chain-proposal/TC-P0-3 附加输入/22 条退役 stub/resume-map 截断/每次 check 知识对账；移除 participant 实体与命令族（`--participant` 兼容接收）、`identity_revision`、`paused`、gates 系统（receipt 存 `participant_id = actorId`，旧 v3 文件兼容读取）。
- v3 适配更新：删除 participant 预注册预检、bridge 的 identity revision 解析与 gates 投影、`session-pause/resume` 操作面；capability 六键协商不变。
- 安装：`pi install npm:pi-maestro-flow@0.21.2`。

## v0.21.0（2026-08-13）

- API Manager 新增 `api.models`：结构化模型列表，复用各 Provider 的 url/key 配置。
- Cockpit 统一编辑器接管输入历史（原 Flow `history-editor` 移除）：新增 `historyEnabled` 配置与设置开关（默认开启，需 /reload），全屏编辑器区域显示历史 banner。
- Claude 编辑器增强：`unified-editor`、`input-history-store` 测试覆盖与 review findings 修正。
- 安装：`pi install npm:pi-maestro-flow@0.21.0`。

## v0.20.0（2026-08-13）

- Execution-generation 会话模型：`run-response/1.1`、v3 capability negotiation 与 statusless projection。
- Teammate 输出容量治理、immutable publication id、dispatch/消息投递与 observe/retry 加固。
- Compaction hard tool boundary、延迟工具激活、managed Chrome profile 与 Goal verifier 修复。
- Cockpit Zen Stack、可 detach 的 viewport-stability patch。
- 安装：`pi install npm:pi-maestro-flow@0.20.0`。

## v0.18.0（2026-08-09）

**比较范围：** `v0.17.0（撤回） → v0.18.0`
**代码截止：** 2026-08-09

### 1. 打包 Skill 发现修复（v0.17.1 修复并入）

- 恢复打包 Pi 资源（Skills / agents / catalog 条目）在 `pi install` 后物化到已安装插件目录的路径（`prepare-package-skills.mjs`、`maestro-package.ts`、skill-loader / skill-manager / skill-runtime 接线）。
- 新增运行时测试：`package-resources-runtime.test.ts`（资源发现）、`package-resources.test.mjs`（tarball 内容）、`prepare-package-skills.test.mjs`。
- 发布门禁新增真正隔离的 `USERPROFILE` + `HOME` 全新安装验证：运行时 Skill 列表 + 至少一次 Skill 调用。

### 2. Teammate 跨会话投递强化

- WindowThread 投递日志：incoming/outgoing 消息经 `queued → injected → accepted/rejected/timeout` 状态机流转，重投幂等，线程条目跨 reload 持久。
- workspace-peer 消息携带 `source`（user/monitor/system）、`messageKind`（message/supervision）、`traceId`、`replyTo`、`fromSessionName` 元数据；主会话投递使用格式化渲染（`formatWorkspaceRemoteRootMessage`）。
- 入站 root 队列重放（`shouldReplayWorkspaceRootQueue`）：extension reload 后排队中的 peer 消息重新投递，不再丢失。
- Monitor 干预投递确认：`InterventionDeliveryAck` 带重试与过期检测（`sendInterventionWithRetry`）。
- 跨会话 `abort` 请求显式拒绝并返回明确错误，不再静默忽略。
- 新增/更新测试：session-core、workspace-peers、monitor-runtime、monitor-supervision、session-mode。

### 3. Settings-Core 0.1.3（解除 deprecated）

- 代码无变更，仅版本 bump 解除撤回时留下的 deprecated 标记，闭包安装无警告。

### 4. 选装 Scholar 技能套件

- `optional/skills/scholar-*`：10 个选装学术技能（构思、实验、写作、评审/回复、引用验证、去 AI 痕迹、LaTeX 整理、会议发表、学位论文 Word）。
- 默认不进入安装面；`maestro install toggle --enable <skill>` 启用，详见 `optional/skills/README.md`。

### 5. 文档

- 文档站新增 Self-Evolve 指南页（中/英）；Landing 功能卡更新；changelog 记录撤回与 v0.18.0。
- 所有安装命令更新为 v0.18.0。

**升级：**

```bash
pi install npm:pi-maestro-flow@0.18.0
pi list
```

已安装 v0.17.0 的用户直接覆盖安装，不要先运行 `pi remove`。

---

## v0.17.0 撤回说明（2026-08-09）

发布后发现：部分全新 npm 安装启动 Pi 后没有可用 Skill。为阻止新的故障安装，完整发布闭包已从 `latest` 回退：

| 包 | 已撤回版本 | 当前 `latest` |
|----|-----------:|--------------:|
| `pi-maestro-flow` | `0.17.0` | **`0.16.0`** |
| `pi-maestro-teammate` | `1.10.0` | **`1.9.0`** |
| `pi-cockpit` | `0.12.0` | **`0.11.0`** |
| `pi-maestro-settings-core` | `0.1.2` | **`0.1.1`** |

npm 因当前 granular token 不具备 2FA 保护下的 destructive unpublish 权限而拒绝物理删除；四个版本仍保留用于审计，但均有 deprecated 警告且不再被 `latest` 解析。

在线 tarball 对比显示 Flow `0.16.0` 和 `0.17.0` 都包含 194 个 Skill 条目，因此问题不是简单的包内文件缺失，安装注册/路径同步/运行时发现链仍在调查。修复版发布前必须使用真正隔离的 `USERPROFILE` 与 `HOME` 验证 Skill 列表和至少一次实际调用。

已安装用户请关闭所有 Pi 进程后直接降级：

```bash
pi install npm:pi-maestro-flow@0.16.0
pi list
```

不要先执行 `pi remove npm:pi-maestro-flow`，它可能卸载共享 npm 目录中的整个依赖树，使 Cockpit/Teammate 的绝对路径注册指向不存在位置。

---

## v0.17.0（已撤回，2026-08-09）

**比较范围：** `v0.16.0 → v0.17.0`  
**代码截止：** 2026-08-09  
**主题：** 跨会话调度、持久监控监督、共享 TUI 语言、会话切换与运行循环加固

### 版本矩阵

| 组件 | v0.16.0 | v0.17.0 | 变化 |
|------|---------|---------------|------|
| `pi-maestro-flow` | `0.16.0` | `0.17.0` | 编排、Self-Evolve、运行循环、API Manager |
| `pi-maestro-teammate` | `1.9.0` | `1.10.0` | 跨会话调度、Monitor、路由与会话 UI |
| `pi-cockpit` | `0.11.0` | `0.12.0` | Agent/Window Bar、会话 Tab、窗口监控 |
| `pi-maestro-settings-core` | `0.1.1` | `0.1.2` | 共享 locale 与翻译契约 |
| `maestro-flow` | `0.5.65` | `0.5.67` | Run/Session 链路和参数传递修复 |

运行环境仍要求 Node.js `>=22.19.0`。Pi 核心包由宿主提供，开发验证基线保持 `@earendil-works/pi-*@0.83.0`。

## 核心变化

### 1. 跨会话 Scheduler 与 Sessions Core

Teammate 新增跨会话调度和会话注册内核。Monitor 不再必须依附于发起任务的当前交互会话，可以使用独立会话持续观察同一工作区中的 Agent 和窗口。

- 新增 `SchedulerCore`，统一管理跨会话任务排队、唤醒和结果回传。
- 新增 Sessions Core，维护会话端点、窗口模式注册表和宿主可达性。
- Flow 侧增加跨会话结果发布与 output-store acknowledgement，结果被消费后有明确确认边界。
- 每轮发布都带持久 publication id；重试或重复观察同一结果时，调用方可以幂等处理，避免重复入库或重复呈现。
- Cockpit 改为从会话端点读取 Agent 和 Window 状态，为会话 Tab、窗口切换和独立 Monitor 提供统一数据源。

这项变化主要改善长时间、多窗口和跨会话工作流。相关概念见 [Monitor 跨会话监督](/guides/monitor)、[并行多智能体调度](/guides/teammate-dispatch)、[Advisor 逐轮监督](/guides/advisor)和 [Pi Cockpit 可视化](/guides/cockpit)。

### 2. 持久 Monitor 监督与闭环干预

Monitor 从临时观察层升级为持久监督运行时。

- 监督事件写入持久 ledger，会话重载后仍可恢复上下文。
- 新增确定性的 Monitor Controller，负责租约、会话模式和干预状态转换。
- 支持闭环干预：检测停滞或方向偏移后，生成建议并通过受控通道反馈给正在运行的 Agent。
- Advisor 提供逐轮质量检查，可结合目标和约束判断当前回合是否需要纠偏。
- Stall 通知按 Agent 冷却时间节流，持续停滞不会在调用方界面重复刷屏。
- Monitor 可运行在独立会话中，不占用主交互会话的执行生命周期。

### 3. Teammate 派发、路由与控制中心

本版本扩展了 taskType 和模型路由能力，并提高失败恢复的可预测性。

- **自定义 taskType：** Agent 可声明项目级任务类型；Control Center 会把这些类型与内置 `explore / analysis / debug / planning / development / review / testing / verification` 一起呈现。
- **路由上下文：** 模型选择会携带 Agent、任务类型、会话模式和调用来源上下文，便于应用精确的项目策略。
- **Role Circuit Policy：** 模型或角色连续失败后进入受控熔断状态，避免在已知失败路径上无限重试。
- **最大思考级别：** Control Center 可直接选择 `max`；它作为 `xhigh` 的别名进入现有思考深度优先级。
- **并发限流重试：** concurrency-limit 类错误现在归类为可重试错误；退避上限可配置，不再立即把瞬时容量限制当作任务失败。
- **观察增强：** `observe` 增加 turns 视图、Monitor 模式上下文和转录分组，适合检查某一会话的完整轮次历史。
- **会话交接：** `Alt+R` 打开会话列表，可将当前操作交接到目标会话，并保留 routing、monitor 和 turns 上下文。
- **Reviewer 角色：** 项目 Agent 目录新增只读代码审查角色。
- **协议一致性：** 工具描述与参数 schema 对齐，Todo 用法冲突和重复描述已消除。

调用参数和优先级见 [并行多智能体调度](/guides/teammate-dispatch)与[模型路由与思考深度](/guides/model-routing)。

### 4. Cockpit 会话与窗口界面

Cockpit 的状态展示从单一会话组件扩展为基于 endpoint 的 Agent/Window 工作区视图。

- 新增 Agent Bar 和 Window Bar，分别汇总执行中 Agent 与可交接窗口。
- 新增会话 Tab 和会话 UI 状态存储，切换时保持所选会话和面板状态。
- 支持从会话列表交接、窗口监控和相关快捷键重排。
- Window Thread View 可查看目标窗口的会话线程，而不需要离开当前 Cockpit 上下文。
- 输入路由、Overlay、Sidebar 与 Split Pane 统一适配新会话状态。
- 编辑保护失败现在返回更具体的诊断信息，便于区分文件冲突、写入失败和保护规则拒绝。
- Cockpit 文案跟随共享 TUI locale，切换语言后无需重启。

### 5. 共享 TUI 语言与翻译目录

Settings Core 新增公共 i18n 契约，Flow、Teammate 和 Cockpit 使用相同 locale 来源，同时保留各自的翻译目录。

- 系统语言检测遵循 `LC_MESSAGES → LANGUAGE → LANG → Intl` 的优先顺序。
- 公共 translator 支持基础目录与包级目录合并；Teammate 和 Cockpit 不再各自猜测语言。
- 在设置面板切换语言后，现有 locale 事件会通知所有伴随扩展更新界面。
- Flow、Teammate 和 Cockpit 在 quit/reload 时释放监听器，防止重载后重复应用语言事件。
- zh-CN 目录保留 `taskType`、`thinking`、Provider、Agent 等协议标识符原文，避免翻译后无法与配置键对应。

设置结构见 [设置系统总览](/guides/settings-overview)与 [TUI 操作指南](/guides/tui-guide)。

### 6. Self-Evolve 自动沉淀模式

Self-Evolve Phase 2B 增加 `auto-deposit` 模式，同时保留 `dry-run` 作为审慎默认路径。

- CLI staging gate 在真正写入候选前检查运行模式和候选资格。
- 当前会话可在 `dry-run` 与 `auto-deposit` 之间切换，不需要重启扩展。
- 自动沉淀仍受知识候选质量门、证据和后续 review/promote 治理约束；开启该模式不等于自动发布知识。
- 深度模拟和端到端验证覆盖模式切换、候选生成和失败回退。

知识候选生命周期与完整操作见 [Self-Evolve 自进化](/guides/self-evolve)和[知识系统](/guides/knowledge)。

### 7. API Manager 模型迁移与请求头预设

- API Manager 支持重命名模型 ID，并同步迁移引用该 ID 的下游配置，减少手工修复 failover、映射和 Agent 配置的遗漏。
- Channel 配置新增 Agent header presets，可选择 Claude Code、Codex、Grok、Antigravity 等常用请求头组合，也可继续使用自定义 headers。
- 迁移操作在配置边界验证新旧 ID，避免目标冲突或产生悬空引用。

详细设置见 [API Provider 与模型故障转移](/guides/api-provider-config)。

## 稳定性与问题修复

### 运行循环与 Compaction

- 会话 reload 后重新挂载 Loop Scheduler，并恢复持久化循环。
- Compaction 替换消息时保留 loop-critical 标记，避免关键循环状态在摘要替换后丢失。
- 达到 hard compaction 阈值后，在第一个安全工具边界中断循环，避免继续扩张上下文。
- 修正输入历史 route sigil 的编辑和长内容渲染截断。

参见 [Compaction 容量管理](/guides/compaction-config)和 [bash_bg 与 observe](/guides/bash-bg-observe)。

### 工具与平台兼容

| 范围 | 修复 |
|------|------|
| `bash_bg` | 前台执行自动转后台时返回一致的状态快照，调用方可立即交给 `observe` |
| Browser | `browser run` 失败信息包含可操作原因，不再只返回泛化错误 |
| Windows 打包 | 本地 tarball 枚举使用 `--force-local`，避免路径被误判为远程规范 |
| Teammate | 并发限制进入重试分类，退避上限可调；stall 通知按 Agent 冷却 |
| zh-CN TUI | 协议关键字保持英文标识，防止 UI 标签与配置值不一致 |
| Cockpit 编辑保护 | 写入失败展示更精确的原因和目标上下文 |

## Core Engine 0.5.65 → 0.5.67

`pi-maestro-flow` 的候选清单把 `maestro-flow` 精确 pin 从 `0.5.65` 更新到 `0.5.67`。

- **0.5.66：** Run Session 支持 line-delimited artifact metadata。
- **0.5.67：** 所有 Session 创建路径注册 projection；补充 enum 参数校验和 session prune；chain-file 启动保留 step args 与显式 topic；chain dispatch 透传 `--arg`，失败 Session 保持 canonical 可达。

这是精确依赖升级，现有安装不会自动跟随上游版本。升级套件时应一起核对 Flow 与 Core Engine 版本。

## 行为变化与升级注意事项

1. 升级前关闭所有正在运行的 Pi 进程，避免旧 SettingsManager 把内存中的旧配置写回磁盘。
2. 伴随扩展仍按 **Teammate → Cockpit → Flow** 的顺序注册；重启后使用 `pi list` 核对全部版本。
3. TUI 语言切换现在会同步影响三个扩展。自定义目录中的协议键应保留原始英文标识。
4. 使用独立 Monitor 会话时，确认目标工作区可见且会话端点仍在注册表中。
5. 模型 ID 重命名会迁移下游引用；执行后仍应检查自定义脚本或外部文件中的字符串引用。
6. `auto-deposit` 只自动生成候选，不绕过 evidence、review 或 promote 治理。
7. Core Engine 使用精确 pin；不要只升级伴随包而保留旧的 Flow 依赖闭包。

已安装 v0.17.0 的用户请回退：

```bash
pi install npm:pi-maestro-flow@0.16.0
pi list
```

当前 `latest` 已解析到 0.16.0；不要先运行 `pi remove npm:pi-maestro-flow`。

## 关键提交索引

| 提交 | 主题 |
|------|------|
| `11e26d28` | 持久 Monitor 监督、ledger、闭环干预与 Advisor |
| `56d291b3` | 跨会话 Scheduler/Sessions Core |
| `9e2803f6` | 跨会话结果发布、output-store ack、SchedulerCore loop |
| `6431d9f8` | endpoint 驱动的 Agent/Window Bar 与会话 Tab |
| `fa97c02f` | 会话列表交接、窗口监控与快捷键调整 |
| `86152333` | Self-Evolve auto-deposit Phase 2B |
| `7eb22395` | API Manager 模型 ID 重命名及下游迁移 |
| `3a870ea1` | 共享 TUI locale 与包级翻译目录 |
| `3287b757` | Role Circuit Policy、自定义 taskType、路由上下文 |
| `6bcb9fca` | observation turns、Monitor 上下文与转录分组 |
| `afb9dbda` | `Alt+R` 会话列表交接 |
| `8e4c3d38` | Cockpit 编辑失败诊断 |
| `f021f083` | `release: v0.17.0`（发布提交） |

仓库维护方面，pipeline 输出迁移到 `.pi-sync`，旧的受版本控制 `flow/` 镜像被移除。这会改变源码仓库布局，但不改变 npm 包中的用户功能。

### 发布前验证与缺口（2026-08-09）

- 串行根 `test:release` 门禁全绿（3140 ok / 0 fail，含 settings-core、teammate declarations、cockpit、flow 全子系统与 packed 消费者测试）。
- 四包 dry-run shasum 与 npm registry 逐一比对一致：settings-core `0.1.2` `a94722d4`、teammate `1.10.0` `9f5a5651`、cockpit `0.12.0` `0d9521d2`、flow `0.17.0` `7330fed7`。
- 原 fresh 用户目录 smoke 只确认版本矩阵与 RPC 启动，没有断言安装后的 Skill 被 Pi 实际发现和可调用；该缺口导致发布门误判。
- 下一修复版必须在隔离 `USERPROFILE` + `HOME` 中验证 Skill 列表和至少一次真实 Skill 调用。
- 原发布顺序为 settings-core → teammate → cockpit → flow；`maestro-flow` 精确 pin `0.5.67`。

版本详情可查看仓库中的 `RELEASE.md` 与 GitHub [`v0.17.0` Release](https://github.com/catlog22/pi-maestro-flow/releases/tag/v0.17.0)。

---

## v0.16.0（2026-08-07）

v0.16.0 引入完整的 in-shell 设置套件、会话级知识治理、Window Transcript evidence staging、Self-Evolve M1-M5、Todo 绑定派发、`agent://` 结果记录和 Compaction 压力加固。

| 组件 | 版本 |
|------|------|
| `pi-maestro-flow` | `0.16.0` |
| `pi-maestro-teammate` | `1.9.0` |
| `pi-cockpit` | `0.11.0` |
| `pi-maestro-settings-core` | `0.1.1` |
| `maestro-flow` | `0.5.65` |

主要变化：

- 设置操作完整留在 Shell 内，API Manager、Hooks、主题、Provider、Failover 和 Vision Provider 不再跳转旧 picker。
- Teammate task 可绑定 Todo，Agent 接管任务归属并推进注入队列。
- 普通和结构化 Agent 结果统一通过 `agent://` 读取。
- 知识系统加入会话级治理、窗口 transcript evidence 和 K12-K17 审核流程。
- Self-Evolve 完成 M1-M5 自动化层和并行会话基础设施。
- Compaction 增加工具循环压力终止、摘要重试、网关熔断和僵尸租约修复。
- Core Engine 0.5.63 移除存在安全风险的旧 Sharp 运行链，0.5.64-0.5.65 增强知识治理与证据审计。

版本详情可查看仓库中的 `RELEASE.md` 与 GitHub `v0.16.0` Release。
