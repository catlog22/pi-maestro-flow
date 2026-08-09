---
title: "版本更新日志"
icon: "🔄"
---

这里记录 pi maestro flow 套件从上一稳定版本到当前版本的用户可见变化、行为调整、问题修复和升级要求。

> **当前状态：v0.17.0（2026-08-09 发布）。** 本页以 `v0.16.0` 标签（`02436592`）为基线，覆盖至发布提交 `f021f083` 的 37 个功能提交及发布提交本身。安装命令与版本矩阵与已发布的 npm 包和 GitHub Release 一致。

---

## v0.17.0（2026-08-09）

**比较范围：** `v0.16.0 → v0.17.0`  
**代码截止：** 2026-08-09  
**主题：** 跨会话调度、持久监控监督、共享 TUI 语言、会话切换与运行循环加固

### 版本矩阵

| 组件 | v0.16.0 | v0.17.0 | 变化 |
|------|---------|---------------|------|
| `pi-maestro-flow` | `0.16.0` | `0.17.0` | 编排、Self-Evolve、运行循环、API Manager |
| `pi-maestro-teammate` | `1.9.0` | `1.10.0` | 跨会话调度、Monitor、路由与会话 UI |
| `pi-cockpit` | `0.11.0` | `0.12.0` | Agent/Window Bar、会话 Tab、窗口监控 |
| `pi-maestro-settings-core` | `0.1.1` | `0.1.2` | 共享 locale 与翻译契约 |
| `maestro-flow` | `0.5.65` | `0.5.67` | Run/Session 链路和参数传递修复 |

运行环境仍要求 Node.js `>=22.19.0`。Pi 核心包由宿主提供，开发验证基线保持 `@earendil-works/pi-*@0.83.0`。

## 核心变化

### 1. 跨会话 Scheduler 与 Sessions Core

Teammate 新增跨会话调度和会话注册内核。Monitor 不再必须依附于发起任务的当前交互会话，可以使用独立会话持续观察同一工作区中的 Agent 和窗口。

- 新增 `SchedulerCore`，统一管理跨会话任务排队、唤醒和结果回传。
- 新增 Sessions Core，维护会话端点、窗口模式注册表和宿主可达性。
- Flow 侧增加跨会话结果发布与 output-store acknowledgement，结果被消费后有明确确认边界。
- 每轮发布都带持久 publication id；重试或重复观察同一结果时，调用方可以幂等处理，避免重复入库或重复呈现。
- Cockpit 改为从会话端点读取 Agent 和 Window 状态，为会话 Tab、窗口切换和独立 Monitor 提供统一数据源。

这项变化主要改善长时间、多窗口和跨会话工作流。相关概念见 [Monitor 跨会话监督](/guides/monitor)、[并行多智能体调度](/guides/teammate-dispatch)、[Advisor 逐轮监督](/guides/advisor)和 [Pi Cockpit 可视化](/guides/cockpit)。

### 2. 持久 Monitor 监督与闭环干预

Monitor 从临时观察层升级为持久监督运行时。

- 监督事件写入持久 ledger，会话重载后仍可恢复上下文。
- 新增确定性的 Monitor Controller，负责租约、会话模式和干预状态转换。
- 支持闭环干预：检测停滞或方向偏移后，生成建议并通过受控通道反馈给正在运行的 Agent。
- Advisor 提供逐轮质量检查，可结合目标和约束判断当前回合是否需要纠偏。
- Stall 通知按 Agent 冷却时间节流，持续停滞不会在调用方界面重复刷屏。
- Monitor 可运行在独立会话中，不占用主交互会话的执行生命周期。

### 3. Teammate 派发、路由与控制中心

本版本扩展了 taskType 和模型路由能力，并提高失败恢复的可预测性。

- **自定义 taskType：** Agent 可声明项目级任务类型；Control Center 会把这些类型与内置 `explore / analysis / debug / planning / development / review / testing / verification` 一起呈现。
- **路由上下文：** 模型选择会携带 Agent、任务类型、会话模式和调用来源上下文，便于应用精确的项目策略。
- **Role Circuit Policy：** 模型或角色连续失败后进入受控熔断状态，避免在已知失败路径上无限重试。
- **最大思考级别：** Control Center 可直接选择 `max`；它作为 `xhigh` 的别名进入现有思考深度优先级。
- **并发限流重试：** concurrency-limit 类错误现在归类为可重试错误；退避上限可配置，不再立即把瞬时容量限制当作任务失败。
- **观察增强：** `observe` 增加 turns 视图、Monitor 模式上下文和转录分组，适合检查某一会话的完整轮次历史。
- **会话交接：** `Alt+R` 打开会话列表，可将当前操作交接到目标会话，并保留 routing、monitor 和 turns 上下文。
- **Reviewer 角色：** 项目 Agent 目录新增只读代码审查角色。
- **协议一致性：** 工具描述与参数 schema 对齐，Todo 用法冲突和重复描述已消除。

调用参数和优先级见 [并行多智能体调度](/guides/teammate-dispatch)与[模型路由与思考深度](/guides/model-routing)。

### 4. Cockpit 会话与窗口界面

Cockpit 的状态展示从单一会话组件扩展为基于 endpoint 的 Agent/Window 工作区视图。

- 新增 Agent Bar 和 Window Bar，分别汇总执行中 Agent 与可交接窗口。
- 新增会话 Tab 和会话 UI 状态存储，切换时保持所选会话和面板状态。
- 支持从会话列表交接、窗口监控和相关快捷键重排。
- Window Thread View 可查看目标窗口的会话线程，而不需要离开当前 Cockpit 上下文。
- 输入路由、Overlay、Sidebar 与 Split Pane 统一适配新会话状态。
- 编辑保护失败现在返回更具体的诊断信息，便于区分文件冲突、写入失败和保护规则拒绝。
- Cockpit 文案跟随共享 TUI locale，切换语言后无需重启。

### 5. 共享 TUI 语言与翻译目录

Settings Core 新增公共 i18n 契约，Flow、Teammate 和 Cockpit 使用相同 locale 来源，同时保留各自的翻译目录。

- 系统语言检测遵循 `LC_MESSAGES → LANGUAGE → LANG → Intl` 的优先顺序。
- 公共 translator 支持基础目录与包级目录合并；Teammate 和 Cockpit 不再各自猜测语言。
- 在设置面板切换语言后，现有 locale 事件会通知所有伴随扩展更新界面。
- Flow、Teammate 和 Cockpit 在 quit/reload 时释放监听器，防止重载后重复应用语言事件。
- zh-CN 目录保留 `taskType`、`thinking`、Provider、Agent 等协议标识符原文，避免翻译后无法与配置键对应。

设置结构见 [设置系统总览](/guides/settings-overview)与 [TUI 操作指南](/guides/tui-guide)。

### 6. Self-Evolve 自动沉淀模式

Self-Evolve Phase 2B 增加 `auto-deposit` 模式，同时保留 `dry-run` 作为审慎默认路径。

- CLI staging gate 在真正写入候选前检查运行模式和候选资格。
- 当前会话可在 `dry-run` 与 `auto-deposit` 之间切换，不需要重启扩展。
- 自动沉淀仍受知识候选质量门、证据和后续 review/promote 治理约束；开启该模式不等于自动发布知识。
- 深度模拟和端到端验证覆盖模式切换、候选生成和失败回退。

知识候选生命周期见 [知识系统](/guides/knowledge)。

### 7. API Manager 模型迁移与请求头预设

- API Manager 支持重命名模型 ID，并同步迁移引用该 ID 的下游配置，减少手工修复 failover、映射和 Agent 配置的遗漏。
- Channel 配置新增 Agent header presets，可选择 Claude Code、Codex、Grok、Antigravity 等常用请求头组合，也可继续使用自定义 headers。
- 迁移操作在配置边界验证新旧 ID，避免目标冲突或产生悬空引用。

详细设置见 [API Provider 与模型故障转移](/guides/api-provider-config)。

## 稳定性与问题修复

### 运行循环与 Compaction

- 会话 reload 后重新挂载 Loop Scheduler，并恢复持久化循环。
- Compaction 替换消息时保留 loop-critical 标记，避免关键循环状态在摘要替换后丢失。
- 达到 hard compaction 阈值后，在第一个安全工具边界中断循环，避免继续扩张上下文。
- 修正输入历史 route sigil 的编辑和长内容渲染截断。

参见 [Compaction 容量管理](/guides/compaction-config)和 [bash_bg 与 observe](/guides/bash-bg-observe)。

### 工具与平台兼容

| 范围 | 修复 |
|------|------|
| `bash_bg` | 前台执行自动转后台时返回一致的状态快照，调用方可立即交给 `observe` |
| Browser | `browser run` 失败信息包含可操作原因，不再只返回泛化错误 |
| Windows 打包 | 本地 tarball 枚举使用 `--force-local`，避免路径被误判为远程规范 |
| Teammate | 并发限制进入重试分类，退避上限可调；stall 通知按 Agent 冷却 |
| zh-CN TUI | 协议关键字保持英文标识，防止 UI 标签与配置值不一致 |
| Cockpit 编辑保护 | 写入失败展示更精确的原因和目标上下文 |

## Core Engine 0.5.65 → 0.5.67

`pi-maestro-flow` 的候选清单把 `maestro-flow` 精确 pin 从 `0.5.65` 更新到 `0.5.67`。

- **0.5.66：** Run Session 支持 line-delimited artifact metadata。
- **0.5.67：** 所有 Session 创建路径注册 projection；补充 enum 参数校验和 session prune；chain-file 启动保留 step args 与显式 topic；chain dispatch 透传 `--arg`，失败 Session 保持 canonical 可达。

这是精确依赖升级，现有安装不会自动跟随上游版本。升级套件时应一起核对 Flow 与 Core Engine 版本。

## 行为变化与升级注意事项

1. 升级前关闭所有正在运行的 Pi 进程，避免旧 SettingsManager 把内存中的旧配置写回磁盘。
2. 伴随扩展仍按 **Teammate → Cockpit → Flow** 的顺序注册；重启后使用 `pi list` 核对全部版本。
3. TUI 语言切换现在会同步影响三个扩展。自定义目录中的协议键应保留原始英文标识。
4. 使用独立 Monitor 会话时，确认目标工作区可见且会话端点仍在注册表中。
5. 模型 ID 重命名会迁移下游引用；执行后仍应检查自定义脚本或外部文件中的字符串引用。
6. `auto-deposit` 只自动生成候选，不绕过 evidence、review 或 promote 治理。
7. Core Engine 使用精确 pin；不要只升级伴随包而保留旧的 Flow 依赖闭包。

正式发布后安装：

```bash
pi install npm:pi-maestro-flow@0.17.0
pi list
```

## 关键提交索引

| 提交 | 主题 |
|------|------|
| `11e26d28` | 持久 Monitor 监督、ledger、闭环干预与 Advisor |
| `56d291b3` | 跨会话 Scheduler/Sessions Core |
| `9e2803f6` | 跨会话结果发布、output-store ack、SchedulerCore loop |
| `6431d9f8` | endpoint 驱动的 Agent/Window Bar 与会话 Tab |
| `fa97c02f` | 会话列表交接、窗口监控与快捷键调整 |
| `86152333` | Self-Evolve auto-deposit Phase 2B |
| `7eb22395` | API Manager 模型 ID 重命名及下游迁移 |
| `3a870ea1` | 共享 TUI locale 与包级翻译目录 |
| `3287b757` | Role Circuit Policy、自定义 taskType、路由上下文 |
| `6bcb9fca` | observation turns、Monitor 上下文与转录分组 |
| `afb9dbda` | `Alt+R` 会话列表交接 |
| `8e4c3d38` | Cockpit 编辑失败诊断 |
| `f021f083` | `release: v0.17.0`（发布提交） |

仓库维护方面，pipeline 输出迁移到 `.pi-sync`，旧的受版本控制 `flow/` 镜像被移除。这会改变源码仓库布局，但不改变 npm 包中的用户功能。

---

## v0.16.0（2026-08-07）

v0.16.0 引入完整的 in-shell 设置套件、会话级知识治理、Window Transcript evidence staging、Self-Evolve M1-M5、Todo 绑定派发、`agent://` 结果记录和 Compaction 压力加固。

| 组件 | 版本 |
|------|------|
| `pi-maestro-flow` | `0.16.0` |
| `pi-maestro-teammate` | `1.9.0` |
| `pi-cockpit` | `0.11.0` |
| `pi-maestro-settings-core` | `0.1.1` |
| `maestro-flow` | `0.5.65` |

主要变化：

- 设置操作完整留在 Shell 内，API Manager、Hooks、主题、Provider、Failover 和 Vision Provider 不再跳转旧 picker。
- Teammate task 可绑定 Todo，Agent 接管任务归属并推进注入队列。
- 普通和结构化 Agent 结果统一通过 `agent://` 读取。
- 知识系统加入会话级治理、窗口 transcript evidence 和 K12-K17 审核流程。
- Self-Evolve 完成 M1-M5 自动化层和并行会话基础设施。
- Compaction 增加工具循环压力终止、摘要重试、网关熔断和僵尸租约修复。
- Core Engine 0.5.63 移除存在安全风险的旧 Sharp 运行链，0.5.64-0.5.65 增强知识治理与证据审计。

版本详情可查看仓库中的 `RELEASE.md` 与 GitHub `v0.16.0` Release。
