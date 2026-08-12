# Run Brief 作为"会话地图"的问题分析与优化方案

> 基于 maestro-scholar-v2 会话 `019febc4-2b4c-7372-8537-ef98cf3588b3`（2026-08-10T13:02 → 2026-08-12，41.9h）transcript 取证：164 次 run-control 调用中 `run brief` 17 次、`--help` 13+ 次、`chain replace` 10 次。
> 关联文档：`docs/teammate-call-efficiency-analysis-20260812.md`（同一会话的 teammate 调用效率分析）。

## 一、brief 加载了什么（构成解剖）

以 `run brief 20260811-003-review` 为例，返回总长 **28,050 字节**：

| 组成部分 | 大小 | 占比 | 内容 |
|---|---|---|---|
| `result.guidance`（技能正文） | 17.2KB | **61%** | prepare/review.md 全文 3.9KB + workflow 运行模式全文 11.6KB + freshness 1.2KB + refs |
| 顶层元数据（locator/next/continuation） | 1.4KB | 5% | 门禁指令（continuation）、建议命令（next）、preconditions |
| **真正的"地图信息"（session+run+upstream）** | **<0.5KB** | **<2%** | 仅 session_id、run_id、status、active_run_id、open_decisions |

其余 32%（约 9KB）为 result 包装字段与 guidance 元信息。

## 二、使用模式（17 次加载）

- 每次返回 **28–40KB**（execute 类 brief 更大），17 次合计 ≈ 500KB ≈ 12.5 万 token 消耗在重复加载上。
- **压缩后必重载**：7 个 compaction 点后有 6 个紧跟 `run brief`——压缩把 brief 内容从上下文蒸发，agent 被迫重拉。
- **门禁强制重载**：continuation 的 precondition 原文 `"after acceptance, reload the same Run brief before continuing"`，导致同一 run 反复加载：011-review ×5、003-review ×3、008-review ×2、013-execute ×2。
- **加载后仍需拼装状态**：恢复流程为 `run brief → run check → session status → session graph` 4–6 个命令；发生过 `session evidence` 返回 **68KB** 灌爆上下文。
- 部分调用返回头带动态提示 `"Read-only view: ... has no mutation lease owner"`——brief 混入实时状态，无法当作纯静态缓存复用。

## 三、为什么作为"会话地图"没发挥效果

1. **它不是地图，是"出生证明 + 技能包"**：97% 的体积回答"这个 run 怎么干"（技能正文），2% 才是状态，且状态只有 run_id/status，**没有已封存结论、gate 结果、artifacts 索引、最近决策**。地图功能必须用 check/status/graph/evidence 拼装，而拼装结果在压缩后再次蒸发，形成"重拼-蒸发"循环。

2. **技能正文重复加载的浪费**：61% 是每次不变的静态内容（review.md 全文、workflow 运行模式），文件就在磁盘上，`read` 成本远低于 30KB 内联，却每次都内联进上下文，压缩后还要再付一次。

3. **压缩恢复机制没有"地图注入"**：压缩后系统只发 "Continue from checkpoint"，agent 必须自己拼装。没有把"当前 run、链位置、最近结论、下一步命令"作为摘要直接注入续接消息。

4. **动态信息混入静态载荷**：`no mutation lease owner` 等实时状态混在 brief 里，使 brief 无法长期缓存，每次必须重拉。

5. **CLI 面复杂 + 地图不稳定**：13+ 次 `--help` 探索（session/run/complete/edit/prepare/decide/recover/accept-reuse/chain），10 次 `chain replace`——agent 每次恢复要重新学命令语法，且链（路线图）被反复改写，说明地图本身在运行中不稳定。

## 四、优化方案（按收益排序）

| # | 方案 | 预期收益 |
|---|---|---|
| 1 | **brief 分层为"地图卡 + 技能指针"**：地图卡 <2KB（位置、状态、下一步、活跃 run、结论索引），技能正文只给 `path` 按需 `read`（文件不受压缩影响） | 加载量 -97%；压缩恢复成本大降 |
| 2 | **压缩续接消息自带地图摘要**：位置、最近封存结论（3–5 条）、下一步命令模板，agent 无需拼装 | 消灭恢复期 4–6 命令拼装；消灭 68KB evidence 事故 |
| 3 | **门禁去重载**：删除/降级 `"reload the same Run brief"` precondition——重载地图卡（2KB）而非完整 brief（30KB） | 消除 011-review ×5 类重复加载 |
| 4 | **命令速查进地图卡**：本次 run 可能用到的 5–8 个命令模板 | 消灭恢复期 `--help` 探索（13+ 次） |
| 5 | **chain 稳定性**：用 `insert` 追加而非 `replace`（10 次 replace 需审计），记录改写原因 | 路线图稳定，恢复期不再重新规划 |
| 6 | **check/evidence 大返回摘要化**：>10KB 截断为摘要 + 文件路径，按需读 | 防上下文灌爆 |

## 五、证据索引

- 会话 transcript：`C:\Users\dyw\.pi\agent\sessions\--D--maestro-scholar-v2--\2026-08-10T13-02-09-740Z_019febc4-2b4c-7372-8537-ef98cf3588b3.jsonl`
- `run brief` 调用明细（17 次，时间/argv/返回体大小）见本分析会话取证输出
- 门禁语义来源：`run brief` 返回的 `continuation.preconditions`
- 相关：`docs/teammate-call-efficiency-analysis-20260812.md`、`docs/teammate-tool-fix-plan.md`
