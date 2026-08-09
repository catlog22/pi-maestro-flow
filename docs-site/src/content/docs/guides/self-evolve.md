---
title: "Self-Evolve 自进化"
icon: "✨"
---

Self-Evolve 把 Pi 的真实运行轨迹转成**可审计、可评审、可回退的知识候选**。它监听回合结束和会话压缩边界，提取可复用经验、证据与候选类型，再通过评审门决定跳过、保留不确定项或进入知识候选池。

> Self-Evolve 默认禁用。它不会让模型直接改写知识库或 Skill。即使启用 `auto-deposit`，也只会在用户显式运行 `/self-evolve review` 后自动 **stage** 过门候选；**promotion 始终是独立治理动作，绝不自动执行**。

> **版本可用性：** 当前稳定版 0.16.0 支持 dry-run 候选信号；包含 `auto-deposit` 的 v0.17.0 已撤回。本页保留当前源码中的 auto-deposit、health、canary 与 proposal 契约供修复版审阅，请勿安装 0.17.0。

---

## 1. 最短上手流程

建议第一次使用保持默认 `dry-run`：

```text
# 启用候选信号收集
/self-evolve on

# 查看当前模式、模型、预算、输出目录与计数器
/self-evolve status

# 正常工作若干回合，或经历一次 session compact
# 然后查看最近 10 条信号
/self-evolve signals 10

# 用 analyst 评审最近 5 条可行动信号
/self-evolve review 5

# 查看评审历史
/self-evolve reviews 5
```

此流程只生成 suggestions、evidence 和 reviews，不写入知识候选池。确认信号质量稳定后，再考虑 `auto-deposit`。

## 2. M1-M5 功能分层

Self-Evolve 不是一个无约束的“自动改自己”按钮，而是分层的知识生命周期自动化：

| 层 | 能力 | 用户可见结果 | 治理边界 |
|----|------|--------------|----------|
| **M1：闭环与验收** | 固化 run check、stage、seal、review、promote、未来 search 的完整时序 | 可执行的闭环验收与阻断检查 | 未 seal、stale receipt、未裁决冲突均 fail-closed |
| **M2：薄路由器** | `self-evolve` Skill 把自然语言 intent 映射到既有 Maestro CLI | review-run、stage、health、full-cycle 等受控流程 | 不直接写 spec/knowhow 文件 |
| **M3：信号与评审** | `agent_end` / `session_compact` 采集、去重、证据生成、LLM review、auto-deposit | suggestions、reviews、deposits 与 TUI 状态 | 默认 dry-run；auto-deposit 只 stage 不 promote |
| **M4：知识健康** | 聚合 freshness、审计、冲突、候选 TTL 与 approval receipt | `health.json`、revalidation queue | 队列自动生成，supersede/deprecate 等处置仍需确认 |
| **M5：在线验证与提案** | 高影响知识 canary/shadow；Skill 修改 proposal/apply/revert | PROMOTE/ROLLBACK 建议、签名提案和回执 | canary 只建议；Skill apply/revert 必须显式 reason |

实际运行通常只需要 M3 的 `/self-evolve` 命令。M4-M5 面向知识维护者和高级治理流程。

## 3. 启用方式与优先级

Self-Evolve 默认 `enabled: false`。三种入口：

### 会话命令

```text
/self-evolve on
/self-evolve off
```

命令写入项目配置 `.pi/self-evolve.json`。

### 项目配置

```json
{
  "enabled": true,
  "mode": "dry-run"
}
```

该文件已被项目 `.gitignore` 忽略，适合保存本项目的个人运行偏好。

### 环境变量

```bash
PI_SELF_EVOLVE=1 pi
PI_SELF_EVOLVE=0 pi
```

`PI_SELF_EVOLVE` 优先于配置文件，可强制启用或关闭。状态页会显示有效值来自环境变量还是项目配置。

## 4. 候选信号如何产生

启用后监听三个宿主边界：

| 边界 | 行为 |
|------|------|
| `agent_end` | 序列化最近 transcript，提取末条 assistant 内容、工具与文件证据 |
| `session_before_compact` | 只暂存本次 compact 的 file operations，不取消或修改压缩 |
| `session_compact` | 从压缩摘要和 read/modified 文件操作生成 compact 信号 |

写入前依次执行：

1. 对脱敏后的轨迹摘要计算 SHA-256；
2. 与进程内 LRU 和最近日文件比较，跳过重复 trace；
3. 按 `agent_end` / `session_compact` 来源分别执行 cooldown；
4. 检查 `maxSignalsPerSession` 共享预算；
5. 丢弃工具轨迹碎片、`grep: No matches`、纯标题和普通进度汇报等噪音；
6. 启发式分类为 `knowhow`、`spec` 或 `unknown`；
7. 生成 `se-<12 hex>` id、证据文件和可执行 stage 模板。

`unknown` 或没有 suggestion 的信号会标记为 `not-actionable`，review 时自动跳过。**0 条候选是合法结果**，不应为提高产量而保留过程日志。

## 5. Dry-run 与 Auto-deposit

| 模式 | `/self-evolve review` 的行为 | 是否 stage | 是否 promote |
|------|-------------------------------|------------|--------------|
| `dry-run`（默认） | 评审信号并写 reviews ledger | 否 | 否 |
| `auto-deposit` | 评审后把过门的 `stage` 信号写入 pending 候选池 | 是 | **永不** |

切换模式：

```text
/self-evolve config mode=dry-run
/self-evolve config mode=auto-deposit
```

也可在 `/self-evolve` 面板中选择 `mode`，按 `Enter` 或 `Space` 切换，再用 `Ctrl+S` 保存。

### Auto-deposit 的触发条件

只有同时满足以下条件才会执行 `maestro knowledge stage`：

- 用户主动执行 `/self-evolve review [N]`；
- review verdict 为 `stage`，且 score 不低于 `reviewScoreThreshold`；
- 信号具有可行动的 `knowhow` 或 `spec` suggestion；
- signal id 符合 `se-[0-9a-f]{12}`；
- `evidence/<signal-id>.md` 存在；
- 信号属于当前项目；
- 此 signal id 尚未成功 deposit。

Stage 使用结构化 argv 调用 Maestro CLI，带 60 秒硬超时、1 MiB 输出边界和 Windows 进程树终止。成功与失败都写 deposit 审计；失败记录可在修复原因后重试，成功记录跨重启幂等去重。

> `auto-deposit` 不是自动知识发布。它只创建 pending candidate；review、resolve、session/run seal、fresh receipt 与 promotion 仍走[知识系统](/guides/knowledge)治理门。

## 6. Review 评审门

```text
/self-evolve review          # 默认 5 条
/self-evolve review 10       # 最大 10 条
/self-evolve reviews 5       # 最近评审记录
```

评审通过 Teammate 的 `analyst` 执行结构化判断，每条信号返回：

| Action | 含义 | 后续 |
|--------|------|------|
| `stage` | 证据真实、可复用且值得成为候选 | dry-run 中仅建议；auto-deposit 中尝试 stage |
| `skip` | 噪音、重复或价值不足 | 不进入候选池 |
| `uncertain` | 证据或新颖性不足，需要人工判断 | 不自动 stage |

Review gate 会：

- 丢弃不属于本批信号的幻觉 verdict id；
- 把 score 低于 `reviewScoreThreshold` 的 `stage` 降级为 `uncertain`；
- 跳过没有 suggestion 的非可行动信号；
- 使用 60 秒单次 timeout 和 120 秒总 deadline；
- 模型、Teammate 或结构化结果不可用时 fail closed，不执行 deposit。

模型默认为继承主会话，可显式设置：

```text
/self-evolve config model=provider/model-id
/self-evolve config model=auto
```

指定模型必须出现在当前 `modelRegistry.getAvailable()` 中。

## 7. 命令速查

| 命令 | 作用 |
|------|------|
| `/self-evolve` / `panel` | 打开可编辑 TUI 面板 |
| `/self-evolve status` | 查看有效状态、模式、模型、预算、计数和输出目录 |
| `/self-evolve on` / `off` | 启用或关闭信号采集 |
| `/self-evolve config` | 查看完整配置 |
| `/self-evolve config <k>=<v> ...` | 原子校验并保存一个或多个配置值 |
| `/self-evolve config reset` | 恢复默认配置，但保留当前 `enabled` |
| `/self-evolve signals [N]` | 查看最近信号，支持日期和项目过滤 |
| `/self-evolve signals delete <id-prefix...>` | 按 id 前缀删除 signal 记录 |
| `/self-evolve signals clear` | 清空 suggestions 日文件中的 signal 记录 |
| `/self-evolve signals export ...` | 导出过滤后的 signal JSONL |
| `/self-evolve review [N]` | 评审最近可行动信号；auto-deposit 时尝试 stage |
| `/self-evolve reviews [N]` | 查看 review ledger |
| `/self-evolve deposits [N]` | 查看成功和失败的 deposit 审计 |

过滤示例：

```text
/self-evolve signals 20 --since 2026-08-01 --until 2026-08-09
/self-evolve signals --project pi-maestro-flow
/self-evolve signals export --project pi-maestro-flow
```

`signals delete/clear` 只修改 suggestions 记录，不等于删除已 stage/promote 的知识。

## 8. TUI 面板与状态栏

不带参数执行 `/self-evolve` 打开面板。

| 按键 | 动作 |
|------|------|
| `↑` / `↓` | 选择配置字段 |
| `Enter` | 编辑字段；对 `enabled`、`mode` 执行切换 |
| `Space` | 切换 `enabled` 或 `mode` |
| `Ctrl+S` | 校验并保存到 `.pi/self-evolve.json` |
| `r` | 从磁盘刷新；有未保存修改时需再次确认 |
| `q` / `Esc` | 关闭；有未保存修改时需再次确认丢弃 |

面板显示配置来源、当前模型、suggestions 路径、运行计数和最多 8 条最近信号。窄于 20 列时自动折叠为单行状态。

状态栏格式：

```text
EVOL ● <signals>·<deduped>·<suppressed>·<deposits>D !<failures>
```

禁用时显示 `EVOL off`；没有 deposits 或 failures 时对应片段省略。

## 9. 配置参考

默认 `.pi/self-evolve.json`：

```json
{
  "enabled": false,
  "mode": "dry-run",
  "cooldownMs": 300000,
  "maxSignalsPerSession": 20,
  "maxTraceChars": 8000,
  "maxTraceMessages": 12,
  "maxEvidence": 8,
  "maxFiles": 14,
  "reviewScoreThreshold": 0.6,
  "maxReviewFiles": 28
}
```

| 字段 | 默认 | 说明 |
|------|------|------|
| `enabled` | `false` | 总开关 |
| `mode` | `dry-run` | `dry-run` 或 `auto-deposit` |
| `model` | `auto` | Phase 2B review 模型，格式 `provider/model` |
| `cooldownMs` | `300000` | 每个信号来源的最短间隔；支持 `5m`、`30s`、`1.5h` |
| `maxSignalsPerSession` | `20` | 本会话 `agent_end` 与 compact 共享的信号预算 |
| `maxTraceChars` | `8000` | digest 最大字符数 |
| `maxTraceMessages` | `12` | transcript tail 最大消息数 |
| `maxEvidence` | `8` | 每条候选最大证据引用数 |
| `maxFiles` | `14` | 保留的 suggestions 日文件数，旧文件归档 |
| `reviewScoreThreshold` | `0.6` | `stage` 低于此分数降级为 `uncertain` |
| `maxReviewFiles` | `28` | 保留的 review 日文件数，旧文件归档 |

除 `cooldownMs` 可为 0 外，计数/容量字段要求正整数；score 必须位于 `[0,1]`。多个 `key=value` 采用 all-or-nothing 校验，任何一个非法值都会拒绝整次修改。

环境变量：

| 环境变量 | 作用 |
|----------|------|
| `PI_SELF_EVOLVE` | 强制覆盖 `enabled` |
| `SELF_EVOLVE_OUTPUT_DIR` | 全局输出根，建议使用绝对路径 |
| `SELF_EVOLVE_SKILL` | 记录当前 Skill 层提示，便于按 Skill 聚合信号 |

## 10. 数据目录与权限

默认全局根目录：

```text
~/.maestro/self-evolve/
├── suggestions/<date>.jsonl   # 候选信号
├── evidence/<se-id>.md        # 脱敏证据与候选内容
├── reviews/<date>.jsonl       # 评审 verdict 和 gate 统计
├── deposits/<date>.jsonl      # stage 尝试、退出码、stagedId、错误
├── archive/                   # 超出 retention 的日文件
├── exports/                   # signals export
├── approvals/<date>.jsonl     # promote/supersede 等治理回执
├── canaries/                  # shadow 在线验证状态
├── proposals/                 # Skill 提案、快照、签名和 diff
├── health.json
└── health-<project>.json
```

目录使用 `0700`、文件使用 `0600`。信号在落盘前复用 Advisor redaction 过滤常见 secret，但仍不应在任务输出或自定义提示中放入凭据。全局目录会聚合多个项目，查看或导出时优先使用 `--project`。

## 11. 从 Candidate 到 Promoted Knowledge

Self-Evolve 的责任边界：

```text
运行轨迹
  → signal + evidence
  → analyst review gate
  → pending candidate（仅 auto-deposit）
  → knowledge review / resolve
  → sealed source + fresh receipt
  → user-confirmed promote
  → future maestro search/load
```

Promote 前由 Agent 读取 `maestro knowledge review <session-id> --json`，向用户呈现标题、内容摘要、证据、既有匹配和推荐 disposition。用户决定 unique / duplicate / related / conflict / supersede，Agent 再执行 `maestro knowledge promote ... --resolve ... --reason ...`。

晋升成功后可记录独立 approval receipt：

```bash
node scripts/self-evolve-approval.mjs record \
  --action promote --session <session-id> \
  --candidates <candidate-id> --reason "<why>"
```

查询和对账：

```bash
node scripts/self-evolve-approval.mjs query --session <session-id> --json
node scripts/self-evolve-approval.mjs reconcile
```

这些是 Agent/维护者侧 CLI，不是 `/self-evolve` 子命令。

## 12. 知识健康闭环

生成可重建健康快照：

```bash
node scripts/self-evolve-health.mjs
```

输出聚合：

- `maestro spec health` 的 freshness、contested 和谱系状态；
- `maestro knowledge audit` findings 与 prune plan；
- Run/Session ledger 中 validated、contradicted、cited 信号；
- review_required 滞留、候选 TTL、跨 Run 同标题候选；
- review 质量统计和 approval receipt 缺口；
- 按优先级生成 revalidation queue 与建议动作。

标记已处理队列项：

```bash
node scripts/self-evolve-health.mjs mark <item-id> --action reviewed
node scripts/self-evolve-health.mjs unmark <item-id>
```

Health sidecar 只生成事实快照和建议队列，不自动执行 supersede、deprecate、conflict mark 或 prune。

## 13. Canary 与 Skill Proposal

### 高影响知识 Canary

```bash
# 第一次调用创建 shadow 窗口；后续调用读取新的 health 快照并观察
node scripts/self-evolve-phase5.mjs canary <knowledge-id> --window 3
node scripts/self-evolve-phase5.mjs list --type canary
```

Canary 要求当前项目存在 24 小时内生成的 health 快照。它比较启动后的增量 validated/cited/contradicted 信号：达到佐证阈值给出 PROMOTE 建议，出现 contradiction 或窗口耗尽则给出 ROLLBACK 建议。**脚本只输出建议，不修改知识库。**

### Skill 修改提案

```bash
node scripts/self-evolve-phase5.mjs proposal <skill-path> \
  --content <new-skill-file> --reason "<why>"
node scripts/self-evolve-phase5.mjs list --type proposal
node scripts/self-evolve-phase5.mjs apply <proposal-id> --reason "<approval>"
node scripts/self-evolve-phase5.mjs revert <proposal-id> --reason "<why>" [--force]
```

Proposal 包含原文件 SHA-256、diff、`allowed-tools` 权限差异、frontmatter/标签静态检查和签名。Apply 后校验失败会自动恢复备份；revert 检测当前文件与快照冲突，只有显式 `--force` 才覆盖并写回执。

`apply`、`revert` 和任何影响全局知识的操作都必须来自用户显式请求或已确认治理步骤。

## 14. 常见问题

### 没有生成信号

1. 运行 `/self-evolve status` 确认有效状态为 on；
2. 检查 `PI_SELF_EVOLVE=0` 是否覆盖项目配置；
3. 等待 `agent_end` 或 `session_compact` 边界；
4. 检查 cooldown、session budget、deduped 与 suppressed 计数；
5. 普通过程日志可能被噪音过滤，这是预期行为。

### Review 提示模型不可用

```text
/self-evolve config model=provider/model-id
```

确认模型已在当前会话认证且出现在模型目录中，并确认 `pi-maestro-teammate` 已安装。Review fail closed，不会因为模型失败而 stage。

### Auto-deposit 没有产生 Candidate

```text
/self-evolve config
/self-evolve reviews 5
/self-evolve deposits 10
```

检查 mode、verdict/score、信号 project、evidence 文件、signal id 和 deposit error。`skip`、`uncertain`、跨项目信号及已成功 deposit 的 id 都不会再次 stage。

### 配置看似未生效

环境变量优先于 `.pi/self-evolve.json`。面板修改必须 `Ctrl+S` 保存；`r` 会重读磁盘，并在有未保存修改时要求二次确认。

### 输出目录写入失败

使用可写的绝对 `SELF_EVOLVE_OUTPUT_DIR`，检查目录包含关系与权限。扩展对路径逃逸、CLI 输出超限和 deposit 超时均 fail closed，并把错误计入状态或 deposit ledger。

## 15. 已知边界

- 信号分类 `knowhow/spec/unknown` 是启发式提示，不是真实治理结论。
- Health 的跨 Run 候选索引是 advisory；上游跨 Run stage 事务化仍不由本扩展提供。
- Canary 依赖新的 health 快照，不是实时监听器。
- 自动全文知识注入未启用；promoted 条目通过未来 `maestro search` 暴露，再由 `maestro load` 消费。
- Spec 已晋升内容没有通用 snapshot rollback，通常通过 supersede 修正版处置。
- Self-Evolve 不应为了“产生知识”保留原始日志、工具轨迹或无复用价值的运行状态。

## 16. 相关指南

- [知识系统](/guides/knowledge) — stage、review、resolve、promote 与知识门
- [架构与核心概念](/guides/architecture) — Self-Evolve 在运行时中的位置
- [Advisor 逐轮监督](/guides/advisor) — 共享脱敏和监督评估基础设施
- [Monitor 跨会话监督](/guides/monitor) — 监督其他窗口的停滞和偏航
- [版本更新日志](/guides/changelog) — auto-deposit 与 v0.17.0 变化
