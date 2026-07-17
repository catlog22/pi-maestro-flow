---
title: Pi 版本 Skill 迁移 — AGENTS.md 知识系统积极调用门同步
description: 将 claude-instructions.md 的知识系统积极调用门机制迁移到 Pi 版本 AGENTS.md 的步骤清单
type: recipe
category: arch
created: 2026-07-17T23:00:00+08:00
tags: [AGENTS.md, 知识系统, 积极调用门, pi迁移, skill迁移]
status: active
---

# Pi 版本 Skill 迁移 — AGENTS.md 知识系统积极调用门同步

## Goal

将 maestro2 `workflows/claude-instructions.md` 中经过验证的知识系统积极调用门（active invocation gate）机制同步到 Pi 版本 `packages/pi-maestro-flow/AGENTS.md`，保留 Pi 特有的 teammate/explorer 工具表面积。

## Source → Target

| Source | Target |
|--------|--------|
| `D:\maestro2\workflows\claude-instructions.md` | `D:\pi-maestro-flow\packages\pi-maestro-flow\AGENTS.md` |

## Prerequisites

- 已读取源文件 Knowledge System 完整章节。
- 已读取目标文件，识别 Pi 特有模式（teammate、explorer、rg、`/spec-add`、`/manage-knowhow-capture`）。

## Migration Steps

### Step 1: Mandatory Gate — 空结果 ≠ 免检 + Re-search triggers

**Source 机制**: Gate rule 明确 empty results 不免检，返回 hint 时先执行 hint 再重试；Re-search triggers 定义三个重搜时机。

**操作**:
1. 在 `### Mandatory Gate` 段落补充：`Empty results do not exempt the gate: when the response includes a hint (e.g. code index not initialized), execute the hinted command and retry before proceeding.`
2. 在 `maestro search` 命令参数中补充 `--kind <kind>`，并加注释说明 sealed run artifact kind filter。
3. 新增 **Re-search triggers** 小节，列出三个触发条件：进入新模块边界、同一问题修复失败 2 次、架构/方案决策前。

**Pi 适配**: 保留原有 "dispatching an explorer, dispatching another teammate" 的 Pi 用语。

### Step 2: Query Rules — 路由表扩充 + Association follow-through

**Source 机制**: 完整路由表（含 Debug 症状 / review 教训查询路径）；Association follow-through 沿关联走一跳。

**操作**:
1. 将简单的 bullet list 改为 `| Target | Tool |` 路由表，包括：
   - Known symbol → `maestro search --code`
   - Concept / knowledge → `maestro search`
   - Debug symptoms / review lessons → `maestro search --kind diagnosis` / `--kind lessons`
   - Usage sweep / pattern scan → `teammate` + `agent: "explorer"`（Pi 特化）
   - Exact regex → `rg`（Pi 特化，非 Grep tool）
2. 新增 **Association follow-through** 小节：
   - Chunked entry → `maestro load --type knowhow --id <parent-id>`
   - Backlinks / forward links → `maestro wiki backlinks/forward <id>`
   - Rule evolution → `maestro spec history <sid>`

**Pi 适配**: 路由表中 explore 行和 regex 行使用 Pi 原生工具名。

### Step 3: Record — Finish checklist

**Source 机制**: `session-mode: run` 模式下 `maestro run check` 全绿时会发出 finish 收口清单（handoff、补录、冲突标注、verdict）。

**操作**: 在 Record 末尾补充 `In session-mode: run, maestro run check emits a finish checklist on all-green — execute each item; do not skip.`

**Pi 适配**: 无需修改，maestro run 机制跨平台一致。

### Step 4: Supersession — 三正交轴

**Source 机制**: confidence ⊥ status ⊥ time-decay 三轴正交，不混用。

**操作**: 将 `Keep confidence, lifecycle status, and time decay as separate dimensions.` 改为显式的 **Three orthogonal axes** 声明：`confidence (human/audit ruling) ⊥ status (active/deprecated lifecycle) ⊥ time-decay (automatic freshness). Do not conflate them.`

**Pi 适配**: 无需修改，spec 生命周期跨平台一致。

## Verification

- [ ] AGENTS.md Mandatory Gate 段落包含空结果 hint 重试 + re-search triggers
- [ ] Query Rules 含 5 行路由表 + association follow-through
- [ ] Record 末尾含 finish checklist 提示
- [ ] Supersession 含三正交轴声明
- [ ] 所有 Pi 特有用语（teammate、explorer、rg、/spec-add、/manage-knowhow-capture）保留不变
- [ ] 文件结构和其他章节（Teammate、Explore、Todo、Goal、Smart Search、Execution）未被改动

## Notes

- AGENTS.md 的 Tool Boundaries、Teammate、Explore with Teammate、Todo、Goal、Smart Search、Execution 等 Pi 特有章节不在本次迁移范围。
- 未来 claude-instructions.md 的 Explore 章节如有重大更新，需单独评估是否同步到 AGENTS.md 的 Explore with Teammate 章节（因工具表面积完全不同）。
