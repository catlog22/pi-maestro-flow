# self-evolve 扩展（Phase 2A 脚手架）

> Harness 式知识沉淀闭环的第二扩展入口（第三个 `pi.extensions` 条目）。
> **默认禁用，零行为影响。** 本阶段（Phase 2A）只做 **dry-run 候选信号收集**：
> 绝不 stage / promote / 写知识，只产出建议文件供人工或 Phase 2B 治理步骤消费。

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

有界策略：默认仅保留最近 **14** 个日文件（`maxFiles`），超过即修剪；进程内轨迹 hash 去重（LRU，容量 256），重启时从当日文件预种子去重状态。冷却按**来源独立**计（`agent_end` 每轮计数 + 冷却；`session_compact` 低频，不被紧邻的 `agent_end` 冷却压制），全局预算 `maxSignalsPerSession` 两者共享。

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
   可用字段：`enabled` / `cooldownMs`（默认 300000）/ `maxSignalsPerSession`（默认 20）/ `maxTraceChars`（默认 8000）/ `maxTraceMessages`（默认 12）/ `maxEvidence`（默认 8）/ `maxFiles`（默认 14）。
3. **会话内命令**（写入 `.pi/self-evolve.json`）：
   ```
   /self-evolve                     # 打开 TUI 面板（默认；r 刷新 · q/esc 关闭）
   /self-evolve on                 # 启用（dry-run）
   /self-evolve off                # 禁用
   /self-evolve status             # 完整状态（文本通知）
   /self-evolve config             # 查看全部配置
   /self-evolve config <k>=<v> ... # 修改配置（校验后持久化）
   /self-evolve config reset       # 恢复默认（保留 enabled）
   /self-evolve signals [N]        # 列出最近 N 条候选信号（默认 10）
   /self-evolve review [N]         # dry-run 评审最近 N 条信号（默认 5，用配置模型）
   /self-evolve panel              # 打开 TUI 面板（同默认；r 刷新 · q/esc 关闭）
   ```

## Dry-run 评审（Phase 2B 最小验证版）

`/self-evolve review [N]` 用配置的模型（`model`，默认继承主会话）对最近 N 条信号做**质量评估**（Phase 2B 评审门的最小验证）：

- 判定依据：证据锚点真实性 / 可复用性 / 新颖性 → 每条信号输出 `stage | skip | uncertain` + 置信分 + 理由；
- **dry-run 保证**：只评估并落盘评审记录，**绝不 stage / promote**；评审落盘全局目录 `~/.maestro/self-evolve/reviews/<date>.jsonl`；
- 评审经 teammate analyst 路由（复用 supervision 共享层，与 advisor 同模式）；模型不可用或 teammate 未安装时优雅降级提示；
- 模型必须在 `modelRegistry.getAvailable()` 中，否则提示用 `/self-evolve config model=<provider>/<model>` 配置。

## TUI 显示与控制

### 状态栏指示器

启用后状态栏常驻 `EVOL ● s·d·p` 段（s=已写信号 · d=去重 · p=抑制），失败时追加 `!n`；禁用时显示 `EVOL off`。随事件与配置变更实时刷新。

### 面板 `/self-evolve`（默认） / `/self-evolve panel`

只读 TUI 面板（`ctx.ui.custom` overlay），展示：配置摘要（含来源）、运行时计数器、最近信号列表。配置修改请走 `/self-evolve config`（带校验与持久化）——面板仅刷新/关闭。渲染遵循 Maestro settings 视觉语言（共享 `frame`/`headerLine`/`rule` 原语）；按终端高度计算行预算，信号列表超出时以 `… +N more` 截断，底部帮助行永不被裁剪；窄终端（<20 列）自动折叠为单行状态。

| 键 | 动作 |
|---|---|
| `r` | 刷新（重读配置与信号文件） |
| `q` / `Esc` | 关闭 |

### 配置控制 `/self-evolve config <key>=<value>`

可编辑键（全部经 `setConfigValue` 校验，非法值整体拒绝并提示）：

| 键 | 类型 | 示例 |
|---|---|---|
| `enabled` | bool | `true` / `false` |
| `model` | `provider/model` 或 `auto` | `maestro-qwen/qwen3.8-max`、`auto` |
| `cooldownMs` | 时长 | `300000`、`5m`、`30s`、`1.5h` |
| `maxSignalsPerSession` | 正整数 | `20` |
| `maxTraceChars` | 正整数 | `8000` |
| `maxTraceMessages` | 正整数 | `12` |
| `maxEvidence` | 正整数 | `8` |
| `maxFiles` | 正整数 | `14` |

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
  "suggestion": "maestro knowledge stage knowhow \"<title>\" --content-file <evidence-file> --run <run-id>",
  "trigger": { "reason": "threshold" }
}
```

要点：
- `traceHash` = 脱敏轨迹摘要（`redactAdvisorText`，与 advisor 共用）的 sha256——同内容轨迹自动去重。
- `dryRun: true` 恒定：`suggestion` 只是**命令模板**，本扩展从不执行任何 `maestro knowledge` 写入。
- `candidateType` 为关键词启发式（knowhow/spec/unknown），仅作提示，不作结论。
- 全部内容经 secret 脱敏后才落盘（复用 `advisor/runtime.ts` 的 `redactAdvisorText`）。

## 护栏

- 默认禁用；启用后所有 handler 均 try/catch，任何失败只计数上报，**绝不抛出到宿主事件链**。
- **输出全局化（不污染 git）**：建议文件只写 `~/.maestro/self-evolve/suggestions/`（或 `SELF_EVOLVE_OUTPUT_DIR` 指定根），配置 `.pi/self-evolve.json` 已入 .gitignore；输出根做包含校验（`isPathInside`），环境变量误配不能把写入重定向到根外。
- 文件权限：目录 `0o700`、文件 `0o600`。
- 绝不 stage/promote/写知识、绝不自动改 `.pi/skills/`（设计 v2 §9.5）。
- per-session 预算：`maxSignalsPerSession` + `cooldownMs` 双重限频（设计 v2 §10「评估成本失控」护栏）。

## Phase 2B 集成点（见设计 v2 §9 / §6）

| 缺口 | 建议接入 |
|---|---|
| 治理硬化 | 消费 `.pi/self-evolve/suggestions/` 时补 capability + approval receipt + promotion 强制 reason/actor |
| 跨 Run 候选索引 | 现有建议为按日 JSONL；Phase 2B 可建跨 run 事务索引（对应 `run/knowledge.ts:411` 锁外冲突检查） |
| 证据根提升 | `corroborated` 自动提权需排除同 Session 复制（§9.2），建议基于 `traceHash` 跨日聚合 |
| 不可信数据 | transcript 指令型内容 lint 与来源标记在消费端补齐；落盘侧已完成 secret redaction |
| 评估预算 | 信号本身无 LLM 成本（纯本地特征提取），Phase 2B 若引入 LLM 生成需自带 per-run budget/超时 |

## 代码结构

```
src/self-evolve/
  runtime.ts    纯逻辑（host-free、可单测）：config 归一化、轨迹 digest、hash、
                file/tool 证据提取、候选类型启发式、信号记录构建、路径与修剪、
                TUI/命令展示助手（setConfigValue / formatStatusText / 信号解析）
  extension.ts  宿主接线：env/config 读取、agent_end / session_before_compact /
                session_compact 事件、去重 LRU、预算/冷却、JSONL 追加 + 修剪、
                /self-evolve 命令（status/on/off/config/signals/panel）、状态栏
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
# 行为回归（mock 宿主，47 断言：默认禁用零副作用 / 启用持久化 / 信号生成 /
# 去重与冷却语义 / 状态栏 / 配置校验 / dry-run 保证）
cd packages/pi-maestro-flow && node --experimental-strip-types src/self-evolve/se-e2e.mts
```

风格与结构对齐 `src/advisor/`（第二入口先例），互不修改对方逻辑。
