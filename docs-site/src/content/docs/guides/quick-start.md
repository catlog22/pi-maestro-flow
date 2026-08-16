---
title: "10 分钟快速入门"
icon: "🚀"
---

10 分钟了解 Maestro Flow 的核心功能和使用方法。完整安装步骤见[安装与初始化](/guides/install)。

> v0.18.0 已发布（修复 v0.17.0 撤回的 Skill 发现回归）；当前稳定安装版本为 `0.18.0`。

---

## 1. 安装

```bash
# 1. 前置：Node.js ≥ 22.19.0 与 Pi Coding Agent ≥ 0.83.0
npm install -g --ignore-scripts @earendil-works/pi-coding-agent

# 2. 安装或升级插件（teammate 与 cockpit 自动随附）
pi install npm:pi-maestro-flow@0.21.6

# 3. 验证 Flow、Teammate 与 Cockpit 均已列出
pi list
```

安装完成后**重启 Pi 或 reload extensions**，插件注册的工具即可用。

## 2. 启动并派发第一个任务

```bash
pi   # 启动，用自然语言描述任务即可
```

Maestro Flow 自动分类意图并路由：

- **简单任务** → 直接执行
- **多步工程** → 分解为链式计划，逐步验证
- **长周期目标** → 自主循环，独立验证完成度

`/maestro-help` 可浏览全部命令。

## 3. 并行多智能体调度（旗舰能力）

一次派出多个子进程智能体并行工作，支持 DAG 依赖图与结构化输出：

```javascript
teammate({
  tasks: [
    { name: "defs", agent: "explorer", prompt: "FIND: Auth 导出\nSCOPE: src/auth/" },
    { name: "calls", agent: "explorer", prompt: "FIND: Auth 导入\nSCOPE: src/" },
    { name: "report", agent: "general", prompt: "合并 {defs} + {calls} 生成缺口报告" }
  ]
})
```

`{name}` 注入上游任务输出，第三个任务会自动等待前两个完成后执行。详见[并行多智能体调度](/guides/teammate-dispatch)。

## 4. 核心概念速览

| 概念 | 一句话 |
|------|--------|
| **Flow 编排层** | goal（目标）、todo（任务）、plan（计划）、知识系统、MCP/LSP/浏览器连接 |
| **Teammate 执行引擎** | 并行子进程智能体、DAG 依赖图、模型路由 |
| **Cockpit 可视化** | 实时状态堆栈、Starship 风格 Footer、9 套主题 |

> 简言之：**flow 负责「编排与知识」，teammate 负责「并行执行」，cockpit 负责「看见」**。

架构细节见[架构与核心概念](/guides/architecture)。

## 5. 常用入口速查

| 入口 | 用途 |
|------|------|
| `/maestro-help` | 全部命令浏览 |
| `/goal status` | 查看当前 Goal |
| `/maestro-settings` | 统一设置面板 |
| `/cockpit` | Cockpit 设置覆盖层 |
| `/api-manager` | API Provider 管理 |
| `/mcp` | MCP 服务器管理 |
| Alt+S / `/smart-search config` | 搜索 Provider 配置 |

## 6. 下一步

- 想深入了解各功能子系统？浏览左侧**指南**目录。
- 想了解全部配置项与默认值？看[配置参考](/guides/settings-overview)分类。
- 排查环境变量？见[环境变量速查](/guides/env-vars)。
