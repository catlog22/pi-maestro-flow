---
title: Monorepo workspace 依赖未发布变更的发布修正（v0.4.12→0.4.13）
description: 发布主包时漏发 workspace 依赖包导致 release note 与产物不一致的检测、修正与预防模式
type: recipe
category: debug
created: 2026-07-22
tags: [release,monorepo,npm,workspace,dependency,versioning,publish,workflow]
status: active
---

# Monorepo workspace 依赖未发布变更的发布修正

## 症状

发布 `pi-maestro-flow@0.4.12` 后，其 release note 宣称包含「teammate 子代理生命周期 / 流式状态 / 运行指标」等特性，但这些特性实际位于 workspace 依赖包 `pi-maestro-teammate`，而 0.4.12 精确 pin 了 `pi-maestro-teammate@0.4.5`——该版本**不包含**这些特性。即已发布产物与 release note 不一致。

## 根因

- 发布主包时照搬上一版 release note 的「teammate 保持 0.4.5」结论，**未核实依赖包是否有新变更**。
- `pi-maestro-teammate` 本地版本停在 0.4.5（自 2026-07-16 未 bump），但自上个主包 tag 以来已有 6 个 commit 改动该包（+1245/-328），全部晚于 0.4.5 的 npm 发布时间（2026-07-18）。
- 「依赖包版本号未变」≠「依赖包无未发布变更」。版本 bump 滞后于实际代码变更是 monorepo 常见盲区。

## 检测（发布前必做）

```bash
# 依赖包上次发布时间
npm view pi-maestro-teammate time --json | tail -5

# 自上个主包 tag 以来依赖包目录的新 commit
git log v0.4.11..HEAD --oneline -- packages/pi-maestro-teammate/

# 本地版本 vs npm 已发布版本
node -e "console.log(require('./packages/pi-maestro-teammate/package.json').version)"
npm view pi-maestro-teammate version
```

任一信号表明依赖包有已提交未发布变更，且主包 release note 描述这些特性，就必须先发布依赖包。

## 修正模式

npm 不允许 republish 同一版本，因此修正需要新 patch 版本：

1. **先发布依赖包**：bump `pi-maestro-teammate` 0.4.5→0.4.6，`npm publish --workspace=packages/pi-maestro-teammate`。
2. **再升主包**：bump `pi-maestro-flow` 0.4.12→0.4.13，同时把依赖 `pi-maestro-teammate` 0.4.5→0.4.6，`npm install` 更新 lock。
3. **重发主包**：`npm publish --workspace=packages/pi-maestro-flow`。
4. **RELEASE.md 注明 supersedes**：明确本版本取代上一版及原因，更新版本对照表与验证段。
5. tag + push + `gh release create`，标题注明 supersedes。

## 预防

- 发布流程固化「Step 1.5：检查 workspace 依赖包未发布变更」（见 `RCP-20260712-npm-publish-github-release`）。
- 主包 release note 描述某特性前，先确认该特性所在包已发布且主包依赖版本已指向它。
- 依赖包代码变更后应即时 bump 版本，避免版本与实际变更长期脱节。

## 本次执行记录

- `pi-maestro-teammate@0.4.6`：https://github.com/catlog22/pi-maestro-flow/releases/tag/v0.4.13
- `pi-maestro-flow@0.4.13`（dep teammate@0.4.6）：同上 tag
- 验证：`npm view pi-maestro-flow@0.4.13 dependencies.pi-maestro-teammate` = 0.4.6
