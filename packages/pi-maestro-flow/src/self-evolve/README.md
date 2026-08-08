# self-evolve 扩展（Phase 2A 脚手架 + Phase 2B auto-deposit）

> Harness 式知识沉淀闭环的第二扩展入口（第三个 `pi.extensions` 条目）。
> **默认禁用，零行为影响。** Phase 2A 做 **dry-run 候选信号收集**：
> 绝不 stage / promote / 写知识，只产出建议文件供人工或治理步骤消费；
> **Phase 2B 增加 `auto-deposit` 模式**：评审门通过的候选**自动 stage** 进知识库 pending 池
> （永不自动 promote，治理纪律）。

设计依据：`docs/self-evolution-plugin-design.md`（v2）§3（载体与集成点）、§9（Phase 2A 范围）。

## 它做什么

启用后监听两类宿主事件，生成 dry-run 候选信号：

| 事件 | 用途 | 信号内容 |
|---|---|---|
| `agent_end`（每轮结束） | turn_interval 等价源：计数 + 冷却 | 轨迹摘要（sha256 hash 去重）、tool 证据、末条 assistant 文本提炼的标题 |
| `session_before_compact` | 仅观测，暂存本次压缩的 fileOps（绝不 cancel） | — |
| `session_compact` | compact 等价源：压缩摘要 | 压缩摘要 + 读写文件证据（`role: read/modified`） |

每条信号追加写入（**全局输出，不污染项目 git**）：

```
~/.maestro/self-evolve/suggestions/<YYYY-MM-DD>.jsonl
```

默认输出根为 `~/.maestro/self-evolve/`（单一全局文件夹，跨项目聚合）；可用环境变量覆盖：`SELF_EVOLVE_OUTPUT_DIR=<绝对路径>`。每条信号携带 `project`（`basename(cwd)`，跨项目区分）与 `skill`（默认 `general`，`SELF_EVOLVE_SKILL` 环境变量可注入当前 skill 层，供 Phase 2B 按 skill 分层消费）。项目 `.pi/self-evolve.json` 配置保留（已加入 .gitignore），建议输出目录永不落在项目内。

有界策略：默认仅保留最近 **14** 个日文件（`maxFiles`），超过即**归档**到 `archive/`（不删除，见护栏）；进程内轨迹 hash 去重（LRU，容量 256），重启时从当日文件预种子去重状态。冷却按**来源独立**计（`agent_end` 每轮计数 + 冷却；`session_compact` 低频，不被紧邻的 `agent_end` 冷却压制），全局预算 `maxSignalsPerSession` 两者共享。

## 启用方式（默认禁用）

三者任一即可启用；**未启用时所有 handler 直接 no-op，不读文件、不落盘**：

1. **环境变量**（强制覆盖，优先于配置文件）：
   ```bash
   PI_SELF_EVOLVE=1 pi
   # 显式关闭：PI_SELF_EVOLVE=0（覆盖配置文件的 enabled: true）
   ```
2. **项目配置** `.pi/self-evolve.json`：
   ```json
   { "enabled": true }
   ```
   可用字段：`enabled` / `cooldownMs`（默认 300000）/ `maxSignalsPerSession`（默认 20）/ `maxTraceChars`（默认 8000）/ `maxTraceMessages`（默认 12）/ `maxEvidence`（默认 8）/ `maxFiles`（默认 14）/ `reviewScoreThreshold`（默认 0.6）/ `maxReviewFiles`（默认 28）。
3. **会话内命令**（写入 `.pi/self-evolve.json`）：
   ```
   /self-evolve                     # 打开 TUI 面板（默认；r 刷新 · q/esc 关闭）
   /self-evolve on                 # 启用（dry-run）
   /self-evolve off                # 禁用
   /self-evolve status             # 完整状态（文本通知）
   /self-evolve config             # 查看全部配置
   /self-evolve config <k>=<v> ... # 修改配置（校验后持久化）
   /self-evolve config reset       # 恢复默认（保留 enabled）
   /self-evolve signals [N] [--since YYYY-MM-DD] [--until YYYY-MM-DD] [--project <p>]
                                  # 列出最近 N 条候选信号（默认 10；含 id，供删除引用；支持日期/项目过滤）
   /self-evolve signals delete <se-id-prefix...>  # 按 id（支持前缀）删除候选信号记录
   /self-evolve signals clear     # 清空全部候选信号记录（dry-run 候选，可重建）
   /self-evolve signals export [--since ...] [--until ...] [--project ...]
                                  # 导出过滤后的信号到 ~/.maestro/self-evolve/exports/signals-<ts>.jsonl
   /self-evolve review [N]         # 评审最近 N 条信号（默认 5，用配置模型）；auto-deposit 模式下过门信号自动 stage
   /self-evolve reviews [N]        # 查历史评审记录（默认 5，含评审门统计）
   /self-evolve deposits [N]       # 查自动沉淀记录（默认 10；成功含 stagedId，失败含 exitCode/error）
   /self-evolve panel              # 打开 TUI 面板（同默认；r 刷新 · q/esc 关闭）
   ```

## Dry-run 评审（Phase 2B 最小验证版）

`/self-evolve review [N]` 用配置的模型（`model`，默认继承主会话）对最近 N 条信号做**质量评估**（Phase 2B 评审门的最小验证）：

- 判定依据：证据锚点真实性 / 可复用性 / 新颖性 → 每条信号输出 `stage | skip | uncertain` + 置信分 + 理由；
- **评审门（review gate）**：`reviewScoreThreshold`（0..1，默认 0.6）——`stage` 评分低于阈值自动降级为 `uncertain`；幻觉 verdict id（不在本次待评审信号集合内）直接丢弃计 `droppedInvalid`；无 suggestion 的非可行动信号（如 `candidateType=unknown`）跳过评审并计 `nonActionableSkipped`。评审记录新增 `droppedInvalid` / `downgraded` / `nonActionableSkipped` 统计字段。
- **dry-run 保证**：只评估并落盘评审记录，**绝不 stage / promote**；评审落盘全局目录 `~/.maestro/self-evolve/reviews/<date>.jsonl`；
- 评审经 teammate analyst 路由（复用 supervision 共享层，与 advisor 同模式）；模型不可用或 teammate 未安装时优雅降级提示；
- 模型必须在 `modelRegistry.getAvailable()` 中，否则提示用 `/self-evolve config model=<provider>/<model>` 配置。

## Auto-deposit 模式（Phase 2B）

`mode=auto-deposit` 时，`/self-evolve review [N]` 在评审门之后多一步：**verdict=stage 且过门的信号自动执行 `maestro knowledge stage`**（写入点复用显式 CLI 护栏，不经扩展直写），候选进入知识库 **pending 池**。**永不自动 promote**（治理纪律：promotion 仍需用户请求或 confirmed governance step）。

**模式切换（显式，默认仍 `dry-run`）**：

```
/self-evolve config mode=auto-deposit   # 切换（写入 .pi/self-evolve.json）
/self-evolve config mode=dry-run        # 切回
```
TUI 面板中 `mode` 行直接编辑（`Enter` 输入后 `Ctrl+S` 保存）。

**行为差异**：

| 模式 | `/self-evolve review [N]` 行为 |
|---|---|
| `dry-run`（默认） | 只评估信号 → 落盘 `reviews/<date>.jsonl`；suggestion 供人工复制执行 |
| `auto-deposit` | 评估后，过门（`stage` 且评分 ≥ `reviewScoreThreshold` 且可行动）信号 → 自动执行 stage → 落盘 `deposits/<date>.jsonl` 审计 |

**执行与审计**：

- stage 命令由信号重建为结构化 argv（`knowledge stage <type> "<title>" --content-file <evidence.md> --session <sid>|--run <rid> --evidence <refs>`，与人工 `suggestion` 模板同源——session-first，run 兜底；执行时追加 `--json` 保证 `candidate_id` 解析可靠），经 **cross-spawn** 执行 `maestro` CLI（Windows 上 `maestro.cmd` 安全解析，与 `session/cli-adapter.ts` `defaultRunner` 同范式）：**60s 硬超时** + 进程树终止（win32 `taskkill /T /F`）、**1MB 输出上限**（超限即终止）、stdout/stderr error 处理器、监听器 cleanup；
- 每次尝试（成功与失败）都写一条 deposit 审计记录（`~/.maestro/self-evolve/deposits/<date>.jsonl`），含 signal id、title、type、完整命令、退出码、解析出的 `stagedId`（`KDC-*`）、错误摘要——**绝不静默失败**；
- **fail-closed 前置校验**：信号对应 evidence 文件（`evidence/<se-id>.md`）缺失时**不执行** stage，ledger 直接记 `exitCode=-1 + error`；signal id 不匹配 `se-[0-9a-f]{12}`（手改 JSONL 防御）同样拒绝并记录；
- **幂等去重**：已成功沉淀（`exitCode=0`）的信号从 ledger 种子化去重集合，二次 review 自动跳过（跨重启持久）；失败/缺失/异常的记录可重试；
- **跨项目守卫**：信号 `project` 与当前项目不一致时跳过（全局 suggestions 目录混聚多项目，绝不把 A 项目信号 stage 进 B 项目知识库）；
- **计数语义**：`·<n>D` 状态栏计数与 review 汇总 `deposit: N staged · M failed` 只统计**成功** stage（`exitCode=0`），失败尝试在 `deposits` 命令中可查；
- `/self-evolve deposits [N]` 查历史（成功与失败记录并列）。

> ⚠️ 触发保持**显式**：仅在用户主动运行 `/self-evolve review` 时自动沉淀，不在 `agent_end`/`session_compact` 上自动触发（评估成本护栏 + 无意识写入防线）。

## TUI 显示与控制

### 状态栏指示器

启用后状态栏常驻 `EVOL ● s·d·p` 段（s=已写信号 · d=去重 · p=抑制），失败时追加 `!n`；禁用时显示 `EVOL off`。指示器使用**有效状态**（`PI_SELF_EVOLVE=1/0` 环境覆盖优先于配置文件）。随事件与配置变更实时刷新。

### 面板 `/self-evolve`（默认） / `/self-evolve panel`

TUI 面板（`ctx.ui.custom` overlay），展示：配置菜单（含来源）、运行时计数器、最近信号列表、**评审门与评审保留字段**（review score gate：`reviewScoreThreshold`（stage 低于 → uncertain）；review retention：`maxReviewFiles`）、**输出路径行**（suggestions 目录）、**禁用态引导文案**（提示 `Enter` 切换 enabled / `/self-evolve on` / `PI_SELF_EVOLVE=1`），并支持**面板内直接编辑配置**。配置修改经 `setConfigValue` 校验后，`Ctrl+S` 持久化到 `.pi/self-evolve.json` 并刷新状态栏。渲染遵循 Maestro settings 视觉语言（共享 `frame`/`headerLine`/`rule` 原语）；按终端高度计算行预算，信号列表超出时以 `… +N more` 截断，底部帮助行永不被裁剪；窄终端（<20 列）自动折叠为单行状态。

| 键 | 动作 |
|---|---|
| `↑` / `↓` | 选择配置字段 |
| `Enter` | 编辑字段（数字/时长/model 文本）；对 `enabled` 为切换；`mode` 在 `dry-run` / `auto-deposit` 间切换（文本输入，经 `setConfigValue` 校验） |
| `Space` | 切换 `enabled` 总开关 |
| `Ctrl+S` | 保存修改（校验通过后持久化） |
| `r` | 刷新（重读配置与信号文件；有未保存修改时需再按一次确认丢弃） |
| `q` / `Esc` | 关闭（有未保存修改时需再按一次确认丢弃） |

`mode` 行可编辑：`dry-run`（默认，评审不写知识）/ `auto-deposit`（评审过门候选自动沉淀，见下节）。

### 配置控制 `/self-evolve config <key>=<value>`

可编辑键（全部经 `setConfigValue` 校验，非法值整体拒绝并提示）：

| 键 | 类型 | 示例 |
|---|---|---|
| `enabled` | bool | `true` / `false` |
| `mode` | 枚举 | `dry-run`（默认，评审不写知识）/ `auto-deposit`（评审过门候选自动 stage，见「Auto-deposit 模式」）；其他值整体拒绝 |
| `model` | `provider/model` 或 `auto` | `maestro-qwen/qwen3.8-max`、`auto` |
| `cooldownMs` | 时长 | `300000`、`5m`、`30s`、`1.5h` |
| `maxSignalsPerSession` | 正整数 | `20` |
| `maxTraceChars` | 正整数 | `8000` |
| `maxTraceMessages` | 正整数 | `12` |
| `maxEvidence` | 正整数 | `8` |
| `maxFiles` | 正整数 | `14` |
| `reviewScoreThreshold` | 0..1 | `0.6`（评审门：stage 低于此值自动降级 uncertain） |
| `maxReviewFiles` | 正整数 | `28`（评审记录独立保留，超过归档） |

**模型配置**：`model` 指定 Phase 2B LLM 步骤（候选综合 / 评审门）使用的模型，格式 `provider/model`；默认 `auto` = 继承主会话当前模型（与 advisor 的 `resolveAdvisorModel` 同语义）。Phase 2A 本身为纯本地特征提取，**不调用任何模型**；信号记录携带解析后的模型（`model` 字段），供 Phase 3 独立证据根检查使用。

示例：`/self-evolve config cooldownMs=10m maxSignalsPerSession=5`；`/self-evolve config reset` 恢复默认（保留 `enabled` 当前值）。修改即写入 `.pi/self-evolve.json` 并刷新状态栏。

## 数据格式（JSONL，每行一个对象）

```json
{
  "schemaVersion": 1,
  "id": "se-3f2a1b9c0d4e",
  "kind": "candidate",
  "source": "session_compact",
  "dryRun": true,
  "createdAt": "2026-08-06T10:15:30.000Z",
  "sessionId": "20260806-xxxx",
  "traceHash": "3f2a1b9c0d4e…（sha256，跨 run 去重键）",
  "candidateType": "knowhow",
  "title": "Compaction summary 首行（≤120 字符）",
  "summary": "压缩摘要或末条 assistant 文本（≤600 字符，已脱敏）",
  "evidence": [
    { "type": "file", "ref": "src/foo.ts:123", "role": "modified" },
    { "type": "tool", "ref": "read" }
  ],
  "suggestion": "maestro knowledge stage knowhow \"<title>\" --content-file ~/.maestro/self-evolve/evidence/se-3f2a1b9c0d4e.md --session <session-id> --evidence \"src/foo.ts:123, read\"",
  "trigger": { "reason": "threshold" }
}
```

要点：
- `traceHash` = 脱敏轨迹摘要（`redactAdvisorText`，与 advisor 共用）的 sha256——同内容轨迹自动去重。
- `dryRun: true` 恒定：`suggestion` 只是**命令模板**，本扩展从不执行任何 `maestro knowledge` 写入。
- `suggestion` 为**可执行会话源模板**：写信号时扩展同步生成证据文件 `~/.maestro/self-evolve/evidence/<se-id>.md`（`--content-file` 直接指向该文件，无死占位符）；`candidateType=unknown` 的信号**无 suggestion**（不可 stage，评审时跳过）。
- `candidateType` 为关键词启发式（knowhow/spec/unknown），仅作提示，不作结论。
- 全部内容经 secret 脱敏后才落盘（复用 `advisor/runtime.ts` 的 `redactAdvisorText`）。

自动沉淀审计记录（`~/.maestro/self-evolve/deposits/<date>.jsonl`，每行一个对象）：

```json
{
  "schemaVersion": 1,
  "kind": "deposit",
  "createdAt": "2026-08-07T…",
  "project": "pi-maestro-flow",
  "mode": "auto-deposit",
  "signalId": "se-3f2a1b9c0d4e",
  "title": "…",
  "candidateType": "knowhow",
  "source": "agent_end",
  "sessionId": "20260807-xxxx",
  "command": "maestro knowledge stage knowhow \"…\" --content-file … --session …",
  "exitCode": 0,
  "stagedId": "KDC-…",
  "error": "…（失败时）"
}
```

## 护栏

- 默认禁用；启用后所有 handler 均 try/catch，任何失败只计数上报，**绝不抛出到宿主事件链**。
- **输出全局化（不污染 git）**：建议文件只写 `~/.maestro/self-evolve/suggestions/`（或 `SELF_EVOLVE_OUTPUT_DIR` 指定根），配置 `.pi/self-evolve.json` 已入 .gitignore；输出根做包含校验（`isPathInside`），环境变量误配不能把写入重定向到根外。
- 文件权限：目录 `0o700`、文件 `0o600`。
- **修剪即归档**：超过 `maxFiles`/`maxReviewFiles` 的旧日文件不删除——移入 `~/.maestro/self-evolve/archive/<date>.jsonl.<ts>.archived`（rename 跨设备失败自动 copy+rm 回退）。
- **采集侧噪音过滤**：轨迹片段（`ASSISTANT:` / `TOOL <name>:` / `grep: No matches` / 纯 markdown 标题 / 进度词）在源头丢弃并计入 `suppressed`，不落盘。
- 绝不 stage/promote/写知识、绝不自动改 `.pi/skills/`（设计 v2 §9.5）。
- per-session 预算：`maxSignalsPerSession` + `cooldownMs` 双重限频（设计 v2 §10「评估成本失控」护栏）。
- **auto-deposit 护栏**：默认仍 `dry-run`，模式切换显式；只自动 stage **不自动 promote**；每次沉淀全审计（成功与失败）；evidence 缺失 / id 非法 fail-closed 不执行；stage 经显式 CLI 写入点（cross-spawn + 60s 超时 + 1MB 输出上限 + 进程树终止）；已沉淀幂等去重；跨项目信号跳过；失败计入 `deposits` 历史（不静默）。

## Phase 2B 集成点（见设计 v2 §9 / §6）

| 缺口 | 建议接入 | 状态 |
|---|---|---|
| 治理硬化 | capability + approval receipt + promotion 强制 reason/actor | approval receipt（`self-evolve-approval.mjs`）+ skill TOCTOU fence 已做；**auto-deposit 已落地**（见上节） |
| 跨 Run 候选索引 | 现有建议为按日 JSONL；建跨 run 事务索引（对应 `run/knowledge.ts:411` 锁外冲突检查） | **遗留**：位于 maestro2 仓库（非本包），未实现 |
| 证据根提升 | `corroborated` 自动提权需排除同 Session 复制（§9.2），建议基于 `traceHash` 跨日聚合 | 未做（Phase 3） |
| 不可信数据 | transcript 指令型内容 lint 与来源标记在消费端补齐；落盘侧已完成 secret redaction | 落盘侧已做；消费端遗留 |
| 评估预算 | 信号本身无 LLM 成本（纯本地特征提取），Phase 2B 若引入 LLM 生成需自带 per-run budget/超时 | review 用 teammate analyst + 超时已限；自动触发未放开 |

## 代码结构

```
src/self-evolve/
  runtime.ts    纯逻辑（host-free、可单测）：config 归一化、轨迹 digest、hash、
                file/tool 证据提取、候选类型启发式、信号记录构建、路径与修剪、
                TUI/命令展示助手（setConfigValue / formatStatusText / 信号解析）
  extension.ts  宿主接线：env/config 读取、agent_end / session_before_compact /
                session_compact 事件、去重 LRU、预算/冷却、JSONL 追加 + 归档修剪、
                /self-evolve 命令（status/on/off/config/signals/review/reviews/panel）、状态栏
  se-e2e.mts    行为回归测试（mock 宿主，32 断言）
  README.md     本文档
src/tui/
  self-evolve-overlay.ts  /self-evolve（默认）/panel 只读面板（Component + Focusable）
```

## 测试

```bash
# 纯函数 smoke（19 断言）
node --experimental-strip-types <(cat <<'EOF'
...
EOF
)
# 行为回归（mock 宿主，84 断言：默认禁用零副作用 / 启用持久化 / 信号生成 /
# 去重与冷却语义 / 状态栏 / 配置校验含 mode / dry-run 保证 / review 评审门 /
# auto-deposit 自动 stage + deposit ledger / 幂等去重 / fail-closed / 跨项目守卫 / executor throw）
cd packages/pi-maestro-flow && node --experimental-strip-types src/self-evolve/se-e2e.mts
```

风格与结构对齐 `src/advisor/`（第二入口先例），互不修改对方逻辑。
