<div align="center">

# pi-maestro-flow

### Maestro 工作流编排 → Pi 原生扩展

**将 [Maestro-Flow](https://github.com/catlog22/maestro-flow) 的多智能体编排能力带入 [Pi Coding Agent](https://github.com/earendil-works/pi)**

[![npm: pi-maestro-flow](https://img.shields.io/npm/v/pi-maestro-flow?color=cb3837&logo=npm&logoColor=white&label=pi-maestro-flow)](https://www.npmjs.com/package/pi-maestro-flow)
[![npm: pi-maestro-teammate](https://img.shields.io/npm/v/pi-maestro-teammate?color=cb3837&logo=npm&logoColor=white&label=pi-maestro-teammate)](https://www.npmjs.com/package/pi-maestro-teammate)
[![Pi Package](https://img.shields.io/badge/Pi-Package-8B5CF6)](https://pi.dev/packages)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

</div>

## 概述

pi-maestro-flow 是 [Maestro-Flow](https://github.com/catlog22/maestro-flow) 的 Pi 扩展版本，将 Maestro 的意图驱动多智能体编排框架转化为 Pi 原生工具和技能。

**原项目**: [catlog22/maestro-flow](https://github.com/catlog22/maestro-flow) — 意图驱动的多智能体工作流编排框架
**文档站**: [Maestro-Flow Docs](https://catlog22.github.io/maestro2/)

## 包含内容

| 资源 | 位置 | 数量 | 说明 |
|------|------|------|------|
| **Extension 工具** | `packages/` | 3+1 | `teammate`, `maestro`, `maestro-wait`, `maestro-status` |
| **Skills** | `.pi/skills/` | 113 | 全部 maestro 命令 + 技能，`/skill:name` 调用 |
| **Agent 定义** | `.pi/agents/` | 29 | teammate 子进程代理定义 |
| **Workflow 文档** | `packages/pi-maestro-flow/workflows/` | 82 | 打包的工作流参考文档 |
| **Templates** | `packages/pi-maestro-flow/templates/` | 23 | 打包的模板文件 |

## 安装

```bash
# 从 npm 安装（自动安装 pi-maestro-teammate 依赖）
pi install npm:pi-maestro-flow

# 或从本地路径安装（开发模式）
pi install ./packages/pi-maestro-teammate
pi install ./packages/pi-maestro-flow
```

> **前置依赖**: 需要安装 [Maestro CLI](https://github.com/catlog22/maestro-flow)（`npm install -g maestro-flow`）以使用 `maestro search`、`maestro load`、`maestro delegate`、`maestro explore` 等命令。

## 项目结构

```
pi-maestro-flow/
├── .pi/
│   ├── skills/                     # 113 skills（Pi 项目级）
│   └── agents/                     # 29 agents（teammate discoverAgents）
├── packages/
│   ├── pi-maestro-flow/            # 主扩展包（纯代码 + workflows + templates）
│   └── pi-maestro-teammate/        # teammate dispatch 引擎
└── docs/                           # 开发参考文档
```

| 包 | 目录 | npm | 说明 |
|---|---|---|---|
| **pi-maestro-teammate** | `packages/pi-maestro-teammate/` | [`pi-maestro-teammate`](https://www.npmjs.com/package/pi-maestro-teammate) | 核心 teammate dispatch — P0 三轴解耦 (name × reply_to × lifecycle) |
| **pi-maestro-flow** | `packages/pi-maestro-flow/` | [`pi-maestro-flow`](https://www.npmjs.com/package/pi-maestro-flow) | Maestro 工具 + 82 workflows + 23 templates |

## 工具

### teammate — 子进程代理调度

```
teammate({
  agent: "delegate",            // 代理定义名
  task: "实现认证模块",

  // P0 三轴控制
  name: "auth-worker",          // 可寻址名称
  reply_to: "caller",           // "caller" | "main"
  lifecycle: "ephemeral",       // "ephemeral" | "resident"

  // 并行模式
  tasks: [{ agent: "scout", task: "..." }, { agent: "reviewer", task: "..." }],

  // 链式模式
  chain: [{ agent: "scout", task: "查找API" }, { agent: "delegate", task: "修复: {previous}" }]
})
```

### maestro — 多动作调度

```
// 探索
maestro({ action: "explore", prompts: ["FIND: auth middleware\nSCOPE: src/"] })

// 委托
maestro({ action: "delegate", prompt: "PURPOSE: Fix auth\nTASK: Patch token refresh", tool: "claude" })

// 混合代理
maestro({ action: "moa", prompts: ["分析支付流程架构"] })
```

## Skills 分类

| 类别 | 代表 Skills | 数量 |
|------|-------------|------|
| 工作流编排 | `maestro-analyze`, `maestro-plan`, `maestro-execute`, `maestro-ralph-v2` | ~25 |
| 质量保障 | `quality-review`, `quality-test`, `security-audit` | ~8 |
| Odyssey 闭环 | `odyssey-planex`, `odyssey-debug`, `odyssey-ui` | ~5 |
| 团队协作 | `team-coordinator`, `team-executor`, `team-frontend` | ~20 |
| 知识管理 | `spec-add`, `manage-knowhow-capture`, `manage-knowledge-audit` | ~15 |
| 学术写作 | `scholar-writing`, `scholar-review`, `scholar-thesis-docx` | ~10 |
| 学习辅助 | `learn-decompose`, `learn-follow`, `learn-investigate` | ~5 |
| 工具开发 | `skill-generator`, `skill-tuning`, `workflow-skill-designer` | ~5 |

## 致谢

本项目基于 [Maestro-Flow](https://github.com/catlog22/maestro-flow) 构建，将其工作流编排能力移植到 [Pi Coding Agent](https://github.com/earendil-works/pi) 生态系统。

- **Maestro-Flow**: 意图驱动的多智能体工作流编排框架 — [@catlog22](https://github.com/catlog22)
- **Pi**: AI agent toolkit — [@earendil-works](https://github.com/earendil-works)
- **Pi Subagents**: 参考实现模式 — [pi-subagents](https://github.com/nicobailon/pi-subagents)

## License

[MIT](LICENSE)
