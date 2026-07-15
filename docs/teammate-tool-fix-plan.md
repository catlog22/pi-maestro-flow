# Teammate 工具修复方案

> 基于 2026-07-15 对 `docs/tool-schema-reference.md` §5–§8 与实际实现（`packages/pi-maestro-teammate/`，v0.4.3）的交叉审计。
> 问题分三层：实现级 bug（P0）、schema 与校验缺陷（P1）、设计改进与文档（P2）。

## ✅ 实施状态（2026-07-15 完成，v0.4.4）

F1–F11 全部落地，112 个测试全绿（94 原有 + 18 新增 `test/normalize.test.ts`）。变更明细见 `packages/pi-maestro-teammate/CHANGELOG.md`。

决策点裁定结果：① A（删除死代码）；② A（fork 传递，per-task 可覆盖）；③ 移除（已验证 pi 校验用 TypeBox `Value.Check`，`Type.Object` 默认允许未知属性，旧调用方传 `protocol_version` 不会被拒）；④ 引入 `dependsOn`；⑤ 不拆分，`message` 对 abort 可选。

实施中额外发现并修复：代理路径 `teammate-send` 只认名称寻址（根路径已支持 correlation ID/前缀）——两条路径已对齐到 `resolveAgentCorrelationId`。

## 问题清单总览

| ID | 严重度 | 类型 | 问题 | 位置 |
|----|--------|------|------|------|
| F1 | P0 | 实现 bug | reply_to 死锁检测是死代码 + 假 fallback（声称回退实际不派发） | `src/extension/index.ts:803-815`, `2546-2569` |
| F2 | P0 | 实现 bug | `{name}` 未知引用静默降级：拼写错误不建依赖、不报错、字面量残留 | `src/runs/execution.ts:170,196,1166` |
| F3 | P0 | 实现 bug | 多任务模式 `context: "fork"` 被静默丢弃（schema 声称 applies to all modes） | `src/runs/execution.ts:80-92,1339-1348` |
| F4 | P1 | 设计缺陷 | 废弃的 `chain` 优先级高于 `tasks` | `src/extension/index.ts:727,2934` |
| F5 | P1 | 冗余 | normalize 逻辑在 execute 与 handleProxyRequest 重复两份且已漂移 | `src/extension/index.ts:723-767,2932-2960` |
| F6 | P1 | 校验缺口 | 多任务模式顶层 `agent`/`task` 被静默忽略；空任务（task 与 prompt 均缺）照常派发 | `src/extension/index.ts:730-745` |
| F7 | P1 | schema 泄漏 | `protocol_version` 内部细节暴露给 LLM 调用方 | `src/extension/schemas.ts:150-156` |
| F8 | P2 | 设计改进 | 依赖仅靠 `{name}` 插值隐式推导，无显式 `dependsOn` | `src/runs/execution.ts:160-175` |
| F9 | P2 | 一致性 | teammate-send 只收 name、teammate-watch 收 name/correlation ID；`abort` 塞在发消息工具里且 `mode` 无默认值文档 | `src/extension/schemas.ts:259-287` |
| F10 | P2 | 语义模糊 | `taskType` 与 `agent` 概念重叠，路由优先级只写在描述文本里；`view: "roles"` 孤儿枚举 | `src/extension/schemas.ts:17-25,271-275` |
| F11 | P2 | 文档 | `docs/tool-schema-reference.md` 与 schema 脱节（chain、默认值语义、`{name.field}` 等缺失） | `docs/tool-schema-reference.md` §5–§8 |

---

## Phase 0 — 前置重构：统一 normalize（F5）

**其余多数修复的载体，必须先做。**

### 现状

任务归一化逻辑写了两份：

- `execute`（`index.ts:723-767`）：chain 分支先归一化再用第二段循环合并顶层默认值；
- `handleProxyRequest`（`index.ts:2932-2960`）：inline 合并，错误消息不同（`Requires "agent" field for single mode...` vs `Requires "agent" or "tasks".`）。

### 方案

提取纯函数到 `src/runs/execution.ts`（或新建 `src/shared/normalize.ts`）：

```ts
interface NormalizeResult {
  tasks: NormalizedTask[] | null;   // null = 单任务模式
  isMultiTask: boolean;
  warnings: string[];               // F6 的警告在此收集
  error?: string;                   // fail-fast 错误
}
export function normalizeTeammateParams(params: RunTeammateParams): NormalizeResult
```

- chain 与 tasks 的默认值合并统一为一段代码（`t.x ?? params.x`）；
- 错误消息统一为一处定义；
- `execute` 与 `handleProxyRequest` 均改为调用该函数。

### 测试

新增 `test/normalize.test.ts`：单任务 / tasks / chain / 空参数 / chain+tasks 同给 / 顶层默认值下沉，共约 8 个 case。两处调用点行为一致性由此单测保证。

### 风险

低。当前两份实现语义一致（仅消息文本不同），提取属等价重构。

---

## Phase 1 — P0 bug 修复

### F1：reply_to 死锁检测死代码 + 假 fallback

**现状**：`index.ts:803` 的触发条件 `reply_to !== "main" && reply_to !== "caller"` 在 schema 枚举约束下只可能因 `undefined` 命中，而 `detectReplyCycle(state, name, undefined)` 在 `index.ts:2551` 立即返回 false——检测永不生效。且命中路径的返回消息声称 "Falling back to reply_to='caller'"，代码却直接 return、不派发任何 agent，还标记 `isError: false`。`detectReplyCycle` 按 agent 名遍历回复链，说明它是为"reply_to 可填 agent 名"的旧设计写的，schema 收窄后未同步清理。

**方案（推荐 A）**：删除死代码。移除 `index.ts:802-815` 调用点与 `detectReplyCycle`（`index.ts:2546-2569`）。schema 维持 `caller | main`。

**备选 B**（若确需 agent 间定向回复路由）：`reply_to` 放开为 `Type.String()`（`caller`/`main` 为保留字），保留 `detectReplyCycle`，并修正 fallback 为真回退：

```ts
if (wouldCycle) {
  params = { ...params, reply_to: "caller" };  // 继续执行，不 return
  warnings.push(`[deadlock] reply_to cycle detected, falling back to "caller"`);
}
```

**决策点 ①**：选 A 还是 B。无明确需求时选 A（最小、无行为变化）；B 需要额外验证 `ActiveAgent.replyTo` 全链路按名路由的正确性。

**测试**：A 无需新增（删除后编译通过 + 现有测试绿）；B 需增加 cycle 检测与 fallback 派发的集成测试。

### F2：`{name}` 未知引用静默降级

**现状**：`extractDependencies`（`execution.ts:170`）只认已存在的任务名，未知引用被过滤；`resolveVariables`（`execution.ts:196`）对未知名原样保留。后果：`{taskA}` 拼错成 `{task_a}` 时依赖边不建立、任务立即并行执行、prompt 残留字面 `{taskA}`，全程无警告。`execution.ts:1166` 的 `throw new Error('Task references unknown name')` 因上游已过滤而不可达。

**方案**（不能直接报错——task 文本中的 `{word}` 可能是合法字面量，如代码示例、glob）：

1. 新增 `collectUnknownRefs(template, taskNames): string[]`——用同一 `VAR_PATTERN_SOURCE` 扫描但**不过滤**，返回不在 `taskNames` 中的名字；
2. `runGraph` 入口（`execution.ts:1162` 附近）汇总所有任务的 unknownRefs：
   - 与某任务名编辑距离 ≤ 2 的未知引用 → **报错拒绝执行**（大概率拼写错误，如 `{task_a}` vs `{taskA}`）；
   - 其余 → 在结果 messages 附加一条 system warning（`[warn] task "b" references unknown name "{foo}" — treated as literal text`），不阻断；
3. 删除 `execution.ts:1166` 不可达 throw（或降为防御性断言并注释说明）;
4. 工具描述 `TEAMMATE_PROMPT_SNIPPET` 补一句：未知 `{name}` 会按字面处理，引用前确认任务名。

**测试**：`test/graph-status-and-structured-output.test.ts` 增加三个 case——拼写近似报错、无关字面量仅警告、正确引用无警告。

**风险**：编辑距离规则可能误伤极端命名（任务名彼此相近且文本含同形字面量）。可接受：报错信息给出两个候选名，调用方可改名或改引用。

### F3：多任务模式 `context: "fork"` 静默丢弃

**现状**：`NormalizedTask`（`execution.ts:80-92`）无 `context` 字段，normalize 映射（`index.ts:731-743`）不拷贝，`runGraph` 逐任务调用 `runTeammate`（`execution.ts:1339-1348`）不传。schema 注释却声称 Execution Control "applies to all modes"。

**方案（推荐 A）**：传递。

1. `NormalizedTask` 增加 `context?: "fresh" | "fork"`；
2. normalize 时 `context: t.context ?? params.context`（同时在 `TaskSpec` 增加可选 `context` 字段，允许 per-task 覆盖，与其他字段的默认值模式对齐）；
3. `runGraph` 的 runTeammate 调用透传 `context: task.context`；
4. schema description 注明成本：fork N 个并发任务 = N 份父会话拷贝，建议仅对确需历史的任务 per-task 设置。

**备选 B**：拒绝——`tasks` + `context: "fork"` 时 normalize 返回明确错误。保守但砍掉一个 schema 已承诺的能力。

**决策点 ②**：A 或 B。推荐 A——改动小、语义符合 schema 既有承诺。

**⚠️ 行为变化**：修复前 `tasks + fork` 实际全 fresh；修复后真 fork，token 成本上升。需在 CHANGELOG 与工具描述中显著标注。

**测试**：多任务 fork 传递单测（mock `runSingleAttempt` 断言 `forkSessionFile` 被设置）；per-task 覆盖优先级测试。

---

## Phase 2 — schema 与校验收敛

### F4：chain 优先级调换与退役

**现状**：`index.ts:727` 与 `index.ts:2934` 均先检查 `chain`——废弃参数反而压过推荐参数 `tasks`。

**方案**（两步走）：

1. **本次**：normalize 中调换顺序（tasks 优先）；使用 chain 时在结果 messages 附 deprecation warning；chain+tasks 同给时忽略 chain 并警告；
2. **下个 minor 版本**：从 `TeammateParams` 移除 `chain`，`normalizeChainToTasks` 同步删除。

**风险**：chain+tasks 同给的调用极少见（本仓库内 grep 无此用法），低风险。

### F6：静默忽略与空任务校验

在 `normalizeTeammateParams` 中补三条规则：

| 场景 | 现状 | 修复后 |
|------|------|--------|
| `tasks` 存在且顶层 `agent`/`task` 也提供 | 静默忽略 | warnings 附 `top-level agent/task ignored in multi-task mode` |
| 某任务 `task` 与 `prompt` 均缺 | `task: ""` 空 prompt 照常派发 | fail-fast：`error: task[i] requires "task" or "prompt"`（派发前拒绝，避免烧掉一次空跑） |
| `promptArgs` 提供但 `prompt` 缺失 | 参数被丢弃 | warnings 提示（`promptArgs` 依赖 `prompt` 模板；单任务模式下 task 为 $1 时保持现状不警告——先核实 `resolvePromptTask` 的实际消费逻辑，见 `execution.ts:585`） |

**⚠️ 行为变化**：空任务从"能跑"变"报错"，属纠错型 breaking，CHANGELOG 标注。

### F7：protocol_version 收编

**现状**：`schemas.ts:150-156` 暴露给 LLM，唯一作用是 v2 默认 `reply_to=caller`。

**方案**：从 `TeammateParams` 移除该字段；运行时 `RunTeammateParams` 类型保留可选字段以兼容存量调用（需先确认 pi 校验层对未知字段是剥离还是拒绝——若拒绝则只能保留字段并在 description 标注 `internal, do not set`）。

**决策点 ③**：移除 vs 标注 internal。取决于 pi 框架的 additionalProperties 校验行为，实施时先验证。

---

## Phase 3 — 设计改进（可选，需决策）

### F8：显式 `dependsOn` 字段

`TaskSpec` 增加 `dependsOn?: string[]`，依赖集 = `dependsOn` ∪ `{name}` 推导，取并集：

- 表达"只要求顺序、不需要注入输出"的依赖不再被迫在文本里写 `{name}`；
- `dependsOn` 中的未知名**严格报错**（无字面量歧义，与 F2 的宽容规则互补）；
- 向后兼容，`{name}` 插值行为不变。

改动点：`TaskSpec` schema、`NormalizedTask`、`runGraph` 依赖构建（`execution.ts:1163`）合并两个来源。

**决策点 ④**：是否引入。推荐引入——F2 只能缓解拼写风险，dependsOn 才是根治。

### F9：send/watch/list 一致性

1. **寻址统一**：`teammate-send.to` 支持 correlation ID/前缀（与 teammate-watch 对齐），解析函数共用——未命名 agent 当前"能看不能停"；
2. **abort 语义**：保留 `mode: "abort"` 但将 `message` 改为可选（abort 不需要消息体）；不另立 teammate-stop 工具（工具数量本身也是 LLM 的选择负担）；
3. **mode 默认值**：核实 `sendRpcMessage` 对 undefined mode 的实际处理，在 schema description 标注 default；
4. **`view: "roles"`**：核实用途，在 schema description 与文档中说明，或若已废弃则从枚举移除。

**决策点 ⑤**：abort 拆分与否（上述取向为不拆分）。

### F10：taskType 语义文档化

核实 `taskType` 在 `applyModelRouting` 与角色提示注入中的全部效果，然后：

- schema description 明确：`taskType` 影响模型路由（及角色提示，若属实），不改变 agent 行为定义；
- 文档写明优先级链：`task.model` > 顶层 `model` > `taskType` 自动路由 > agent frontmatter 默认；
- `agent` 与 `taskType` 矛盾组合（如 `agent: "explorer", taskType: "review"`）不报错，但文档说明以 agent 为准、taskType 仅影响路由。

---

## Phase 4 — 文档再生成（F11）

**在 Phase 1–2 代码落地后执行**，避免文档二次漂移。更新 `docs/tool-schema-reference.md`：

1. §5 teammate：
   - 补"顶层字段 = 多任务默认值，per-task 覆盖优先"核心语义；
   - 补 `chain`（标注 deprecated 与移除计划）或注明已移除；
   - 补 `{name.field}` / `{name[0]}` 结构化输出引用；
   - 补依赖推导规则 + 未知引用的字面量处理警告（对应 F2 行为）；
   - 补 `context` 多任务行为与 fork 成本提示（对应 F3 决策结果）；
   - `reply_to` 默认值来源说明（或随 F7 简化后的表述）；
   - "Explorer 专用提示词结构"移到 explorer agent 说明或 maestro explore 章节，消除与 CLAUDE.md 指引的重复；
2. §6–§8：补 `mode` 默认值、寻址规则（name vs correlation ID）、`view: "roles"` 说明；
3. 新增「teammate vs maestro 选择规则」小节：maestro 三个 action 是 `runTeammate` 的 CLI-endpoint 包装（`src/tools/delegate.ts:11` 等），给出选择判据（pi agent 定义 → teammate；外部 CLI endpoint / MoA → maestro）;
4. 修正文档头部生成时间，并注明对应 schema 版本（`pi-maestro-teammate@x.y.z`）。

---

## 实施顺序与依赖

```
Phase 0  F5 normalize 统一 ──┬─→ Phase 1  F1 / F2 / F3（并行）
                             └─→ Phase 2  F4 / F6 / F7
Phase 1+2 全绿 ──→ Phase 3  F8 / F9 / F10（按决策结果）
                └─→ Phase 4  F11 文档再生成（最后）
```

- 测试运行：`cd packages/pi-maestro-teammate && npm test`（node --test，现有 12 个测试文件须保持全绿）；
- 每个 Phase 独立提交，行为变化项（F3-A、F6 空任务报错、F4 优先级调换）在 commit message 与 CHANGELOG 标注。

## 决策点汇总

| # | 问题 | 选项 | 推荐 |
|---|------|------|------|
| ① | reply_to 死代码 | A 删除 / B 放开为 agent 名并修 fallback | A |
| ② | tasks + fork | A 传递（真 fork）/ B 拒绝报错 | A |
| ③ | protocol_version | 移除 / 标注 internal 保留 | 视 pi 校验行为，倾向移除 |
| ④ | dependsOn 显式依赖 | 引入 / 不引入 | 引入 |
| ⑤ | abort 拆分 | 独立 teammate-stop / 保留 mode 但 message 可选 | 后者 |
