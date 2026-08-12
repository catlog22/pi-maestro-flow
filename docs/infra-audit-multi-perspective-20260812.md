# 基础设施多视角审查报告（2026-08-12）

> 多 agent 从不同视角交叉审查基础设施：**teammate 工具、压缩机制、resource 协议、Session/Run 架构、CLI 设计**。
> 方法：5 个并行 reviewer agent（gpt-5.6-sol，只读，结构化输出），各自基于真实会话取证证据包 + 代码/文档验证。
> 证据源：maestro-scholar-v2 会话 `019febc4-2b4c-7372-8537-ef98cf3588b3`（41.9h transcript）→ 证据包 `C:\Users\dyw\.pi\agent\sessions\_infra_evidence\`（evidence-teammate / evidence-compaction / evidence-resource / evidence-sessionrun / evidence-cli）。
> 审查问题集见会话讨论（T1–T7、C1–C6、R1–R6、S1–S7、L1–L6）；后续注入链追踪新增 X1。

## 一、总览：33 项 findings

| 视角 | 数量 | P1(high) | P2(medium) | 关键主题 |
|---|---|---|---|---|
| teammate 工具 | 7 | 3 | 4 | 失败分层、错误不可操作、600s 窗口、崩溃诊断、发布包漏文件、截断、fresh 复用 |
| 压缩机制 | 6 | 3 | 3 | 续接无地图、必保状态无校验、分级预警、恢复重载 brief、后台 agent 未入 checkpoint、cache 违背设计 |
| resource 协议 | 6 | 4 | 2 | agent:// 87% 失败、摘要通道、契约文档缺失、写盘仍截断、缓存时效、ID 解析 |
| Session/Run 架构 | 7 | 4 | 3 | brief 职责耦合、门禁成本、chain 治理、读路径过碎、lease 不稳、seal 需救援、evidence 无容量 |
| CLI 设计 | 6 | 5 | 1 | help 非机器友好、brief 未分层、上下文推导、多命令拼装、命令族重叠、错误不可操作 |
| 提示词/消息注入 | 1 | 1 | 0 | peer 协调消息降级为 user role、来源元数据无权限语义、用户目标被错误覆盖 |

## 二、分视角 findings

### 2.1 teammate 工具（T1–T7）

| ID | Sev | 问题 | 证据 | 根因 | 建议 |
|---|---|---|---|---|---|
| T1 | P2 | 20% 失败率混合三层故障 | 5 次校验失败、1 次 ENOENT、2 次子进程退出 | 调用方/schema、包资源、运行时、provider 重试混在一个统计里，无法定位责任层 | 按 admission/package/spawn/runtime/provider 分桶，记录可重试性与浪费时长 |
| T2 | P2 | 入口校验错误仍不可操作 | index.ts:1954 交宿主校验，execute:1987 才做语义校验 | 参数在 execute 前被宿主拒绝，扩展无法生成修复指引 | 校验 formatter：输出字段、原因、允许值及最小修正版调用 |
| T3 | P2 | 600s 默认前台窗口吞吐成本过高 | 40% 耗尽窗口；teammate-core.ts:775-800 决定 detach | 固定 10 分钟附着预算过长，主会话持续阻塞 | 新增独立 foregroundWaitMs 降至 60–120s；保留完成通知 |
| T4 | P1 | 启动崩溃诊断与降级仍有缺口 | tools=0；execution.ts:1903,1969-1975 stderr 排除可回放 | 崩溃根因未留存；stderr 启动失败被副作用围栏阻断 fallback | 持久化 spawn 参数与 stderr；无 protocol/tool/IPC 时允许一次同模型重启再切 fallback |
| T5 | P1 | 发布包仍会遗漏 default-rules.json | rules.ts:7,28 读 JSON；package.json:93 仅含 src/**/*.ts，npm pack 无该文件 | 运行时规则文件未进发布白名单；工作区存在掩盖了安装包缺失 | config JSON 加入 files；对打包产物做安装后 loadRules 冒烟测试 |
| T6 | P1 | 大文本在持久化前已不可逆截尾 | execution-infra.ts:468-477 单消息限 64KB、526-544 截尾；92KB 截断实证 | agent:// 持久化的是已截断结果，无原文 artifact 与可逆出口 | 流式原文落私有 artifact；内联仅摘要+原始字节数/hash/稳定引用 |
| T7 | P2 | fresh 会话缺少跨 dispatch 复用身份 | index.ts:2069 每次随机 ID；execution.ts:594-598 按 ID 建目录；schemas.ts:82-88 无 reuse 键 | 新 dispatch 无稳定 session identity 或匹配策略 | 显式 sessionKey/reuse/reset，按 role+cwd+model 隔离；默认仍 fresh |

### 2.2 压缩机制（C1–C6）

| ID | Sev | 问题 | 证据 | 根因 | 建议 |
|---|---|---|---|---|---|
| C1 | P1 | 续接消息未内联恢复地图 | auto-compaction.ts:85 仍只发送固定续接句 | checkpoint 已含运行态，续接通道未读取并注入 | 由 checkpoint 生成 ≤2KB 地图卡随续接消息注入，标注 checkpointId |
| C2 | P1 | 必保状态仅靠摘要模型自觉 | maestro-compaction.ts:659-677 要求保留状态，858-865 仅校验摘要非空 | 无章节/ID/阻塞项/下一动作的输出完整性校验 | 解析校验必保字段，缺失重试，最终用 runtimeState 生成保底摘要 |
| C3 | P2 | 分级预警缺少历史回放验收 | 旧会话无预警；auto-compaction.ts:732-743 已有 nudge | 机制已补四档，但无证据证明长会话稳定预警 | 回放 41.9h transcript，断言 nudge→auto-prune→critical 顺序与提前量 |
| C4 | P1 | 恢复默认仍重载重型 brief | 恢复需 4–6 命令；index.ts:1629-1630 默认 run brief | checkpoint 已有 runId/gates/artifactRefs/nextAction，恢复入口未消费 | 用 checkpoint 地图直接续跑；仅版本过期或字段缺失时轻量刷新 |
| C5 | P2 | checkpoint 未登记后台 agent 状态 | maestro-compaction.ts:520-540 无 agent 字段 | 压缩快照与 teammate 结果发布是两条独立异步链，无统一栅栏 | 快照运行中/未消费 agent 及 publicationId；压缩后先对账再仲裁续接顺序 |
| C6 | P2 | cache 行为违背 soft-compaction 定稿 | 设计文档:115,119,140-142 要求默认关；settings.ts:163 默认开 | cache 从 telemetry 升级为决策门（auto-compaction.ts:2125,2267-2268 可否决 prune） | 恢复默认关闭；升级决策门需先发布替代 ADR 与回归 |

### 2.3 resource 协议（R1–R6）

| ID | Sev | 问题 | 证据 | 根因 | 建议 |
|---|---|---|---|---|---|
| R1 | P1 | 持久化是隐含条件而非完成不变量 | 33/38 失败；store.ts:38-39,115,278 有 100 条/512K 条件 | 完成不等于可读；落盘受监听器/序列化/容量约束，失败仅列现有 ID | 完成回执显式返回 persisted、canonical URI 及失败原因；错误附可执行恢复路径 |
| R2 | P1 | 摘要策略缺少独立可靠的全文通道 | 通知中位 608 字且有 65KB 全量；摘要阈值 1200/480 附 URI | 完整性依赖 URI 确认；无确认时回退内联仍暴露于截断 | 通知固定携带状态、预览、字节数和可验证指针 |
| R3 | P1 | agent 协议缺少可发现的规范文档 | tool-schema-reference.md 无 resource 章节；契约仅在运行时描述 | 静态参考落后；失败后无法从文档发现 publicationId/alias 与恢复流程 | 版本化 resource 规范：持久化前置条件、ID 语义、作用域、失败码、恢复决策树 |
| R4 | P1 | 写盘加指针仍不能保证长结果完整读取 | 92KB 内联截断；resource.ts:352-355 200K 截断 | 写盘与读取均有独立上限，文本资源无分页/续读 | 长结果原子落盘+哈希指针；resource 支持 offset/limit，截断响应给续读游标 |
| R5 | P2 | 五分钟缓存状态时效边界不可控 | 5 分钟缓存仅为 ghCache；agent 分支每次读盘 cached=false | PR/Issue 可陈旧 5 分钟；agent 资源不参与 TTL | PR/Issue 增加 force-refresh/ETag 并返回 cachedAt/expiresAt |
| R6 | P2 | 名称与 UUID 解析差异缺诊断可见性 | UUID 先查 correlation/直接 publication，名称扫描可歧义 | 三类标识语义不同且按 cwd 分桶；失败消息不说明 ID 类型/作用域 | 成功通知只推荐 publicationId；失败诊断标注解析分支与候选 URI |

### 2.4 Session/Run 架构（S1–S7）

| ID | Sev | 问题 | 证据 | 根因 | 建议 |
|---|---|---|---|---|---|
| S1 | P1 | Brief 职责耦合造成重复上下文 | brief 地图 <2%；evidence-sessionrun.md:10-14 | 出生协议、技能注入、状态导航共用同一载荷 | 拆 <2KB 地图卡；技能仅返回 path+hash，首次或版本变化再加载正文 |
| S2 | P1 | Continuation 门禁成本失衡 | 同一 011 brief 加载 5 次 | 用"重载载荷"证明新鲜度而非校验 revision | accept 后校验 revision 刷新地图卡；仅协议 hash 变化时重载正文 |
| S3 | P2 | Chain 改写缺少治理审计 | 5 分钟 9 次改链且无原因记录 | canonical writer 未约束 actor、reason 与版本并发 | replace 要求 lease+expected revision+reason；追加 actor 与前后 hash 审计 |
| S4 | P1 | 状态读取路径过碎 | 恢复需 4–6 命令 | 读模型按存储实体拆分，未按"恢复执行"用例提供一致快照 | 复合 resume-view：位置、chain、gates、决策、产物索引、next，带 revision |
| S5 | P2 | Lease 所有权跨执行边界不稳 | 5 次 no owner；目标架构要求 core 单写者 | lease 未稳定覆盖跨会话、子代理、后台 handoff | lease 下沉 core 绑定 session+execution；显式 delegation/handoff token 与失主恢复 |
| S6 | P1 | 封存状态机需要 Agent 级救援 | 封存 011 需 2 次派遣+14 次 help | seal 路由缺幂等复合事务与机器可执行错误提示 | seal-route 单命令：preflight、repair、seal 原子编排，失败返回 next_action |
| S7 | P2 | Evidence 聚合查询无容量边界 | session evidence 单次 68.1KB | 缺默认投影、分页游标与响应容量预算 | 默认摘要+计数+索引；分页取正文，10KB 软限，大结果走 artifact 路径 |

### 2.5 CLI 设计（L1–L6）

| ID | Sev | 问题 | 证据 | 根因 | 建议 |
|---|---|---|---|---|---|
| L1 | P1 | 命令面过宽且帮助非机器友好 | 45 次 help；三族 help 仅 Usage/Commands 文本 | 兼容入口与主路径同层暴露，帮助面向人工浏览 | help --json、生命周期分组、恢复包附 5–8 条命令模板 |
| L2 | P1 | run brief 返回体未分层 | 单次 28–40KB；技能正文占 61% | 动态状态、元数据、静态技能正文绑定为单一返回体 | 默认返回 <2KB 地图卡；技能只返回路径/摘要，显式参数按需展开 |
| L3 | P2 | 会话上下文推导能力不透明 | 17 次 brief 中 15 次显式传 session | CLI 未暴露唯一会话/宿主通道/lease 的解析优先级 | 唯一上下文时自动推导并回显来源；歧义时列候选与修复命令 |
| L4 | P1 | 恢复状态需多命令拼装 | 恢复 4–6 命令；status 与 graph 字段重叠 | 恢复所需状态分散在 brief/check/status/graph 四个读模型 | status --full --json：聚合位置、门禁、结论索引、阻塞项、下一命令 |
| L5 | P1 | 命令族职责边界重叠 | session done/next、run start/status 为弃用别名或桥 | Session→Execution 迁移兼容层直接暴露，未收敛 | 按 Session 身份/Execution 生命周期/Run 尝试划界；隐藏别名并输出唯一替代命令 |
| L6 | P1 | 校验错误不可操作 | 4 次校验失败返回 schema 原文 | 校验层泄露 TypeBox 细节 | 输出自然语言摘要、JSON Pointer、合法值及最小修复示例，保留机器错误码 |

### 2.6 提示词与 workspace 消息注入（X1）

| ID | Sev | 问题 | 证据 | 根因 | 建议 |
|---|---|---|---|---|---|
| X1 | P1 | peer 协调消息可能覆盖真实用户目标 | `workspace-peers.ts:715` 把 peer 消息包装为 `customType: teammate-message`；`index.ts:1850` 经 `pi.sendMessage` 注入；Pi SDK `agent-session.js:1065` 建为 `role: custom`，`pi-agent-core/messages.js:71` 在发送模型前统一转换成 `role: user`。本会话中该消息紧邻“规划解决方案”，实际触发范围误判 | developer prompt 要求冲突时以最新 user message 调整当前 turn；但 peer 协调消息在模型权限层也是 user。信封中的 `Source: system` 仅是正文文本，不是可信 role/priority 元数据，模型无法可靠区分“人类用户目标”与“执行协调约束” | 短期在信封加入“coordination only，不得替换/缩小 active user objective”；中期为 custom message 保留可信 `origin=workspace-peer` 与较低任务优先级；根本上宿主不得把所有 custom 消息无差别转换为普通 user role，并应明确 developer prompt 的“user”仅指人类用户 |

**来源边界**：`The user may send messages while you are working...` 等 developer 指令在本仓库、Maestro core、Pi SDK 可读源码和 `~/.pi` 配置中均无精确命中，只能确认其来自工作区之外的会话启动 prompt 层；不能据现有证据归因到某个具体宿主实现。

## 三、跨视角横切发现（7 个系统性问题）

1. **错误消息不可操作**（T2+L6）：schema 校验失败只抛 TypeBox JSON，无字段/期望值/修复示例 → 主 agent 反复违规（4 次校验失败直接相关）。
2. **重型载荷未分层**（S1+S2+L2+C4）：brief 30KB 一次返回、技能正文 61%、门禁强制重载 → 17 次加载 ≈500KB ≈12.5 万 token。
3. **恢复路径碎、无地图注入**（C1+C4+S4+L4）：压缩续接消息无状态摘要 → agent 4–6 命令拼装（checkpoint 里其实已有 runId/gates/nextAction，恢复入口未消费）。
4. **持久化/容量缺口链**（R1+R4+T6）：完成≠可读（87% 拉取失败）、写盘仍截断（200K）、单消息 64KB 截尾、无分页 → 后台结果系统性缺失 → 重派/重读。
5. **agent 生命周期未入会话状态**（C5+T7+S5+S6）：checkpoint 无 agent 字段、fresh 无复用身份、lease 跨边界不稳、seal 需 agent 救援。
6. **治理缺审计**（S3+C6）：chain replace 10 次无原因记录；cache 实现违背已定稿设计文档。
7. **消息权限降级导致目标覆盖**（X1）：workspace peer 协调消息以 custom role 进入 Pi，但在 LLM 转换时成为普通 user role；与“最新 user request 优先”的 developer 指令组合后，协调约束可能被误判为新的用户任务。

## 四、优先行动建议（按跨视角收益排序）

| 序 | 行动 | 涉及 | 预期收益 |
|---|---|---|---|
| 1 | **恢复地图注入**：checkpoint 生成 ≤2KB 地图卡随续接消息注入；恢复入口直接消费 checkpoint 字段（runId/gates/nextAction），不再默认重载 brief | C1+C4+S1+S4+L2+L4 | 消灭恢复期 4–6 命令拼装与 30KB 重载；压缩循环成本大降 |
| 2 | **隔离 peer 协调消息的权限语义**：信封显式声明 coordination-only；SDK 保留可信 origin/priority；宿主不再把所有 custom 消息无差别降为普通 user | X1 | 防止 peer/system 协调消息覆盖或缩小人类用户目标 |
| 3 | **校验错误可操作化**：宿主页校验 + formatter（字段/原因/允许值/修正示例） | T2+L6 | 消除 20% 失败中的校验类（占一半） |
| 4 | **发布包修复**：default-rules.json 加入 npm files + 安装后冒烟 | T5 | 消除 ENOENT 类运行失败 |
| 5 | **持久化对账**：完成回执显式返回 persisted 状态与 canonical URI；失败附恢复路径 | R1+R2+R3+R4+T6 | 后台结果不再系统性缺失，重派率下降 |
| 6 | **前台窗口 60–120s**：新增 foregroundWaitMs 独立参数 | T3 | 单次等待从 10 分钟降至 ≤2 分钟 |
| 7 | **checkpoint 登记后台 agent**：快照运行中/未消费 agent 与 publicationId，压缩后对账 | C5+R1 | 压缩与后台完成不再乱序/丢失 |
| 8 | **seal-route 单命令原子编排**：preflight/repair/seal + next_action 错误 | S6+L5 | 消灭 agent 级生命周期救援 dispatch |
| 9 | **治理**：chain replace 加 lease+reason+审计；cache 默认行为回归设计文档 | S3+C6 | 地图稳定与行为可预期 |

## 五、证据与关联文档

- 证据包：`C:\Users\dyw\.pi\agent\sessions\_infra_evidence\`（5 个 evidence-*.md，含全部原始取证数据与代码 file:line）
- 会话 transcript：`C:\Users\dyw\.pi\agent\sessions\--D--maestro-scholar-v2--\2026-08-10T13-02-09-740Z_019febc4-2b4c-7372-8537-ef98cf3588b3.jsonl`
- 关联分析：`docs/teammate-call-efficiency-analysis-20260812.md`、`docs/brief-session-map-analysis-20260812.md`
- 代码锚点：`packages/pi-maestro-teammate/`（index.ts / schemas.ts / execution.ts / execution-infra.ts / teammate-core.ts / store.ts / resource.ts / rules.ts / extension/workspace-peers.ts）、`packages/pi-maestro-flow/` 的压缩实现（auto-compaction.ts / maestro-compaction.ts / settings.ts）、Pi SDK `pi-coding-agent/dist/core/agent-session.js` 与 `pi-agent-core/dist/harness/messages.js`
