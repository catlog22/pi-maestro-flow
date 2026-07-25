---
title: pi TUI 工具流式刷新导致主页面反复置顶的根因与修复
description: 流式工具组件高于视口且首行每秒变化时，tui.ts doRender 的 firstChanged<prevViewportTop 分支无条件 fullRender(true) 导致反复置顶；上游未修复，附源码修复与免源码规避方案
type: tip
explicitId: tip-20260725-pi-viewport-jump-fullredraw
created: 2026-07-25T01:23:36.032Z
keywords:
  - tui
  - viewport
  - fullRedraw
  - 置顶
  - 流式刷新
  - teammate
  - doRender
  - firstChanged
  - differential-render
specCategory: debug
---

# 症状

工具（尤其是会**流式刷新**的工具，如 teammate 的多 agent 进度树）每次刷新时，pi 主页面**反复被置顶**（清屏 + 光标回到顶部 + 滚动缓冲被清空），表现为整页闪烁/跳顶。

# 根因（上游 pi 源码）

位置：`packages/tui/src/tui.ts` 的 `doRender()` 差分渲染算法。

当本次渲染的**首个变化行**位于上一帧可见视口之上时，代码无条件触发全量重绘：

```ts
if (firstChanged < prevViewportTop) {
  logRedraw(`firstChanged < viewportTop ...`);
  fullRender(true);   // 发出 \x1b[2J\x1b[H\x1b[3J：清屏 + 光标 home + 清滚动缓冲
  return;
}
```

`fullRender(true)` 的 `\x1b[H`（光标 home）+ `\x1b[3J`（清 scrollback）就是「置顶」的来源。

触发条件（两者同时满足）：
1. 流式工具组件渲染高度 **超过终端视口**（组件越高越容易触发）；
2. 组件**首行（行 0）每次刷新都变化**——典型是进度 header 里**每秒跳动的耗时** `formatDuration(focusedDurationMs)`。

此时行 0 落在视口之上（`firstChanged=0 < prevViewportTop`），而每秒一次的耗时跳动使 `firstChanged` 持续命中该分支 → **每秒一次全量重绘 → 反复置顶**。

注：pi-maestro-flow 之前把 teammate 进度改为「不折叠、整棵树全显示」后，组件更容易高于视口，从而暴露了这个上游潜在 bug。

# 上游状态（截至本地落后 origin/main 240 commit 时核对）

- `origin/main`（earendil-works/pi）该分支逻辑**完全相同**，**上游未修复**。
- 自本地 HEAD 起仅 2 个 commit 动过 `tui.ts`，均与此无关（调试日志路径、退出时清理反色光标）。
- **没有任何配置项/环境变量**可控制该触发：渲染相关只有 `clearOnShrink`（`PI_CLEAR_ON_SHRINK`，默认关，且是另一条触发路径）。

# 源码修复方案（已在本地 G:\github_lib\pi 实现并验证）

将该分支改为「仅在确有必要时才全量重绘」：

```ts
if (firstChanged < prevViewportTop) {
  if (lastChanged < prevViewportTop) {
    // 所有变化行都在视口之上（已滚走），可见区没变 → 跳过重绘
    this.previousLines = newLines; ...; return;
  }
  if (newLines.length === this.previousLines.length) {
    // 变化延伸到视口但总行数不变（位置未移位）→ 收敛到视口顶，只差分更新可见部分
    firstChanged = prevViewportTop;
  } else {
    fullRender(true); return;   // 上方高度真的变了 → 仍需全量重绘（正确性所需）
  }
}
```

验证：新增 `packages/tui/test/tui-viewport-no-jump.test.ts`（3 项，去掉修复前 2 项失败）；TUI 全套 693/693 通过；`tsgo --noEmit` 与 biome 通过。

# 不修改 pi 源码的规避方案（pi-maestro-flow 侧，部分缓解）

触发关键是「视口上方的行每秒在变」。从扩展侧让**组件首行保持稳定**即可消除每秒全量重绘：

- **把每秒跳动的耗时从 header（行 0）移走**（放到靠近底部、始终可见的行，如 focused-tool 行），header 只在状态切换时变化 → `firstChanged` 落在视口内 → 不再每秒全量重绘。保留整棵树不折叠。
- 或**给流式组件设高度上限**（重新引入窗口化），使组件不高于视口——但与「不折叠全显示」的需求冲突。

局限：扩展侧方案只消除「每秒」跳顶；当 agent 增删/完成导致组件**高度结构变化**时仍可能偶发全量重绘（罕见，可接受）。要彻底解决仍需 pi 源码修复（用户维护 catlog22/pi fork，补丁可落在 fork 上）。

# 关键文件

- 上游 bug：`G:\github_lib\pi\packages\tui\src\tui.ts`（`doRender`，`firstChanged < prevViewportTop` 分支）
- 触发源：`D:\pi-maestro-flow\packages\pi-maestro-teammate\src\tui\render.ts`（`renderProgress` 的 header 含每秒耗时）
- 修复测试：`G:\github_lib\pi\packages\tui\test\tui-viewport-no-jump.test.ts`
