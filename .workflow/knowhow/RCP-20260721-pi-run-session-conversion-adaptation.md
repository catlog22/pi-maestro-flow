---
title: Pi run/session 架构适配应走转换脚本
description: 将 Maestro 新 run/session 人类 CLI 适配同步到 Pi skills 的转换链路、验证方法与后续完善点
type: recipe
category: arch
created: 2026-07-21T00:00:00+08:00
tags: [pi, skill迁移, run-session, convert-pi, session架构]
status: active
---

# Pi run/session 架构适配应走转换脚本

## Goal

Pi 版本 skills 需要跟随 Maestro run/session 架构创新：人类入口使用 `maestro run start`、`maestro run done`、`maestro run edit` 和 `maestro session create --chain`；`session create --chain-file` 只保留为高级 coordinator JSON 路径。适配应沉到转换脚本，而不是安装脚本或 package prepack 拷贝脚本。

## Current Decision

- **转换入口**：`convert-pi.mjs` 是 Claude/Codex 文案与工具表面转为 Pi 形态的适配层；run/session CLI 语义替换应放在这里。
- **结构入口**：`convert.mjs` 负责 `.claude` commands/agents/skills 到目标目录的结构转换。
- **发布入口**：`packages/pi-maestro-flow/scripts/prepare-package-skills.mjs` 只在 `prepack` 时把 root `.pi/skills` 复制到 package 内，不能承载语义迁移。
- **runtime 状态**：`packages/pi-maestro-flow/src` 和 `packages/pi-maestro-teammate/src` 当前没有直接硬编码旧 `run create` / `run complete` / `--chain-file` 调用，欠债主要在转换规则和验证防线。

## Adaptation Rules

1. 单步人类入口：使用 `maestro run start "<intent>" --cmd <step> --platform pi --workflow-root .`。
2. 完成入口：面向 skill/agent 文案优先使用 `maestro run done <run_id> --verdict ...`；core coordinator 内部可继续使用 `maestro run complete --session ... --verdict ...`。
3. 简单链：使用 `maestro run start "<intent>" --chain <cmd...> --no-dispatch` 或 `maestro session create "<topic>" --chain <cmd...>`。
4. 中途追加或调整 future steps：使用 `maestro run edit <cmd...> --after latest`；不要为同一任务再建第二个 Topic Session。
5. `session create --chain-file` 仅用于含 `decision_points`、`decomposition`、`argument_requirements`、retry metadata 或 executor hints 的高级 coordinator chain。
6. 转换脚本必须区分 frontmatter 和正文；工具名 remap 只作用于真实 frontmatter，不得改坏 fenced code/template 中的示例 `allowed-tools:`。

## Implementation Notes

- `convert-pi.mjs --dst .pi` 可直接对 canonical Pi resources 运行，便于本地修正 root `.pi/skills`。
- 转换脚本需要兼容 Windows 路径，判断 agents/skills 路径时应 normalize `\` 为 `/`。
- 正文中的 `AskUserQuestion` 可转为 Pi 语义的 `user prompt`，但 frontmatter 的 `allowed-tools` 仍必须保留真实工具名。
- team coordinator 模板中 `Otherwise: maestro run create ...` 应改为 `maestro run start "<task summary>" --cmd <team-skill> --session <slug> --platform pi --workflow-root .`。
- team monitor 中面向人类/skill 文案的 `maestro run complete <run_id>` 可改为 `maestro run done <run_id>`。

## Needed Improvements

当前适配可以工作，但程序还应继续完善：

1. **规则模块化**：把 `transformSessionRunCli()` 内的大段字符串替换拆成命名规则表，按 `core maestro`、`maestro-next`、`team coordinator`、`template examples` 分类，降低误替换风险。
2. **fixture 回归**：新增转换 fixture 测试，覆盖 frontmatter、fenced code、JSON catalog、team role、core coordinator 五类输入；要求转换后 idempotent。
3. **pipeline 文档化**：在开发文档中明确顺序：`convert.mjs` 结构转换 → `convert-pi.mjs --dst .pi` Pi 语义转换 → skill contract lint → package tests。
4. **防回退扫描**：把旧入口扫描固化为测试或 lint：禁止非高级路径出现 `run prepare + run create`、裸 `run create`、把 `--chain-file` 作为默认手写路径。
5. **版本能力检查**：如果依赖的 `maestro-flow` 版本未提供 `run start` / `run done` / `run edit`，Pi package 应在 install 或 test 阶段给出清晰失败，而不是生成不可执行的 skill 文案。
6. **转换目标收敛**：长期应消除硬编码 `D:/maestro2` / `D:/pi-maestro-flow`，让源目录和目标目录通过 CLI 参数或环境变量传入。

## Verification

本次适配后可用以下命令验收：

```bash
node convert-pi.mjs --dst .pi
node --check convert-pi.mjs
rg -n "run prepare|run create|session create --chain-file|chain-file|ralph next" .pi/skills .pi/agents -g "*.md" -g "*.json"
cd packages/pi-maestro-flow
npm run test:package
npm run test:session
```

期望结果：

- `run prepare` / `run create` 不再作为普通人类入口出现。
- `run create` 只可出现在 executor 的禁止重复建 Run 说明等反例上下文。
- `--chain-file` 只出现在高级 coordinator JSON 路径说明。
- `test:session` 的 `skill-contract-lint` 通过，non-core skill contract findings 为 0。

## Related

- `convert.mjs`：结构转换。
- `convert-pi.mjs`：Pi 兼容语义转换，应承载 run/session CLI 迁移规则。
- `.pi/skills/maestro/SKILL.md`、`.pi/skills/maestro-ralph/SKILL.md`、`.pi/skills/maestro-next/SKILL.md`：核心 run/session skill contract。
- `packages/pi-maestro-flow/scripts/prepare-package-skills.mjs`：发布前复制 canonical skills，不做语义迁移。
