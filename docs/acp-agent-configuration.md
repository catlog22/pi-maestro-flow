# ACP Agent 通用配置

本文档参考 [ACP Agents 入门](https://agentclientprotocol.com/get-started/agents)，说明如何把支持 Agent Client Protocol（ACP）的外部 agent 接入 teammate。

适用对象：

- 已经实现 ACP 的 CLI agent
- 自己编译的 ACP server
- 通过 npx、uvx 或其他 launcher 启动的 ACP agent
- 需要在 teammate 中注册为 `cli/<tool>` 的外部执行体

本文只描述通用配置契约，不包含任何特定机器的 endpoint、API key、模型或认证状态。

## 1. ACP 的运行方式

ACP agent 通常由 client 启动为一个子进程，通过 stdin/stdout 使用 JSON-RPC 通信：

```text
ACP client
  -> spawn(command, args, cwd, env)
  -> agent ACP server
  <- JSON-RPC responses and notifications over stdio
```

基本要求：

- agent 的 stdout 只能输出 ACP JSON-RPC 数据
- 普通日志写到 stderr
- client 负责启动和关闭进程
- session 生命周期由 ACP 方法管理，不要把普通 CLI 文本输出当作 ACP 响应
- `cwd`、环境变量和权限边界由 client 或宿主负责提供

ACP 启动配置与 ACP wire schema 是两个层次：启动配置告诉 client 如何找到进程，ACP 方法定义进程启动后的交互。

## 2. 通用启动配置

一个通用的 ACP agent 至少需要：

```json
{
  "command": "/absolute/path/to/agent",
  "args": ["--acp"],
  "cwd": "/absolute/path/to/workspace",
  "env": ["AGENT_API_KEY"]
}
```

字段含义：

| 字段 | 说明 |
|---|---|
| `command` | 可执行文件、脚本或 launcher 的路径 |
| `args` | 传给 launcher 的固定参数，通常包含 ACP 模式参数 |
| `cwd` | agent 启动时的工作目录 |
| `env` | 允许透传的环境变量名；不是 `NAME=value` 数组 |
| `mode` | `local` 或 `ssh`，由宿主的 transport 决定 |
| `host` / `user` | SSH transport 的目标信息 |
| `hostKeySha256` | SSH 主机指纹固定值，可选但建议使用 |

配置中只写变量名，不写凭证值：

```json
{
  "env": ["ANTHROPIC_AUTH_TOKEN", "OPENAI_API_KEY"]
}
```

凭证值应由启动 agent 的父进程、操作系统环境、凭证管理器或 agent 自己的登录流程提供。不要把 key、token、密码或私钥内容写入提交到仓库的 JSON。

## 3. ACP 会话生命周期

一个 ACP client 至少应验证以下流程。

### 3.1 `initialize`

client 与 agent 协商协议版本和能力：

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "initialize",
  "params": {
    "protocolVersion": 1,
    "clientInfo": {
      "name": "example-client",
      "version": "1.0.0"
    },
    "clientCapabilities": {}
  }
}
```

需要检查：

- 返回的 `protocolVersion` 是否兼容
- agent 是否报告 `loadSession`、`prompt`、`image`、`mcp` 等能力
- 错误是否明确区分启动失败、版本不兼容和认证失败

### 3.2 `session/new`

创建一个新会话：

```json
{
  "jsonrpc": "2.0",
  "id": 2,
  "method": "session/new",
  "params": {
    "cwd": "/absolute/path/to/workspace",
    "mcpServers": []
  }
}
```

返回值通常包含：

- `sessionId`
- `configOptions`
- `modes`
- agent 可用的模型、权限和推理配置

模型值必须以这个响应为准。宿主配置中的 `acpModel` 不应凭空猜测，也不应把另一个 provider 的模型 id 强行写进去。

### 3.3 配置选项

如果 agent 返回 `configOptions`，client 可以通过 `session/set_config_option` 选择模型、权限模式或推理等级。

例如，agent 可能报告：

```json
{
  "id": "model",
  "category": "model",
  "type": "select",
  "options": [
    { "value": "model-a", "name": "Model A" },
    { "value": "model-b", "name": "Model B" }
  ]
}
```

宿主应只选择 agent 广告过的值。未广告的模型必须在 prompt 前拒绝，而不是静默回落到另一个模型。

### 3.4 `session/prompt`

发送用户回合：

```json
{
  "jsonrpc": "2.0",
  "id": 3,
  "method": "session/prompt",
  "params": {
    "sessionId": "<session-id>",
    "prompt": [
      {
        "type": "text",
        "text": "Reply with READY only."
      }
    ]
  }
}
```

回合期间 agent 通过 `session/update` 发送文本、工具调用、状态和资源更新；回合结束时返回 `stopReason`。client 必须同时处理：

- 增量文本
- 工具调用和工具结果
- 权限请求
- 终端输出
- 认证或 provider 错误
- 取消和进程退出

## 4. Teammate backend 注册

当前项目使用通用 ACP backend：

```text
pi-maestro-teammate/v1/acp-cli
```

它负责把 teammate 的运行请求转换为 ACP client 行为。一个外部 CLI 一条 registration：

```json
{
  "mode": "backend-registry",
  "default": "pi-subprocess",
  "backends": {
    "my-agent": {
      "module": "pi-maestro-teammate/v1/acp-cli",
      "config": {
        "command": "/absolute/path/to/agent",
        "args": ["--acp"],
        "modelId": "cli/my-agent",
        "acpModel": "<session/new 广告的模型值>",
        "startupTimeoutMs": 30000,
        "runTimeoutMs": 900000
      }
    }
  }
}
```

主要字段：

| 字段 | 作用 |
|---|---|
| `module` | 选择通用 ACP backend |
| `modelId` | teammate route，例如 `cli/my-agent` |
| `acpModel` | agent 内层模型，必须来自 `session/new` |
| `startupTimeoutMs` | `initialize` + `session/new` 的握手上限 |
| `runTimeoutMs` | 单条 registration 的回合运行上限 |
| `cwd` | agent 工作目录 |
| `env` | 允许父进程透传的变量名 |
| `mode` | `local` 或 `ssh` |

`modelId` 和 `acpModel` 是两个不同的轴：

- `modelId` 决定 teammate 把任务交给哪个 CLI
- `acpModel` 决定这个 CLI 内部使用哪个模型

任务使用 `model: "cli/my-agent"` 时，backend 会应用注册项的 `acpModel`。如果任务明确指定了 agent 广告的其他模型值，则使用任务值。

### 4.1 使用 ACP registry 快照

仓库维护了一份版本固定的 ACP registry 快照。对于快照中存在的 agent，可以使用：

```json
{
  "my-agent": {
    "module": "pi-maestro-teammate/v1/acp-cli",
    "config": {
      "acpAgent": "<registry agent id>",
      "acpInstall": "auto",
      "modelId": "cli/my-agent",
      "startupTimeoutMs": 120000
    }
  }
}
```

规则：

- `acpAgent` 提供 registry 中固定的启动方式和版本
- `acpInstall: "auto"` 可以把 npx agent 安装到 Pi agent 目录
- `acpAgent` 与手写 `args` 不能同时使用
- 如果指定了自定义 `command`，它必须是实际 launcher，而不是内层 agent 二进制
- 第一次 npx/安装启动通常需要更高的 `startupTimeoutMs`

### 4.2 自定义 agent

不在 registry 快照中的 agent 直接填写 `command` 和 `args`：

```json
{
  "my-custom-agent": {
    "module": "pi-maestro-teammate/v1/acp-cli",
    "config": {
      "command": "/opt/my-agent/bin/my-agent-acp",
      "args": [],
      "modelId": "cli/my-custom-agent"
    }
  }
}
```

自定义 agent 必须先单独验证 ACP `initialize/session/new`，再加入 teammate registration。

## 5. CLI 目录投影

backend registration 决定 agent 能否运行。为了让 route 出现在 teammate 模型目录，还需要配置 `teammate-cli-tools.json`：

```json
{
  "version": "1",
  "tools": {
    "my-agent": {
      "enabled": true,
      "mode": "local",
      "command": "/absolute/path/to/agent",
      "args": ["--acp"]
    }
  }
}
```

两份文件的职责不同：

| 文件 | 作用 |
|---|---|
| `teammate-backends.json` | 启动权威，决定 route 能否运行 |
| `teammate-cli-tools.json` | 目录输入，决定 route 是否显示 |

有目录条目但没有 backend 时，route 可能显示但派发会拒绝；有 backend 但没有目录条目时，按名字可能可运行但不会出现在目录。

路径优先级：

- 项目：`<cwd>/.pi/teammate-backends.json`
- 全局：`$PI_CODING_AGENT_DIR/teammate-backends.json`
- 项目 backend 文件存在时整份覆盖全局 backend 文件
- CLI tools 条目按工具名进行项目覆盖全局

如果启用了 model-registry 的 CLI compatibility projection，还必须显式启用 teammate CLI tools 投影。具体字段以当前 registry 配置契约为准。

## 6. Windows 和 launcher

ACP backend 使用 `shell: false`。Windows 上不要假设以下 shell 行为成立：

- `npx` 自动解析到 `npx.cmd`
- `codex-acp` 自动解析到 `codex-acp.cmd`
- Git Bash PATH 会自动出现在 Windows PTY 的 PATH 中

需要时使用 Node 直接调用 npm 的 JavaScript 入口：

```json
{
  "command": "C:/Program Files/nodejs/node.exe",
  "args": [
    "C:/Program Files/nodejs/node_modules/npm/bin/npx-cli.js",
    "-y",
    "<package>@<version>"
  ]
}
```

或者使用一个只设置环境变量并转发 stdio 的 `.mjs` launcher。launcher 不应注入提示词、修改 ACP 消息或把凭证写入文件。

## 7. 验证顺序

推荐按最小边界逐级验证：

1. 检查 `command` 和 `args` 能启动进程
2. 发送 `initialize`
3. 发送 `session/new`
4. 读取并保存 `configOptions`
5. 选择一个 agent 广告的模型或模式
6. 发送禁止修改文件的最小 `session/prompt`
7. 验证 `session/update` 和最终 stop reason
8. 再执行真实 teammate 任务

ACP handshake 成功不代表 provider 可用。`initialize/session/new` 只证明 agent server 能启动；真实 prompt 还需要 agent 自己的 provider、认证和模型权限。

## 8. 常见故障

| 现象 | 优先检查 |
|---|---|
| `spawn ... ENOENT` | command 是否真实存在；Windows 是否需要 Node launcher |
| `spawn ... EINVAL` | 是否直接执行了 `.cmd` shim；改用 Node 入口 |
| `ACP initialize timed out` | agent 下载、Node、网络和启动参数；提高 startup timeout |
| `session/new` 超时 | agent provider 初始化、认证和工作目录 |
| 模型在 prompt 前被拒绝 | 模型值不是 `session/new` 广告值 |
| 目录中没有 `cli/<tool>` | teammate-cli-tools 条目、`enabled` 和可达性 |
| prompt 返回 provider 错误 | ACP agent 自身的 endpoint、认证和模型权限 |
| stdout 出现普通日志 | agent 没有遵守 ACP stdio framing；日志必须转到 stderr |

## 9. 安全边界

- 只启动用户确认过的 command 或固定版本 launcher
- 对 npx/uvx 包固定版本，避免每次运行解析到未知版本
- `env` 只列变量名，不写值
- 不把 API key、OAuth token、密码或私钥提交到注册 JSON
- 不使用 shell 拼接用户输入
- SSH 模式固定 host、user 和 host key；不要依赖交互式密码提示
- 测试 prompt 使用 `read-only` 或 `plan` 模式，并明确禁止文件和工具操作

## 参考

- [ACP Agents 入门](https://agentclientprotocol.com/get-started/agents)
- [ACP Session Setup](https://agentclientprotocol.com/protocol/v1/session-setup)
- [Teammate Backend 适配器契约](teammate-backend-adapter-contract.md)
- [执行后端与外部 MCP 配置](backend-and-mcp-configuration.md)
