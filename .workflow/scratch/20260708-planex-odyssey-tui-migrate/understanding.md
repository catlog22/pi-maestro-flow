# TUI Migration — understanding.md

## 1. Requirement & Criteria

**需求**: 参考 oh-my-pi 优化 pi-teammate TUI 显示，迁移重构有价值的组件，保持高效精简。

**分析发现**:
- `@earendil-works/pi-tui` 即 oh-my-pi TUI 包的发布版，已导出 Box/ScrollView/TabBar/visibleWidth 等组件
- pi-teammate 已声明 `@earendil-works/pi-tui` 为 peerDependency (0.80.3)
- 当前 `attach-overlay.ts` (377行) 全部手写：边框、标签页、滚动、宽度计算
- `render.ts` 使用 `.slice(0, N)` 截断，CJK/emoji 不正确

**验收标准 (8项)**: AC1-AC8 全部通过。

## 2. Plan

6 个任务按依赖链执行：T1(render.ts宽度) → T2+T3(TabBar+ScrollView) → T4(Box边框) → T5(Spinner) → T6(精简验证)

## 3. Execution

**修改文件**:
- `pi-teammate/src/tui/render.ts` — 5 处 `.slice(0, N)` → `truncateToWidth()`
- `pi-teammate/src/tui/attach-overlay.ts` — 完全重写 377→269 行
- `flow/src/tools/plan.ts` — plan overlay 重构（discovery 阶段追加）

**技术决策**:
- 使用 `LinesProxy` 组件将动态内容传递给 Box，避免为每个区段创建独立 Component
- 每个 agent 保持独立的 `scrollOffset`，在 render 时同步到 ScrollView
- Spinner 使用 80ms setInterval 驱动 braille 帧循环，仅在有 running tools 时触发 requestRender

## 4. Verification

| AC | 方法 | 结果 | 证据 |
|----|------|------|------|
| AC1 | grep | PASS | `new Box(0, 0, undefined, BORDER)` line 77 |
| AC2 | grep | PASS | `new ScrollView([], {...})` line 73, `.render(inner)` |
| AC3 | grep | PASS | `new TabBar("", ...)` line 69, `tabBar.handleInput` |
| AC4 | grep | PASS | 0 stripAnsi, 7x truncateToWidth, 2x visibleWidth |
| AC5 | review | PASS | 所有快捷键/功能逐一确认 |
| AC6 | wc -l | PASS | 269 行 (目标 ≤300，原 377) |
| AC7 | grep | PASS | 5x truncateToWidth in render.ts |
| AC8 | grep | PASS | SPINNER 帧 + setInterval 80ms |

## 5. Fix Log

- **AC6 首次 349 行超标** → 去除 section 注释、压缩常量定义、合并接口、内联简单逻辑 → 269 行

## 6. Generalization

**模式 P1**: `stripAnsi() + .length + manual box-drawing + manual scrollOffset` → 可用 pi-tui 组件替换

**3 层扫描结果**:
| 层 | 命中 | 跨层确认 |
|----|------|----------|
| Syntax | `plan.ts` stripAnsi + `.slice` + `+-|` 边框 | ✓ |
| Semantic | `plan.ts` 完整 overlay 反模式 | ✓ |
| Structural | `plan.ts` 平行模块结构 | ✓ |
| Historical | stripAnsi 近期引入，无回归风险 | ✓ |

**统计**: 1 pattern, 2 total hits (attach-overlay + plan), 1 cross-layer confirmed, 0 regression risks

## 7. Discoveries

| # | 文件 | 分类 | 处置 |
|---|------|------|------|
| 1 | `flow/src/tools/plan.ts` overlay | risk → **已修复** | Box + ScrollView + wrapTextWithAnsi |
| 2 | `flow/src/extension/index.ts` .slice(0,40) | safe | 低影响，纯 ASCII |
| 3 | `flow/src/statusline/statusline.ts` | safe | 无宽度计算 |
| 4 | `pi-teammate/extension/index.ts` widget | safe | 结构过简单 |

## 8. Learnings

**可复用实现模式 — pi-tui overlay 构建范式**:

1. 创建 `LinesProxy` 作为 Box 的唯一子组件，允许动态设置渲染内容
2. Box(paddingX=0, paddingY=0, border=config) 提供统一边框
3. 内部分区用 `dim("─".repeat(inner))` 分隔（Box 自动添加 `│` 侧边）
4. ScrollView 管理可滚动区域，per-entity scrollOffset 外部存储并在 render 时同步
5. TabBar 处理标签切换，onTabChange 回调更新活跃 ID
6. 所有宽度计算通过 `visibleWidth`/`truncateToWidth`，消除 CJK/emoji 问题

**多轮修复模式**:
- AC6 首次超标时，优先删除注释/空行/section 分隔，然后压缩常量定义和接口声明
- 保持功能代码不变，仅压缩声明和格式

**验收标准模板 — migration 类型**:
- 行为保全 AC 必须包含所有已知功能点的逐一枚举
- 行数 AC 的目标应设为原始行数的 80% 而非绝对值，更灵活
- verify_method: grep 适用于组件使用验证；cli-review 适用于行为保全
