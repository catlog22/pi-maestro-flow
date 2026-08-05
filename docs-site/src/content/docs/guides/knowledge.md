---
title: "知识系统"
icon: "🧠"
---

持久化知识系统确保 Agent 在接触代码前拥有完整的项目上下文：语义搜索、Spec 规范与 Knowhow 经验沉淀，跨会话存活。

> **执行边界**：本文的命令分三种界面——`bash` 代码块中的 `maestro search/load` 由 Agent 经 `bash_bg` 以 CLI 方式执行（区别于 teammate-dispatch 中模型侧 `maestro({ action: ... })` 工具的 explore/delegate/moa 三个 action）；`/maestro-spec`、`/maestro-knowhow` 是用户在 Pi 会话中输入的斜杠命令；`maestro spec supersede ...` 等维护命令同样是 Agent 侧 CLI。

---

## 强制知识门

在任何代码访问或调度之前执行：

```bash
# 搜索（跨 spec、knowhow、domain、issue、session）
maestro search "<查询>" [--type spec|knowhow|domain|issue] [--code] [--kg]

# 加载特定知识
maestro load --type <type> [--list] [--category <cat>] [--keyword <word>] [--id <id>]
```

知识门是暴露而非消费：搜索响应被检视、相关条目完整可用后，门才算通过。只有 ID 或摘要（如压缩后）存活时，需要重新加载。

## 查询最佳实践

```bash
# ❌ 避免关键词堆砌
maestro search "topology display frontend DetailedTopologySVG elk layout rendering"

# ✅ 使用聚焦查询
maestro search "topology layout"
maestro search "DetailedTopologySVG" --code
maestro load --type spec --category coding
```

- 每个查询用 1-3 个核心关键词；
- 概念查询与代码符号查询分离；
- 进入新子系统、连续两次修复失败、或架构决策前，重新搜索。

## 知识类型

| 类型 | 分类 | 用途 |
|------|------|------|
| `spec` | `arch`, `coding`, `debug`, `test`, `review`, `learning`, `ui` | 可复用约定和规则 |
| `knowhow` | `compact`, `tip` | 任务特定模式和配方 |
| `domain` | — | 项目术语表 |
| `issue` | — | 跟踪的 Bug 和任务 |
| `roadmap` | — | 里程碑和阶段规划 |

## 知识生命周期

```bash
# 添加
/maestro-spec "coding: 使用 Result<T,E> — 服务方法必须返回 Result<T,AppError>"
/maestro-knowhow

# 演化（替代、冲突标记）
maestro spec supersede SPEC-042 --by SPEC-089     # 替代旧规则
maestro spec conflict mark src/auth.ts 45 --note "JWT vs session: 两者均有效"

# 维护
maestro spec health                                # 健康检查
maestro spec history SPEC-042                     # 查看历史
maestro search "旧模式" --include-deprecated       # 搜索含已废弃
```

### 三轴正交

| 轴 | 说明 |
|----|------|
| `confidence` | 人工/审计裁决 |
| `status` | active / deprecated 生命周期 |
| 时间衰减 | 自动新鲜度衰减 |

## 相关知识操作

| 命令 | 用途 |
|------|------|
| `maestro search` | 知识检索（跨类型、code、kg） |
| `maestro load --type ... --id ...` | 加载完整条目 |
| `maestro wiki backlinks <id>` / `forward <id>` | 关联导航 |
| `maestro spec history <sid>` | 规则历史 |
| `maestro knowledge stage` | 暂存可复用配方/坑 |

## 下一步

- [架构与核心概念](/guides/architecture) — 知识门在流程中的位置
- [工作流模式](/guides/goal-plan-todo) — 门控 → 探索 → 实现的完整模式
- [Smart Search Provider 配置](/guides/smart-search-provider-config) — 外部检索与知识检索的分工
