---
title: 0.x caret 依赖范围陷阱：跨 0.x minor bump 悄悄超出 sibling 包的 ^ 范围
description: monorepo 发布时把依赖包跨 0.x minor 升级（0.5→0.6）会使 sibling 包的 ^0.5.0 范围失效（^0.5.0=<0.6.0）；检测/修正/预防模式
type: tip
category: debug
explicitId: tip-20260727-zero-x-caret-peer-range-trap
created: 2026-07-27T04:54:26.379Z
keywords:
  - release
  - npm
  - semver
  - caret
  - peer-dependency
  - 0.x
  - monorepo
  - workspace
  - version-bump
  - publish
specCategory: debug
---

# 0.x caret 依赖范围陷阱：跨 0.x minor bump 会悄悄超出 sibling 包的 ^ 范围

## 症状

monorepo 中把某个 workspace 依赖包跨 0.x minor 升级（如 `pi-maestro-teammate` 0.5.0 → 0.6.0）后，另一个 sibling 包（如 `pi-cockpit`）的 `peerDependencies`/`devDependencies` 仍写着 `^0.5.0`。发布后该范围**不再包含** 0.6.0，安装方会得到 peer 冲突告警或解析到错误的旧版本，且本地 `npm install`（workspace symlink）不会报错，问题被掩盖到发布之后。

## 根因

npm semver 的 caret 在 0.x 上是特例：

- `^1.5.0` = `>=1.5.0 <2.0.0`（允许 minor 升级）
- `^0.5.0` = `>=0.5.0 <0.6.0`（**只允许 patch**，0.5.x；0.x 的 minor 被视为 breaking）
- `^0.0.3` = `>=0.0.3 <0.0.4`（只允许这一个 patch）

因此在 0.x 阶段跨 minor bump（0.5→0.6）等价于一次「breaking」升级，所有用 `^0.5.0` 引用它的 sibling 包范围都会失效。这与 1.x 的直觉（^ 允许 minor）相反，是 monorepo 发布盲区。

## 检测（发布前必做，并入 RCP-20260712 的 Step 1.5 / Step 3）

确定某个依赖包 `DEP` 要 bump 到 `NEW`（跨 0.x minor）后，扫描所有引用它的范围：

```bash
# 列出每个包对 DEP 的声明（dependencies / devDependencies / peerDependencies）
grep -rn "\"<DEP>\"" packages/*/package.json

# 规则判定：任何 "^0.OLD.x" 范围都不包含 0.NEW.0
node -e "console.log(require('semver').satisfies('0.6.0','^0.5.0'))"  # false → 必须放宽
```

任一 `^0.OLD.x`（OLD < NEW 的 minor）都必须放宽，否则发布后 sibling 包范围失效。

## 修正模式

1. 把所有引用包的范围改为新 minor：`^0.5.0` → `^0.6.0`（peer/dev），精确 pin 的 `0.5.0` → `0.6.0`（dependencies）。
2. `npm install` 刷新 package-lock 的 workspace 条目。
3. 再按依赖顺序发布（被依赖包先发），发布后 `npm view <sibling> peerDependencies.<DEP>` 复核范围。

## 预防

- 0.x 阶段每次跨 minor bump 前，固定执行上面的 grep 扫描，把「放宽 sibling 范围」纳入 bump 清单。
- 主包 release note 描述某特性前，确认承载该特性的依赖包已发布且所有引用范围都覆盖新版本。
- 1.x 之后此陷阱缓解（^ 允许 minor），但 0.x 项目须长期警惕。

## 本次执行记录

- v0.6.0 发布：`pi-maestro-teammate` 0.5.0→0.6.0，`pi-cockpit` peer `^0.5.0`→`^0.6.0`、dev `0.5.0`→`0.6.0`，`pi-maestro-flow` dep `0.5.0`→`0.6.0`。
- 验证：`npm view pi-cockpit@0.1.0 peerDependencies.pi-maestro-teammate` = `^0.6.0`；`npm view pi-maestro-flow@0.6.0 dependencies.pi-maestro-teammate` = `0.6.0`。
- 关联流程：`RCP-20260712-npm-publish-github-release`（Step 1.5 workspace 依赖检查）、`RCP-20260722-monorepo-workspace-dep-release-correction`。
