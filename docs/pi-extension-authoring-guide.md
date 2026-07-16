# Pi Extension Authoring Guide

> 基于 [pi-extensions](https://github.com/narumiruna/pi-extensions) 仓库分析，Pi SDK v0.80.3，扩展版本 v0.11.0。

---

## 1. 扩展最小结构

```
extensions/pi-my-ext/
├── package.json
├── tsconfig.json
├── README.md
├── LICENSE
├── src/
│   └── my-ext.ts        # 入口文件
└── test/
    └── my-ext.test.ts
```

## 2. package.json 模板

```json
{
  "name": "@scope/pi-my-ext",
  "version": "0.1.0",
  "description": "Pi extension — what it does",
  "type": "module",
  "license": "MIT",
  "private": false,
  "keywords": ["pi-package", "pi-extension", "pi"],
  "files": ["src", "README.md", "LICENSE"],
  "pi": {
    "extensions": ["./src/my-ext.ts"]
  },
  "scripts": {
    "check": "biome check . && npm run typecheck",
    "format": "biome check --write .",
    "typecheck": "tsc --noEmit"
  },
  "dependencies": {
    "typebox": "^1.3.3"
  },
  "devDependencies": {
    "@biomejs/biome": "2.5.2",
    "@earendil-works/pi-ai": "0.80.3",
    "@earendil-works/pi-coding-agent": "0.80.3",
    "typescript": "6.0.3"
  }
}
```

关键字段：

| 字段 | 规则 |
|------|------|
| `type` | 必须 `"module"`（ESM only） |
| `pi.extensions` | 指向入口 `.ts` 文件，Pi 直接运行 TypeScript（无编译步骤） |
| `files` | 源码直接发布，`["src", "README.md", "LICENSE"]` |
| `dependencies` | 仅运行时必需的库（如 `typebox`） |
| `devDependencies` | Pi SDK 包、Biome、TypeScript |

## 3. TypeScript 配置

```json
{
  "extends": "../../tsconfig.json",
  "compilerOptions": { "rootDir": "." },
  "include": ["src/**/*.ts"]
}
```

根 tsconfig 配置：`target: ES2022`，`module/moduleResolution: NodeNext`，`strict: true`，`noEmit: true`。

## 4. Pi SDK 包

| 包 | 用途 | 使用场景 |
|----|------|----------|
| `@earendil-works/pi-coding-agent` | `ExtensionAPI`, `ExtensionContext`, `defineTool`, `getAgentDir` 等 | **必需** — 每个扩展都用 |
| `@earendil-works/pi-ai` | `Message`, `Usage`, `isContextOverflow`, `complete` | AI 调用、消息类型 |
| `@earendil-works/pi-tui` | `Key`, `Markdown`, `Container`, `Text`, `SelectList` 等 | 自定义 UI 组件 |
| `@earendil-works/pi-agent-core` | `AgentToolResult` | subagent 结果类型 |
| `typebox` | `Type` — JSON Schema 构建器 | 工具参数定义 |

> `@mariozechner/pi-*` 已弃用，新扩展只用 `@earendil-works/*`。

---

## 5. 入口文件模式

每个扩展的入口文件 **必须** 默认导出一个接收 `ExtensionAPI` 的函数：

```typescript
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function myExtension(pi: ExtensionAPI) {
    // 在这里注册 tool、command、hook
    // 返回 void，无需返回值
}
```

此函数在扩展加载时调用一次。**不要** 在加载时调用需要会话的方法（如 `getThinkingLevel()`），应推迟到 `session_start` 事件。

---

## 6. Tool 注册

### 6.1 使用 `defineTool()` 定义

```typescript
import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const myTool = defineTool({
    name: "my_tool",                 // snake_case 标识符
    label: "My Tool",                // 显示名称
    description: "Tool description for the model",
    promptSnippet: "Short instruction injected into system prompt",
    promptGuidelines: [              // 行为规则注入 system prompt
        "When to use this tool...",
        "When NOT to use this tool...",
    ],
    parameters: Type.Object({        // typebox JSON Schema
        target: Type.String({ description: "What to operate on" }),
        force: Type.Optional(Type.Boolean({ description: "Skip confirmation" })),
    }),

    async execute(toolCallId, params, signal, onUpdate, ctx) {
        // toolCallId: string — 调用唯一标识
        // params: 类型来自 parameters schema
        // signal: AbortSignal — 取消信号
        // onUpdate: (partial: AgentToolResult) => void — 流式更新
        // ctx: StatusContext — ui, cwd, sessionManager 等

        return {
            content: [{ type: "text", text: "result" }],
            details: { /* 任意结构化数据 */ },
            terminate: true,   // 可选：结束 agent turn
            isError: true,     // 可选：标记为错误
        };
    },

    // 可选：自定义 TUI 渲染
    renderCall(args, theme, context) {
        return new Text("...", 0, 0);
    },
    renderResult(result, { expanded }, theme, context) {
        return new Container();
    },
});

// 注册
pi.registerTool(myTool);
```

### 6.2 返回值格式

```typescript
{
    content: [
        { type: "text", text: "文本结果" },
        { type: "image", data: base64String, mimeType: "image/png" },  // 图像
    ],
    details: { /* 结构化元数据 */ },
    terminate: boolean,  // 结束 agent turn
    isError: boolean,    // 标记错误
}
```

### 6.3 动态启用/禁用

```typescript
pi.setActiveTools(["tool_a", "tool_b"]);  // 设置活跃工具集
pi.getActiveTools();                       // 获取当前活跃工具
pi.getAllTools();                           // 获取所有注册工具
```

---

## 7. Slash Command 注册

```typescript
pi.registerCommand("my-cmd", {
    description: "What this command does",  // /help 中显示

    // 可选：参数自动补全
    getArgumentCompletions(prefix) {
        return [
            { value: "option1", label: "Option 1", description: "..." },
            { value: "option2", label: "Option 2", description: "..." },
        ];
    },

    // 处理函数
    async handler(args, ctx) {
        // args: string — 原始参数字符串
        // ctx: ExtensionCommandContext
    },
});
```

### 7.1 子命令模式

```typescript
async handler(args, ctx) {
    const [subcommand, ...rest] = args.trim().split(/\s+/);
    switch (subcommand) {
        case "status":  return handleStatus(ctx);
        case "enable":  return handleEnable(rest.join(" "), ctx);
        case "disable": return handleDisable(rest.join(" "), ctx);
        default:        return handleHelp(ctx);
    }
},
```

### 7.2 ctx (ExtensionCommandContext) API

```typescript
ctx.ui.notify(message, level)        // "info" | "warning" | "error"
ctx.ui.confirm(title, message)       // → boolean
ctx.ui.select(title, options)        // → 选中项
ctx.ui.input(title, placeholder)     // → 输入字符串
ctx.ui.setStatus(key, value)         // 设置 statusline 项
ctx.ui.custom<T>(callback)           // 全自定义 TUI 组件

ctx.hasUI                            // 是否有交互界面
ctx.model                            // 当前模型 { id, provider }
ctx.modelRegistry                    // 获取 API keys/headers
ctx.sessionManager.getBranch()       // 获取会话消息
ctx.isIdle()                         // agent 是否空闲
ctx.cwd                              // 当前工作目录
ctx.mode                             // "tui" | other
ctx.abort()                          // 中止当前 turn
ctx.getContextUsage()                // { percent: number | null }
```

---

## 8. Hook / 事件系统

所有 hook 使用 `pi.on(eventName, handler)` 注册，handler 接收 `(event, ctx)`。

### 8.1 生命周期事件

| 事件 | 时机 | 典型用途 |
|------|------|----------|
| `session_start` | 会话开始 | 初始化状态、安装 UI、加载设置 |
| `session_shutdown` | 会话结束 | 清理资源 |
| `session_tree` | 会话树变化 | 重装 footer |
| `session_before_compact` | 上下文压缩前 | 持久化状态 |
| `session_compact` | 压缩后 | 恢复状态，发送续接消息 |

### 8.2 Agent Turn 事件

| 事件 | 时机 | 事件数据 |
|------|------|----------|
| `agent_start` | agent 开始处理 | — |
| `agent_end` | agent 结束 | `event.messages` |
| `before_agent_start` | agent 启动前 | `event.prompt`, `event.systemPrompt` |
| `turn_start` | turn 开始 | — |
| `turn_end` | turn 结束 | — |

### 8.3 消息事件

| 事件 | 时机 | 返回值 |
|------|------|--------|
| `input` | 用户/扩展输入 | `{ action: "handled" }` 消费该输入 |
| `message_start` | 消息流开始 | — |
| `message_update` | 消息流更新 | — |
| `message_end` | 消息完成 | `{ message: { ...modified } }` 改写消息 |

### 8.4 工具事件

| 事件 | 时机 | 返回值 |
|------|------|--------|
| `tool_call` | 工具执行前 | `{ block: true, reason: "..." }` 阻止 |
| `tool_execution_start` | 工具开始 | — |
| `tool_execution_end` | 工具结束 | — |

### 8.5 Provider / Model 事件

| 事件 | 时机 |
|------|------|
| `before_provider_request` | API 调用前 |
| `after_provider_response` | API 响应后 |
| `model_select` | 模型切换 |
| `thinking_level_select` | 思考级别变化 |

### 8.6 Hook 返回值改写模式

```typescript
// 注入 system prompt
pi.on("before_agent_start", (event, ctx) => {
    return { systemPrompt: event.systemPrompt + "\n\nExtra instructions..." };
});

// 改写消息（用于 retry 等）
pi.on("message_end", (event, ctx) => {
    if (shouldRewrite(event.message)) {
        return { message: { ...event.message, content: modified } };
    }
});

// 阻止工具调用
pi.on("tool_call", (event, ctx) => {
    if (shouldBlock(event)) {
        return { block: true, reason: "Not allowed in current state" };
    }
});

// 消费用户输入
pi.on("input", (event, ctx) => {
    if (event.text === "special") {
        return { action: "handled" };
    }
});
```

---

## 9. Statusline API

### 9.1 简单状态显示

```typescript
ctx.ui.setStatus("my-ext", "active");     // 显示
ctx.ui.setStatus("my-ext", undefined);    // 隐藏
```

### 9.2 高级 Footer（pi-statusline 模式）

```typescript
pi.on("session_start", (_event, ctx) => {
    ctx.ui.setFooter((tui, theme, footerData) => {
        return {
            dispose() { /* 清理 */ },
            invalidate() { /* 标记需重绘 */ },
            render(width) { /* 返回 string[] 行 */ },
        };
    });
});
```

`footerData: ReadonlyFooterDataProvider` 提供：
- `getGitBranch(): string | null`
- `getExtensionStatuses(): ReadonlyMap<string, string>`
- `onBranchChange(callback): unsubscribe`

---

## 10. 会话与状态管理

### 10.1 发送消息到会话

```typescript
pi.sendUserMessage(prompt);                                    // idle 时作为新用户消息
pi.sendUserMessage(prompt, { deliverAs: "followUp" });        // busy 时排队
pi.sendUserMessage(prompt, { deliverAs: "steer" });           // busy 时中断并导向
```

### 10.2 会话持久化

```typescript
pi.appendEntry<T>(customType, data);                          // 写入自定义条目
const entries = ctx.sessionManager.getBranch();                // 读取会话条目
```

### 10.3 执行 Shell 命令

```typescript
const result = await pi.exec("git", ["status", "--porcelain"], {
    cwd: "/path",
    timeout: 5000,
});
// result.code, result.stdout, result.stderr, result.killed
```

### 10.4 CLI Flag

```typescript
pi.registerFlag("my-flag", { description: "...", type: "string" });
const value = pi.getFlag("my-flag");
```

---

## 11. 自定义 TUI 组件

```typescript
const result = await ctx.ui.custom<ReturnType>((tui, theme, keybindings, done) => {
    return {
        render(width) { return ["line1", "line2"]; },
        handleInput(data) { /* 键盘输入 */ },
        invalidate() { /* 标记脏 */ },
    };
});
```

构建块：`Container`, `Text`, `Spacer`, `Markdown`, `DynamicBorder`, `BorderedLoader`, `SelectList`, `SelectItem`（来自 `@earendil-works/pi-tui`）。

---

## 12. 配置与设置模式

### 12.1 配置文件加载层级

环境变量 → 项目级 `.pi/<config>.json` → 用户级 `~/.pi/agent/<config>.json` → 内置默认值

```typescript
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import * as path from "node:path";

const SETTINGS_FILE = path.join(getAgentDir(), "pi-my-ext-settings.json");
```

`getAgentDir()` 返回 `process.env.PI_CODING_AGENT_DIR ?? ~/.pi/agent`。

### 12.2 安全写入

```typescript
// 原子写入：先写临时文件，再重命名
import * as fs from "node:fs/promises";
import * as os from "node:os";

const tmpFile = path.join(os.tmpdir(), `pi-my-ext-${Date.now()}.json`);
await fs.writeFile(tmpFile, JSON.stringify(data, null, "\t"));
await fs.rename(tmpFile, SETTINGS_FILE);

// 敏感文件设权限
await fs.chmod(SETTINGS_FILE, 0o600);
```

### 12.3 环境变量作为 Feature Flag

```typescript
const disabled = process.env.PI_MY_EXT_DISABLED === "1";
const timeout = Number(process.env.PI_MY_EXT_TIMEOUT_MS) || 30000;
```

---

## 13. 高级架构模式

### 13.1 何时拆分文件

单文件直到 ~1000-1500 行，拆分条件：
- 有独立协议实现（>200 行）— 如 LSP client、CDP client、S3 client
- 可分离的配置/发现逻辑 — 如 adapter、route 匹配
- 可独立测试的工具函数 — 如 text-edit 应用

**pi-lsp 参考架构（9 文件）：**

| 文件 | 职责 |
|------|------|
| `pi-lsp.ts` | 入口：注册 tools/commands/events |
| `types.ts` | 共享接口定义 |
| `lsp-client.ts` | JSON-RPC over stdio 通信 |
| `runner.ts` | 诊断/修复工作流编排 |
| `adapters.ts` | 配置加载（env → project → user → defaults） |
| `routes.ts` | 文件扩展名 → LSP server 路由 |
| `files.ts` | 工作区文件收集 |
| `command.ts` | 命令存在性检查 |
| `text-edits.ts` | LSP TextEdit 应用 |

### 13.2 模块级状态对象

```typescript
interface ExtensionState {
    host: string;
    port: number;
    active: boolean;
    // ...
}
const state: ExtensionState = { host: "localhost", port: 0, active: false };

// 所有 tool 读写此共享状态
```

### 13.3 并发控制

```typescript
async function mapWithConcurrencyLimit<T, R>(
    items: T[],
    limit: number,
    fn: (item: T) => Promise<R>,
): Promise<R[]> {
    const results: R[] = [];
    const executing: Set<Promise<void>> = new Set();
    for (const item of items) {
        const p = fn(item).then(r => { results.push(r); });
        executing.add(p);
        p.finally(() => executing.delete(p));
        if (executing.size >= limit) await Promise.race(executing);
    }
    await Promise.all(executing);
    return results;
}
```

### 13.4 状态机模式（pi-maestro-flow Goal）

```typescript
type GoalStatus = "active" | "paused" | "done";
type PauseReason = "user" | "budget" | "gate" | "error";

// 事件驱动的状态转换
// session_start → 恢复持久状态
// 正常 agent_end → 自动验证；pass 完成，fail 发送续接，inconclusive 保持 active
// aborted/error agent_end → 暂停或进入恢复路径，不验证完成
// session_before_compact → 保存状态
// session_shutdown → 仅持久化与清理，不验证
// turn_end → 不参与 Goal 验证（它只是单个 turn 的边界）
// tool_call → 阻止无效调用
```

Goal 的 LLM tool schema 必须以单一 `type: "object"` 为根；不要使用根级 `anyOf`，部分 OpenAI-compatible provider 会直接拒绝该函数 schema。action 专属必填项可在执行层校验。

### 13.5 AbortSignal 处理

```typescript
async execute(_id, params, signal, _onUpdate, ctx) {
    const client = new ExternalClient();
    const onAbort = () => client.close();
    signal.addEventListener("abort", onAbort);
    try {
        ctx.ui.setStatus("my-ext", "running");
        return await client.doWork(params);
    } finally {
        signal.removeEventListener("abort", onAbort);
        ctx.ui.setStatus("my-ext", undefined);
    }
}
```

### 13.6 轮询与防抖

```typescript
let refreshTimer: NodeJS.Timeout | null = null;
const INTERVAL = 30_000;
const DEBOUNCE = 250;

function scheduleRefresh(immediate = false) {
    if (refreshTimer) clearTimeout(refreshTimer);
    refreshTimer = setTimeout(doRefresh, immediate ? 0 : DEBOUNCE);
}

function startPolling() {
    setInterval(doRefresh, INTERVAL);
}
```

---

## 14. 错误处理原则

- 所有扩展使用 `try/finally` 清理，`finally` 中总是清除 status key
- AbortSignal 在 `finally` 中解绑
- 分类错误为 retryable（provider 错误、context overflow）vs non-retryable（auth、usage limits）
- 不吞掉错误（除 cleanup 路径），用 `ctx.ui.notify(msg, "error")` 通知用户
- 自定义错误类可带 `retryable` / `launchable` 标志控制流程

---

## 15. 测试模式

### 15.1 测试框架

使用 Node.js 原生 `node:test` + `node:assert/strict`：

```typescript
import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createMockPi, createMockContext } from "../../../test/support.js";
import init from "../src/my-ext.js";  // 注意: .js 扩展名（NodeNext 要求）
```

### 15.2 Mock 工具

```typescript
const mockPi = createMockPi();
init(mockPi);  // 注册所有 tool/command/hook

// 验证注册
assert.ok(mockPi.commands.has("my-cmd"));
assert.ok(mockPi.tools.has("my_tool"));

// 获取注册的 handler 并调用
const handler = mockPi.commands.get("my-cmd").handler;
const ctx = createMockContext();
await handler("args", ctx);

// 验证效果
assert.equal(ctx.statuses.get("my-ext"), "active");
```

### 15.3 测试文件位置

```
extensions/pi-my-ext/test/my-ext.test.ts
```

运行：`npm test`（根目录，使用自定义 test runner `scripts/run-tests.mjs`）。

---

## 16. 发布流程

1. **无编译步骤** — TypeScript 源码直接发布，Pi 原生运行
2. `just pack <name>` — 预览 npm tarball 内容
3. `just publish <name>` — 发布（版本已存在则跳过）
4. `just bump @scope/pi-<name> patch|minor|major` — 工作区版本升级
5. `just npm-public @scope/pi-<name>` — 修复 scoped 包 404 可见性

安装：`pi install npm:@scope/pi-my-ext`
临时使用：`pi -e npm:@scope/pi-my-ext`

---

## 17. 边界规则

- 扩展之间 **不能** 互相依赖（`package.json` 和 `import` 均不可）
- 由 `scripts/check-extension-boundaries.mjs` 强制执行
- 弃用扩展移至 `extensions/deprecated/`（不在 workspace 中、不参与测试、不参与边界检查）

---

## 18. 代码风格（Biome）

- 缩进：Tab
- 行宽：100
- 引号：双引号
- 分号：始终
- Lint：推荐预设
- VCS 感知（使用 `.gitignore`）

---

## 19. 最小可用扩展模板

```typescript
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

export default function myExtension(pi: ExtensionAPI) {
    // 1. Slash command
    pi.registerCommand("my-cmd", {
        description: "Does something useful",
        handler: async (args, ctx) => {
            ctx.ui.notify(`Got: ${args}`, "info");
        },
    });

    // 2. Tool
    pi.registerTool(defineTool({
        name: "my_tool",
        label: "My Tool",
        description: "A tool for the agent",
        promptSnippet: "Use my_tool when you need to...",
        parameters: Type.Object({
            input: Type.String({ description: "The input" }),
        }),
        async execute(_id, params, signal, _onUpdate, ctx) {
            ctx.ui.setStatus("my-ext", "working");
            try {
                const result = await doWork(params.input, signal);
                return { content: [{ type: "text", text: result }] };
            } finally {
                ctx.ui.setStatus("my-ext", undefined);
            }
        },
    }));

    // 3. Lifecycle hooks
    pi.on("session_start", (_event, ctx) => {
        ctx.ui.setStatus("my-ext", "ready");
    });
    pi.on("session_shutdown", (_event, ctx) => {
        ctx.ui.setStatus("my-ext", undefined);
    });
}
```

---

## 附录 A：扩展复杂度分级

| 级别 | 代表 | 特征 | 文件数 |
|------|------|------|--------|
| **简单** | pi-caffeinate, pi-retry | 纯 hook，无 tool/command | 1 |
| **标准** | pi-btw, pi-wait-what | 1-2 个 command/tool + hooks | 1 |
| **中等** | pi-statusline, pi-google-genai | 多 tool + 外部 API + config | 1-2 |
| **复杂** | pi-subagents, pi-chrome-devtools | 进程管理 + TUI + 并发 | 2-3 |
| **大型** | pi-lsp, pi-sync, pi-maestro-flow | 协议实现 + 多模块 | 5-9+ |

## 附录 B：完整事件列表

```
session_start, session_shutdown, session_tree,
session_before_compact, session_compact,
agent_start, agent_end, before_agent_start,
turn_start, turn_end,
input, message_start, message_update, message_end,
tool_call, tool_execution_start, tool_execution_end,
before_provider_request, after_provider_response,
model_select, thinking_level_select
```

## 附录 C：ExtensionAPI 完整方法

```typescript
// 注册
pi.registerTool(tool)
pi.registerCommand(name, config)
pi.registerFlag(name, config)
pi.on(event, handler)

// 状态
pi.getFlag(name): string | undefined
pi.getThinkingLevel(): ThinkingLevel
pi.getAllTools(): ToolInfo[]
pi.getActiveTools(): string[]
pi.setActiveTools(names: string[])

// 操作
pi.sendUserMessage(text, options?)
pi.appendEntry<T>(customType, data)
pi.exec(cmd, args, options): Promise<ExecResult>
```
