---
title: 发布前枚举所有 workspace 包并校验 registry tarball SHA
description: 防止 settings-core 等低可见度 workspace 包有源码变更但未 bump，导致精确依赖消费者发布旧协议
type: tip
category: review
explicitId: tip-20260805-publishable-workspace-sha-drift
created: 2026-08-04T16:38:54.476Z
keywords:
  - workspace
  - settings-core
  - version-bump
  - tarball
  - shasum
  - release-gate
---

## 症状与证据

`v0.14.1..v0.14.2` 中 `packages/pi-maestro-settings-core/src/public/v1/schema.ts` 新增 40 行，加入 `SETTINGS_SECRET_SET_PLACEHOLDER`、`list-crud`、`overview` 和 overview status，测试新增 63 行，但 manifest 仍为 `0.1.0`。npm `pi-maestro-settings-core@0.1.0` shasum 为 `9052aaf7c9ae0e503b7601c153f1dedab48f5b82`，当前本地同版本 dry-run shasum 为 `2c0fabe12df2b42ab1ad3f7a609b7e447efb32de`；直接解包 diff 证明 registry tarball 缺少上述协议。

Flow、Teammate、Cockpit 均精确依赖 `pi-maestro-settings-core@0.1.0`。workspace typecheck、组合 packed install 甚至启动 smoke 可能因 workspace hoist、TypeScript loader/jiti 对缺失 value export 的处理而未立即失败，不能作为“registry 内容相同”的证据。

## 发布前强制校验

1. 从 workspaces manifest 枚举每个可发布包，不能手写“主三包”白名单。
2. 对每包检查 last tag 到候选 commit 的目录 diff、local version、npm latest/version、npm 发布时间。
3. 即使 local version 等于 registry version，也必须比较 `npm pack --dry-run --json` 的 shasum 与 `npm view <pkg>@<version> dist.shasum`。同版本 SHA 不同即阻断发布。
4. release note 的版本矩阵、dry-run 表和发布顺序必须包含所有有可发布内容变更的 workspace 包。
5. 对精确依赖构建闭包：底层包 bump 后，所有精确消费者都必须 bump 并更新依赖。settings-core 修正链应为 settings-core -> teammate/cockpit -> flow。
6. 根 `test:release` 必须先运行 settings-core typecheck/test，并用 manifest contract 断言三个消费者依赖值等于本地 settings-core version。

## 当前决策

不重发不可变的 `0.1.0`，也不立即创建修正版。保持已发布 `v0.14.2` 不变，等待下一个版本统一 bump settings-core 与全部精确消费者。下次发版前必须先处理该依赖闭包并重新执行四包 dry-run、registry 安装和运行 smoke。

关联：`knowhow-rcp-20260804-verified-monorepo-release`、`knowhow-rcp-20260722-monorepo-workspace-dep-release-correction`。
