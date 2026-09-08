# `/gateway` 命令与 MCP 工具设计说明

> 本文说明 Pi Maestro 中 `/gateway`、Gateway MCP 控制面和本地 MCP 客户端工具之间的关系。重点是调用边界与生命周期，不是 MCP 协议入门。

## 1. 结论先行

`/gateway` 不是一个把所有 MCP 工具直接暴露给模型的命令。它是 Gateway/MCPX 的**管理控制面**：打开管理 Overlay，负责 daemon、隧道、工作区注册、协作 Session、Gateway Todo 和 Monitor 等操作。

Pi 调用外部 MCP 服务的模型工具是另一个层次：MCP adapter 注册一个名为 `mcp` 的统一代理工具；模型先通过它发现服务器和工具，再按需连接并调用目标工具。只有显式配置 direct tools 时，部分 MCP 工具才会以独立 Pi 工具名注册。

因此需要区分三条链路：

```text
/gateway 命令
  └─ McpxOverlay
      └─ McpxStreamableHttpClient
          └─ Gateway MCP endpoint（默认 http://127.0.0.1:9090/mcp）
              └─ session / todo / monitor / pi_window 等 Gateway 工具

MCP adapter
  ├─ /mcp 命令：管理与观察外部 MCP 服务
  └─ mcp Pi tool：状态、发现、连接、认证和调用外部 MCP 工具

可选 direct tools
  └─ 从元数据缓存选择少量外部 MCP 工具，注册为独立 Pi tool
```

源码依据：`src/extension/index.ts` 中 `/gateway` 注册（约 3010 行）、`src/tui/mcpx-overlay.ts`、`src/tui/mcpx-client.ts`，以及 `src/mcp/index.ts` 的 adapter 注册逻辑。

## 2. 分层与职责

### 2.1 `/gateway`：管理入口，不承担通用工具代理

扩展注册的命令只有两个行为：

- `/gateway`：打开 `openMcpxOverlay(ctx)`；
- `/gateway wizard`：打开 `openMcpxWizard(ctx)`。

Overlay 的职责是 Gateway 运行状态和控制操作，例如：

- Gateway daemon 的启动、停止、重启和状态检查；
- workspace 的 lease/permanent 注册与移除；
- MCPX quick tunnel 的状态与刷新；
- CollaborativeSession、独立 Gateway Todo、member lease、execution Monitor；
- 通过 Gateway 发现和观察其他 Pi window。

`/gateway` 本身没有调用 `registerMcpAdapter`、`executeCall` 或外部 MCP server 的路径。这样可以避免把“管理 Gateway”与“调用任意外部 MCP 服务”混成一个权限和生命周期域。

### 2.2 Gateway MCP 控制面：Overlay 的远端协议客户端

Overlay 通过 `McpxStreamableHttpClient` 使用 MCP Streamable HTTP：

1. 对 endpoint 执行 `initialize`，协商协议版本 `2025-11-25`；
2. 保存 `Mcp-Session-Id`，后续请求复用会话；
3. 以 JSON-RPC `tools/call` 调用 Gateway 提供的控制工具；
4. 将 `structuredContent` 优先作为结构化 envelope，兼容文本中携带 JSON 的响应；
5. 将非 `ok/success` 状态统一转换为 `McpxClientError`，按 `auth`、`unsupported`、`http`、`protocol`、`tool` 分类。

Overlay 目前按领域工具调用 Gateway，例如：

| Gateway MCP 工具 | 典型操作 | 设计含义 |
|---|---|---|
| `session` | list/get/renew | 协作 Session 发现、读取与成员租约 |
| `todo` | list/claim/release/advance | Gateway Todo 的独立状态机 |
| `monitor` | list/observe/cancel | execution Monitor 的观察与取消 |
| `pi_window` | list/send/observe | 跨 Pi window 的消息与事件观察 |

这些是 Gateway 服务端的控制工具，不应与外部 MCP server 的工具元数据混用。Overlay 负责把它们映射为面板操作，并在调用参数中携带 `sessionId`、`memberId`、revision、generation 或 operationId 等并发/租约字段。

### 2.3 MCP adapter：模型侧的统一 `mcp` 工具

`registerMcpAdapter(pi)` 在扩展初始化阶段注册：

- `/mcp` 命令：面向用户的管理入口；
- `mcp` Pi tool：面向模型的统一访问入口。

统一代理的 schema 是一组互斥倾向的操作字段：

| 字段 | 用途 |
|---|---|
| 无字段 | 展示服务器状态 |
| `server` | 列出某服务器的工具 |
| `search` + 可选 `regex/server/includeSchemas` | 按名称或描述搜索工具 |
| `describe` | 展示工具描述与参数 schema |
| `connect` | 主动连接服务器并刷新元数据 |
| `tool` + `args` + 可选 `server` | 调用目标工具；`args` 必须是 JSON 对象字符串 |
| `action: "auth-start"` | 启动 OAuth，返回浏览器 URL |
| `action: "auth-complete"` | 提交 redirect URL、code 或 input 完成 OAuth |
| `action: "ui-messages"` | 读取已完成 MCP UI session 的消息 |

执行优先级固定为：

```text
action > tool > connect > describe > search > server > status
```

这条优先级在描述文本和实际 `execute` 分支中保持一致，防止模型同时填入多个字段时出现不可预测路由。

## 3. 外部 MCP 调用生命周期

### 3.1 配置发现与安全边界

管理态和运行态必须分开：

- 管理器使用完整配置，以便显示 `enabled: false` 的服务器；
- 运行时使用 `loadMcpConfig`，过滤掉 `enabled: false`，停用服务不得连接或注册工具；
- 项目配置只有在当前 workspace 被信任时才加入运行时配置；扩展注册早期只读取显式/global 配置，session context 建立后再按信任状态初始化。

配置合并后以 `mcpServers` 为根键。服务器定义可以是 stdio（`command/args/env/cwd`）或 HTTP（`url/headers/auth`），并可声明 `lifecycle`、`idleTimeout`、`directTools`、`excludeTools` 和请求超时等策略。

### 3.2 初始化

`initializeMcp` 创建 `McpServerManager`、生命周期管理器、元数据 Map、失败追踪器、UI resource handler 和 consent manager：

1. 恢复仍有效的工具/资源元数据缓存；
2. 按 `lifecycle` 注册服务器；`eager`/`keep-alive`（首次无缓存时也会 bootstrap）服务器并行连接；
3. 从连接结果生成带前缀的工具元数据；
4. 更新缓存、状态栏和失败状态；
5. 启动健康检查、重连和 idle shutdown。

默认模型调用仍采用 lazy connect：状态或缓存可以先展示工具，真正调用时才建立连接。连接、重连和 session shutdown 由 `McpSessionLifecycle` 串行协调，并通过 generation/abort 防止旧 session 的迟到初始化污染新状态。

### 3.3 调用与结果

`mcp({ tool, args, server })` 的核心流程是：

1. 校验 `args` 是 JSON object；拒绝数组、null、标量和非法 JSON；
2. 若指定 `server`，先验证服务器存在；未指定时先在已知元数据中查找；
3. 必要时按工具名前缀匹配服务器并 lazy connect；
4. 如果需要 OAuth，按配置尝试自动认证，否则返回可执行的认证指引；
5. 通过 `acquireConnection` 获取带 request options 的 connection lease，避免关闭/重连错误地清理另一个连接实例；
6. 调用原始 MCP tool，或读取资源工具对应的 resource URI；
7. 将 text/image/resource/resource_link/audio 等 MCP content 转换为 Pi 内容块；空 content 时回退到 `structuredContent`；
8. 经 output guard 限制内联字节数/行数，超大结果摘要化并保留可追溯 details；
9. 在 finally 中释放 lease，并通过 renderer 展示折叠或展开结果。

如果模型误把 Pi 原生工具名交给 `mcp`，代理会明确提示“请直接调用该工具”，而不是重复执行或静默转发。

## 4. 统一代理与 direct tools 的取舍

### 4.1 默认路径：一个代理工具

工具注册器刻意只向 Pi 注册一个 `mcp` 工具，而不是将外部服务器的数百个工具全部注册到 LLM context。优点是：

- 减少 schema 和工具描述占用的上下文；
- 服务器增删不需要频繁改变 Pi 工具目录；
- 连接、认证、缓存、输出守卫集中在单一边界；
- 通过 `search`/`describe` 实现渐进式发现。

### 4.2 选择性路径：direct tools

`directTools` 不是第二套 MCP 协议，而是代理调用链的快捷暴露：

- 仅根据有效元数据缓存生成 direct tool spec；
- 可按服务器、工具名或 `MCP_DIRECT_TOOLS` 环境变量筛选；
- 遵循 `excludeTools`、资源暴露设置和 tool prefix；
- 跳过与 Pi 内置工具冲突或彼此重复的名字；
- 执行器仍复用 lazy connect、OAuth、connection lease、UI session 和 output guard。

因此 direct tool 只改变模型看到的入口名，不改变 MCP 调用的安全与生命周期。若缓存缺失，adapter 会保留 proxy tool，以保证仍有发现/调用路径；配置要求 direct tools 但缓存不可用时，初始化会尝试 bootstrap 元数据，成功后提示重载才能得到稳定的 direct tool 目录。

## 5. `/gateway` 与 `mcp` 的边界

| 问题 | `/gateway` / Gateway MCP 控制面 | `mcp` Pi tool / MCP adapter |
|---|---|---|
| 服务对象 | 内置 Gateway/MCPX | 外部 MCP servers |
| 主要消费者 | 人类操作员与 Overlay | 模型和 `/mcp` 命令 |
| 入口 | `/gateway`、wizard、Overlay | `mcp({...})`、`/mcp` |
| 协议方向 | Overlay → Gateway endpoint | Pi → 外部 MCP endpoint/process |
| 工具示例 | `session`、`todo`、`monitor`、`pi_window` | 任意外部 server 工具与资源 |
| 状态所有权 | Gateway workspace/session store | MCP session state、metadata cache、server manager |
| 权限重点 | Gateway token、workspace/member lease、revision/generation | workspace trust、OAuth、consent、output guard、连接 lease |
| 是否应合并 | 否；只通过稳定的控制协议交互 | 否；不应把 Gateway 控制工具伪装成外部工具 |

兼容层 `mcpx-bridge.ts` 保留了 `/mcpx` 时代的部分命名和配置路径，但生命周期与 workspace 状态已经由内置 Gateway 拥有。新设计应使用 Gateway 的稳定控制客户端和结构化契约，避免重新引入直接读写旧 MCPX 状态文件的路径。

### 5.1 Gateway Board 是平行的本地工具

`board` 是 Pi 内置的独立工具，不属于外部 MCP proxy，也不等同于 Overlay 通过 Gateway endpoint 调用的 `todo` 工具。它通过认证本地 IPC 调用 workspace-shared Gateway Board，并由宿主注入 workspace path、request ID、operation ID 和 Pi endpoint identity。

- 只读动作：`list`、`get`、`observe`；
- 变更动作：使用 `expectedRevision` 做 CAS fence，并按需要携带 operation ID；
- endpoint 绑定（`attach-endpoint`/`detach-endpoint`）与执行 ownership（`claim`/`renew`/`release`/`takeover`）分开；
- Pi Todo、Gateway Todo 与 Board 是三个不同状态域，不应在 `mcp` 代理中互相伪装。

这样，Gateway 相关能力形成三种清晰入口：人类通过 `/gateway` 管理，模型通过 `board` 操作共享任务状态，Overlay 通过 Gateway MCP endpoint 操作协作 Session/Monitor；外部服务仍统一走 `mcp`。

## 6. GUI/UCL 工具路由不是 MCP proxy

当启用 `PI_GUI=1` 时，GUI/UCL 会暴露独立的：

- `GET /tools`：返回 host tool catalog、schema、是否 GUI-callable、mutating 和 owner；
- `POST /tools/:name`：调用 GUI registry 中允许的工具。

这条 HTTP 路由与 `mcp` proxy 平行但不等价。它在执行前还会：

1. 校验工具存在且 GUI 可调用；
2. 从 TypeBox schema 转换并校验参数；
3. 限制 in-flight 数量，拒绝重复 invoke id；
4. 监听连接关闭、显式 timeout 和 `/cancel`；
5. 经过 `GuiPermissionGateway.authorize`；
6. 再次确认当前 session context、工具注册和参数 schema 没有在授权期间变化；
7. 以 progress event 和 `tool.invoked` event 回传执行状态。

这套 gate 是 GUI 工具执行的权限边界，不应被 `/gateway` Overlay 或外部 MCP 调用绕过。若未来需要让 GUI 调用 MCP，应该调用已注册的 `mcp` 工具并继续经过同一 permission gateway，而不是复制一份 MCP client。

## 7. 扩展约束

新增 Gateway 或 MCP 能力时遵循以下约束：

1. **先定归属**：Gateway workspace/session 控制操作放在 Gateway MCP 工具；外部服务能力放在 MCP adapter；模型直接可见的 Pi 原生能力不放入 `mcp`。
2. **保持单一代理默认值**：除非有明确高频、稳定 schema 的需求，不新增大量 direct tools。
3. **管理态/运行态分离**：需要显示停用服务器时使用完整管理配置；连接、注册和调用必须使用过滤后的运行时配置。
4. **所有长操作可取消**：传播 `AbortSignal`，连接获取使用 lease，session 重启时让旧 generation 失效。
5. **结构化错误优先**：返回稳定的 `details.error`/`mode`/`server` 字段，并给出下一步，而不是只拼接日志。
6. **结果统一过转换与输出守卫**：不要在新入口重复实现 MCP content 转换、structuredContent fallback 或大结果截断。
7. **权限不可旁路**：GUI 调用经过 permission gateway；OAuth/consent/sampling/elicitation 等交互必须由既有 MCP 管理路径处理。
8. **增加测试边界**：至少覆盖路由优先级、invalid args、disabled server、未认证、连接失败/重连、取消与 stale context，以及 Gateway 工具 envelope 的协议错误。

## 8. 关键源码索引

- `/gateway` 命令：`packages/pi-maestro-flow/src/extension/index.ts`
- Gateway Overlay：`packages/pi-maestro-flow/src/tui/mcpx-overlay.ts`
- Gateway MCP Streamable HTTP client：`packages/pi-maestro-flow/src/tui/mcpx-client.ts`
- Gateway 兼容桥：`packages/pi-maestro-flow/src/mcpx-bridge.ts`
- Gateway Board 工具：`packages/pi-maestro-flow/src/tools/gateway-board.ts`
- MCP adapter 与 `/mcp` 命令：`packages/pi-maestro-flow/src/mcp/index.ts`
- MCP 配置加载：`packages/pi-maestro-flow/src/mcp/config.ts`
- MCP 初始化与生命周期：`packages/pi-maestro-flow/src/mcp/init.ts`、`lifecycle.ts`
- 统一代理执行：`packages/pi-maestro-flow/src/mcp/proxy-modes.ts`
- direct tools：`packages/pi-maestro-flow/src/mcp/direct-tools.ts`
- MCP 内容转换：`packages/pi-maestro-flow/src/mcp/tool-registrar.ts`
- MCP 结果渲染：`packages/pi-maestro-flow/src/mcp/tool-result-renderer.ts`
- GUI/UCL 工具路由：`packages/pi-maestro-flow/src/gui/tool-routes.ts`

本文与用户侧操作文档的关系：MCP 基本操作见 `docs-site/src/content/docs/guides/mcp.md`；MCPX 暴露层见 `docs-site/src/content/docs/guides/mcpx.md`。本文补充两者在 `/gateway` 命令中的架构边界与实现约束。
