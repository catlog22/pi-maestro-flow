---
kind: plan
status: drafted
scope: pi-maestro-flow 插件扩展（源自 oh-my-pi 功能盘点）
analyzed: 2026-08-03（多 agent：2×explorer 盘点 + 2×analyst 评分/可行性验证）
sources:
  - G:\github_lib\oh-my-pi（@oh-my-pi/pi-coding-agent v16.3.11，fork 自 badlogic/pi-mono，同步点 b21b42d）
  - D:\pi-maestro-flow\packages\{pi-maestro-flow, pi-maestro-teammate, pi-cockpit}（flow 0.14.2）
  - 宿主 @earendil-works/pi-coding-agent 0.82.1/0.83.0 扩展类型声明
related:
  - docs/advisor-vs-monitor-relationship-20260803.md
  - docs/supervision-unification-analysis-20260803.md
---

# oh-my-pi → pi-maestro-flow 插件扩展方案（可行项落地方案）

## 0. 结论速览

oh-my-pi 是 Pi 的强化 fork，与插件宿主 `@earendil-works/pi-coding-agent` 同源 → **其"深耦合 session"功能大多可经宿主插件 API 达成**。盘点 45 项功能后：**9 项可做（Tier 1 三项 + Tier 2 六项），零新增重依赖**；Rust core 深埋项（bash/grep/ast-grep/iso）与 TT-SR/collab/ACP 不做。

**关键宿主事实（全部已实证，`node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/types.d.ts`）**：

| 事实 | 证据 | 含义 |
|---|---|---|
| `tool_call` 事件 `event.input` 可变 | types.d.ts:676-684（"Mutate it in place to patch tool arguments"） | 权限拦截（plan 只读边界/5 模式授权，现有实现）的机制；T1-1/T2-3 已改为独立工具不再依赖（见 §3 决策） |
| 内置工具可被同名重注册覆盖 | 宿主 `agent-session.js:1946-1997`（`toolRegistry.set` 同名替换）+ cockpit `quiet-tools.ts:328-370` 活先例 | 可接管 read/edit，但**不可反注册**（关闭需 /reload，`quiet-tools.ts:18-20`） |
| `block:true` 中止 / `AbortSignal` / 完整 turn I/O | types.d.ts（ToolCallEventResult、TurnStart/End、ToolExecutionStart/Update/End） | advisor / 监督类功能的事件底座 |
| 会话树操作 `fork/navigateTree/switchSession` | types.d.ts:233-262 | checkpoint/rewind 的宿主等价物 |
| 生命周期事件超出清单 | types.d.ts:850-920（`session_before_tree`、`turn_end`、`message_end`、`after_provider_response`、`model_select` 等） | 扩展挂载点多于预期 |

---

## 1. 缺口 / 重叠 / 不可行分类

### 1.1 真实缺口（本方案范围）

| 功能 | oh-my-pi 参考实现 | 插件现状 |
|---|---|---|
| 内部 URL scheme（pr:// issue:// agent:// skill:// 等 13 种） | `internal-urls/router.ts:45-69`；`tools/read.ts:2172-2184` | 无任何 scheme 路由 |
| 结构化代码审查 /review（P0-P3 + verdict） | `custom-commands/bundled/review/index.ts`；`tools/review.ts:20-38`；`prompts/agents/reviewer.md` | 仅有"会话导出型" `markdown-review-command.ts`，非代码审查 |
| web 站点化提取器（~80 scrapers） | `web/scrapers/`（arxiv/github/nvd/osv/cisa/stackoverflow…） | `web-access/extract.ts` 仅 6 类站点（github/rsc/pdf/youtube/video/curator） |
| hashline 哈希锚点编辑 | `packages/hashline/src/`（recovery + 四种 stale-anchor 恢复，`messages.ts:156-181`） | 无 |
| DAP 调试（lldb-dap/dlv/debugpy 等） | `dap/defaults.json`（全部为**外部 adapter + 纯 TS JSON-RPC client**） | 无调试工具 |
| conflict:// 冲突解决 | `tools/conflict-detect.ts:245-313,500-611`；`tools/write.ts:566-853` | 无 git 冲突处理 |
| omp commit 原子拆分 | `commit/agentic/` + `topo-sort.ts:3-40`（依赖排序 + 环拒绝） | 无 commit 工具 |
| 多格式规则导入 | `discovery/`（cursor/cline/codex/agents-md… 8+ 格式） | 有 Codex 兼容 hooks + skills，但无格式转换导入 |
| Hindsight 轻量记忆 | `hindsight/`（backend/bank/client）+ `packages/mnemopi`（SQLite） | `knowledge/` 是只读语义搜索适配，无 retain/recall 工具 |
| checkpoint/rewind | `tools/checkpoint.ts:19-45`；session 消息截断 | 仅有 compaction 子系统，无命令级 checkpoint |

### 1.2 能力重叠（仅增强，不重复建设）

- **LSP writethrough**：插件 `tools/lsp-tool.ts:265-319` 已实现 `workspace/willRenameFiles → didRenameFiles → 多服务器 applyWorkspaceEdit` 全流程。仅剩"edit 后诊断回写"微增强。
- **approval 权限**：插件 `permissions/controller.ts:59-70` 5 模式已覆盖 oh-my-pi `tools/approval.ts`。
- **MCP**：插件 `mcp/`（manager/oauth/proxy/tool-registrar）已覆盖。
- **web_search 供应商链**：插件 11 家（`web-access/search-router.ts:13-24`）vs oh-my-pi 18 家 → 只需补供应商，不必移植链。
- **task 子代理**：插件 teammate（子进程 + DAG + 模型路由 + observe）**强于** oh-my-pi task（其隔离还需 Rust iso）。
- **stats 面板**：插件已有 effort-display/statusline/pressure-telemetry，聚合面板增量价值小。

### 1.3 不可行 / 不做（记录理由）

| 功能 | 理由 |
|---|---|
| bash/grep/glob/find/ast-grep/iso/sixel/tokenizer 原生实现 | Rust core（pi-natives N-API addon）深埋；且宿主内置 + 插件 fff（`@ff-labs/fff-node`）已覆盖 |
| TT-SR 时间旅行流规则 | 内嵌 `session/agent-session.ts:749,1753,3028`；插件只能近似 tool_call/input 拦截 + 正则注入（留 Tier 3） |
| collab / ACP | 需外部 relay 服务器 / Zed 驱动，超出插件范畴 |
| eval 双内核 | loopback 宿主工具回调深耦合（Bun API）；仅"无回调 v1"可移植（Tier 3） |

---

## 2. 三维评分矩阵（1-5；增量成本分越高越省力）

| # | 功能 | 价值 | 可行性 | 增量成本 | 总分 |
|---|---|---|---|---|---|
| d | internal-urls 内部 URL scheme | 4 | 5 | 5 | **14** |
| a | 结构化代码审查 /review | 5 | 4 | 4 | **13** |
| b | web 站点化提取器 | 4 | 4 | 4 | **12** |
| c | hashline 哈希编辑 | 5 | 3 | 3 | 11 |
| e | DAP 调试工具 | 4 | 4 | 3 | 11 |
| f | conflict:// 冲突解决 | 3 | 4 | 4 | 11 |
| h | omp commit 原子提交 | 4 | 4 | 3 | 11 |
| k | 多格式规则导入 | 3 | 4 | 4 | 11 |
| l | Hindsight 轻量记忆 | 4 | 4 | 3 | 11 |
| j | checkpoint/rewind | 4 | 3 | 3 | 10 |
| g | advisor 第二模型监督 | 3 | 3 | 2 | 8 |
| i | eval 持久内核 | 3 | 3 | 2 | 8 |

---

## 3. Tier 1 — 强烈推荐（收益高 × 路径已验证）

### T1-1 内部 URL scheme（pr:// issue:// skill:// …）⭐ 最高性价比

> **决策（2026-08-03）**：采用**独立 `resource` 工具**，弃用 tool_call 拦截 read。理由：①拦截是隐形魔法，模型不知道哪些 scheme 可用、格式错了行为不可预期（歧义）；②拦截 `block:true` 只能中止、不能返回内容，合成内容必须物化临时文件；③宿主 read 是纯文件工具（`ReadToolInput = {path, offset?, limit?}`），悄悄改写会破坏模型的 read 心智模型；④独立工具可自定义 renderCall/renderResult、可被 search_tool_bm25 检索激活，可观测性好；⑤无覆盖/顺序风险（Q1/Q2 不再阻塞）。
>
> **实施状态（2026-08-03）✅ 已实现**：`src/tools/resource.ts`（resource 工具）+ 注册（`extension/index.ts` registerResourceTool + RESOURCE_TOOL_GUIDANCE 系统提示引导、`plan.ts` 只读白名单、`policy.ts` ALWAYS_ALLOWED、`gui-registry.ts` GUI 名单）+ 测试 `test/resource.test.ts`（13 例含 site 套件，全部通过）。

- **价值**：模型已习惯读 URL；`resource` 工具接受 `pr://owner/repo/123`、`issue://…`、`skill://…`、`rule://…`、`agent://…`，把 GitHub/内部资源获取从"先 bash 再读"降为一步。
- **实现形态**：新工具 `resource`（`registerTool`），一个工具覆盖全部只读 scheme。
  ```typescript
  pi.registerTool({
    name: "resource",
    description: "通过 URI scheme 读取资源：pr://owner/repo/N、issue://owner/repo/N、skill://name、rule://name、agent://id/findings.0.path。GitHub 类走 gh CLI + 缓存；本地类直接解析。读本地文件用 read。",
    parameters: { uri: "string" },
    execute: async ({ uri }) => { /* 注册式路由表分发 */ }
  })
  ```
  - 路由子集优先级：`pr://` / `issue://`（gh CLI 已有 `web-access/github-api.ts:15-33`，可加 SQLite 缓存）→ `skill://` / `rule://`（本地文档，直接解析）→ `agent://`（已实现，见下）→ `memory://`（预留）。

> **扩展（2026-08-03）✅ agent:// 已实现**：`src/teammate/agent-output-store.ts`（结构化输出持久化：`<cwd>/.pi/agents/<correlationId>.json`，0600 私有权限、100 文件上限按 mtime 淘汰、512KB 输出上限）+ flow 的 `tool_result` 钩子捕获 teammate 结果（`details.results[].structuredOutput`，仅 toolName=teammate，捕获失败静默不破坏工具执行）+ resource 的 `agent://<correlationId-or-name>[/json/path]` 路由（JSON 路径取值：hasOwnProperty 防原型链、深度 ≤10、路径 miss 报精确原因）。测试 `test/agent-output-store.test.ts`（7 例）+ resource agent:// 端到端 2 例。
- **消除歧义的配套措施**：
  - `before_agent_start` 系统提示追加一行："PR/issue/技能等协议资源用 `resource` 工具，`read` 只读本地文件"——把边界说死；
  - 只读 scheme 走标准新工具流程，权限分类直接归 ALWAYS_ALLOWED；
  - `conflict://` 拆为独立 `conflict` 工具（见 T2-3），**不共用** resource，避免一个工具既读又写造成二义。
- **风险**：模型需认识新工具（description + 系统提示缓解）；gh 未安装时的降级提示。
- **参考**：oh-my-pi `tools/read.ts:2172-2184` 的 scheme 分发逻辑（迁移到独立工具的 execute 内）。

### T1-2 结构化代码审查 /review（P0-P3 + verdict）

- **价值**：审查是编码 agent 最高频高价值任务；当前插件没有 diff 驱动、多 reviewer、带优先级 verdict 的代码审查。
- **实现形态**：新 `registerCommand("review")` + 可选 `review` 工具。
  1. git diff 提取（`--cached` / `base...HEAD`）+ 噪音过滤（参考 oh-my-pi EXCLUDED_PATTERNS）；
  2. 按 diff 权重分片；
  3. 并行派发 teammate（analyst 角色，`pi-maestro-teammate/v1/execution` `runGraph`，环检测已有 `runs/execution-infra.ts:686`）；
  4. 结构化输出 P0-P3 + confidence + verdict（复用 `structured_output` 先例）；
  5. `ctx.ui.custom` 聚合面板（复用 `tui/markdown-review-overlay.ts` 交互模式）。
- **风险**：长 diff token 成本；reviewer 输出质量方差（用 JSON schema 约束 + 已有 `PI_TEAMMATE_STRUCTURED_OUTPUT_PATH` 通道）。

### T1-3 web 站点化提取器升级 smart_search

> **实施状态（2026-08-03）✅ 已实现**：`src/tools/web-access/site-extract.ts`（注册式分发 + arXiv abs / Stack Overflow / NVD CVE / OSV / CISA KEV 五个站点提取器，全部走 SSRF 原语 fetchRemoteUrl）+ 接入 `extract.ts` extractContent（GitHub 提取后分发，miss/失败回退通用管线）+ 测试 `test/site-extract.test.ts`（本地 HTTP server + setSiteApiBaseOverride seam，7 例通过）。smart_search native 路径自动受益。

- **价值**：当前提取器对 arXiv/GitHub/SO/NVD/OSV 返回裸 HTML/摘要；站点化结构化 markdown 显著提升安全/依赖类问题回答质量。
- **实现形态**：**增强现有**，非新建系统。
  - `web-access/extract.ts` 注册式分派表追加站点解析器（纯 TS fetch+parse）；
  - 接入 `fetch-router.ts` 与 smart_search 的 `native: true` 模式（`smart-search.ts:166-172` → `executeNativeFetch` :282-302）；
  - 首批高价值站点：**arXiv / Stack Overflow / NVD / OSV / CISA-KEV**（5 个）。
- **风险**：站点结构漂移维护成本；与既有 github-extract/rsc-extract 的重复；NVD/OSV 字段 schema 需固定。零新依赖（unpdf/readability/turndown 已在树内）。

---

## 4. Tier 2 — 值得做（价值确定，成本/风险中等）

### T2-1 hashline 哈希锚点编辑

- **价值**：编辑可靠性是 agent 最大痛点（oh-my-pi 案例：205 次调用中 182 次 no-op）。
- **实现形态**：**推荐新工具** `hashline_edit`（避免覆盖内置 edit 的不可逆副作用）。
  - 解析 `path#L42-58` 锚点 → 内部读文件 + 定位 + `oldText/newText` 替换 + stale-anchor 恢复（参考 `hashline/recovery.ts` 四种恢复模式）。
  - 引擎可引 `@oh-my-pi/hashline` 包（纯 TS）或移植核心 recovery 逻辑。
- **风险**：新工具必须登记 plan 白名单（`plan.ts:656-698`，否则 plan 模式全被拦）+ 权限 `policy.ts:66-74` 分类；Q1 未决（同名覆盖行为）不阻塞——路径 A（新工具）不依赖该前提。

### T2-2 DAP 调试工具

- **实现形态**：新 `tools/dap/` 目录。
  - `DapClient`：仿 `tools/lsp/client.ts` 架构（spawn `cross-spawn` 三管道 :88-93、pending request map :56-74、超时/abort :206-230）但**换行分隔 JSON 帧**（LSP 是 Content-Length 帧，`client.ts:332-337`，需新写帧解析）；
  - `DapManager`：按进程 root 去重（仿 `manager.ts` `#getOrCreate`）；
  - `dap` 工具：initialize/launch/attach/breakpoints/continue/threads/stackTrace/stop；
  - adapter 为外部进程（debugpy/lldb-dap/dlv，用户 PATH），插件只 spawn；
  - 会话结束 `pi.sendMessage(triggerTurn:true)` 唤醒（仿 `bash-bg.ts:391-412`）。
- **零新依赖**：DAP 协议可手写；`vscode-debugprotocol` 可选（纯类型）。
- **风险**：adapter 未装需探测 + 降级提示；帧解析与 DAP 方法集是新工作。

### T2-3 conflict:// 冲突解决

> **决策（2026-08-03）**：与 T1-1 一致，做成**独立 `conflict` 工具**（读+写），不再共用拦截层。
>
> **实施状态（2026-08-03）✅ 已实现**：`src/tools/conflict.ts`（`conflict` 工具：list / diff / resolve 三 action + `conflict://N` 编号 + `conflict://*` 批量；检测走 `git diff --name-only --diff-filter=U` + 冲突标记解析；resolve 支持 `@ours`/`@theirs`/自定义文本；`@base` v1 不支持——引导用 `git show :1:<path>`；偏移校验防扫描后变更）+ 注册同步税四件套（extension registerConflictTool、plan 白名单 list/diff 放行 resolve 阻止、policy action-aware、GUI 名单）+ 测试 `test/conflict.test.ts`（12 例：解析/扫描/list/diff/resolve 单条+自定义+批量/权限策略）。

- **实现形态**：新工具 `conflict`（list/diff/resolve/ours/theirs 四 action）。
  - list：git 检出 → 冲突文件列表；
  - diff：逐文件解析冲突标记（`<<<<<<<`/`=======`/`>>>>>>>`），渲染三方内容（参考 `conflict-detect.ts:245-313`）；
  - resolve：解析 `conflict://N` 与 `@theirs`/`@ours`/`@base` 简写拼接（参考 `write.ts:566-853`，含 `recoveredPrefix` 容错 :842-853）；
  - 写回走标准 edit/write 权限链。
- **风险**：与真实文件路径混淆（LLM 学习成本）；协议复杂度；读+写双语义需在 description 中写清。

### T2-4 omp commit 原子拆分提交

- **实现形态**：新 `commit` 工具/命令。
  - `git diff` 读工作树 → 按 hunk 分组 → LLM 拆分提案（含依赖声明）→ topo 校验（环拒绝，参考 `topo-sort.ts:3-40`）→ dry-run 预览 → 依序 `git apply --cached` + 每 commit 独立消息；
  - 源文件优先、lock 文件排除；失败 `git reset` 回退；
  - 长操作走 bash_bg。
- **风险**：**必须强制走 permissions 授权**（`permissionController.authorize`）；hunk 粒度边界情况。

### T2-5 多格式规则导入

- **实现形态**：新 `registerCommand("import-rules")`：解析 Cursor `.mdc` / Cline `.clinerules` / Codex `AGENTS.md` / `.cursorrules`（参考 `discovery/cursor.ts`/`cline.ts`/`codex.ts`/`agents-md.ts` 解析器结构）→ 转换为现有 hooks 配置（`hooks/schema.ts` CODEX_HOOK_EVENTS 模型）或 skill 文件。
- **风险**：跨格式语义丢失（需映射表 + 导入报告）。

### T2-6 Hindsight 轻量记忆

- **实现形态**：新 `memory` 工具（retain/recall/reflect 三 action）+ SQLite 后端（参考 `packages/mnemopi` schema 或引包）+ `session_start`/`session_shutdown` 持久化 + `agent_end` 可选自动 reflect。
- **风险**：**必须严格限定 recall 返回长度与保留策略**（防上下文膨胀）；与现有只读 knowledge 系统（`knowledge/cli-adapter.ts`）形成"写记忆 vs 读规范"分工。

### T2-7 checkpoint/rewind

- **实现形态**：命令级软实现（**语义降级为"分支导航"而非"时光倒流"，需向用户明示**）。
  - checkpoint：`appendEntry` 存 {entryId, goal, git HEAD/tag} + `setLabel` 标记；
  - rewind：`ExtensionCommandContext.fork(entryId)` / `navigateTree`（types.d.ts:233-262）+ 恢复 git 状态；
  - 复用 `compaction/auto-compaction.ts:90-93` 既有 checkpoint manifest 机制。
- **风险**：rewind 产生新分支而非原地截断；需与 Plan/todo 状态联动。

---

## 5. Tier 3 — 备选（低价值/高成本/强外部依赖）

| 项 | 判断依据 |
|---|---|
| advisor 第二模型逐轮监督 | 事件+delegate 可近似（`turn_end`/`tool_result` → 第二模型 → `context` 钩子链尾注入），但每轮延迟/成本翻倍；已有 goal 验证 + run-control 监督稀释增量价值。**建议只做 agent_end 低频监督**；与 Monitor 的关系见 `docs/advisor-vs-monitor-relationship-20260803.md` |
| eval 持久内核 | NDJSON runner 可移植（Bun API → node:child_process），但 loopback 工具回调深耦合；建议只做"无回调执行内核"v1。注意 bash_bg stdin 是 `["ignore","pipe","pipe"]`（`bash-bg.ts:509`）不可 REPL，须仿 LSP 三管道 |
| TT-SR 流规则 | 仅能近似：tool_call/input 拦截 + 正则注入子集 |
| stats 面板增强 | 已部分重叠；聚合面板成本低但增量价值小 |
| LSP writethrough 增强 | 已重叠（lsp-tool.ts:265-319 全流程已有）；仅剩 edit 诊断回写 |
| collab / ACP / Rust natives | 外部服务或 Rust 深埋，不做 |

---

## 6. 横切工程约束（所有新工具必读）

1. **plan 模式白名单**：`plan.ts:656-698` `onToolCallPlan` 对白名单外任何工具返回 `{block:true}`。**新工具（hashline_edit/dap/conflict/commit/memory/checkpoint）必须登记白名单**，否则 plan 模式全被拦。
2. **权限分类**：`permissions/policy.ts:40-78` + `settings.ts` 需同步 ALWAYS_ALLOWED / EDIT_TOOLS 分类（只读前缀如 `pr://` 天然符合 ALWAYS_ALLOWED）。
3. **重注册不可逆**：覆盖内置 read/edit 后无法卸载，关闭需 /reload（`quiet-tools.ts:18-20` 作者注释）。**统一策略：新增独立工具（resource/conflict/hashline_edit/…），避免覆盖内置与 tool_call 拦截**（歧义分析与决策见 §3 T1-1）。
4. **tool_call 拦截注入上限**：`block:true` 只能中止、不能返回内容。**本方案已弃用拦截式资源读取**（T1-1/T2-3 均为独立工具），该约束仅适用于未来可能的 hashline 锚点改写等场景。
5. **注册同步税**：每新工具同步三处——工具 schema + plan 白名单 + 权限分类（`resource` 只读 scheme 归 ALWAYS_ALLOWED）。

---

## 7. 开放问题（实施前需确认）

| # | 问题 | 影响 |
|---|---|---|
| Q1 | 宿主是否允许 `registerTool` 注册与内置同名工具 | T2-1 路径 B（覆盖 edit）；当前推荐路径 A 不依赖 |
| Q2 | ~~`tool_call` 多 handler 的注册顺序语义~~ **已解除**：T1-1/T2-3 改为独立工具后不再依赖拦截链 | 仅未来 hashline 锚点改写等拦截场景需重新评估 |
| Q3 | 插件运行环境 Node vs Bun（`smart-search.ts` 用 Node 风格，宿主若 Bun 运行则 `@oh-my-pi/*` 包能否引入） | 引 hashline/mnemopi 包 |
| Q4 | 插件依赖树是否有 SQLite 驱动 | T2-6 memory 后端选型 |

---

## 8. 建议落地顺序

1. **第一周：T1-1 + T1-3**（纯增量、零风险、见效快）——一个 `resource` 工具（pr:// issue:// skill:// 路由 + gh 缓存）+ 一个站点提取器模块（arXiv/SO/NVD/OSV/CISA 五个站点）。
2. **第二周：T1-2 /review**（复用 teammate 现有基建，MVP 可出）——`/review` 命令 + P0-P3/verdict 输出契约 + overlay。
3. **第三周起：T2 按痛点排序**——hashline（编辑可靠性最大痛点）→ DAP（调试刚需）→ conflict/commit（git 工作流）→ memory/import-rules/checkpoint。
4. 每完成一项，同步更新 plan 白名单 + 权限分类（§6），并补 focused tests。
