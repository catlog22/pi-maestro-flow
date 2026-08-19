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

### Plan 执行阶段的 Knowledge Gate

从 v0.21.6 起，已批准 plan 的执行契约以 Knowledge Gate 开启：执行 agent 在任何项目工作前须先运行 `maestro search "<1-3 个任务关键词>"`，并对每个命中的治理结果执行 `maestro load`（search 为暴露、load 记录消费），随后在进入新子系统或架构边界时重新 search。`search` 是检索归因拼写，`load` 才是消费记录——两者都不可省略。详见 `RELEASE.md` 与引擎 `agy-instructions.md`。

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
| `maestro knowledge record <ids...>` | 记录纯归因（search/load 来源） |
| `maestro knowledge review <session-id> --json` | 待裁决候选清单（含归因统计） |
| `maestro knowledge promote <session> --resolve <id> --as <处置>` | 裁决并提升候选 |

## 会话级知识治理（v0.16.0+）

知识治理下沉到会话（Session）级：候选在来源 Run/Session 封存时自动结算，带**窗口转录证据**与**可审计裁决**，杜绝无来源或脱离轨迹的知识入库。

### 窗口转录证据（K12-K17）

- `/maestro-knowledge-from-window <spec|knowhow> <标题> <内容>`（Pi）或 `maestro knowledge stage ... --transcript-quote <descriptor.json>`（CLI）以**当前窗口的原始记录**为候选背书。
- 原始引文仅作为**不可信快照证据**存储——绝不进入候选内容、评审输出或检索（铁律：暴露 ≠ 消费）；评审只呈现 `[untrusted]` 状态。
- 转录-only 候选自动进入 `review_required`，`promote --all` 会跳过它们，必须经人工裁决后显式提升。

### 归因与结算

- `maestro search` 是**暴露而非消费**——需要把命中转为证据时用 `maestro load --id`（记 `consumed`）或 `maestro knowledge record <ids...> --signal ... --source search`（纯归因）。
- Run/Session 封存时自动生成知识汇总（`run-knowledge` / `session-knowledge` 消息）——那是封存时刻的权威知识状态，无需手工重推。

### 评审呈现协议

候选需要裁决时（封存提示、`review_required`、冲突），Agent 必须自行读取 `maestro knowledge review <session-id> --json`，逐条呈现：标题、内容摘要、evidence 锚点、匹配到的既有条目（id+标题）、推荐处置（unique / duplicate / related / conflict / supersede）及一行理由；**用户只做决策**，Agent 负责读取、呈现与执行。

### 写入质量门槛

只有未来工作能直接复用、避免重付学习成本的内容才值得沉淀，且至少满足一条：① 踩坑警示（非显而易见的失败模式+预防）；② 失败教训（失败、根因、替代方案）；③ 非平凡权衡（为何 A 不选 B）；④ 新确立的规定性约束。**0 候选是合法结果**——不为证明管道有价值而硬造候选。

## 下一步

- [Self-Evolve 自进化](/guides/self-evolve) — 候选信号、评审门、auto-deposit、健康检查与 canary
- [架构与核心概念](/guides/architecture) — 知识门在流程中的位置
- [工作流模式](/guides/goal-plan-todo) — 门控 → 探索 → 实现的完整模式
- [Smart Search Provider 配置](/guides/smart-search-provider-config) — 外部检索与知识检索的分工
