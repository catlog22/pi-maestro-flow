# Self-Evolve 自进化配置

## PURPOSE

开启 pi 的自进化能力：在 agent_end / session_compact 边界自动从轨迹中提取可复用经验（pitfall / failure lesson / trade-off / prescriptive constraint），经评审门后 stage 进知识库 pending 池，供 SopLoader 和后续会话复用。

**治理纪律**：只 stage 不 promote。auto-deposit 模式也只到 pending；晋升仍需用户显式 `maestro knowledge promote` 或 `/self-evolve promote`。默认 dry-run（只采集候选，不写知识）。

## PREREQUISITES

- pi-maestro-flow 已安装（`/install init` 完成）
- 已配置至少一个模型（`/install teammate-models` 或 `init` 配的模型），review 与语义 enrichment 会调用 LLM
- 可选：已配置 `.workflow/knowhow/` 目录（SopLoader 从此目录发现 SOP 文档）

## 安装步骤

### 1. 启用扩展

在项目 `.pi/self-evolve.json` 写入配置（项目级，随仓库提交）：

```json
{
  "enabled": true,
  "mode": "dry-run",
  "reviewScoreThreshold": 0.6,
  "cooldownMs": 300000,
  "maxSignalsPerSession": 20
}
```

或用命令行配置：

```
/self-evolve on
/self-evolve config mode=dry-run
/self-evolve config model=<provider>/<model>
/self-evolve config reviewScoreThreshold=0.6
```

字段说明：
- `enabled` — 主开关（默认 false）。env `PI_SELF_EVOLVE=1` 可强制启用
- `mode` — `dry-run`（默认，只采集候选）或 `auto-deposit`（评审门后自动 stage 进 pending）
- `model` — review 与语义 enrichment 用的 LLM（`provider/model` id；省略则继承主会话模型）
- `reviewScoreThreshold` — 评审门评分阈值（0..1，低于则降级 uncertain，默认 0.6）
- `cooldownMs` — 同源信号最小间隔（默认 300000 = 5 分钟）
- `maxSignalsPerSession` — 每会话最大候选信号数（默认 20）

### 2. 验证采集

启用后正常工作几个 agent 轮次，检查：

```
/self-evolve status
/self-evolve signals
```

状态栏应显示 `EVOL ● <signals>·<deduped>·<suppressed>`。信号写入 `~/.maestro/self-evolve/suggestions/<date>.jsonl`，证据文件写入 `~/.maestro/self-evolve/evidence/<signal-id>.md`。

### 3.（可选）启用语义 enrichment（Phase 7）

默认 `captureMode=heuristic`（关键词分类 + 机械截断，无 LLM 成本）。切换到 `hybrid` 启用受预算的语义 enrichment：LLM 可把无关键词但有价值的轮次从 `unknown` 救回为 actionable knowhow/spec。

```
/self-evolve config captureMode=hybrid
```

语义 enrichment 受 per-session 预算约束：≤2 次 LLM 调用 / ≤6 候选 / 每批 ≤3 / 单次 30s 超时。LLM 不可用 / 超时 / 预算耗尽 / 输出非法时自动回退 heuristic（写 `heuristic_fallback` terminal 记录，原始信号照常可用）。

### 4. 评审与沉淀

```
/self-evolve review [N]          # 评审最近 N 个候选（全局，默认 5）
/self-evolve review pending [N]  # 评审当前 session 未评审的候选
/self-evolve signals             # 查看已采集信号
/self-evolve reviews [N]         # 查看评审历史
/self-evolve deposits [N]        # 查看沉淀历史
/self-evolve wrap                # 手动出会话摘要
```

评审通过后：
- dry-run 模式：verdict=stage 的信号生成 `maestro knowledge stage` 命令模板，用户手动执行
- auto-deposit 模式：verdict=stage 且过门的信号自动 stage 进知识库 pending 池（仍不自动 promote）

晋升 pending 候选：

```
maestro knowledge promote <session> --resolve <candidate-id> --as unique --reason "<理由>"
```

## INTERACTIVE INPUTS

- 是否启用（`enabled`）— 默认 false，确认后改 true
- 模式（`mode`）— dry-run 还是 auto-deposit（默认 dry-run）
- 评审模型（`model`）— 用哪个 LLM 做评审与语义 enrichment（省略则继承主会话模型）
- captureMode — heuristic 还是 hybrid（默认 heuristic，确认想用语义 enrichment 才切 hybrid）

## 验证

```bash
# 状态栏显示 EVOL ●
/self-evolve status

# 采集后检查信号文件
ls ~/.maestro/self-evolve/suggestions/

# 评审后检查 pending 候选
maestro knowledge review <session-id> --json
```

## 产物位置

- `~/.maestro/self-evolve/suggestions/<date>.jsonl` — 候选信号（raw + heuristic）
- `~/.maestro/self-evolve/evidence/<signal-id>.md` — 证据 markdown（stage 的 --content-file 指向它）
- `~/.maestro/self-evolve/enrichments/<date>.jsonl` — 语义 enrichment ledger（hybrid 模式）
- `~/.maestro/self-evolve/reviews/<date>.jsonl` — 评审记录
- `~/.maestro/self-evolve/deposits/<date>.jsonl` — 沉淀审计
- `~/.maestro/self-evolve/session-summaries/<date>.jsonl` — 会话收尾摘要
- `.pi/self-evolve.json` — 项目级配置（随仓库提交）

## 注意事项

- **只 stage 不 promote**：任何路径都不自动晋升知识；晋升必须用户显式执行
- **默认 heuristic**：现有用户启用后无感增加 LLM 成本；语义 enrichment 需显式 `captureMode=hybrid`
- **shutdown 只做收尾**：`session_shutdown` 不启动 LLM/review/stage，只快照计数、写摘要、best-effort notify
- **SopLoader 只读**：从 `.workflow/knowhow/` 发现带 `tools`/`sop_topic` frontmatter 的文档，不写不改
- **全局输出根**：信号/证据/评审等产物在 `~/.maestro/self-evolve/`（env `SELF_EVOLVE_OUTPUT_DIR` 可覆盖），不污染项目 git
