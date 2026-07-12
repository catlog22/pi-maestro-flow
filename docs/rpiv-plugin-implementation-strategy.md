# Pi 插件实现策略

> 基于 [rpiv-mono](https://github.com/juicesharp/rpiv-mono) 仓库深度分析提炼。
> 涵盖 Extension API、Skill 系统、Workflow 引擎、Agent 定义、Monorepo 生态。
> 与 `pi-extension-authoring-guide.md`（基础 API 参考）互补，本文聚焦**架构策略**与**高级模式**。

---

## 目录

1. [架构全景](#1-架构全景)
2. [Extension API 完整表面积](#2-extension-api-完整表面积)
3. [Skill 系统](#3-skill-系统)
4. [Workflow 引擎](#4-workflow-引擎)
5. [Agent 定义系统](#5-agent-定义系统)
6. [Monorepo 生态模式](#6-monorepo-生态模式)
7. [实现策略总结](#7-实现策略总结)

---

## 1. 架构全景

rpiv-mono 是一个 15 包的 monorepo，实现了 Pi Coding Agent 的完整开发工作流扩展系统。核心分层：

```
┌─────────────────────────────────────────────────────┐
│                    用户交互层                         │
│  /skill:plan  /wf arch  /rpiv-models  /rpiv-setup   │
├─────────────────────────────────────────────────────┤
│               rpiv-pi (纯协调器)                      │
│  extensions/rpiv-core  ←→  skills/  ←→  agents/     │
├─────────────────────────────────────────────────────┤
│            rpiv-workflow (工作流引擎)                  │
│  stage-def → routing → loop → runner → state(JSONL) │
├─────────────────────────────────────────────────────┤
│               工具层 (sibling 插件)                    │
│  rpiv-todo │ rpiv-advisor │ rpiv-ask-user-question   │
│  rpiv-args │ rpiv-web-tools │ rpiv-i18n │ rpiv-btw   │
├─────────────────────────────────────────────────────┤
│        rpiv-config (共享配置 I/O 基底)                 │
├─────────────────────────────────────────────────────┤
│   Pi SDK (@earendil-works/pi-coding-agent, pi-ai)    │
└─────────────────────────────────────────────────────┘
```

**核心设计原则**：
- **Pure-orchestrator**: rpiv-pi 不注册工具，仅协调 session hooks、guidance 注入、命令注册
- **Sibling 解耦**: 所有工具包为 peerDependency，动态 import + `isModuleNotFound` 降级
- **Skill 即 Markdown**: 技能逻辑在 SKILL.md 中声明式定义
- **Agent 即 Markdown**: 子 agent 系统提示词在 `.md` 文件中声明
- **JSONL 审计**: 工作流状态 append-only，支持断点续跑

---

## 2. Extension API 完整表面积

### 2.1 入口签名

```ts
// extensions/rpiv-core/index.ts
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
  // 注册 hooks、commands、flags
}
```

`package.json` 声明：
```json
{
  "pi": {
    "extensions": ["./extensions"],
    "skills": ["./skills"]
  }
}
```

### 2.2 事件系统 — `pi.on(event, handler)`

| 事件 | 触发时机 | handler 参数 | 返回值 | 典型用途 |
|------|---------|-------------|--------|---------|
| `session_start` | 新会话/子会话启动 | `(event, ctx: { cwd, hasUI, ui, modelRegistry? })` | `void` | guidance 注入、agent 同步、model capture |
| `session_compact` | 上下文自动压缩 | `(event, ctx: { cwd })` | `void` | 重置+重新注入（压缩后 transcript 被清除） |
| `session_shutdown` | 会话销毁/退出 | `(event)` | `void` | 清除缓存和状态 |
| `tool_call` | 每次工具调用 | `(event: ToolCallEvent, ctx: ExtensionContext)` | `void` | 基于 read/edit/write 注入 guidance；git 命令清除缓存 |
| `before_agent_start` | agent turn 开始前 | `(event, ctx)` | `{ message }` 或 `undefined` | 注入 git-context 变更 |
| `input` | 用户输入（展开前） | `(event: { text, source })` | `{ action: "continue" }` | `/skill:` bracket model override |
| `agent_end` | agent turn 结束 | `()` | `void` | 恢复 baseline model |

**ToolCallEvent**: `{ toolName: string, input: Record<string, unknown> }`
**InputEvent**: `{ text: string, source: "interactive" | "extension" | "rpc" }`

### 2.3 消息系统

```ts
pi.sendMessage({
  customType: string,   // 消息类型标识
  content: string,      // Markdown 内容
  display: boolean,     // true=用户可见, false=仅 LLM 可见
});
```

rpiv-core 定义的消息类型：

| 常量 | 用途 |
|------|------|
| `MSG_TYPE_GIT_CONTEXT` (`"rpiv-git-context"`) | branch/commit/user 信息 |
| `MSG_TYPE_GUIDANCE` (`"rpiv-guidance"`) | AGENTS.md / CLAUDE.md / architecture.md |
| `MSG_TYPE_PIPELINE_INDEX` (`"rpiv-pipeline-index"`) | 技能索引注入 |

`display` 由 `pi.getFlag("rpiv-debug")` 控制，默认隐藏。

### 2.4 命令注册

```ts
pi.registerCommand(name: string, {
  description: string,
  handler: (args: string, ctx: { hasUI: boolean, ui: UI }) => Promise<void>
});
```

### 2.5 Flag 系统

```ts
pi.registerFlag(name, { description, type: "boolean", default: false });
pi.getFlag(name): unknown;
```

### 2.6 模型控制

```ts
pi.setModel(model): Promise<boolean>;     // 持久化到磁盘！
pi.getThinkingLevel(): string;
pi.setThinkingLevel(level);
```

**关键警告**: `setModel` 会持久化到 settings 文件。必须配合 `BaselineSnapshot + restoreBaseline()` 确保作用域结束后恢复。

### 2.7 其他 API

| API | 用途 |
|-----|------|
| `pi.exec(cmd, args, opts)` | 执行外部进程 |
| `pi.registerTool(tool)` | 注册工具 |
| `pi.getCommands()` | 查询已注册命令 |
| `pi.events.emit/on(channel, data)` | 进程内事件总线 |
| `pi.sendUserMessage(content)` | 以 user 角色发消息 |
| `pi.registerShortcut(keyId, opts)` | 注册快捷键 |

### 2.8 SDK 公共导出

从 `@earendil-works/pi-coding-agent` 导入：

| 导出 | 用途 |
|------|------|
| `createAgentSession(opts)` | 创建子 AgentSession |
| `getAgentDir()` | `~/.pi/agent/` 路径 |
| `parseFrontmatter(text)` | 解析 YAML frontmatter |
| `loadSkills(opts)` / `loadSkillsFromDir(opts)` | 加载 skill 列表 |
| `parseSkillBlock(text)` | 解析 `<skill name="…">` 标签 |
| `SessionManager` | 会话管理（create/open/forkFrom） |
| `DefaultResourceLoader` | 扩展发现与过滤 |

---

## 3. Skill 系统

### 3.1 SKILL.md 完整规范

每个 skill 是一个目录，内含 `SKILL.md` 文件。

#### Frontmatter 字段

| 字段 | 必需 | 类型 | 说明 |
|------|------|------|------|
| `name` | ✅ | string | 唯一标识，与目录名一致 |
| `description` | ✅ | string | 自然语言描述（LLM 用于分发） |
| `argument-hint` | 推荐 | string | 参数提示 |
| `shell-timeout` | 可选 | number | Shell 块超时秒数 |
| `disable-model-invocation` | 可选 | boolean | 禁止 body 内调 model |
| `allowed-tools` | 可选 | string | 工具白名单 |
| `contract` | 可选 | object | 输入/输出约定 |

#### Contract 结构

```yaml
contract:
  produces:
    kind: produces          # produces（写制品）或 side-effect（副作用）
    meta:
      artifactKind: plan    # 领域标签（plan/design/review/frd）
    data:                   # JSON Schema 验证输出
      type: object
      required: [phases]
      properties:
        status: { enum: [in-progress, in-review, ready] }
  consumes:
    data:                   # 对输入的约束
      type: object
      properties:
        status: { const: ready }
    meta:
      artifactKind: [design]   # 接受的上游制品类型
    reads:                     # 命名通道读取
      plans:
        meta:
          artifactKind: plan
```

Contract 驱动三层验证：
1. **加载时** — `validateWorkflow()` 检查 skill 存在 + contract 兼容
2. **运行时** — `validate-output.ts` 验证 stage 输出
3. **路由时** — `gate()`/`match()` 基于 `data` 决定走向

#### Body 结构

```markdown
# {Skill Name}

## Input
`$ARGUMENTS` — 用户参数的描述。

## Metadata
```!
node "${SKILL_DIR}/../_shared/now.mjs"
echo
node "${SKILL_DIR}/../_shared/git-context.mjs"
```（运行时执行，输出注入 body）

## Flow
1. Input → 2. Research → 3. Write → 4. Review → 5. Present

## Steps
### Step 1: ...
### Step 2: ...

## Guidelines
## Important Notes
```

#### Shell 代码块（` ```! `）

以 ` ```! ` 标记的代码块在 skill 展开时执行，输出替换代码块位置：
- `$SKILL_DIR` — 当前 skill 目录
- `$ARGUMENTS` — 用户参数
- `shell-timeout` 控制执行超时
- 总是 exit 0（容错降级）

### 3.2 共享工具库 (`_shared/`)

| 脚本 | 用途 | 输出 |
|------|------|------|
| `now.mjs` | ISO 时间戳 + slug | `2026-05-19T11:23:04-0400\t2026-05-19_11-23-04` |
| `git-context.mjs` | Git 状态摘要 | `branch:` / `commit:` / `repo:` / `author:` |
| `git-changes.mjs` | 变更快照 | `---status---` + `---diffstat---` |
| `list-recent.mjs` | 目录最新文件 | 按修改时间排序 |
| `stitch-elaborations.mjs` | 代码拼接 | 修改 plan 文件 |

### 3.3 Skill Bracket（model/effort override）

`/skill:<name>` 调用时可覆写模型配置：

1. 监听 `input` 事件，匹配 `/skill:` 前缀
2. 查 `models.json` 的 `config.skills?.[name]`
3. 保存 baseline → `applyEffectiveModel()` → 设新值
4. `agent_end` 时 `restoreBaseline()` 还原
5. 单槽位设计：Pi 序列化 turns

### 3.4 Subagent 调度模式

Skill body 中通过 Agent tool 调度子 agent：

```markdown
Agent({
  subagent_type: "artifact-code-reviewer",
  description: "post-finalization plan code review",
  prompt: `Plan artifact: {path}
Review the finalized plan against the live codebase...`
})
```

模式：
- **Wave 并行**: 多个独立 agent 同批次调度
- **Sequential 串行**: 有依赖的 agent 分步调度
- **审查后门控**: agent 结果决定下一步走向

---

## 4. Workflow 引擎

### 4.1 Workflow 定义

```ts
interface Workflow {
  name: string;
  description?: string;
  start: string;                      // 入口 stage key
  stages: Record<string, StageDef>;   // stage 字典
  edges: Record<string, EdgeTarget>;  // 路由图
}
```

### 4.2 Stage 三臂联合体

| 臂 | 判别字段 | 工厂 | 描述 |
|----|---------|------|------|
| `SkillStage` | `skill` | `produces()` / `acts()` / `terminal()` | 调用 `/skill:<name>` |
| `ScriptStage` | `run` | `.script({run})` | 纯 TS 函数 |
| `PromptStage` | `prompt` | `.prompt({prompt})` | 原始文本 |

**StageKind**: `"produces"`（写 artifact）vs `"side-effect"`（副作用）
**SessionPolicy**: `"fresh"`（新 session）vs `"continue"`（fork 前驱）

关键属性：
- `outputSchema` / `inputSchema`: Standard Schema v1 (TypeBox/Zod/Valibot)
- `onInvalid`: `"retry"` 或 `"halt"`
- `loop`: fanout / iterate / assess
- `verify`: post-condition judge
- `reads`: 命名通道消费

### 4.3 内置 Workflow（5 个）

| 名称 | 流水线 | 用途 |
|------|--------|------|
| **ship** | blueprint → implement → validate → commit | 快速交付 |
| **arch** | research → design → plan → implement → validate → code-review → gate → commit | 完整架构流 |
| **vet** | code-review → gate → blueprint → implement → validate → commit | 先审后做 |
| **polish** | architecture-review → blueprint(iterate) → implement → validate → code-review → commit | 打磨优化 |
| **build** | ~20 stages，含 slice、design-review、synthesis、3 quality gates + human checkpoint | 最复杂的 carve 流 |

### 4.4 路由系统

```ts
// gate — 数字字段条件路由
gate("blockers_count", {
  design: gt(0),
  commit: eq(0)
}, "commit")

// match — 枚举字段路由
match("verdict", {
  commit: "pass"
}, { from: "validation" })

// defineRoute — 通用自定义路由
defineRoute(targets, fn, opts?)
```

谓词：`gt(n)`, `gte(n)`, `lt(n)`, `lte(n)`, `eq(n)`

### 4.5 Loop 系统

| Kind | 模型 | 并行 | 典型用例 |
|------|------|------|---------|
| **fanout** | push: 预计算全部 unit | 有界并行 (`maxConcurrency`) | phase 并行实现 |
| **iterate** | pull: 逐个生成 | 串行 | 累积式 blueprint |
| **assess** | producer→judge 循环 | 串行 | 质量门控 |

fanout 的 `deps` DAG 做拓扑排序，按依赖波次 dispatch。

### 4.6 Runner 架构

```
runner.ts        — runWorkflow + resumeWorkflow
run-stage.ts     — 单 stage 执行
chain-advance.ts — 链推进 + 路由审计
resolve-stage.ts — stage 模式推导
preflight.ts     — 运行时预检
resume.ts        — JSONL → RunState 重建
resume-loop.ts   — loop 续跑
```

### 4.7 状态管理

**JSONL 审计日志**: `.rpiv/workflows/runs/<run-id>.jsonl`
- append-only，每行一个 JSON 对象
- 行类型：`WorkflowHeader` + `WorkflowStage` + `RoutingDecision`
- StageStatus: `completed` | `failed` | `skipped` | `aborted`
- 是 resume 的 system of record

**RunState 可变簿记**:
- `primaryArtifact`: 滚动 slot
- `output`: 最新 stage Output
- `named`: 命名 publish 注册表
- `lastSession`: continue policy fork 源
- `termination`: running | completed | failed | aborted | cancelled

### 4.8 SDK Host 集成

`WorkflowHostContext` 接口（rpiv-workflow 定义，rpiv-pi 实现）：

```ts
interface WorkflowHostContext {
  cwd: string;
  hasUI: boolean;
  maxConcurrency: number;
  spawnChild<T>(options: {
    prompt: string;
    model?: ModelSelection;
    signal?: AbortSignal;
    reattach?: { sessionFile: string };
    fork?: { sessionFile: string };
    withSession: (child: WorkflowSessionContext) => Promise<T>;
  }): Promise<T>;
}
```

`SdkWorkflowHost` 实现关键点：
- 每个 stage 在独立子 `AgentSession` 中运行
- 交互 session 从不执行 stage
- per-unit model 通过 `modelRegistry.find` 解析，child creation 时应用
- 嵌套 fanout 深度 ≤ 2 (`MAX_FANOUT_DEPTH`)
- 子 session 过滤 ambient observer extensions
- 子 session 绑定 deferring relay UI（问卷 queue 到 lane dock）
- teardown: `session_shutdown` → `dispose()`

---

## 5. Agent 定义系统

### 5.1 Agent `.md` 格式

```yaml
---
name: codebase-analyzer
description: "分析代码库实现细节..."
tools: read, grep, find, ls       # 工具白名单
isolated: true                     # 隔离执行
extensions: [rpiv-web-tools]       # 可选扩展
---

{系统提示词 body — Markdown}
```

### 5.2 rpiv-pi 内置 15 个 Agent

**定位类**: codebase-locator, artifacts-locator, precedent-locator, scope-tracer, integration-scanner
**分析类**: codebase-analyzer, artifacts-analyzer, codebase-pattern-finder
**审计类**: artifact-code-reviewer, artifact-coverage-reviewer, diff-auditor, claim-verifier, peer-comparator, slice-verifier
**研究类**: web-search-researcher

### 5.3 Agent 同步机制

`agents.ts` 中的 `syncBundledAgents()`:
1. 将捆绑 agents 拷贝到 `~/.pi/agent/agents/`
2. SHA 哈希检测变更
3. SyncResult 跟踪: added/updated/unchanged/removed/pendingUpdate/pendingRemove/errors
4. `session_start` 时自动执行（仅首次 per-process）
5. `/rpiv-update-agents` 手动触发

---

## 6. Monorepo 生态模式

### 6.1 依赖架构

```
  Pi SDK (@earendil-works/pi-coding-agent)
     ↑ peerDep
     │
  rpiv-config ←── dep ─── 所有包
     ↑ dep
     ├── rpiv-pi ──── peerDep ──→ rpiv-workflow (+ 其他工具包)
     └── rpiv-workflow ── dep ──→ rpiv-config
```

**关键**: rpiv-pi 对工具包全部使用 `peerDependencies`，不硬依赖。

### 6.2 Sibling 插件系统

```ts
// siblings.ts — 声明式注册表
export const SIBLINGS: readonly SiblingPlugin[] = [
  {
    pkg: "npm:@tintinweb/pi-subagents",
    matches: /@(tintinweb|gotgenes)\/pi-subagents/i,
    provides: "Agent / get_subagent_result / steer_subagent tools",
  },
  // ... 8 个 sibling
];
```

检测方式：regex 匹配 Pi settings.json 的 `packages[]`（纯文件系统，无运行时 import）。

### 6.3 打包策略

- **统一版本**: 全包锁定同一版本号（`1.20.0`）
- **npm scope**: `@juicesharp/rpiv-*`
- **关键字标识**: `"pi-package"` + `"pi-extension"`
- **ship-manifest.test.ts**: 验证 `files[]` 覆盖所有生产 `.ts` — 防发布遗漏
- **ambientObserver 标记**: 纯观察者扩展自声明排除子会话加载

### 6.4 各包角色

| 包 | 角色 | Pi API |
|----|------|--------|
| rpiv-config | 共享配置 I/O | 无（纯工具库） |
| rpiv-pi | 协调器 + 技能 + agents | extensions + skills |
| rpiv-workflow | 工作流引擎 | extensions |
| rpiv-args | `$1/$ARGUMENTS` 替换 | extensions |
| rpiv-ask-user-question | 结构化问答 | extensions |
| rpiv-todo | 任务追踪 + overlay | extensions |
| rpiv-advisor | 第二意见审查 | extensions |
| rpiv-web-tools | web_search/web_fetch | extensions |
| rpiv-i18n | 国际化 | extensions |
| rpiv-btw | /btw 侧问 | extensions |
| rpiv-warp | Warp 终端通知 | extensions + ambientObserver |
| rpiv-telemetry | MLflow 遥测 | extensions (private) |
| rpiv-voice | 语音听写 | extensions |

---

## 7. 实现策略总结

### 7.1 编写 Pi 扩展的关键模式

#### 模式 1: Pure-Orchestrator Extension

rpiv-pi 的核心模式 — 扩展本身不注册工具，仅协调：

```ts
export default function(pi: ExtensionAPI) {
  // 1. 注册 flags
  pi.registerFlag("my-debug", { description: "...", type: "boolean", default: false });

  // 2. 注册生命周期 hooks
  pi.on("session_start", async (event, ctx) => {
    // 注入 guidance、捕获 context
  });
  pi.on("tool_call", async (event, ctx) => {
    // 拦截 read/edit/write，注入上下文
  });

  // 3. 注册命令
  pi.registerCommand("my-command", {
    description: "...",
    handler: async (args, ctx) => { /* ... */ },
  });

  // 4. 条件注册（依赖可选 sibling）
  void (async () => {
    try {
      const { someAPI } = await import("@scope/optional-sibling");
      someAPI.register(/* ... */);
    } catch (err) {
      if (!isModuleNotFound(err)) throw err; // sibling 缺失 = 静默降级
    }
  })();
}
```

#### 模式 2: Guidance 注入

在 `session_start` 和 `tool_call` 时向 LLM 注入上下文：

```ts
pi.sendMessage({
  customType: "my-guidance",
  content: "## Architecture\n...",
  display: false,  // 仅 LLM 可见
});
```

层级发现：从项目根到操作文件目录，逐层查找 AGENTS.md > CLAUDE.md > architecture.md。

#### 模式 3: Model Override Bracket

`input` → arm (保存 baseline, 设 override) → `agent_end` → disarm (恢复 baseline)

关键：`setModel()` 持久化到磁盘，必须在 scope 结束时恢复。

#### 模式 4: Sibling 解耦

```ts
// 所有 sibling 为 peerDependency
// 运行时动态 import + isModuleNotFound 降级
try {
  const mod = await import("@scope/sibling");
  mod.doSomething();
} catch (err) {
  if (isModuleNotFound(err)) return; // 静默降级
  throw err; // 真实错误抛出
}
```

#### 模式 5: 链式 IIFE 避免 jiti 竞态

多个 sibling 的动态 import 必须串行（避免 jiti 的半初始化 barrel namespace）：

```ts
void (async () => {
  await registerA().catch(logFail("A"));
  await registerB().catch(logFail("B")); // 等 A 完成再 import B
  await registerC().catch(logFail("C"));
})();
```

### 7.2 编写 Skill 的关键模式

#### 模式 1: 标准 Skill 结构

```
skills/my-skill/
├── SKILL.md           # 技能定义（frontmatter + body）
├── templates/         # 可选：输出模板
└── _helpers/          # 可选：辅助脚本
```

#### 模式 2: Contract 驱动的 Skill 链

```yaml
# design skill 产出
contract:
  produces:
    kind: produces
    meta: { artifactKind: design }
    data:
      type: object
      required: [slices]

# plan skill 消费
contract:
  consumes:
    meta: { artifactKind: [design] }
    data:
      type: object
      properties:
        status: { const: ready }
```

#### 模式 3: 多波次 Subagent 调度

```markdown
### Step 4: Parallel Review

发送所有 Agent 调用在同一消息中：

Agent({ subagent_type: "code-reviewer", ... })
Agent({ subagent_type: "coverage-reviewer", ... })

等待两个结果，合并成统一表格。
```

### 7.3 编写 Workflow 的关键模式

#### 模式 1: 基本 DAG

```ts
defineWorkflow({
  name: "my-flow",
  start: "research",
  stages: {
    research:  produces({ skill: "research" }),
    design:    produces({ skill: "design" }),
    implement: acts({ skill: "implement" }),
    commit:    terminal({ skill: "commit" }),
  },
  edges: {
    research: "design",
    design:   "implement",
    implement: "commit",
  },
});
```

#### 模式 2: 条件路由 + 质量门控

```ts
edges: {
  review: gate("blockers_count", {
    design: gt(0),     // 有 blocker → 回退 design
    commit: eq(0),     // 无 blocker → 前进 commit
  }, "commit"),        // 默认走 commit
}
```

#### 模式 3: Fanout 并行执行

```ts
stages: {
  implement: acts({
    skill: "implement",
    loop: fanout({
      units: (output) => output.data.phases.map((p, i) => ({
        prompt: `Phase ${i + 1}: ${p.title}`,
        label: p.title,
        id: `phase-${i + 1}`,
      })),
    }),
  }),
}
```

### 7.4 编写 Agent 的关键模式

```yaml
---
name: my-analyzer
description: "简短描述（LLM 用于选择调度）"
tools: read, grep, find, ls    # 最小权限工具集
isolated: true                  # 与主会话隔离
---

你是 {角色}。你的工作是 {职责}。

## 核心职责
1. ...

## 分析策略
### Step 1: ...

## 输出格式
...

## 重要规则
- 包含 file:line 引用
- 不要猜测
```

### 7.5 对 pi-maestro-flow 的适用指导

基于 rpiv-mono 分析，pi-maestro-flow 可借鉴的实现策略：

1. **Extension 分层**: 核心协调逻辑放 `extensions/`，工具注册放独立 sibling 包
2. **Skill 系统**: 以 SKILL.md 格式定义可组合的工作流步骤
3. **Contract 验证**: 通过 `produces`/`consumes` 声明实现 skill 链的类型安全
4. **Agent 捆绑**: agents/ 目录存放 `.md` 格式的专用子 agent 定义
5. **Guidance 注入**: 通过 `session_start` + `tool_call` hooks 自动注入架构上下文
6. **Workflow 编排**: 使用 DAG + routing + loop 组合 skill 为完整流水线
7. **状态持久化**: JSONL append-only 日志支持断点续跑
8. **可选依赖**: peerDep + 动态 import + `isModuleNotFound` 降级

---

*本文档基于 rpiv-mono v1.20.0 分析。与 `pi-extension-authoring-guide.md`（基础 API）互补使用。*
