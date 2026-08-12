# Teammate 调用效率问题分析

> 基于 maestro-scholar-v2 会话 `019febc4-2b4c-7372-8537-ef98cf3588b3`（2026-08-10T13:02 → 2026-08-12，**41.9 小时**，cwd `D:\maestro-scholar-v2`）完整 transcript 取证分析。
> 数据口径：调用耗时 = toolResult 时间戳 − 发起 assistant 消息时间戳；转后台任务的实际完成点以通知为准，量级可靠。
> 会话文件：`C:\Users\dyw\.pi\agent\sessions\--D--maestro-scholar-v2--\2026-08-10T13-02-09-740Z_019febc4-2b4c-7372-8537-ef98cf3588b3.jsonl`（26.9MB，3456 条记录）

## 一、量化概况

| 指标 | 数值 |
|---|---|
| teammate dispatch 次数 | 40 |
| 前台等待合计 | **247 分钟**（中位 559s ≈ 600s 默认前台窗口） |
| 撞满 600s 前台窗口转后台 | **16/40（40%）** |
| 失败 / 空转 dispatch | **8/40（20%）** |
| observe 调用 | 85（20 次 >60s，多次整 10 分钟超时轮询） |
| 上下文压缩 | 7 次；toolResult 累计 5.7MB；单次 teammate 结果最大 92KB（被截断） |
| bash 调用 | 1028，其中 **794 次为 ls/cd/test/find 目录探测** |
| 模型切换 | gpt-5.6-sol ↔ deepseek-v4-flash 共 5 次；03:22–14:40 由 flash 协调 |

## 二、问题清单（按影响排序）

### P1-1 串行管道 + 同步阻塞等待（最大时间黑洞）

- 40 次 dispatch 全部为"发出 → 前台阻塞 → 等结果 → 再发下一个"；主 agent 视角最大并发 = 1（并行仅存在于单次 dispatch 内部）。
- 转后台后仍继续等待：`task108-impl` 转后台后 **9.6 小时**才等来下一步动作；`final-report-verifier` 转后台后等待 10.7 分钟（期间被 "model fallback handoff" 取消）。
- 85 次 observe 中多次整 10 分钟超时（`timeout (600015ms)`）——完成通知本会自动到达，observe 阻塞纯属浪费。
- 后果：墙钟时间 ≈ 各阶段耗时之和，42 小时内大量为等待。

### P1-2 评审波次爆炸 + 每轮全新 agent 重读仓库

- 同一代码库至少被评审 3 轮：六维评审(12.6h) → 重试(13.4h) → 5 个交叉审核(14.3h) → M1 六维(19.7h) → rev2 六维(23.5h) → **11 个 deep-dive**(23.8–24.2h) → 全量 delta 七维(37.1h) → 重试(38.3h) → compact 7 任务(38.4h) → dd 重试(38.7h)。
- 19 个 `dd-*` 任务各自派全新 agent 对**单条 finding** 独立重读代码验证；context 几乎全为 `fresh`，每轮重付"理解仓库"成本。
- 任务结构失衡：review 类 55 个 vs 实现类 12 个。

### P1-3 20% dispatch 失败 / 空转（8/40）

| 时间 | 失败类型 |
|---|---|
| 14.28h | ENOENT `D:\pi-maestro-flow\packages\pi-maestro-teammate\src\experts-mode\config\default-rules.json`（基础设施 bug） |
| 19.70h | teammate 参数校验失败（tasks 多余属性） |
| 23.79h | outputSchema 根必须是 `object`，给了 `array` |
| 24.71h | teammate 参数校验失败（多余属性） |
| 25.03h | 空 dispatch（tasks 缺失） |
| 38.75h ×2 | 子进程异常退出（exit=1, tools=0, 6s 即崩） |
| 39.10h | `context` 值非法（fork 被拒） |

失败后原样重派（rev 波次曾连续 3 次尝试同一条评审）。

### P2-4 上下文洪泛 + 压缩循环 → 反复重新发现

- 全部 toolResult 累计 5.7MB；单次 teammate 结果最大 92KB 内联回主上下文且**被截断**。
- 7 次 compaction 后，恢复期的第一批工具调用几乎全是 `read` / `run-control` / `ls` / `find` / `teammate-list`——重建状态。
- 794 次目录探测类 bash（`rg --files -g '*'` 反复扫描同一根目录：hydro_generator_adaptive_mdo 13 次、maestro-scholar-v2 7 次等）。

### P2-5 弱模型协调

- 03:22–14:40 主循环由 deepseek-v4-flash 驱动，恰是失败最密集窗口（provider 并发失败、ENOENT、校验失败、交叉审核事故）；14:40–14:41 90 秒内 3 次模型切换。

## 三、根因归因

### 3.1 Skill 契约直接塑造"同步阻塞"行为（主因）

会话 1.55h 注入 `maestro` skill（`D:\pi-maestro-flow\.pi\skills\maestro\SKILL.md`，10473 字符），其 `<teammate_contract>` 原文：

> - `background: false` is the default. **Use foreground dispatch whenever the result determines the current answer or next action.**
> - If this turn must consume a background result, call `observe` exactly once with `action: "wait"` and a bounded timeout…
> - Otherwise end the turn and wait for the automatic `teammate-complete` notification.
> - Never silently ignore an unfinished dispatch.

流水线中每个阶段的结果都"决定下一步动作"→ 契约导致全部前台等待 10 分钟 → 转后台 → 再按契约 observe 阻塞。**正确性优先的设计权衡，代价是吞吐**。注入后立即 `workflow-attach`（canonical Session `20260810-maestro-hydro-adaptive-mdo-20260810-144331`，Run 003-review，gates 4/11），此后 156 次 run-control、seal-route 等均为该管道产物。

### 3.2 工作流门禁驱动返工

review 步骤为六维评审 + gate 门禁；gates 4/11 失败 → 修复 → 再评审 → deep-dive 逐个补验 → 再全量重审。波次爆炸主要由此驱动。

### 3.3 用户决策参与循环

14.26h "5个agent交叉审核"（用户明确要求）、14.60h "修复"、16.48h "你来直接执行恢复 并且继续"、20.53h `/model` 切模型。审-修循环部分由用户推动。

### 3.4 基础设施不稳定

ENOENT `default-rules.json`（teammate 包 bug）；provider 并发失败 → retry；"Teammate run cancelled during model fallback handoff"。

## 四、"结果内联仍反复重复发现"的机制（4 个断点）

内联 ≠ 持久：结果文本进入上下文窗口，但被以下机制反复打断：

| 断点 | 机制 | 证据 |
|---|---|---|
| 压缩蒸发 | 上下文触顶 → compaction 把历史（含内联结果）替换为高级摘要，细节丢失 | 7 次压缩；每次压缩后首批工具调用为 read/run-control/ls/find |
| 内联截断 | 超长结果（>~50KB）被截断，截掉部分从未可见 | 92KB 结果尾部 `...`；38KB 未截断 |
| 后台通知仅摘要 | 转后台调用完成时只收到 `teammate-complete` 通知，中位 **608 字符**；主 agent 未用 `resource agent://` 拉完整输出（后续仅 observe/teammate-send） | 22 条通知中位 608 字符；无 resource/read 拉取记录 |
| fresh 子进程不共享 | 每个 teammate 是全新会话，主 agent 内联知识无法传递；每轮评审/每个 dd-* 都在子进程重读仓库 | context=fork 仅 1 次，其余全 fresh |

补充：即使内联完整，细节埋在 26.9MB 历史中，对后续 turn 的模型"可见但不等于已内化"——从历史翻找不如重新 `rg --files` 快；弱模型从长历史提取细节能力更差，更容易选择重扫。

## 五、解法建议（按成本排序）

1. **长结果写文件 + 内联只回摘要**：要求 agent 把完整报告写入 artifact 文件，`outputSchema` 约束回传结构（会话 38.4h 已自发采用 "Return JSON <=10000 chars"）；主 agent 需要细节时按需 `read` 文件——文件不受压缩影响。
2. **后台结果用 `resource agent://<correlationId>` 拉完整输出**，而非依赖 600 字符通知摘要。
3. **仓库地图沉淀为产物文件**（如 `docs/repo-map.md`：关键路径、结论表），后续阶段只 `read` 它，不再重扫目录。
4. **压缩恢复依赖 goal/todo/artifacts 状态**，而非重新发现。
5. **并行化**：互不依赖的 step 显式 `background: true` + 短 `timeoutMs`（60–120s），等待期间推进其他阶段；不要 observe 阻塞，等自动通知。
6. **闭环整体执行**：把"评审→修复→再评审"放进一个 run-executor 内完成，主 agent 只做监督与例外处理。
7. **评审一次取证**：reviewer 一次给全证据（file:line + 严重度 + 修复建议），只对 high 级 finding 深挖；用 `teammate-send` 复用同一 agent 追问，而非每轮新派。
8. **协调者用最强模型**，flash 级只留给 leaf 任务。

## 六、证据索引

- 会话 transcript：`C:\Users\dyw\.pi\agent\sessions\--D--maestro-scholar-v2--\2026-08-10T13-02-09-740Z_019febc4-2b4c-7372-8537-ef98cf3588b3.jsonl`
- Skill 契约来源：`D:\pi-maestro-flow\.pi\skills\maestro\SKILL.md`（`<teammate_contract>` 段）
- 工具本身缺陷（已修复，v0.4.4）：`docs/teammate-tool-fix-plan.md`（2026-07-15，F1–F11 全部落地，112 测试全绿）
- 关键时间点：见上文各节标注的相对小时数（0h = 2026-08-10T13:02Z）

## 七、关联文档

- `docs/brief-session-map-analysis-20260812.md` — Run Brief 作为"会话地图"的问题分析与优化方案（同一会话取证）
