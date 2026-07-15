---
title: Schema 收窄产生死代码 + TypeBox 校验允许未知属性（teammate 审计教训）
description: 三个可复用教训：schema 枚举收窄后残留分支成死代码、pi 的 TypeBox Value.Check 默认允许未知属性可安全移除内部字段、双路径重复逻辑用源码守护测试锁定共享实现
type: tip
created: 2026-07-15T07:19:01.050Z
tags:
  - typebox
  - schema-validation
  - dead-code
  - drift
  - guard-test
specCategory: learning
---

# Teammate 审计可复用教训

## 1. Schema 收窄后的死代码模式

当 schema 把字段从自由 string 收窄为枚举（如 reply_to → `caller|main`），按旧设计写的运行时分支（`if (x !== "a" && x !== "b")`）只剩 `undefined` 一条路可进，而下游函数对 undefined 又直接短路 → **整条防御逻辑静默失效但测试全绿**。排查方法：对每个"防御性分支"反推 schema 约束下它还能否命中；命中不了的删掉或放开 schema，别留着装样子。teammate 的 reply_to 死锁检测即此模式（还叠加了"声称 fallback 却直接 return 不派发"的假恢复）。

## 2. pi 工具参数校验允许未知属性

pi 的 `validateToolArguments`（`@earendil-works/pi-ai/dist/utils/validation.js`）用 TypeBox `Value.Check`，而 `Type.Object` 不设 `additionalProperties: false` 时默认放行未知字段。推论：**从对外 schema 移除一个内部字段是向后兼容的**——旧调用方继续传该字段不会被拒，运行时类型保留即可（teammate 的 `protocol_version` 即如此内部化）。反之要禁止多余字段必须显式 `additionalProperties: false`。

## 3. 双路径重复逻辑的守护方式

同一逻辑在两条代码路径各写一份（teammate 的 root execute vs handleProxyRequest）必然漂移——连错误消息都会先不一致。收敛为共享函数后，用**源码正则守护测试**锁定形态：断言两条路径都出现 `normalizeTeammateParams(...)` 调用、且 `doesNotMatch` 内联重写特征（如 `thinking:\s*parseTeammateThinkingLevel\(`）。这类测试的意图是防止重构倒退，重构时它必然红——更新断言到新形态而非删除。

## 4. 隐式字符串插值 DAG 的风险分级

依赖靠 `{name}` 插值推导时，拼写错误的默认行为是"静默不建边 + 字面量残留"——比报错更糟。分级处理：编辑距离近的未知引用报错（大概率手误）、其余警告放行（可能是合法字面量）、全图无命名任务时跳过（无引用意图）。根治靠显式 `dependsOn` 字段与推导取并集。