# Compaction 阈值配置 TUI 实施规划

## 1. 目标与状态

- 状态：部分实施（Phase 0～3 已完成代码与聚焦测试；完整 package test/typecheck 验证进行中）
- 目标：提供键盘优先、窄屏可用的 Compaction 配置 TUI，统一管理 Pi 原生自动压缩与 Maestro mid-turn 压缩使用的阈值配置。
- 命令：新增 `/maestro-compaction`，不占用 Pi 内置 `/compact`。
- 兼容原则：
  - 自动压缩完成后继续当前任务。
  - 用户执行手动 `/compact` 后停止生成，等待下一条用户消息。
  - mid-turn 压缩持续保留，以已完成的文件操作及其 tool result 作为安全检查点。
  - 不改变现有 Pi 配置格式，不引入第二套持久化阈值。

## 2. 当前实现与约束

### 2.1 当前配置

`packages/pi-maestro-flow/src/compaction/auto-compaction.ts` 当前读取 Pi 兼容配置：

```json
{
  "compaction": {
    "enabled": true,
    "reserveTokens": 16384,
    "keepRecentTokens": 20000
  }
}
```

读取优先级为：

```text
内置默认值 < ~/.pi/agent/settings.json < <cwd>/.pi/settings.json
```

实际触发阈值不是独立配置项，而是：

```text
thresholdTokens = contextWindow - reserveTokens
```

当前压力区间为固定策略：

- Normal：低于 70%
- Nudge：70%～80%
- Auto-prune：80%～自动压缩阈值
- Compact：达到自动压缩阈值

### 2.2 关键问题

Pi 原生 auto-compaction 在运行时持有已加载配置，而 Maestro mid-turn 逻辑会重新读取配置文件。如果 TUI 只写文件、不刷新 Session，两套机制可能在当前 Session 使用不同阈值。

因此保存必须形成一个完整事务：

```text
暂存编辑 → 原子写入 → 关闭 Overlay → ctx.reload() → 两套机制读取同一有效配置
```

`ctx.reload()` 会重建 Extension，不能在每次字段调整后执行，只能在用户明确 Apply 后执行一次。

### 2.3 可复用模式

实施时沿用以下现有模式，不另造交互体系：

| 现有实现 | 复用内容 |
|---|---|
| `src/tui/smart-search-config.ts` | Overlay、编辑态、异步保存、保存失败保留草稿、极窄宽度渲染 |
| `src/skills/skill-manager-tui.ts` | 键盘导航、紧凑布局、操作结果返回、配置变更后 reload |
| `packages/pi-maestro-teammate/src/tui/model-mapping-overlay.ts` | Tab、宽屏列表/检查器、窄屏单列、Saving/Saved/Save failed 状态 |
| `src/tools/smart-search-config.ts` | 保留未知字段、临时文件加 rename 的原子写入 |

## 3. 产品范围

### 3.1 v1 可编辑项

| 字段 | 类型 | 默认值 | 说明 |
|---|---:|---:|---|
| `enabled` | boolean | `true` | 控制 Pi 原生及 Maestro 自动压缩；不影响手动 `/compact` |
| `reserveTokens` | 正整数 | `16384` | 从模型 context window 末端预留的 token 数 |
| `keepRecentTokens` | 正整数 | `20000` | auto-prune 时从上下文末端保护的近期 token 数（protectedFrontierStart），不控制压缩后保留 |

TUI 显示但不持久化：

- 当前模型的 `contextWindow`。
- 派生的 `thresholdTokens` 和触发百分比。
- 70% Nudge、80% Auto-prune 等固定压力区间。
- 当前字段值来源：`project`、`user` 或 `default`。

### 3.2 配置作用域

提供两个 Tab：

- `Project`：写入 `<cwd>/.pi/settings.json`，默认选中。
- `User`：写入 `PI_CODING_AGENT_DIR/settings.json`；未设置该环境变量时写入 `~/.pi/agent/settings.json`。

每个字段支持 `Unset / Inherit`，删除当前作用域内对应字段，让它继承低优先级作用域。删除字段时必须保留 `compaction` 下其他未知键以及配置根节点的全部未知键。

项目未被信任或项目路径不可写时：

- `Project` Tab 显示只读原因。
- 默认切换到 `User` Tab。
- 不静默回退写入其他作用域。

### 3.3 不在 v1 范围

- 不开放 70% Nudge、80% Auto-prune 等策略比率。
- 不新增 `thresholdTokens`、模型 Profile 或自动预设。
- 不增加趋势图、历史 token 遥测或 Dashboard。
- 不修改 Pi 内置 `/compact` 的命令、参数和语义。
- 不为该 TUI 增加全局快捷键。

## 4. TUI 信息架构

### 4.1 宽屏布局

```text
以下数值仅为 300,000 context window 的显示示例：

┌ Maestro Compaction ─ [Project]  User ──────────────────────────┐
│ ✓ Auto compact          Enabled                       project  │
│ ▸ Trigger threshold     283,616 / 300,000 (94.5%)     derived  │
│   Reserve tokens         16,384                          user  │
│   Keep recent            20,000                       default  │
│                                                                │
│ Pressure preview                                               │
│ Normal <70% · Nudge 70–80% · Prune 80–94.5% · Compact ≥94.5%  │
│                                                                │
│ Mid-turn checkpoint  completed file operations · auto resumes │
│ Manual /compact     waits for the next user message            │
│                                                                │
│ ↑↓ select · Enter edit · Space toggle · U inherit             │
│ Ctrl+S apply + reload · Esc cancel                             │
└────────────────────────────────────────────────────────────────┘
```

布局断点：

- `>= 76` 列：左侧设置列表，右侧字段说明、有效值来源和校验提示。
- `40～75` 列：单列设置列表，下方展示选中项详情。
- `< 40` 列：action-first 单列，隐藏压力预览与来源 badge，将详情合并进选中项行，只保留字段名、值和行内错误，外加错误恢复提示和核心快捷键。
- `< 20` 列：使用短标签，允许内容折行，不得横向溢出或抛错。

状态不能只依赖颜色，统一使用 glyph 加文本：

- `✓ Saved`
- `… Saving`
- `! Save failed`
- `△ Warning`
- `× Invalid`

### 4.2 交互

| 按键 | 行为 |
|---|---|
| `Tab` / `Shift+Tab` | 切换 `Project` 与 `User` 作用域 |
| `↑` / `↓` | 移动选中项 |
| `Enter` | 进入或确认数值编辑 |
| `Space` | 切换 `enabled` |
| `U` | 清除当前作用域字段并恢复继承 |
| `Ctrl+S` | 校验并 Apply；成功后关闭 Overlay 并 reload |
| `Esc` | 编辑态返回列表；列表态放弃未保存修改并关闭 |

设置项只有 3 个，v1 不提供筛选框，避免增加无价值的模式切换。字母快捷键仅在列表态生效，数值编辑态只接收编辑输入。

### 4.3 保存状态流

```text
Clean
  └─ edit ─> Dirty
               ├─ Esc ─> Confirm discard / Clean
               └─ Ctrl+S ─> Validating
                                ├─ invalid ─> Dirty + inline error
                                └─ valid ─> Saving
                                               ├─ failure ─> Dirty + Save failed
                                               └─ success ─> Close → reload once
```

保存失败时必须保留：

- 当前 Tab。
- 选中字段。
- 草稿值。
- 校验提示。

## 5. 数据模型与校验

### 5.1 已采用类型

```ts
type CompactionConfigPatch = {
  enabled?: boolean;
  reserveTokens?: number;
  keepRecentTokens?: number;
};

type CompactionSettingSource = "project" | "user" | "default";

type EffectiveCompactionSettings = {
  enabled: boolean;
  reserveTokens: number;
  keepRecentTokens: number;
  source: Record<keyof CompactionConfigPatch, CompactionSettingSource>;
};
```

读取 API 同时返回 raw scope 与 effective settings，避免 Overlay 自行重复实现覆盖规则。

类型迁移选择已明确：`EffectiveCompactionSettings` 是共享配置层的 canonical 类型；原
`auto-compaction.ts` 导出的 `CompactionSettings` 保留为它的 3 个数值/布尔字段的
`Pick` compatibility alias，既不把 `source` 强加给压力策略调用方，也不破坏现有测试
和外部类型引用。auto-compaction 的私有 reader、默认常量和 path helper 已删除。

### 5.2 校验规则

硬错误：

- `reserveTokens` 和 `keepRecentTokens` 必须是正整数及 safe integer。
- 已知当前模型时，`reserveTokens` 必须小于 `contextWindow`。
- 派生的 `thresholdTokens` 必须大于 0。

警告但允许保存：

- `keepRecentTokens >= thresholdTokens`，可能没有足够的可压缩历史。
- `reserveTokens` 小于当前模型 `maxTokens`，可能无法为单次响应留下足够空间。
- 当前没有模型或缺少模型元数据，无法完成 context window 校验。

错误和警告均在选中项附近显示，不只在 Footer 给出笼统消息。

## 6. 实施设计

### 6.1 共享配置层（已实施）

新增：

```text
packages/pi-maestro-flow/src/compaction/compaction-settings.ts
```

职责：

- 解析 user/project 配置路径。
- 读取各作用域 raw config。
- 读取保持同步（`readFileSync`），以兼容 auto-compaction 的同步热路径；写入保持
  async，并经同一路径 Promise queue 串行化，Overlay 只 await 写入结果。
- 计算默认值、user、project 的有效合并结果及字段来源。
- 校验 patch。
- 对单个作用域执行 unset 或更新。
- 使用同一路径粒度的写入队列串行化并发保存。
- 通过同目录临时文件、`0600` mode 和 rename 原子替换；Windows 上 rename 到已存在目标会抛 EPERM，需沿用 `skill-manager-store.ts` 的 fallback（先 `unlink` 目标再 rename）。
- 保留所有不认识的根字段及 `compaction` 子字段。

调整 `auto-compaction.ts` 使用共享 loader，删除其私有重复读取逻辑，保证 TUI、mid-turn 与状态行使用同一数据语义。

### 6.2 Overlay

新增：

```text
packages/pi-maestro-flow/src/tui/compaction-settings.ts
```

Overlay 只负责：

- 暂存编辑。
- 导航、布局和渲染。
- 调用共享配置层校验及保存。
- 成功时返回 `saved: true`，失败时保持打开。

Overlay 不直接调用 `ctx.reload()`，防止 Extension 在组件回调尚未完成时被重建。

### 6.3 Extension 集成

修改：

```text
packages/pi-maestro-flow/src/extension/index.ts
```

注册 `/maestro-compaction`：

1. 获取当前模型 `contextWindow` 与 `maxTokens`。
2. 打开 Overlay。
3. Overlay 成功保存后关闭。
4. 命令 handler 调用一次 `await ctx.reload()`。
5. reload 完成后通知 `Compaction settings saved and reloaded`。

不注册 `/compact`，不拦截 Pi 内置手动命令。

### 6.4 与压缩仲裁的集成

阈值 TUI 与压缩仲裁必须共享以下约束：

- Pi 原生 auto-compaction 是跨 turn 的最终压缩入口。
- mid-turn 只在已完成文件操作、对应 tool result 已进入上下文后提出压缩请求。
- plan-handoff 的 compact 执行模式（`tools/plan.ts` 中 `ctx.compact()`）是第三个压缩入口，当前与 mid-turn 守卫无握手，必须纳入同一仲裁，不得绕过守卫单独进入执行态。
- 同一压力事件只允许一个压缩请求进入执行态，避免 `Already compacted`。
- auto-compaction 完成后恢复当前任务。
- 手动 `/compact` 保持 Pi 原生行为：压缩完成后 idle，等待用户消息。

实现阈值 TUI 不应通过禁用 mid-turn 来规避竞争；仲裁需要独立修复并具备 Session 级测试。

## 7. 分阶段任务

### Phase 0：共享配置模型

- [x] 新增共享配置 loader、effective merge 和 source metadata。
- [x] 新增 user/project path resolver。
- [x] 实现 unknown-key-preserving 原子写入与路径级串行化。
- [x] 将 `auto-compaction.ts` 迁移到共享 loader。
- [x] 保证现有默认值及配置优先级不变。

### Phase 1：TUI Overlay

- [x] 实现作用域 Tab、字段导航、编辑与 inherit。
- [x] 实现派生阈值和压力区间预览。
- [x] 实现宽屏、窄屏和极窄屏布局。
- [x] 实现 Dirty、Saving、Save failed 等非颜色状态。
- [x] 实现分层 `Esc` 和保存失败上下文恢复。

### Phase 2：命令与 reload

- [x] 注册 `/maestro-compaction`。
- [x] 从活动模型获取校验和预览数据。
- [x] Apply 成功后关闭 Overlay，并仅 reload 一次。
- [x] 验证 reload 后 Pi 原生与 Maestro 获取相同 effective settings reader。

> 交付划分：Phase 3（压缩仲裁一致性）风险高且与 TUI 解耦，作为可独立交付的阶段单独推进；Phase 0～2 与 Phase 4 构成阈值 TUI 的最小可交付单元，可不等待 Phase 3 完成而先行交付。

### Phase 3：压缩仲裁一致性

评估过的候选：

1. 仅复用 `auto-compaction.ts` 的 `state.running`：改动最小，但 plan-handoff 和 Pi
   native 入口看不到该状态，不能闭合竞态。
2. 在每个调用点各自检查 `ctx.isIdle()` / 最近 compact event：无需新类型，但
   check-then-act 仍有窗口，而且状态重复、难以做确定性测试。
3. Session 级 owner + lease arbiter：native 入口由 `session_before_compact` 观察，
   mid-turn 和 plan-handoff 在调用 `ctx.compact()` 前竞争同一个 lease；完成、失败、
   abort 或 Session reset 释放。

选择候选 3。它是能覆盖 3 个自动/扩展入口且可用同步单元测试确定性验证的最简单结构；
Pi native event 在同时竞争时优先于 extension lease，因此原生自动压缩和内置手动命令
均不被 Maestro 取消；内置命令仍只作为 native event 被观察，不注册、不覆盖，也不
注入 continuation。被抢占的 mid-turn 或 plan-handoff 请求在其 tagged event 到达时
被取消，并沿现有 error callback 恢复或继续。

- [x] 为 native auto、mid-turn 和 plan-handoff 建立单一执行态仲裁。
- [x] 将 plan-handoff compact 执行模式（`tools/plan.ts` 的 `ctx.compact()`）作为第三个入口纳入同一仲裁，并与 mid-turn 守卫握手。
- [x] 保留基于文件操作完成点的 mid-turn checkpoint。
- [x] 保留自动压缩 continuation；内置手动压缩仍等待用户消息。
- [x] 用 owner/lease 竞态测试验证同一压力事件只有一个扩展请求进入执行态。

### Phase 4：验证与收尾

- [ ] 运行单元测试、TUI 测试和 Session 级集成测试。
- [x] 核对声明/开发依赖版本：`packages/pi-maestro-flow/package.json` 使用
  `@earendil-works/pi-coding-agent` devDependency `0.74.0`，peerDependency 为 `*`。
- [x] 核对实际解析版本：`npm ls @earendil-works/pi-coding-agent --depth=0` 显示
  `pi-maestro-flow` 实际解析到 `0.74.0`；该版本的声明和运行实现均包含
  `ExtensionCommandContext.reload()`、`ctx.compact({onComplete,onError})`、
  `session_before_compact` 与 `session_compact`；`AgentSession.reload()` 的实际实现先
  `await settingsManager.reload()` 再重建 runtime，因此保存后的一次 reload 会同时刷新
  Pi native settings 和 Maestro extension。仓库中 teammate 的独立嵌套
  `0.80.3` 不参与 flow package 的本次运行路径。
- [ ] 确认命令帮助及状态提示不与 `/compact` 混淆。

## 8. 测试计划

### 8.1 配置层

建议新增：

```text
packages/pi-maestro-flow/test/compaction-settings.test.ts
```

覆盖：

- 默认值、user override、project override。
- 字段级 source metadata。
- unset 后正确继承。
- malformed 或字段类型错误时的安全行为。
- 未知根字段及未知 `compaction` 字段保留。
- 临时文件 rename、mode 和保存失败。
- Windows 下 rename 到已存在目标触发 EPERM fallback（先 `unlink` 目标再 rename）。
- 同一路径并发保存串行化。
- `PI_CODING_AGENT_DIR` 与默认 user 路径解析。

### 8.2 TUI

建议新增：

```text
packages/pi-maestro-flow/test/compaction-tui.test.ts
```

覆盖：

- 宽度 `1`、`12`、`20`、`40`、`76`、`80`、`120` 均不抛错、不横向溢出。
- Tab、方向键、数值编辑、toggle、inherit。
- `U` 键清除当前作用域字段并恢复继承，unset 后显示继承来源。
- 编辑态与列表态的分层 `Esc`。
- Dirty 状态退出不误保存。
- 校验错误定位到字段。
- Save failed 保留 Tab、选中项和草稿。
- 状态在无颜色环境下仍可辨认。

### 8.3 集成测试

覆盖：

- `/maestro-compaction` 保存后 `ctx.reload()` 恰好调用一次。
- reload 后 Pi 原生与 Maestro effective settings 一致。
- 自动压缩完成后任务继续。
- 手动 `/compact` 完成后 Session idle。
- mid-turn 只在已完成文件操作的 tool result 后触发。
- native auto 与 mid-turn 同时逼近阈值时只执行一次压缩。
- plan-handoff compact 与 mid-turn 压缩请求并发时只执行一次压缩，不出现 `Already compacted`。

## 9. 验收标准

- [ ] 用户可分别在 Project 和 User 作用域配置 3 个 canonical 字段。
- [ ] TUI 正确显示活动模型的派生阈值、百分比和压力区间。
- [ ] Project override、User fallback 和 unset/inherit 行为正确。
- [ ] 保存为原子写入，未知配置不丢失。
- [ ] 保存失败保留编辑上下文；成功后只 reload 一次。
- [ ] reload 后 Pi 原生 auto-compaction 与 Maestro mid-turn 使用相同有效配置。
- [ ] 自动压缩继续当前任务，手动 `/compact` 等待下一条用户消息。
- [ ] mid-turn 基于已完成的文件操作检查点持续工作。
- [ ] 同一压力事件不会产生重复压缩或 `Already compacted`。
- [ ] 在 `1`～`120` 列宽度下安全渲染，状态不依赖颜色。
- [ ] 不覆盖 `/compact`，不破坏旧配置、旧命令和默认行为。

## 10. 风险与控制

| 风险 | 控制措施 |
|---|---|
| 写入后当前 Session 配置分裂 | Apply 成功后统一 `ctx.reload()`，并做 effective settings 集成断言 |
| reload 销毁 Overlay | Overlay 先返回并关闭，命令 handler 再 reload |
| 外部进程并发修改 settings | 原子写入、路径级串行化；保存前重新读取并仅 patch 目标字段 |
| 数值导致不可达阈值 | safe integer 与 context window 硬校验，危险组合显示警告 |
| Pi API 版本差异 | 同时验证 package 声明版本与实际运行版本，不依赖未确认的阈值 setter |
| 项目目录不可信或不可写 | Project 只读并解释原因，不静默改写 User 配置 |
| 两个压缩入口继续竞争 | 使用单一仲裁状态及真实 AgentSession 竞态测试 |

## 11. 已确定的设计决策

1. 使用 `/maestro-compaction`，不与 Pi 内置 `/compact` 冲突。
2. 只持久化 Pi 已有的 3 个 canonical 字段。
3. 阈值由 `contextWindow - reserveTokens` 派生，不增加重复字段。
4. 固定压力比率在 v1 只读展示。
5. 使用 Project/User Tab 和字段级 inherit。
6. 使用显式 Apply，并在成功后 reload 一次。
7. mid-turn 保留文件操作检查点；阈值 TUI 不以关闭 mid-turn 作为竞争修复。
