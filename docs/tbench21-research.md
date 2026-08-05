# Terminal-Bench 2.1 调研 + DeepSeek V4 Flash 排名 + 可选评价数据集

> 调研日期：2026-08-05。数据来源：tbench.ai、harbor-framework 各仓库（GitHub API/raw）、Harbor Hub job 页面 flight 数据。

## 1. Terminal-Bench 2.1 是什么

- 定位：衡量 agent 在**容器化终端环境**中完成复杂任务能力的基准（组装蛋白质、调试异步代码、修复安全漏洞等）。
- v2.1 = v2.0 的「更严格验证版」：26 个任务被修改（修 bug、改超时/资源、增强对 reward hacking 的鲁棒性），大量改动取自 Z.ai 的 Terminal-Bench 2.0 Verified（HF: `zai-org/terminal-bench-2-verified`）。
- 组织：Stanford × Laude 合作；官方 harness 为 **Harbor**（`harbor-framework/harbor`）；数据集托管在 Harbor Hub（`terminal-bench/terminal-bench-2-1`，约 445 个任务）。
- 官网：https://www.tbench.ai ；排行榜：https://www.tbench.ai/leaderboard/terminal-bench/2.1
- 论文：*Terminal-Bench: Benchmarking Agents on Hard, Realistic Tasks in Command Line Interfaces*, arXiv:2601.11868 (2026)。

### 任务结构（GitHub 仓库 `harbor-framework/terminal-bench-2-1`）

每个任务目录含：

| 文件 | 作用 |
|---|---|
| `instruction.md` | 发给 agent 的任务描述 |
| `task.toml` | 任务清单（名称、分类、难度、超时等） |
| `environment/Dockerfile` | 任务容器镜像 |
| `solution/solve.sh` | oracle 解（验证环境可用性用） |
| `tests/test.sh` (+ `test_outputs.py`) | 判分脚本：退出码/断言决定 reward（0/1） |

注意：GitHub 仓库只含 ~89 个参考任务；完整 445 任务数据集在 Harbor Hub 数据集包内。

### 运行方式（官方）

```bash
uv tool install "harbor[daytona]"     # 或 [modal]
harbor auth login
harbor run -d terminal-bench/terminal-bench-2-1 \
  -a <agent> -m <provider/model> --ak reasoning_effort=<effort> \
  -e <sandbox> -k 5 -n <concurrency> --upload --public
```

提交排行榜：fork `terminal-bench-2-1`，`cd leaderboard && uv run lb submit https://hub.harborframework.com/jobs/<uuid>`，开 PR；CI 校验 + 维护者审查后合并即上榜（要求每任务 ≥5 trials）。

### 排行榜口径

- 按 `metrics.accuracy`（0–100，= reward 平均值 ×100，reward 为 0/1）降序。
- 列：Agent / Model / Effort / Accuracy / Date / Hacks（reward-hacking 比率）/ Cost / PR。
- 所有已合并条目 n_trials=445。

## 2. 当前官方排行榜（20 条已合并，2026-08-05 快照）

| # | Model | Agent | Effort | Acc% | n | Cost$ |
|---|---|---|---|---|---|---|
| 1 | Fable 5 | Claude Code | xhigh | 83.8 | 445 | 552.67 |
| 2 | GPT-5.5 | Codex | xhigh | 83.2 | 445 | 2059.19 |
| 3 | Fable 5 | Terminus 2 | high | 80.5 | 445 | 438.64 |
| 4 | Grok 4.5 | Cursor CLI | high | 79.3 | 445 | 134.09 |
| 5 | Opus 4.8 | Claude Code | high | 78.9 | 445 | 286.94 |
| 6 | GPT-5.6 Terra | Codex | max | 78.4 | 445 | 421.15 |
| 7 | GPT-5.5 | Terminus 2 | xhigh | 78.0 | 445 | 493.85 |
| 8 | Muse Spark 1.1 | mini-SWE-agent | xhigh | 76.2 | 445 | 198.05 |
| 9 | GPT-5.6 Sol | Codex | max | 76.2 | 445 | 574.68 |
| 10 | GPT-5.6 Luna | Codex | max | 75.7 | 445 | 241.45 |
| 11 | Sonnet 5 | Claude Code | high | 74.6 | 445 | 288.18 |
| 12 | GPT-5.6 Terra | Codex | max | 74.4 | 445 | 401.03 |
| 13 | Gemini 3 Pro | Terminus 2 | high | 73.9 | 445 | 224.44 |
| 14 | GPT-5.6 Luna | Codex | max | 71.2 | 445 | 218.28 |
| 15 | Opus 4.7 | Claude Code | max | 68.9 | 447 | 599.52 |
| 16 | Opus 4.7 | Terminus 2 | max | 66.1 | 445 | 582.26 |
| 17 | Gemini 3 Pro | Gemini CLI | high | 65.8 | 445 | 247.76 |
| 18 | Gemini 3.1 Pro | Gemini CLI | high | 65.8 | 445 | 236.49 |
| 19 | Gemini 3.1 Pro | Terminus 2 | high | 65.6 | 445 | 229.99 |
| 20 | GLM-5.1 | Claude Code | max | 58.6 | 445 | 277.14 |

原始数据：`.cache/tb21/standings.json`、`.cache/tb21/submissions/`（20 个提交 JSON）。

## 3. DeepSeek V4 Flash 在 TB2.1 的排名状态

- **模型**：`deepseek/deepseek-v4-flash`（284B 总参 / 13B 激活，MLA+DSA；正式版 2026-07-31 发布）。本地 harness 中 id：`maestro-qwen--deepseek-v4-flash/deepseek-v4-flash`（600K ctx，支持 thinking 至 max）。
- **提交**：PR [#189](https://github.com/harbor-framework/terminal-bench-2-1/pull/189)「DeepSeek V4 Flash (max) + fast-agent v0.9.30」，2026-08-02 由 evalstate 提交，**状态 open（尚未合并）**。
- **source jobs**（Harbor Hub 公开页）：
  - job `1e338a36…`：420 trials，avg_reward = **0.7716**（误差 96）
  - job `a210c698…`：25 trials，avg_reward = **0.6**
- **估算 accuracy**：(420×0.7716 + 25×0.6) / 445 ≈ **76.2%**
- **若合并**：将并列第 8–9 名（与 Muse Spark 1.1、GPT-5.6 Sol 持平），高于 GPT-5.6 Luna (75.7)、Gemini 3 Pro (73.9)。
- **成本**：全程 **$8.74**（445 trials），榜单最低之一（其余 $134–$2059）。
- 另一 DeepSeek 提交 PR #130（V4 Pro + Ouroboros）未合并已关闭。官网排行榜目前**查不到任何 DeepSeek 条目**（RSC payload 无 deepseek/fast-agent 记录）。

## 4. 其他可选的评价数据集

### Harbor 生态（终端 agent，与 TB2.1 同协议）

| 数据集 | 规模/形态 | 说明 |
|---|---|---|
| **Frontier-Bench** (`harbor-framework/frontier-bench`, 442★) | 持续演进 | Terminal-Bench 官方继任项目，frontierbench.ai，任务按 domain 分布，Harbor/Modal 运行 |
| Terminal-Bench Science (234★) | 科学工作流 | 面向自然科学的终端任务扩展 |
| Terminal-Bench Challenges (20★) | 长时单任务 | 长时间运行的单任务基准 |
| harbor-index (22★) | 紧凑高信号 | 评估前沿 agent 的精简基准 |
| mm-tbench | 多媒体终端 | Harbor-native，需理解媒体内容 |

### 直接可用的轻量替代（重点）

| 数据集 | 规模 | 形态 | 与当前 harness（pi-maestro-flow / pi CLI）契合度 |
|---|---|---|---|
| **pi-terminal-bench** (`latent-variable/pi-terminal-bench`) | **68 任务 / 11 类** | **无 Docker、无框架、无 API key**，直接 pi CLI；含 8 个 Terminal-Bench 移植任务 | ★★★★★（本次实跑选定） |
| TUA-Bench (Meta, 45★) | 终端通用 | 独立生态，需其 harness | ★★☆ |
| TerminalWorld (38★) | 1,530 任务 | 从 80,870 个 asciinema 录制反推；数据规模大但 harness 独立 | ★★☆ |
| OpenThoughts-TBLite (29★) | 难度校准 | 构建终端 agent 的轻量基准 | ★★★☆ |

### 经典编码/Agent 基准（非终端原生，供参考）

SWE-bench (Verified) · τ-bench / tau2-bench (1.7k★) · AgentBench (3.6k★) · OSWorld (3k★, GUI) · MLE-bench (OpenAI, 1.6k★) · Mind2Web (1k★) · BFCL · GAIA

## 5. 结论

1. DeepSeek V4 Flash 在 TB2.1 有提交但**未上榜**（PR #189 open）；估算 accuracy ≈76.2%，若合并约为并列第 8 名，成本极具优势（$8.74）。
2. 若要在**当前 harness（pi CLI）**低成本复现同类评估，pi-terminal-bench 是最优路径：8 个 TB 移植任务 + 60 个自建任务，无 Docker 依赖，直接用 `pi -p --model maestro-qwen--deepseek-v4-flash/deepseek-v4-flash` 驱动。
