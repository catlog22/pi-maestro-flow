# pi-maestro-flow

<p align="center">
  <strong>🎼 Pi 编码智能体的多智能体编排层</strong><br />
  <em>将一个编码智能体，变成一支协同工程团队。</em>
</p>

<p align="center">
  <strong>中文</strong> | <a href="README_EN.md">English</a>
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/pi-maestro-flow"><img alt="npm" src="https://img.shields.io/npm/v/pi-maestro-flow?color=cb3837&logo=npm&logoColor=white" /></a>
  <a href="https://www.npmjs.com/package/pi-maestro-teammate"><img alt="npm" src="https://img.shields.io/npm/v/pi-maestro-teammate?color=cb3837&logo=npm&logoColor=white&label=teammate" /></a>
  <a href="https://www.npmjs.com/package/pi-cockpit"><img alt="npm" src="https://img.shields.io/npm/v/pi-cockpit?color=cb3837&logo=npm&logoColor=white&label=cockpit" /></a>
  <a href="https://github.com/catlog22/pi-maestro-flow"><img alt="GitHub" src="https://img.shields.io/badge/GitHub-repo-blue?logo=github" /></a>
  <a href="LICENSE"><img alt="MIT" src="https://img.shields.io/badge/License-MIT-yellow.svg" /></a>
</p>

---

## 是什么

**pi-maestro-flow** 是 [Pi 编码智能体](https://github.com/earendil-works/pi) 的多智能体编排插件。它让一个只能串行干活的智能体，变成一支能**并行调度、自主长跑、先规划后动手、全程可视**的工程团队——并自带跨会话的持久化知识系统。

它由三个插件组成（装一个即得全部）：

| 插件 | 一句话 |
|------|--------|
| **pi-maestro-flow** | 编排层与安装入口：目标/任务/计划、知识系统、MCP/LSP/浏览器/搜索 |
| **pi-maestro-teammate** | 执行引擎：并行子进程智能体、DAG 依赖图、模型路由 |
| **pi-cockpit** | 可视化状态：编辑器上方实时状态堆栈 + Starship 风格 Footer |

> 简言之：**flow 负责「编排与知识」，teammate 负责「并行执行」，cockpit 负责「看见」**。

## 核心特性

- 🔀 **并行多智能体调度** — 一次派出多个子进程智能体并行工作，支持 DAG 依赖图与结构化输出
- 🎯 **Goal 自主长时目标** — 设定目标与 Token 预算，跨多轮自主循环，完成后由独立验证器审计
- 📝 **Plan 先批准再动手** — 只读起草 Markdown 计划，用户批准后才放行编辑；支持独立 Plan 模型
- 🛰️ **Pi Cockpit 可视化** — 实时呈现运行中的 teammate 与 todo 计划，内置 9 套主题；Quiet 模式压缩工具输出与思考折叠
- 🏷️ **终端标题** — Claude Code 风格 Tab 标题 + 可选 LLM 生成会话摘要
- 🖼️ **Vision 多模态委托** — 纯文本主模型自动激活 `describe_image`，委托多模态模型分析图片（首选/回退/缓存/重试可配）
- 📬 **Mailbox 消息队列** — 工作区级隔离的持久消息队列，冷恢复同步
- 👀 **observe 阻塞观察** — `status`/`wait`/`watch` 三态观察，支持终态阻塞等待
- ⏱️ **bash_bg 自适应 Shell** — 长命令超时自动转后台，完成时推送通知，不阻塞对话
- 🧠 **持久化知识系统** — 语义搜索、规范与经验沉淀，跨会话存活
- 🪄 **self-evolve 自进化** — 运行轨迹→知识沉淀闭环的 dry-run 候选信号层（默认禁用，详见 [新特性使用说明](docs/new-features-usage.md)）
- 🔄 **Compaction 容量管理** — 主动压缩阈值、链接阈值推导、摘要输出预算，防止上下文窗口溢出
- 🔁 **模型熔断与故障转移** — 电路断路器保护 API 调用，自动故障转移到备用模型；API 重试策略可配置（最多 12 次）
- 📤 **会话导出** — 导出当前会话上下文信息，用于调试与审计
- 🔌 **全协议连接** — MCP 客户端（含 OAuth 自动认证）· LSP · 浏览器控制（CDP）· 网络搜索/深度研究
- 🔒 **权限控制** — 5 种模式（默认启用 YOLO），细粒度 allow/ask/deny，子进程权限中继
- 🪝 **Codex 兼容 Hooks** — 项目级钩子系统，内置安装器与信任审查
- ⌨️ **快捷键冲突管理** — 自动检测并修复 Shift+Tab 等快捷键冲突
- 👥 **32 个 Agent 角色**（7 内置 + 25 项目级）· 💡 **逐任务思考深度控制**（`off`→`xhigh`）· 🔌 **自定义 API Provider**

```javascript
// 旗舰能力：并行派发 + DAG 依赖，一条指令搞定
teammate({
  tasks: [
    { name: "defs", agent: "explorer", prompt: "FIND: Auth 导出\nSCOPE: src/auth/" },
    { name: "calls", agent: "explorer", prompt: "FIND: Auth 导入\nSCOPE: src/" },
    { name: "report", agent: "general", prompt: "合并 {defs} + {calls} 生成缺口报告" }
  ]
})
```

---

## 安装

pi-maestro-flow 是 **Pi 插件**，用 `pi install` 安装（不是普通 npm 依赖）。只需一条命令即可获得全套件：Flow 会作为安装入口自动拉取并注册其余扩展与依赖。

**前置条件：** [Node.js](https://nodejs.org) ≥ 22.19.0 · [Pi Coding Agent](https://github.com/earendil-works/pi) ≥ 0.74.0（必装）

```bash
npm install -g --ignore-scripts @earendil-works/pi-coding-agent   # 宿主运行时
pi install npm:pi-maestro-flow@0.22.0                              # 安装或升级插件（单入口）
pi list                                                            # 确认 Flow、Teammate 与 Cockpit 均已列出
```

**单入口全路由：** `pi install` 只需装 `pi-maestro-flow`，其余由其 postinstall 自动处理——

- **自动注册的 companion 扩展**：`pi-maestro-teammate`、`pi-cockpit`（写入 `~/.pi/agent/settings.json`）；升级会迁移由 Flow 管理的旧 companion 路径，同名本地开发覆盖会被保留并在启动日志提示，需自行升级或移除。
- **作为普通 npm 依赖一并安装的库**：核心引擎 `maestro-flow`、契约包 `pi-maestro-backend-core` 与实现包 `pi-maestro-backends`（均不是 Pi 扩展，只随 Flow 进 `node_modules`、不单独注册）。
- **bundle 进各包 tarball 的配置契约**：`pi-maestro-settings-core`（不单独安装）。

重启 Pi 或 reload extensions 后再执行模型相关操作。

## 快速开始

```bash
pi   # 启动，用自然语言描述任务即可
```

Maestro Flow 自动分类意图并路由：**简单任务**直接执行 · **多步工程**分解为链式计划逐步验证 · **长周期目标**自主循环并独立验证完成度。`/maestro-help` 可浏览全部命令。

---

## 工具与技能

- **19 个常驻工具 + 5 个 Plan 动态工具**
  - 调度：`teammate` · `teammate-send/list/watch/wait`
  - 编排：`maestro` · `goal` · `todo` · `run-control` · `plan-*`
  - 连接：`mcp` · `lsp` · `browser` · `smart_search` · `ffgrep`/`fffind`
  - 其他：`bash_bg` · `ask-user-question` · `search_tool_bm25`
- **63 个技能**（由 [Maestro Flow](https://github.com/catlog22/maestro-flow) 维护）— 涵盖工作流编排、知识管理、团队协作、UI 设计、学术写作、技能工具六大类。完整清单见 [Maestro Flow 技能目录](https://github.com/catlog22/maestro-flow/tree/main/skills)
- **32 个 Agent 角色** — 7 内置（explorer、planner、analyst、research、general、verifier、workflow）+ 25 项目级（executor、reviewer、debugger、roadmapper…）

完整工具参数与工作流定义见 **[使用指南](docs/USAGE.md)**。

---

## 📖 文档

| 文档 | 说明 |
|------|------|
| **[使用指南](docs/USAGE.md)** / **[English](docs/USAGE_EN.md)** | 完整功能文档 — 全部工具、MCP、权限、思考深度、Agent、工作流 |
| **[用户手册](GUIDE.md)** | 深入教程，每个子系统附示例 |
| **[Smart Search Provider 配置指南](docs/smart-search-provider-config.md)** | 搜索引擎配置 — 双路径架构、Provider API Key、凭证源语法、TUI 操作、配置同步 |
| **[Teammate Backend 适配器契约](docs/teammate-backend-adapter-contract.md)** | 第三方执行后端接入 — `TeammateBackend` 接口、`.pi/teammate-backends.json` 注册、能力裁决、recovery facts、完整示例 |
| **[发布说明](RELEASE.md)** | 版本历史与变更日志 |
| **[更新说明](docs/UPDATES.md)** | 历史提交变更记录 |
| **[新特性使用说明](docs/new-features-usage.md)** | Vision 委托 · 终端标题 · Mailbox · observe watch · self-evolve 快速上手 |
| 各插件 README | [flow](packages/pi-maestro-flow/README.md) · [teammate](packages/pi-maestro-teammate/README.md) · [cockpit](packages/pi-cockpit/README.md) |

---

## 致谢

- **[Maestro-Flow](https://github.com/catlog22/maestro-flow)** — 意图驱动工作流编排框架 by [@catlog22](https://github.com/catlog22)
- **[Pi Coding Agent](https://github.com/earendil-works/pi)** — 终端编码智能体（宿主运行时）by [@earendil-works](https://github.com/earendil-works)
- 驱动内置工具的上游库：[@modelcontextprotocol/sdk](https://modelcontextprotocol.io)（`mcp`）· [Puppeteer](https://github.com/puppeteer/puppeteer)（`browser`）· [@ff-labs/fff-node](https://github.com/dmtrKovalenko/fff)（`ffgrep`/`fffind`）· [@konbakuyomu/smart-search](https://github.com/konbakuyomu/smartsearch)（`smart_search`）· [pi-web-access](https://github.com/nicobailon/pi-web-access)（原生网络搜索/提取/curator）

## 许可证

[MIT](LICENSE) © 2026 catlog22

---

## 友情链接

- **[Linux DO](https://linux.do/)** — Linux DO：学AI，上L站！
