# 多判据软压缩触发 — 设计方案 v2（codex 复核后定稿）

状态: FINAL（已整合 codex 复核意见，裁决"需修改后接受"）
涉及文件:
- `packages/pi-maestro-flow/src/compaction/auto-compaction.ts`
- `packages/pi-maestro-flow/src/compaction/compaction-settings.ts`

## 0. v1 → v2 关键变更（依据 codex 复核）

| codex 意见 | v2 处置 |
|------------|---------|
| D 回归承诺不成立（新判据默认开）| **所有新判据默认 `enabled=false`**，严格向后兼容 |
| C/G7 band 与 action 概念混用、critical-early 含糊 | **拆分 `band` 与 `action`**；不新增 band，用 `action:"compact"`+reason |
| C2 Layer A "初始超阈值必 critical" 与现状（先 prune 再看 residual）冲突 | 明确以 **prune 后 residual** 判定 compact，与现状一致 |
| A velocity 单差分误触发尖峰 | velocity **先只升 nudge→auto-prune**，需 ≥2 连续正差分/3 差分中位数，禁直接 compact |
| A epoch≠turn | 字段改名 `epochsToCritical` |
| B cache defer 在 nudge 档无效（nudge 本就不 prune）| cache **降为 telemetry**，暂不参与决策 |
| F depth 无价值 | **砍掉 depth** |
| F prunableFraction 与现有剪枝循环重复 | **降为解释/状态指标**，不做决策驱动 |
| E tracker 在 policy 内更新破坏纯函数性 | tracker 由 `evaluate()` 显式维护，纯函数只收 immutable snapshot |
| E onSessionStart 未清 tracker | onSessionStart/reset/onCompact/branch-switch/settings-toggle 均清空 |
| G5 无迟滞致档位抖动 | 引入 **hysteresis**（升/降档不同阈值 / 按 epoch 锁定） |
| G1/G2 小 window、usage 缺失 | 纯函数入口守卫；usage 缺失 = **unknown**（非 0），unknown 禁止升级 |
| D 嵌套默认浅复制污染 | 默认配置用**工厂函数/深复制** |
| D 分层合并后无效 effective | 对 merged effective settings 做**完整 invariant 校验** |
| G6 嵌套 patch 深合并 | user/project **逐字段深合并** |

## 1. 问题（不变）

当前软压缩仅凭单一判据 `estimatedTokens/contextWindow` 占比触发，盲区：只看"多满"不看"涨多快"。
v2 聚焦**唯一被 codex 认可有价值的信号：velocity（增长速率）**，其余降级或砍掉。

## 2. 设计原则

1. token 占比为锚点，绝对满度始终能触发压缩（安全兜底）。
2. 多判据只影响"档位/动作选择"，**不新增压缩提交路径**（critical 仍走 arbiter+prepareCompaction+单 owner，遵守 debug-notes-004）。
3. 裁剪应用机制（manifest/pendingSavedTokens/epoch 稳定）不动（遵守 coding-conventions-014）。
4. **所有新判据默认关闭**，默认配置 = 现有行为，严格无回归。
5. 决策与执行分离，决策链为纯函数。

## 3. 核心模型：拆分 band 与 action

```ts
// 不新增 band，ContextPressureBand 保持 4 值（保护 shouldCompactMidTurn 与回归语义）
type ContextAction = "none" | "prune" | "compact";

interface ContextDecision {
  band: ContextPressureBand;   // normal | nudge | auto-prune | critical
  action: ContextAction;       // 实际要做什么
  reasons: string[];           // 命中判据，供 statusline/调试
}
```

**语义厘清（codex C2）**：以"应用 recorded prunes 后、引入本轮新 prune 前"的稳定视图为基准。
- `action="compact"` 当且仅当 **residual estimate > thresholdTokens**（= 现有 critical 路径，不变）。
- 初始超阈值但 prune 后降到阈值下 → `action="prune"`, `band="auto-prune"`（与现状一致）。
- velocity 提前触发只产生 `action="prune"`（升 nudge→auto-prune），**绝不**产生 `action="compact"`（Phase 2 约束）。

## 4. 纯函数边界（codex E）

```text
observeVelocity(prevTracker, observation) -> newTracker        # 纯；evaluate() 持有 state
computeContextSignals(messages, settings, velocitySnapshot) -> ContextSignals  # 纯
decideContextAction(signals, settings) -> ContextDecision       # 纯
planContextPressure(messages, settings, tracker) -> { decision, prunePlan }    # 纯
applyPrunePlan(prunePlan, manifest) -> 修改 manifest            # 有状态，复用现有剪枝机制
```

- `applyContextPressurePolicy` 不再暗中观察 epoch；tracker 更新上移到 `evaluate()`。
- 现有 `applyContextPressurePolicy` 本就修改传入 manifest，不宣称为纯函数；拆为 plan（纯）+ apply（有状态）。
- tracker 清空时机：`onSessionStart` / `reset` / `onCompact` / branch switch / settings disable→enable。

## 5. 信号集（精简）

| 信号 | 状态 | 说明 |
|------|------|------|
| `fullnessRatio` / `criticalGap` | 决策（锚点）| 现有 |
| `velocity` / `epochsToCritical` | 决策（Phase 2，默认关）| 唯一新增决策信号 |
| `prunableFraction` | **仅解释指标** | 显示用，不驱动决策；基于稳定视图计算 |
| `cacheHitRatio` | **仅 telemetry** | 公式 `cacheRead/(cacheRead+input)`；unknown=`undefined`≠0；provider 语义标准化后再议 |
| ~~depth~~ | **砍掉** | 消息/轮数不代表可压缩性 |

### VelocityTracker
- 环形缓冲容量 4，存 `(epochKey, tokens)`，tokens 取**统一口径**：pre-new-prune effective estimate
  （应用 recorded prunes 后、扣 pendingSavedTokens 后），避免 prune acknowledgement 制造假斜率。
- 仅对**成功 provider epoch** 采样（aborted/error 消息不计，codex G3）。
- 斜率稳健化：取最近 ≤3 个差分的**中位数**，或要求 **≥2 个连续正差分**超阈值；单差分不得升级。
- velocity 为 unknown（样本<3、上下文缩短、usage reset、口径变化）→ **禁止任何升级**。

## 6. 决策逻辑（decideContextAction）

**Layer A — 硬安全兜底（不变，最高优先级）**
residual estimate > thresholdTokens → `band=critical, action=compact`。任何新判据不得削弱。

**Layer B — velocity 调制（Phase 2，默认关，仅 sub-critical 生效）**
若 `velocity.enabled` 且 `fullnessRatio ≥ velocity.minFullness`（默认 0.7）
且 velocity 稳健趋势成立（≥2 连续正差分）且 `epochsToCritical ≤ velocity.epochsToCritical`（默认 3）
→ 把 `nudge` 提升为 `auto-prune`（`action=prune`）。**不产生 compact。**

**Hysteresis（codex G5）**
升档用上述阈值；降档需 fullness 跌破更低阈值（如 minFullness-0.05）或按 epoch 锁定决策，
避免 normal↔nudge↔auto-prune 抖动。

**reasons[]** 记录命中判据，如 `CTX AUTO-PRUNE (velocity:2.1ep/critical, prunable:62%)`。

## 7. 配置面（compaction-settings.ts）

```ts
interface SoftCompactionSettings {
  enabled: boolean;
  nudgeRatio: number;        // 0.7
  pruneRatio: number;        // 0.8
  pruneTargetRatio: number;  // 0.7
  velocity: { enabled: boolean; epochsToCritical: number; minFullness: number }; // 默认 {false, 3, 0.7}
  cache:    { enabled: boolean };  // 默认 {false}，仅 telemetry 开关
}
```

- **所有新字段默认 `enabled=false`**（严格向后兼容，codex D）。
- 默认配置由**工厂函数**创建（避免浅复制污染 `DEFAULT_SOFT_COMPACTION`）。
- user/project **逐字段深合并**：项目只设 `velocity.minFullness` 不清除用户的 `velocity.enabled`。
- `validateCompactionPatch` 之外，对 **merged effective settings** 再做完整 invariant 校验
  （`nudgeRatio<pruneRatio`、`pruneTargetRatio<pruneRatio`、`epochsToCritical≥1`、`minFullness∈(0,1)`）。
- 纯函数入口守卫：`contextWindow`/`reserveTokens` 有限正数且 `contextWindow>reserveTokens`（codex G1）。

## 8. 测试计划

1. **回归（发布门禁）**：默认配置（新判据全关）对现有所有测试向量产生**完全一致**的 band+action。
2. **多 epoch 运行时回归（codex D6）**：旧 settings.json（无新字段）跑多个 epoch，行为与现状逐轮一致。
3. **velocity**：≥2 连续正差分+满度≥minFullness → nudge 升 auto-prune；单次大 output 尖峰（单差分）**不得**升级。
4. **unknown 禁升级**：usage 缺失/上下文缩短/样本不足 → velocity unknown → 不升级。
5. **hysteresis**：阈值附近不抖动。
6. **纯函数边界**：computeContextSignals/decideContextAction/observeVelocity 无副作用、可独立单测；
   tracker 状态由 evaluate() 持有。
7. **配置**：嵌套深合并、merged invariant 校验、默认工厂不污染。

## 9. 风险与缓解

- velocity 尖峰误触发 → 稳健趋势（≥2 连续正差分/中位数）+ minFullness + unknown 禁升级 + 仅升 auto-prune。
- 回归 → 新判据默认全关 + 多 epoch 运行时回归测试。
- 缓存抖动 → cache 仅 telemetry，不参与决策（Phase 2 不涉及）。
- 仲裁/TOCTOU → 不新增提交路径；critical 复用现有 arbiter 分支（debug-notes-004）。
  注：codex 指出现有 `currentOwner→prepare→request` 窗口本就存在，velocity 提高进入频率但不创造竞态；
  建议后续单独改进 arbiter 提供覆盖 prepare→compact 的 reservation（非本方案范围）。

## 10. 分阶段落地（修订）

- **Phase 1（等价重构，零行为变化）**：
  拆 `planContextPressure`(纯) / `applyPrunePlan`(有状态)；引入 `ContextDecision{band,action,reasons}`；
  velocity/cache 仅作 telemetry（计算+显示，不决策）；新判据默认全关；回归+多 epoch 测试。
- **Phase 2（velocity 提前 prune，gated）**：
  velocity 升 nudge→auto-prune，稳健趋势 + minFullness + hysteresis；验证误报率。
- **Phase 3（可选，远期）**：
  velocity→compact（`action=compact`+reason，非新 band）仅在 Phase 2 证明低误报后启用；
  cache 在 provider 语义标准化后做 auto-prune 有界 defer（带 hysteresis）。
- **砍掉**：depth。**降级**：prunableFraction（解释指标）、cache（telemetry）。
