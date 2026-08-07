# 知识沉淀与 Run 解耦：精简实施方案（MVP-cut）

> 实施状态（2026-08-06）：**P1/P2/P3 全部完成**。maestro2：tsc clean、新增 29 个单测全绿、全量回归零新增失败（存量 10 个已基线确认）；pi-maestro-flow：typecheck clean、compaction 208/208、两组合 CLI 冒烟全过（新×新 session-only 全闭环晋升 / 新×旧退化不崩）。run delta v1.0 字节未动。
>
> 状态：**推荐执行路径**（独立文档，自包含）
> 定位：`knowledge-session-decoupling-plan.md`（v2.1）§6A 的独立成文版；目标态见 `session-run-knowledge-target-architecture.md`（最终态不因精简而变）
> 审计依据：GPT（gpt-5.6-sol）架构评审 4×P0 全采纳 + qwen3.8-max-preview 复杂度交叉审计（本质复杂度 ≈40%，机制 19→11、Phase 5→3）
> 涉及仓库：`maestro2`（maestro-flow CLI）· `pi-maestro-flow`（Pi 插件）

---

## 1. 要解决的问题（摘要）

1. **知识沉淀强绑 run**：`stage`/`record` 无活跃 run 即 throw（"No unique active Run found"）；不走 workflow 的日常会话零受治理沉淀（实测 81 pending / 2 promoted，真实审核→晋升为零）。
2. **多会话并发串写风险**：归属靠 `findUniqueActiveRun()` 全盘扫描（`maestro2/src/run/store.ts:719`），"A 跑 run、B 闲聊"时 B 的沉淀会错绑 A 的 run。
3. **多平台身份缺失**：Pi 有插件 lease，Claude Code/Codex/Agy 有 hooks（载荷含 `session_id`），纯终端无任何身份。
4. **旁路失控**：compaction checkpoint 以 `status: active` 直写 `.workflow/knowhow`，绕过全部治理门。

**目标**：Session 成为知识治理第一公民——任何平台的任何会话，不依赖 run 即可完成 stage → review → promote → 注入，且并发不串写。**安全语义与完整版完全等强度**（4×P0 全保留），只砍防御性机制。

## 2. 核心安全语义（不可动，等价完整版）

| # | 不变量 |
|---|---|
| S1 | **run delta v1.0 字节级不动**（strict schema + 已部署二进制约束，`knowledge.ts:59`）；session delta 为独立新 schema 族 |
| S2 | **双源 promote 等强度**：run 源 = sealed run + receipt + 新鲜（现状不变）；session 源 = **sealed + 新鲜 session receipt + evidence 非空**——MVP 单分支比完整版"sealed 或 freeze"**更严格** |
| S3 | **写授权 fail-closed**：显式参数 / fenced lease / hook 通道之外不猜测归属；歧义报错列出存活通道；收窄扫描仅限"恰一 running session 且零 live channel"且附 warning |
| S4 | **身份隔离**：宿主会话 ID（pi/claude/codex session id）只是映射键，永不充当 `.workflow/sessions/` 目录权威；"复用最近 running session"捷径永久否决 |
| S5 | **T3 不放宽**：review_required 未裁决 → promote fail-closed；`--reason` 非空 |
| S6 | **语料唯一通道**：`.workflow/specs|knowhow` 只经 promote；compaction active 直写必须止血（K10） |
| S7 | **读不被身份阻断**：search/load 正文读取与身份解析失败解耦 |
| S8 | **时序铁律**：stage 在 seal 前、promote 在源 seal 后；sealed 实体拒写 sidecar |

## 3. 让方案变便宜的三个代码事实（审计实证）

1. **session sidecar 写原语已存在**：`store.ts:573-585` `updateKnowledgeLifecycle` 允许无 active run 的事务内 sidecar 写（注释明示为 run 后知识写设计）——session delta 写入是 ~20 行镜像，非新机制。
2. **hook 通道可并入既有桥接写点**：`hooks.ts:878` 已解析载荷 `session_id`，`hooks.ts:1242-1248` 已按 host session_id 写桥接文件（coordinator-tracker）——通道注册是扩展现有写点，非新管道。
3. **session receipt 刷新是同构复制**：run seal 事务已在 `runtime.ts:2905-2913` 写 reconciliation；`sealSession`（`runtime.ts:2341`）照抄即可。

## 4. 机制清单（K1-K11）

| # | 机制 | 落点 |
|---|---|---|
| K1 | `session-knowledge-delta/1.0` 独立 schema + session sidecar 写（sealed session 拒写） | maestro2 `run/knowledge.ts`、`run/store.ts` |
| K2 | synthetic knowledge session 幂等创建：ID = `ksyn-<hash(host+project+date)>`（日期分区天然轮换，**不做** abandon/恢复/清理）+ host→session 映射；seal 复用 `sealSession` | maestro2 `run/knowledge.ts` / `commands/knowledge.ts` |
| K3 | 写授权分级：**A**=显式参数 / 显式与环境 channel（`--channel`/`MAESTRO_CHANNEL`）/ fenced lease 反查（读 `.workflow/tmp/hook/*.lease/`，epoch claim + 30s stale）/ 单个存活 hook 通道；**C**=收窄扫描（恰一 running 且零 live hook channel，附 warning：有 active Run 则绑 Run，否则绑 Session 本身）；其余 fail-closed 列出存活通道。manual 通道不参与无身份推断（归 --channel 显式调用者）。load 归因无法归属时成功返回 + warning，不静默 | maestro2 `commands/knowledge.ts`、`run/knowledge-identity.ts`（lease/通道读工具） |
| K4 | 通道：hook 注册（并入 `hooks.ts:1242` 桥接写点，hook 事件即天然心跳）+ manual `--channel`/`MAESTRO_CHANNEL`（首次使用自动幂等创建 ksyn-* 合成 Session 并回写通道 context）；位置 `.workflow/tmp/channels/<identity>.channel.json`，统一 lastSeenAt TTL 24h + 任何 hook 事件刷新；**manual 通道不参与无身份调用者的唯一通道推断与 load 归因（已实现：推断层 hook-only）**；预留 revision 字段（MVP 恒写 1） | maestro2 `hooks/`、`commands/` |
| K5 | promote 双源门禁（S2）：session 源单分支 sealed + 新鲜 receipt + evidence 非空；receipt stale/缺失 → throw | maestro2 `run/knowledge.ts`（promoteSessionKnowledge） |
| K6 | `sealSession` 事务尾部刷 session receipt（仿 `runtime.ts:2905-2913`）；失败不阻断 seal，留 missing receipt → promote fail-closed 直到 `review --refresh` | maestro2 `run/runtime.ts` |
| K7 | 来源分派：聚合层 `origin` 标签（候选存储文件即来源，隐式派生）；receipt 签发/resolve/promotion intent/完成状态写回按 origin 分派（session 源走 K1 sidecar）；跨源同 candidate ID 按 `origin+candidate_id` 分账，不合并门禁。**虚拟 run 替代方案永久否决**（污染 sealSession 枚举 `runtime.ts:2345-2351` / summary 计数 / 通知过滤） | maestro2 `run/knowledge.ts`、`knowledge/reconcile.ts` |
| K8 | signal-id 写入前存在性校验（含 canonical/alias 解析）；未知 ID 默认拒收；`--allow-unknown` 写 JSONL 留痕（字段集 schema_version/raw_id/actor/reason/recorded_at，revision 延后） | maestro2 `commands/knowledge.ts` |
| K9 | 插件 env 注入：`session_start`（含 session 替换路径）写 `process.env.PI_HOST_SESSION_ID`；**env-only，不做 capability probe、不传 `--host-session` 标志**（旧 CLI 忽略 env 无害） | pi-maestro-flow `extension/index.ts` |
| K10 | compaction 存储隔离：`buildKnowhowPath`（`maestro-compaction.ts:1296` 附近）根目录迁 `.workflow/recovery/compaction-checkpoints/`，corpus 停止 active 直写；**仅翻 status 不够**（`spec-loader.ts:331` 只过滤 deprecated），必须物理迁路径；恢复按存储路径读取不受影响；staging 半边延后 | pi-maestro-flow `compaction/` |
| K11 | 兼容回归：**新CLI×旧插件 / 新CLI×新插件** 两组合（旧 CLI 两象限在 env-only 注入下退化为现状，无新代码路径）+ run 源字节级回归（`scripts/self-evolve-acceptance.sh` V1-V11 全绿）+ health.mjs `"?"` 归属一行修复（`self-evolve-health.mjs:137`，随行唯一回归项） | 跨仓库 |

**砍除清单（完整版有、MVP 无）**：谱系指纹全套（Windows CIM/三平台原型）、通道指纹自注册路径 B、capability probe、synthetic session abandon/恢复/清理、D4 freeze 分支、source_refs 完整数组与 evidence_root/corroboration 独立证据根重统计、四象限中两个旧 CLI 象限、Phase 5 消费方增强（overlay 分组/DTO 放宽/通知适配——审计验证现状不崩不伪造，属展示增强）。

## 5. 数据布局（MVP 增量）

```
.workflow/
├── sessions/<sid>/
│   ├── knowledge-delta.json            # [新] session-knowledge-delta/1.0（origin=session 候选+归因）
│   ├── knowledge-reconciliation.json   # [新] session receipt（candidate snapshot + corpus fingerprint）
│   └── runs/<rid>/knowledge-delta.json # 现状 v1.0 字节不动
├── tmp/
│   ├── hook/<sid>.lease/               # 现状 lease（K3 只加读侧）
│   └── channels/<identity>.channel.json# [新] 身份通道（K4）
├── sessions/ksyn-*/                    # [新] synthetic knowledge session（K2）
└── recovery/compaction-checkpoints/    # [新] recovery-only（K10）
```

## 6. 三阶段实施

### P1 — CLI 基础面（K1 K2 K3 K4 K8 + health.mjs 一行）

改动：`maestro2/src/run/{knowledge,store,runtime}.ts`（session delta schema/写/lease 读/通道工具）、`commands/knowledge.ts`（双模入口+写授权分级+signal 校验）、`hooks/`（通道注册并入桥接写点）、`commands/search|load`（通道路由）。

验收：
- [ ] **串会话关键用例**：A 有 run + B 闲聊 + B 身份获取失败 → B fail-closed，不触碰 A
- [ ] 无 run 会话首次 stage 幂等创建 synthetic session（同 host+project+date 二次 stage 复用）；sealed session 拒写 sidecar
- [ ] 显式 `--run` 行为与现状逐字节一致（run delta v1.0 回归）
- [ ] 未知 signal-id 默认拒收；`--allow-unknown` 落 JSONL 留痕
- [ ] 两并发窗口 lease 各绑各的；纯终端收窄扫描（附 warning）与 `--channel` 用例
- [ ] load 归因无法归属 → 成功返回 + warning（不再静默丢弃）

### P2 — 治理闭环（K5 K6 K7）

改动：`run/knowledge.ts`（promoteSessionKnowledge 双源门禁 + origin 分派写回）、`knowledge/reconcile.ts`（session receipt 签发/freshness/resolve 适配）、`run/runtime.ts`（sealSession 刷 receipt）。

验收：
- [ ] session 源门禁矩阵：未 seal → throw；sealed 无 receipt → throw；receipt stale → throw；双满足 → 成功（与 run 源等强度）
- [ ] seal receipt 刷新失败 → seal 成功但 promote fail-closed；`review --refresh` 补齐后放行
- [ ] 混合来源：同 candidate ID 出现在 run 与 session → 分账不合并门禁
- [ ] run 源全链 V1-V11 保持全绿（零迁移）

### P3 — 接入与止血（K9 K10 K11）

改动：插件 `extension/index.ts`（env 注入）、`compaction/maestro-compaction.ts`（根目录迁移）、回归脚本。

验收：
- [ ] 两 Pi 窗口各 attached 不同 session：各自正确归属（lease/env）
- [ ] 新 compaction checkpoint 不再出现在 corpus；压缩/恢复全链测试全绿
- [ ] 新CLI×旧插件：env 被忽略，行为退化为现状（收窄扫描兜底可用）
- [ ] 新CLI×新插件：session-only full-cycle 绿（synthetic 创建 → stage → review → seal session → promote → search 命中）

## 7. 明示接受的剩余风险

1. **纯终端零配置体验消失**：多 session 并发裸终端需 `--channel`/显式参数；单 session 有收窄扫描兜底（摩擦，非安全问题）。
2. **无 freeze 分支**：长开 synthetic session 晋升需先 seal；日期分区 ID 天然缓解。
3. **统一 TTL 误杀**：hook 宿主长 idle 后通道过期 → 下次 hook 事件自动重建；空窗期写操作 fail-closed（安全方向）。
4. **存量 KNW-*-session-compact active 条目仍在 corpus**：K10 只止新增，存量 81 pending + checkpoint 条目并入上线前基线分诊（按 origin/age/disposition 分组，先处理 review_required/conflict，禁止无证据批量处置）。

## 8. 升级路径（全部纯增量，无二次迁移）

| 延后项 | 重新引入条件 | 增量方式 |
|---|---|---|
| 谱系指纹 B 级候选 | 二期，且三平台（Pi/Claude/纯终端）双窗口原型实测证据先行 | 新增候选通道类型，不动 A/C 级 |
| D4 freeze 分支 | 实证"长开 synthetic session 不便 seal"后 | 门禁加 OR 分支（放宽方向需再评审） |
| source_refs 完整数组 + evidence_root + corroboration 独立证据根 | OQ-3 分级门禁采纳时 | session delta 独立 schema 族，加字段无存量迁移 |
| checkpoint staging 半边 | P2 完成后 | 隔离存储已在，stage 只是多一个生产者 |
| Phase 5 消费方增强（overlay 分组/DTO 放宽/通知适配/skill-context 计数） | 二期统一做 | 审计验证现状不崩不伪造，属展示增强 |
| 通道 CAS / 分 hostKind 存活策略 | 出现实际并发事故证据后 | revision 字段 MVP 已预留（恒写 1） |

## 9. 遗留开放项（不阻塞开工）

- ~~**收窄扫描去留**~~ → 已保留并实现 session 分支（有 active Run 绑 Run，无则绑唯一 running Session，均附 warning）。
- **通道 TTL 具体值**：已实现 24h；上线后按 hook 静默窗口实测调整。
- ~~**`--allow-unknown` 字段集**~~ → 已实现：schema_version/raw_id/actor/reason/recorded_at（revision 延后）。
- ~~**synthetic session ID 规则**~~ → 已定：`ksyn-<sha256(host|project|date)[:16]>`，host 取 `PI_HOST_SESSION_ID` env / channel identity / `adhoc`（无身份纯终端共用 adhoc，附 warning）；**不含宿主类型**（同日同项目不同宿主各自分区，不同宿主类型不共用）。

## 10. 实现中的附加行为（原 K 清单之外，已落地）

1. **resolve 跨源同 ID 确定性**：同 candidate_id 同时存在于 run 与 session 账本时，`review --resolve` 确定性优先 run 源副本（session 源单独裁决需在其账本内查找）。
2. **promote 计划去重**：跨源同 ID 候选在晋升计划中仅保留 run 源代表写语料一次（避免 evidence 元数据差异导致 CALLER_PAYLOAD_CONFLICT），完成写回仍按 origin 分派到各自账本。
3. **manual 通道自动绑定**：未绑定的 manual 通道首次使用时自动幂等创建 ksyn-* 合成 Session 并回写通道 context。
4. **reconcile 命令保持 run-scoped**：session 级对账由 `review <session-id> --refresh` 承担；reconcile 无 run 时报错指向新路径。
5. **review 裁决命令输出修正**：`resolution_choices` 从不存在的 `knowledge resolve` 子命令改为实际的 `review <sid> --resolve <id>`。

## §11 流程收敛决策：promote 内联裁决 + review 回退化（2026-08-07）

**背景**：reconcile（内嵌 `run check`）与 `review` 职责重叠（对账/展示/裁决），agent 流程存在 check → review → promote 三步职责混淆；且候选集在 check 时并不完整——frontmatter 自动草拟发生在 seal 事务内，因此**呈现时机必须在 seal 之后**（即 `session done` 之后的 receipt/消息呈现）。

**决策**：
1. **happy path 收敛为一步**：`run check`（自动 reconcile）→ `session done`（seal，自动草拟 frontmatter 候选 + 自动刷 receipt）→ agent 从 seal receipt 直接呈现候选+evidence-backed 匹配+推荐处置 → 用户决策 → `promote --resolve <candidate-id> --as <choice> [--target <knowledge-id>] --reason "<非空理由>"`（TOCTOU fence + resolve + promote 一次完成）。
2. **review 降级为回退面（不删除）**：① receipt 缺失/stale 修复（`--refresh`）；② 批量积压/审计分诊（OQ-4 式，session 级聚合）；③ 用户要求重新呈现。从 happy path 必走步骤移除。
3. **resolve 规则不变**：`unique` 不传 `--target`；duplicate/related/conflict/supersede 必须传 evidence-backed `--target`；`--reason` 非空强制；跨源同 ID 优先 run 源。TOCTOU fence 在 promote 内先于 resolve 执行。
4. **实现顺序**：先改 CLI（`promote` 增 `--resolve/--as/--target/--reason` + 单测），再同步注入提示词（run-mode/instructions/skills），**禁止先改提示词**造成文档-代码漂移。

---

## 附录：双轮审核留痕（一行版）

- **GPT 架构评审**（gpt-5.6-sol，只读）：结论"需修订"，4×P0（synthetic session 创建规则 / 指纹不得作写授权 / session 门禁须双重保证 / source 分派事务）+ 4×P1 + 2×P2，全部采纳进 v2；详见 `knowledge-session-decoupling-plan.md` 附录 A。
- **qwen 复杂度交叉审计**（qwen3.8-max-preview，只读，8 处代码验证）：本质复杂度 ≈40%，机制 19→11、Phase 5→3；否决虚拟 run 与复用最近 session 两个取巧替代；详见该文档报告与本文 §3/§4。

*本文档为独立实施方案；语义溯源以 v2.1 规划与目标态总纲为准，冲突时以安全语义（§2）优先。*
