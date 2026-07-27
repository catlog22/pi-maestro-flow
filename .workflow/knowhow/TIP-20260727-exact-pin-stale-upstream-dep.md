---
title: 精确 pin 的外部核心依赖不会自动跟进上游——发布前必核对 pin vs npm latest
description: pi-maestro-flow 精确 pin maestro-flow，上游发新版不会自动跟进，发布产物会静默携带落后版本；发布前核对 pin vs latest，补发需 bump 重发
type: tip
category: debug
explicitId: tip-20260727-exact-pin-stale-upstream-dep
created: 2026-07-27T05:10:17.301Z
keywords:
  - release
  - npm
  - exact-pin
  - dependency
  - maestro-flow
  - version-bump
  - publish
  - upstream
  - stale-dependency
specCategory: debug
---

# 精确 pin 的外部核心依赖不会自动跟进上游——发布前必核对 pin vs npm latest

## 症状

发布 `pi-maestro-flow@0.6.0` 后，其携带的核心 flow 引擎 `maestro-flow` 是 **0.5.55**，而 npm 上 `maestro-flow` 最新已是 **0.5.56**。即发布产物静默携带了一个落后的上游核心依赖，且没有任何告警。

## 根因

`packages/pi-maestro-flow/package.json` 对 `maestro-flow` 使用**精确 pin**（`"0.5.55"`，无 `^`/`~`）：

- 精确 pin **不会**自动跟进上游任何新版本，永远停在写入的那个版本。
- npm 发布时**忽略依赖包自带的 lockfile**，消费方安装时只按 package.json 的 range 解析——精确 pin 意味着所有消费方也固定得到 0.5.55。
- npm **禁止 republish 同一版本**，发现落后后无法原地修正，必须 bump 主包（如 0.6.0→0.6.1）重发。
- 这是隐式默认而非文档化决策；`maestro-flow` 是紧耦合的核心运行时（dependencies 里唯一的 flow 引擎），精确 pin 利于可复现，但代价是上游发布后需人工同步。

## 检测（发布前必做，并入发布 preflight）

```bash
# 上游最新版本
npm view maestro-flow version --prefer-online

# 本仓库当前 pin
node -e "console.log(require('./packages/pi-maestro-flow/package.json').dependencies['maestro-flow'])"
```

若 pin < latest，发布前必须显式决策：接受落后，还是先 bump pin 再发布。不要无意识地照搬上一版 pin。

## 修正 / 选项

| 方案 | 写法 | 取舍 |
|------|------|------|
| 精确 pin（现状） | `"0.5.55"` | 可复现、不受上游意外破坏；落后需手动 bump + 重发 |
| caret 范围 | `"^0.5.55"` | 消费方自动跟进 0.5.x patch；但 0.x 的 patch 也可能实际 breaking（见 zero-x-caret 陷阱） |
| latest / `*` | `"latest"` | 永远最新含 major；风险最高，不建议用于紧耦合核心引擎 |

补发流程：bump pin → `npm install` 刷 lock → 发布主包新 patch 版本 → tag + gh release。

## 预防

- 发布清单固化「核对每个外部核心依赖的 pin vs npm latest」一步。
- 需要自动跟进时接入 dependabot/renovate 自动提 bump PR，而非依赖人工记忆。
- 与 `RCP-20260712-npm-publish-github-release` 的 Step 1.5（workspace 依赖未发布变更检查）并列：Step 1.5 防「依赖包有变更没发」，本条防「外部依赖 pin 落后没升」。

## 本次执行记录

- v0.6.0 发布时 `maestro-flow` pin=0.5.55，npm latest=0.5.56（2026-07-24 发布），落后一个 patch。
- 唯一引用点：`packages/pi-maestro-flow/package.json:87`。
- 关联：`RCP-20260712-npm-publish-github-release`、`TIP-20260727-zero-x-caret-peer-range-trap`。
