---
title: "Agent 角色体系"
icon: "👥"
---

teammate 支持 7 个内置角色 + 25+ 项目级角色，自定义角色通过 Markdown 定义；每个任务可独立指定 agent、模型与思考深度。

---

## 内置角色

| 角色 | 用途 | 边界 |
|------|------|------|
| `general` | 通用实现、分析和验证 | 读写与命令工具 |
| `explorer` | 代码发现与调用链追踪 | 只读 |
| `planner` | 架构与执行规划 | 只读，高 thinking |
| `analyst` | 技术分析和审查 | 只读，高 thinking |
| `research` | 项目架构知识与外部网络研究 | 只读，知识 CLI 与网络搜索 |
| `verifier` | 无 acceptance commands 时的 Goal 备用验证 | 严格只读，结构化 fail-closed verdict |
| `workflow` | 分解并派发依赖 DAG | 读取与 teammate 协作工具 |

> 旧 `delegate`、`goal-verifier` 和 `coordinator` 不再是内置名称。Goal 优先运行 acceptance commands；仅在未声明 commands 时调用 `verifier`。

## 项目级角色

项目自定义角色放在 `.pi/agents/*.md`，用户角色放在 `~/.agents/*.md`；**内置名称不可覆盖**。

当前随项目分发的角色示例（25+ 个，位于 `.pi/agents/`）：

| 分组 | 角色 |
|------|------|
| 执行 | `run-executor`、`general-executor`、`impeccable-agent`、`ralph-executor` |
| 探索 | `cli-explore-agent`、`workflow-codebase-mapper` |
| 分析 | `workflow-analyzer`、`workflow-external-researcher`、`workflow-project-researcher`、`cross-role-reviewer` |
| 规划 | `workflow-planner`、`workflow-plan-checker`、`workflow-roadmapper`、`workflow-collab-planner`、`role-design-author` |
| 评审 | `workflow-reviewer`、`workflow-verifier`、`workflow-integration-checker`、`workflow-nyquist-auditor` |
| 团队 | `team-supervisor`、`team-worker`、`ui-design-agent` |

完整清单以 `teammate-list({ view: "roles" })` 输出为准。

## 自定义角色

在 `.pi/agents/`（项目级）或 `~/.agents/`（用户级）创建 Markdown 文件：

```markdown
---
name: security-auditor
description: 安全审计专家，OWASP 视角
---

只读。审查时聚焦：认证、授权、注入、供应链。
```

- 文件名即角色名（`security-auditor.md` → `security-auditor`）；
- 角色边界通过 prompt 内的工具约束声明；
- 自定义 Agent 可声明新的小写 `taskType` 标识参与模型路由。

## 任务级角色选择

```javascript
teammate({
  tasks: [
    { name: "audit", agent: "security-auditor", prompt: "审查 src/auth/ 的安全问题" },
    { name: "fix", agent: "general", prompt: "修复 {audit} 中最高优先级问题" }
  ]
})
```

未指定角色时默认 `general`。`taskType` 只影响模型路由，不改变角色行为（详见[模型路由与思考深度](/guides/model-routing)）。

## 下一步

- [并行多智能体调度](/guides/teammate-dispatch) — 调度参数详解
- [模型路由与思考深度](/guides/model-routing) — 逐任务模型与 thinking 控制
- [权限系统](/guides/permissions) — 子进程权限中继
