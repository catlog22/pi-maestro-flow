# Grill Report: 精简 todo 工具及通用化上下文注入

**Session**: GRL-001
**Depth**: standard（5 个分支）
**Date**: 2026-07-10T15:33:12.5304026+08:00
**Upstream**: none
**Confidence**: [LOW CONFIDENCE] `maestro explore` 连续 2 次因 endpoint 配置或 503 失败；代码证据来自本地定点读取。

## Discovery Summary

### Project Context

- `.workflow/project.md`、`.workflow/state.json`、`.workflow/roadmap.md` 当前不存在。
- `maestro load --type spec --category arch` 未返回架构 spec。
- 相关历史会话显示，todo 最初用于步骤跟踪与下一步 skill 注入，随后已开始尝试用引用语法糖精简字段，但 `goal` 是否属于引用、最终保留哪些字段尚未锁定。

### Codebase Surface

- 内部模型已改为统一的 `InjectItem { type, source, tag? }`，类型暂限 `text | file | skill`：`packages/pi-maestro-flow/src/tools/todo.ts:18`。
- `TodoParams` 当前只消费 `inject` 与 `refs`，创建和更新时统一进入 `resolveInject()`：`packages/pi-maestro-flow/src/tools/todo.ts:36`、`packages/pi-maestro-flow/src/tools/todo.ts:172`、`packages/pi-maestro-flow/src/tools/todo.ts:198`、`packages/pi-maestro-flow/src/tools/todo.ts:425`。
- `refs` 语法已支持 `file`、`skill`、`text`、`step`、`boundary`、`defer` 前缀，但未知或空引用会被静默忽略：`packages/pi-maestro-flow/src/tools/todo.ts:379`、`packages/pi-maestro-flow/src/tools/todo.ts:393`。
- `next` 会把活动 goal 独立注入，再把每个 inject item 加载成 XML block：`packages/pi-maestro-flow/src/tools/todo.ts:348`、`packages/pi-maestro-flow/src/tools/todo.ts:353`。
- loader 目前把 `text` 直接返回，把 `file` 解析为工作目录相对路径，把 `skill` 搜索为 `SKILL.md`：`packages/pi-maestro-flow/src/tools/todo.ts:442`、`packages/pi-maestro-flow/src/tools/todo.ts:479`。
- 公开 TypeBox schema 仍保留旧的 `InjectionSchema`、`LoadSpecSchema`、`owner`、`completion`、`decision`、`metadata`，且没有公开内部实现需要的 `inject` 字段：`packages/pi-maestro-flow/src/extension/schemas.ts:187`、`packages/pi-maestro-flow/src/extension/schemas.ts:197`、`packages/pi-maestro-flow/src/extension/schemas.ts:234`。
- todo 工具说明仍以 `injection` 与 `load` 作为 create 示例：`packages/pi-maestro-flow/src/extension/index.ts:354`。
- footer widget 仍读取旧的 `injection.goalContext`、`owner`、`decision`，与当前 `TodoTask` 不一致：`packages/pi-maestro-flow/src/extension/index.ts:535`、`packages/pi-maestro-flow/src/extension/index.ts:592`。
- 当前改动未提交；`todo.ts` 与 `schemas.ts` 正处于从多字段模型向统一 inject 模型迁移的中间态。

### Upstream Material

N/A

---

## Branch Log

| # | Branch | Status | Decisions | Open Questions |
|---|--------|--------|-----------|----------------|
| 1 | Scope & Boundaries | 🟢 Complete | 4 | 0 |
| 2 | Data Model & State | 🟢 Complete | 4 | 0 |
| 3 | Edge Cases & Failure Modes | 🟢 Complete | 2 | 0 |
| 4 | Integration & Dependencies | 🟢 Complete | 4 | 0 |
| 5 | Scale & Performance | 🟢 Complete | 2 | 0 |

---

## Branch 1: Scope & Boundaries

**Status**: 🟢 Complete
**Questions asked**: 5
**Decisions locked**: 4

### Q1.1: todo 是否负责解析上下文来源

**Answer**: 选择“统一 Source 引用”。公开接口只保留一个通用上下文字段；todo 持久化未解析 source，并在 `next` 时统一解析为文本块。
**Evidence**: 当前 `InjectItem` 已将 `text | file | skill` 统一为 `type + source + tag?`（`packages/pi-maestro-flow/src/tools/todo.ts:18`）；`next` 已在消费时调用 loader（`packages/pi-maestro-flow/src/tools/todo.ts:353`、`packages/pi-maestro-flow/src/tools/todo.ts:433`）。
**Decision**: superseded by Scope Revision R1
**Constraint**: [SUPERSEDED] todo 的公开 contract MUST 仅暴露一个通用 Context Source 集合，并 MUST 在 `next` 消费时把 source 解析为文本 block；调用方 MUST NOT 被要求预先加载 file 或 skill。
**Clarification**: 用户确认不同类型内容 SHOULD 通过引用语法糖表达，再由 todo 内部归一化和加载。

### Q1.2: 公开接口是否同时保留 refs 与 inject

**Answer**: 选择“单字段混合类型”。只保留一个公开字段；数组元素可以是字符串语法糖，也可以是结构化 Context Source 对象。
**Evidence**: 当前 `TodoParams` 同时公开 `inject?: InjectItem[]` 与 `refs?: string[]`（`packages/pi-maestro-flow/src/tools/todo.ts:42`），并在 `resolveInject()` 中合并（`packages/pi-maestro-flow/src/tools/todo.ts:425`）；这形成两个等价入口和额外优先级问题。
**Decision**: superseded by Scope Revision R1
**Constraint**: [SUPERSEDED] todo 的公开 contract MUST 只包含一个上下文来源集合字段；该集合 MUST 同时接受 Ref Syntax 字符串和结构化 Context Source，并 MUST 归一化为单一内部表示。

### Q1.3: goal 是否属于通用 Context Source

**Answer**: 选择“Goal 完全独立”。通用引用字段不支持 `goal:`，todo 仅自动读取独立 goal 工具的活动目标。
**Evidence**: 当前 `next` 已通过 `getActiveGoal()` 自动注入活动目标（`packages/pi-maestro-flow/src/tools/todo.ts:348`）；旧 schema 的 per-task `goalContext`（`packages/pi-maestro-flow/src/extension/schemas.ts:201`）与该单一来源形成冲突。
**Decision**: locked [LOW CONFIDENCE: `maestro explore` 不可用，但用户已明确确认且本地代码证据一致]
**Constraint**: Goal lifecycle MUST 由 goal 工具独立管理；todo 的通用 Context Source MUST NOT 接受 goal 类型或 per-task goal override；`next` SHOULD 自动注入当前活动 goal。

### Scope Revision R1: context 改为纯文本，skill 改为独立可空配置

**Answer**: 用户修改方向：`context` 为纯文本；todo 增加独立、可空的 skill 配置，并通过类似 Maestro Ralph 的 loader 加载。
**Evidence**: 用户明确修订；Maestro Ralph 将 skill 名称保存在 step 中（`D:/maestro2/src/ralph/status-schema.ts:26`），在 `next` 时通过 `loadSkill()` 延迟加载（`D:/maestro2/src/ralph/cmd-next.ts:111`）。
**Decision**: locked [LOW CONFIDENCE: `maestro explore` 不可用，但用户已明确确认；Ralph 代码已本地核对]
**Constraint**: todo public contract MUST 将 inline `context` 与 skill 配置分离；`context` MUST 为纯文本；skill 配置 MUST 可省略；skill 内容 MUST 由独立 loader 延迟加载。
**Supersedes**: Q1.1 的“全部 source 统一进入 context”、Q1.2 的“单字段混合类型”、Q2.2 的 `{ ref, label? }` 数据模型。
**Open**: 原 `file:` 能力是移除、外移，还是增加第三个独立字段。

### Q1.4: 独立 skill loader 复用 Ralph 到哪一层

**Answer**: 选择完整 Ralph Loader。
**Evidence**: Ralph 的 `findSkill()` 负责按名称发现（`D:/maestro2/src/ralph/skill-scanner.ts:188`）；`loadSkill()` 解析 frontmatter、required/deferred reading 并读取必需文件（`D:/maestro2/src/ralph/skill-resolver.ts:145`、`D:/maestro2/src/ralph/skill-resolver.ts:165`）；`cmd-next` 还注入 skill-config 默认参数（`D:/maestro2/src/ralph/cmd-next.ts:153`、`D:/maestro2/src/ralph/cmd-next.ts:301`）。
**Decision**: revised by Scope Revision R2：复用行为思路，不集成 Ralph runtime
**Constraint**: todo skill loader SHOULD 参考 Ralph 的发现、正文加载、required/deferred reading 与参数默认值处理，但 MUST 由 Pi 插件原生实现；`skill` 为空时 MUST 跳过整个 loader。

### Q1.5: 是否保留通用 file 注入能力

**Answer**: 选择移除通用 file。
**Evidence**: 新 contract 已将 `context` 锁定为纯文本，完整 Ralph loader 会通过 `<required_reading>` 加载 skill 所需文件（`D:/maestro2/src/ralph/skill-resolver.ts:152`、`D:/maestro2/src/ralph/skill-resolver.ts:171`）；继续保留 `file:` 会重新引入第三种输入路径。
**Decision**: locked [LOW CONFIDENCE: `maestro explore` 不可用，但用户已明确确认且代码证据一致]
**Constraint**: todo public contract MUST NOT 提供通用 `file`/`files` 字段或 `file:` 语法；skill 依赖文件 MUST 通过 required reading 加载，其他文件由执行 agent 按需读取。

### Scope Revision R2: 当前不集成 Ralph，未来以 todo 替代 Pi Ralph 控制

**Answer**: 当前不需要集成 Ralph；`D:/maestro2/src` 仅作为 loader 设计参考。未来 Pi 中的 Ralph 步骤控制全部迁移为 todo 控制。
**Evidence**: 当前 Pi todo 已具备任务状态、依赖、`next` 与持久化能力（`packages/pi-maestro-flow/src/tools/todo.ts:24`、`packages/pi-maestro-flow/src/tools/todo.ts:316`、`packages/pi-maestro-flow/src/tools/todo.ts:548`），但 skill loader 仍是 `todo.ts` 内部的简化 `findSkillFile()`（`packages/pi-maestro-flow/src/tools/todo.ts:479`）。
**Decision**: locked [LOW CONFIDENCE: `maestro explore` 不可用，但用户已明确确认且代码证据一致]
**Constraint**: 当前实现 MUST NOT import、调用或依赖 `D:/maestro2` 的 Ralph 模块；Pi MUST 拥有原生 skill loader；todo MUST 被设计为未来 Pi Ralph 步骤控制的基础原语。
**Non-goal**: 当前阶段不迁移或重写 Ralph 本身。

## Branch 2: Data Model & State

**Status**: 🟢 Complete
**Questions asked**: 5
**Decisions locked**: 4

### Q2.1: 唯一公开字段的命名

**Answer**: 选择 `context`。
**Evidence**: 当前公开 schema 使用 `injection`、`load`、`refs`（`packages/pi-maestro-flow/src/extension/schemas.ts:261`），内部持久化使用 `inject`（`packages/pi-maestro-flow/src/tools/todo.ts:30`），同一概念存在四套命名。
**Decision**: locked [LOW CONFIDENCE: `maestro explore` 不可用，但用户已明确确认且本地代码证据一致]
**Constraint**: todo 的唯一公开上下文字段 MUST 命名为 `context`；`injection`、`load`、`refs`、公开 `inject` MUST 从新 contract 中移除或仅用于迁移兼容层。

### Q2.2: context 的结构化元素形态

**Answer**: 选择 `{ ref, label? }`。对象继续复用字符串 Ref Syntax，只为需要显式 block 名称的场景补充可选 label。
**Evidence**: 当前字符串走 `parseRefs()`（`packages/pi-maestro-flow/src/tools/todo.ts:393`），对象则直接使用 `{ type, source, tag }`（`packages/pi-maestro-flow/src/tools/todo.ts:18`），随后在 `resolveInject()` 合并（`packages/pi-maestro-flow/src/tools/todo.ts:425`），形成两条输入语义。
**Decision**: superseded by Scope Revision R1
**Constraint**: [SUPERSEDED] `context` 元素 MUST 为 `string | { ref: string; label?: string }`；两种形态 MUST 使用同一 Ref Syntax parser；公开 contract MUST NOT 再暴露 `type/source/tag` 三元组。

### Q2.3: update 的 context 状态语义

**Answer**: 选择整组替换。
**Evidence**: 当前条件 `params.inject !== undefined || params.refs?.length`（`packages/pi-maestro-flow/src/tools/todo.ts:198`）令空 `refs` 无法触发清空，且两字段合并使替换语义不明确。
**Decision**: revised by Q2.5 for the new scalar/object model
**Constraint**: [REVISED] `update` 省略 `context` MUST 保持原值；清空与替换使用 Q2.5 规则。

### Q2.4: 可空 skill 的公开数据结构

**Answer**: 选择 skill 对象：`skill?: { name: string; args?: string }`。
**Evidence**: Ralph 把 `skill` 与 `args` 分为两个 step 顶层字段（`D:/maestro2/src/ralph/status-schema.ts:26`、`D:/maestro2/src/ralph/status-schema.ts:27`）；todo 的目标是减少顶层字段，因此将二者聚合为一个可选对象。
**Decision**: locked [LOW CONFIDENCE: `maestro explore` 不可用，但用户已明确确认且 Ralph 代码已本地核对]
**Constraint**: todo MUST 使用单个可选 `skill` 对象；`name` MUST 为非空 skill 标识，`args` MAY 为字符串；public contract MUST NOT 再增加独立 `skillArgs` 顶层字段。

### Q2.5: context 与 skill 的 update 清空语义

**Answer**: 选择“省略保持，空值清除”。
**Evidence**: 当前 update 条件无法用空集合清除旧注入（`packages/pi-maestro-flow/src/tools/todo.ts:198`），说明 optional 字段必须区分 omitted 与 explicit empty/null。
**Decision**: locked [LOW CONFIDENCE: `maestro explore` 不可用，但用户已明确确认且代码证据一致]
**Constraint**: update 省略 `context`/`skill` MUST 保持原值；`context: ""` MUST 清除文本；`skill: null` MUST 清除 skill；非空字符串或 skill 对象 MUST 完整替换旧值。

## Branch 3: Edge Cases & Failure Modes

**Status**: 🟢 Complete
**Questions asked**: 3
**Decisions locked**: 2

### Q3.1: 无效 Ref Syntax 的处理

**Answer**: 选择整次调用失败。create/update 在持久化前校验全部 ref，任一无效则不保存任何 context 变更。
**Evidence**: 当前 parser 对无冒号、未知 prefix 或空值直接忽略（`packages/pi-maestro-flow/src/tools/todo.ts:399`、`packages/pi-maestro-flow/src/tools/todo.ts:403`），但 create 仍返回成功（`packages/pi-maestro-flow/src/tools/todo.ts:183`）。
**Decision**: superseded for `context`; failure validation remains applicable to the independent skill field
**Constraint**: [REVISED] `context` 不再解析 ref；skill loader 输入 MUST 给出明确验证错误，不得静默忽略。

### Q3.2: source 解析失败时的状态转换

**Answer**: 选择不推进状态。todo 必须先解析全部 context，再把任务改为 `in_progress`。
**Evidence**: 当前 `handleNext()` 在加载上下文前已经设置并持久化 `in_progress`（`packages/pi-maestro-flow/src/tools/todo.ts:329`、`packages/pi-maestro-flow/src/tools/todo.ts:332`）；loader 之后才可能返回读取错误（`packages/pi-maestro-flow/src/tools/todo.ts:447`、`packages/pi-maestro-flow/src/tools/todo.ts:456`）。
**Decision**: locked [LOW CONFIDENCE: `maestro explore` 不可用，但用户已明确确认且本地代码证据一致]
**Constraint**: `next` MUST 在状态转换前成功解析全部 Context Source；任一解析失败 MUST 返回 error 且 MUST 保持任务为 `pending`，以支持修复后重试。

### Q3.3: skill 发现与校验时机

**Answer**: 用户拒绝基于 Ralph 持久化模型的三个选项，并明确当前不集成 Ralph；未来 Pi Ralph 将由 todo 控制。
**Evidence**: 用户明确修订；当前问题应改为 Pi 原生 loader 的失败时机，而不是复刻 Ralph 的 `command_path` 状态。
**Decision**: locked [LOW CONFIDENCE: `maestro explore` 不可用，但用户已明确确认且代码证据一致]
**Constraint**: create/update MUST 只校验 `skill` 对象的 schema，不检查 skill 是否可发现；`next` MUST 才执行发现与完整加载；加载失败 MUST 保持任务为 `pending` 并返回明确 error。Pi todo MUST NOT 持久化 Ralph-specific `command_path`。

## Branch 4: Integration & Dependencies

**Status**: 🟢 Complete
**Questions asked**: 4
**Decisions locked**: 4

### Q4.1: Pi 原生 skill loader 的模块边界

**Answer**: 选择独立 `skill-loader` 模块。
**Evidence**: 当前 `todo.ts` 同时包含任务模型、状态机、持久化、ref parser、文件/skill loader（`packages/pi-maestro-flow/src/tools/todo.ts:12`、`packages/pi-maestro-flow/src/tools/todo.ts:429`、`packages/pi-maestro-flow/src/tools/todo.ts:544`），继续内嵌会扩大职责。
**Decision**: locked [LOW CONFIDENCE: `maestro explore` 不可用，但用户已明确确认且代码证据一致]
**Constraint**: Pi MUST 提供独立、无 Ralph 依赖的 skill loader 模块与稳定返回类型；todo MUST 通过该模块加载 skill，不得继续在 `todo.ts` 内维护私有 `findSkillFile()`/读取逻辑。

### Q4.2: 是否引入 Pi 原生 skill-config 默认参数

**Answer**: 选择新增 Pi skill-config。
**Evidence**: Maestro 参考实现通过 global/workspace 双层配置并按 skill 参数 deep merge（`D:/maestro2/src/config/skill-config.ts:55`、`D:/maestro2/src/config/skill-config.ts:70`）；当前 Pi 项目尚无对应配置。
**Decision**: locked [LOW CONFIDENCE: `maestro explore` 不可用，但用户已明确确认且参考代码已本地核对]
**Constraint**: Pi MUST 原生实现 skill-config loader；task-level `skill.args` MUST 覆盖默认参数；该实现 MUST NOT 读取 `.maestro/skill-config.json` 或依赖 Maestro runtime。

### Q4.3: Pi skill-config 的作用域与覆盖顺序

**Answer**: 选择项目覆盖全局。
**Evidence**: Pi 项目资源使用 `.pi/`（`README.md:28`），全局 agent 目录默认为 `~/.pi/agent`（`node_modules/@earendil-works/pi-coding-agent/docs/sdk.md:340`）。
**Decision**: locked [LOW CONFIDENCE: `maestro explore` 不可用，但用户已明确确认且 Pi SDK 文档已本地核对]
**Constraint**: loader MUST 读取 `{cwd}/.pi/skill-config.json` 与 `~/.pi/agent/skill-config.json`；MUST 按 skill/param deep merge；项目值 MUST 覆盖全局值；task-level `skill.args` MUST 再覆盖合并后的 defaults。

### Q4.4: skill 的发现机制

**Answer**: 选择复用 `DefaultResourceLoader`。
**Evidence**: Pi host loader 已统一发现项目 `.pi/skills/`、ancestor `.agents/skills/`、全局 `~/.pi/agent/skills/`、`~/.agents/skills/` 与 package skills（`node_modules/@earendil-works/pi-coding-agent/docs/sdk.md:345`、`node_modules/@earendil-works/pi-coding-agent/docs/sdk.md:354`）；`getSkills()` 返回已发现 skill（`node_modules/@earendil-works/pi-coding-agent/examples/sdk/04-skills.ts:40`）。
**Decision**: locked [LOW CONFIDENCE: `maestro explore` 不可用，但用户已明确确认且 Pi SDK 文档已本地核对]
**Constraint**: Pi 原生 skill loader MUST 复用 `DefaultResourceLoader` 的 discovery 结果并按 name 选择 skill；MUST NOT 复制 host 的目录扫描与优先级逻辑。

## Branch 5: Scale & Performance

**Status**: 🟢 Complete
**Questions asked**: 2
**Decisions locked**: 2

### Q5.1: skill discovery 的缓存与刷新

**Answer**: 选择会话缓存，失败时刷新。
**Evidence**: `DefaultResourceLoader.reload()` 会刷新资源，随后 `getSkills()` 获取发现结果（`node_modules/@earendil-works/pi-coding-agent/docs/sdk.md:845`、`node_modules/@earendil-works/pi-coding-agent/docs/sdk.md:852`）；对每个 next 全量 reload 会重复扫描。
**Decision**: locked [LOW CONFIDENCE: `maestro explore` 不可用，但用户已明确确认且 Pi SDK 文档已本地核对]
**Constraint**: loader MUST 在 session 范围缓存 skill discovery；命中 MUST 不触发全量 reload；name 未命中或显式 refresh 时 MAY reload 并 MUST 最多自动重试一次。

### Q5.2: context 与 skill 注入的 prompt 预算

**Answer**: 选择硬预算并失败。
**Evidence**: 当前 `next` 将所有已加载内容完整拼接进 prompt（`packages/pi-maestro-flow/src/tools/todo.ts:353`），没有单文件或总大小限制；skill required reading 可能进一步放大输入。
**Decision**: locked [LOW CONFIDENCE: `maestro explore` 不可用，但用户已明确确认且代码证据一致]
**Constraint**: loader MUST 支持可配置的单文件与总注入预算；超限 MUST 返回可诊断 error 且 MUST 保持任务 `pending`；MUST NOT 静默截断 context、skill body 或 required reading。

## Synthesis

### Decision Summary

| # | Decision | Status | Branch | RFC 2119 |
|---|----------|--------|--------|-----------|
| D-01 | todo 公开上下文改为可选纯文本 `context` | Locked | Scope/Data Model | MUST |
| D-02 | todo 增加可空 `skill?: { name, args? }` | Locked | Data Model | MUST |
| D-03 | 移除通用 `file:`、`refs`、公开 `inject`、`injection/load` 多入口 | Locked | Scope | MUST |
| D-04 | goal 保持独立，由 `next` 自动注入活动 goal | Locked | Scope | MUST/SHOULD |
| D-05 | Pi 原生实现独立 skill loader，不依赖 Ralph/Maestro runtime | Locked | Integration | MUST |
| D-06 | skill discovery 复用 Pi `DefaultResourceLoader` | Locked | Integration | MUST |
| D-07 | 新增 Pi 双作用域 skill-config，项目覆盖全局 | Locked | Integration | MUST |
| D-08 | skill 发现与完整加载全部延迟到 `next` | Locked | Failure Modes | MUST |
| D-09 | loader 失败或预算超限时保持任务 `pending` | Locked | Failure Modes/Scale | MUST |
| D-10 | discovery 使用 session cache，miss 时至多 reload 重试一次 | Locked | Scale | MUST/MAY |
| D-11 | 未来 Pi Ralph 的步骤控制迁移到 todo；当前不实施 Ralph 迁移 | Locked/Deferred | Scope | MUST NOT |

### Verified Constraints

- 新的最小任务模型 SHOULD 收敛为：`subject`、`description?`、`status`、`blockedBy`、`context?`、`skill?`、`summary?` 与时间戳；旧的 `owner`、`metadata`、`completion`、`decision`、`injection`、`load`、`refs`、公开 `inject` 不属于目标 contract。
- `context` MUST 是纯文本。create/update 中省略表示不变；update 的空字符串表示清除。
- `skill` MUST 是可空对象 `{ name: string, args?: string }`。省略表示不变；update 的 `null` 表示清除。
- `next` MUST 先加载活动 goal、inline context、skill body、required reading 与 skill-config defaults，再改变任务状态。
- task-level `skill.args` MUST 覆盖项目与全局 skill-config defaults；具体参数解析格式仍需在实施计划中锁定。
- skill loader MUST 作为 Pi 原生独立模块存在，并通过 `DefaultResourceLoader.getSkills()` 复用 host discovery 结果。
- 当前实现 MUST NOT import `D:/maestro2/src`，也 MUST NOT 持久化 Ralph-specific `command_path` 或 protocol 字段。

### Open Questions

1. 单文件与总注入预算的默认数值及配置位置尚未锁定。
2. `skill.args` 的格式是自由字符串、CLI token 列表还是结构化参数，以及它如何精确覆盖 `skill-config.params`，尚未锁定。
3. skill-config JSON schema 校验、损坏文件的诊断与回退策略尚未锁定。
4. 旧 session 中 `inject`、`injection`、`load` 等持久化字段的迁移策略尚未锁定。
5. 未来“Pi Ralph → todo 控制”的迁移边界与兼容期属于后续工作。

### Risk Register

| # | Risk | Branch | Severity | Mitigation |
|---|------|--------|----------|------------|
| R-01 | public TypeBox schema 与 `TodoParams`/`TodoTask` 已经漂移，当前工具调用可能接受旧字段却被 runtime 忽略 | Integration | High | 以单一 shared type/schema 为真相源，并增加 contract tests |
| R-02 | footer widget 仍读取旧 `owner/decision/injection` 结构 | Integration | High | 同步更新 `TodoTaskLike` 与 UI tags，测试快照 |
| R-03 | 现有工作树处于未提交的中间迁移状态 | Scope | High | 实施前保存/审查当前 diff，按目标 schema 一次收敛 |
| R-04 | 旧 session persistence 仅补 `inject ??= []`，新模型可能丢失或误解释历史数据 | Data Model | High | 添加显式 version 与 migration function |
| R-05 | 自建 skill parser 与 Pi host discovery/skill 语义再次分叉 | Integration | Medium | discovery 委托 `DefaultResourceLoader`；parser 只补 todo 所需加载行为 |
| R-06 | required reading 或 context 过大导致 token/latency 激增 | Scale | High | 硬预算、明确 error、无静默截断 |
| R-07 | `skill.args` 与 defaults 的覆盖若靠 substring 判断会误判 | Data Model | Medium | 使用结构化解析与精确 key merge，不复制 Ralph 的 `args.includes()` heuristic |
| R-08 | skill/config 在 create 后、next 前变化导致执行内容漂移 | Failure Modes | Medium | 记录 load timestamp、resolved skill path 与内容摘要用于诊断，但不持久化 Ralph 字段 |
| R-09 | `maestro explore` endpoint 连续失败，跨文件调用链未获独立 agent 交叉验证 | All | Medium | 下游计划前恢复 explore endpoint 或执行本地 contract/test 验证 |

### Recommended Next Step

范围已足够清晰，可执行：`$maestro-roadmap --from grill:GRL-001`
