---
title: pi-maestro-flow Skill 全量同步 — 子目录白名单丢失修复 + 一键同步脚本
description: convert.mjs 硬编码子目录白名单导致 roles/specs/phases 等被静默丢弃;改为整目录递归拷贝,并固化 sync-pi.mjs 三段流水线一键同步
type: recipe
category: build
created: 2026-07-30T19:45:00+08:00
tags: [pi迁移, skill迁移, convert.mjs, sync-pi, 子目录丢失, 构建流水线]
status: active
---

# pi-maestro-flow Skill 全量同步 — 子目录白名单丢失修复 + 一键同步脚本

## Goal

把 Claude harness(`D:\maestro2\.claude`)完整移植到 pi-maestro-flow 的 pi 构建输出(`flow/`),保证每个 skill 的**所有子目录与附属文件**(`roles/`、`specs/`、`phases/`、`templates/`、`examples/`、`.json`、`.ps1` 等)零丢失,并固化为可重复执行的一键脚本。

## Symptom

`.pi/skills/team-review/`、`flow/skills/team-review/` 只剩 `SKILL.md`,`roles/`(coordinator/fixer/reviewer/scanner)与 `specs/`(`finding-schema.json`、`team-config.json`、`dimensions.md`、`pipelines.md`)全部缺失。共 **45 个 skill** 受影响。

## Root Cause

`D:\pi-maestro-flow\convert.mjs`(Phase 1 拷贝阶段)用**硬编码白名单**拷子目录:

```js
// 旧代码 — 只认这 3 个名字,其余静默跳过
for (const sub of ['scripts', 'references', 'assets']) {
  cpSync(join(srcDir, dir, sub), join(targetDir, sub), { recursive: true });
}
// “其它 .md” 这步只拷顶层、不递归,roles/coordinator/role.md 永远到不了
const otherFiles = readdirSync(join(srcDir, dir)).filter(f => f !== 'SKILL.md' && f.endsWith('.md'));
```

凡子目录名不在 `['scripts','references','assets']` 的一律被丢弃。被丢的目录名包括:`roles specs phases templates examples workflows agents index wisdom`。

## The Fix (convert.mjs `convertSkills()`)

整目录递归拷贝,再单独用 frontmatter 转换版覆写 `SKILL.md`:

```js
// 递归拷贝整个 skill 目录(所有子目录 + 任意深度 .md/.json/.ps1)
cpSync(join(srcDir, dir), targetDir, { recursive: true });
// 覆写 SKILL.md 为 frontmatter 转换版(Claude 工具名 → pi)。
// 附属 .md/.json 保留原始内容,由 convert-pi.mjs(Phase 2)就地改写。
writeFileSync(join(targetDir, 'SKILL.md'), output, 'utf-8');
```

## Pipeline(三段,全部以 `flow/` 为目标)

| Phase | 脚本 | 职责 |
|-------|------|------|
| 1 | `convert.mjs` | 拷贝 `.claude` → `flow/`(commands→skills、agents、skills 递归) |
| 2 | `convert-pi.mjs` | Claude 模式 → pi 就地改写(allowed-tools、Agent/Skill、`<required_reading>` 等);默认目标 `flow/`,仅当 `flow/` 不存在才回退 `.pi/` |
| 3 | `convert-paths.mjs` | `~/.maestro/workflows|templates/` → `~/.pi/agent/packages/pi-maestro-flow/...` |

**关键认知**:`flow/` 是权威 pi 构建输出(随后安装到 `~/.pi/agent/packages/pi-maestro-flow/`)。仓库内的 `.pi/` 目录只是 Phase 2 的回退目标,属陈旧产物,流水线默认不刷新它。

## One-shot Script: `sync-pi.mjs`

已新增 `D:\pi-maestro-flow\sync-pi.mjs`(薄编排器,`spawnSync` 依次调用三段脚本):

```bash
node sync-pi.mjs              # 同步 flow/ 并做子目录完整性校验
node sync-pi.mjs --also-pi    # 额外用 flow/ 刷新陈旧的 .pi/{skills,agents}
node sync-pi.mjs --skip-verify
```

- 任一阶段非 0 退出 → 整体退出码 1。
- 校验:逐个 skill 比对 `D:/maestro2/.claude/skills/<name>` 与 `flow/skills/<name>` 的文件数,**有任何丢失即失败**。
- 环境变量:`PI_SYNC_SRC`(默认 `D:/maestro2/.claude`)、`PI_SYNC_DST`(默认 `<repo>/flow`,经 `PI_MAESTRO_CONVERT_DST` 传给 Phase 2)。

## Verification

- [x] `node sync-pi.mjs --also-pi` 退出码 0
- [x] 45 skills full parity, no subfolder/file lost
- [x] `flow/skills/team-review/` 含 `roles/`(4 角色 + coordinator/commands)+ `specs/`(4 文件)
- [x] `.pi/skills ← flow/skills (488 files)`、`.pi/agents ← flow/agents (25 files)`
- [x] Phase 3 路径替换在附属文件中生效(如 `roles/coordinator/role.md`)

## Notes

- `convert.mjs` / `convert-paths.mjs` 的 `DST` 仍硬编码 `flow/`;`PI_SYNC_DST` 目前只对 Phase 2 与校验生效。若要完全可配置,需让这两个脚本也读环境变量。
- 新增 skill 或修改 `.claude` 源后,直接重跑 `node sync-pi.mjs --also-pi` 即可,幂等。
- 校验只看文件数 parity,不比对内容;内容正确性由 Phase 2/3 的改写逻辑保证。
