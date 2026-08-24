# Codex ACP 安装与 Teammate 注册（AI 可执行）

本文档面向 AI agent，将 Codex 通过 Agent Client Protocol（ACP）接入 teammate。当前 registry 快照固定使用 `codex-acp@1.6.2`，最终 route 是 `cli/codex`。

```text
teammate
  -> pi-maestro-teammate/v1/acp-cli
  -> codex-acp 1.6.2（ACP over stdio）
  -> Codex
```

## PURPOSE

完成以下安装和注册：

1. 安装或解析 registry 固定版本的 `codex-acp`
2. 注册 teammate backend `cli/codex`
3. 添加 `teammate-cli-tools.json` 目录投影
4. 用 ACP 探针确认 Codex 的真实 mode、模型和 reasoning 选项
5. 用 `read-only + plan` 做一次不修改工作区的最小 prompt 验证

成功标准：`model-availability` 能看到 `cli/codex`，ACP `initialize/session/new` 成功，最小 prompt 返回 READY，且工作区没有测试产生的修改。

## PREREQUISITES

- Node.js >= 22
- pi-maestro-teammate 已安装
- Codex CLI 已登录，或其认证方式已由用户配置
- npm 可访问 `@agentclientprotocol/codex-acp@1.6.2`
- 用户确认允许调用一次外部 Codex 模型

先执行：

```bash
node --version
codex --version
```

不要猜测 Codex 模型名。模型和配置项必须以 ACP `session/new` 的广告结果为准。

## 已验证结果

本流程已在 Windows 环境验证：

- adapter：`@agentclientprotocol/codex-acp@1.6.2`
- ACP 探针：成功
- 广告配置项：`mode`、`collaboration_mode`、`model`、`reasoning_effort`、`fast-mode`
- 测试模式：`mode=read-only`、`collaboration_mode=plan`
- 测试模型：`gpt-5.6-sol`
- prompt：`Reply with READY only. Do not edit files, run tools, or change the workspace.`
- 结果：`terminalStatus=completed`、`exitCode=0`、返回 `READY`
- 测试耗时：约 80.8 秒，首次 npx 启动应提高 `startupTimeoutMs`

已知模型选项以探针输出为准。本次探针返回：

```text
model: gpt-5.6-sol, gpt-5.6-terra, gpt-5.6-luna, gpt-5.5, gpt-5.2
reasoning_effort: low, medium, high, xhigh, max, ultra
mode: read-only, agent, agent-full-access
collaboration_mode: default, plan
fast-mode: off, on
```

## TASK

### 1. 选择安装方式

#### 方式 A：使用内置 ACP registry（推荐）

在 backend 配置中使用：

```json
{
  "acpAgent": "codex-acp",
  "acpInstall": "auto",
  "modelId": "cli/codex",
  "startupTimeoutMs": 120000
}
```

`acpInstall: "auto"` 使用仓库锁定的 registry 版本，并安装到：

```text
$PI_CODING_AGENT_DIR/acp-agents/codex-acp/1.6.2/
```

它不会修改用户的全局 npm 前缀。首次运行可能联网安装，因此 `startupTimeoutMs` 推荐至少 `120000`。

#### 方式 B：显式安装 adapter

```bash
npm install --global @agentclientprotocol/codex-acp@1.6.2
```

确认：

```bash
codex-acp
```

ACP server 通过 stdin/stdout 工作，不要把普通 Codex CLI 的交互终端输出当成 ACP 输出。

### 2. Windows 启动方式

teammate 的 ACP backend 使用 `shell: false`。Windows 下直接使用 npm 的 `npx.cmd` 或 `codex-acp.cmd` 可能出现 `spawn ENOENT/EINVAL`。

本次验证成功的显式启动方式是：

```json
{
  "command": "C:/Program Files/nodejs/node.exe",
  "args": [
    "C:/Program Files/nodejs/node_modules/npm/bin/npx-cli.js",
    "-y",
    "@agentclientprotocol/codex-acp@1.6.2"
  ]
}
```

安装到全局 npm 后，也可以让 `command` 指向真实的 Node 入口和 adapter `dist/index.js`，不要直接依赖 `.cmd` shim。路径必须由当前机器实际检查得到。

### 3. 注册 backend

在有效的 `teammate-backends.json` 中合并，不要覆盖已有 backend：

```json
{
  "mode": "backend-registry",
  "default": "pi-subprocess",
  "backends": {
    "codex": {
      "module": "pi-maestro-teammate/v1/acp-cli",
      "config": {
        "acpAgent": "codex-acp",
        "acpInstall": "auto",
        "modelId": "cli/codex",
        "startupTimeoutMs": 120000
      }
    }
  }
}
```

如果使用 Windows 显式 npx 启动方式，则不要同时填写 `acpAgent` 和 `args`，改为：

```json
{
  "codex": {
    "module": "pi-maestro-teammate/v1/acp-cli",
    "config": {
      "command": "C:/Program Files/nodejs/node.exe",
      "args": [
        "C:/Program Files/nodejs/node_modules/npm/bin/npx-cli.js",
        "-y",
        "@agentclientprotocol/codex-acp@1.6.2"
      ],
      "modelId": "cli/codex",
      "acpModel": "gpt-5.6-sol",
      "startupTimeoutMs": 120000
    }
  }
}
```

`acpModel` 只填 ACP 探针实际返回的值。`modelId` 是 teammate route，`acpModel` 是 Codex 内层模型，两者不能混用。

配置路径：

- 项目：`<cwd>/.pi/teammate-backends.json`
- 全局：`$PI_CODING_AGENT_DIR/teammate-backends.json`

项目文件一旦存在，就整份覆盖全局文件。写入前必须保留现有 `default`、`backends` 和未知字段。

如果现有文件是 `model-registry`，不要使用上面的 backend-registry 示例；使用 `pi-teammate-models add` 或 Connections/连接向导，并保留 v2 manifest、`models`、`defaultModel` 和 `compatibility`。

### 4. 添加目录投影

在相同作用域的 `teammate-cli-tools.json` 中合并：

```json
{
  "version": "1",
  "tools": {
    "codex": {
      "enabled": true,
      "mode": "local",
      "command": "codex-acp"
    }
  }
}
```

若使用 Windows 显式 npx 方式，目录投影也使用实际可探测的 Node 命令：

```json
{
  "codex": {
    "enabled": true,
    "mode": "local",
    "command": "C:/Program Files/nodejs/node.exe",
    "args": [
      "C:/Program Files/nodejs/node_modules/npm/bin/npx-cli.js",
      "-y",
      "@agentclientprotocol/codex-acp@1.6.2"
    ]
  }
}
```

- tools key 必须是 `codex`
- backend route 必须是 `cli/codex`
- `teammate-cli-tools.json` 只决定目录显示，不是启动权威
- 不要在 `env` 中写入 API key 或 `NAME=value`
- `model-registry` 模式还必须确认 `compatibility.teammateCliToolsProjection.enabled: true`

### 5. ACP 探针

先只执行 `initialize/session/new`，不要发送 prompt。预期返回：

- protocol version 1
- Codex ACP agent 信息
- `mode`、`collaboration_mode`、`model`、`reasoning_effort`、`fast-mode`

探针失败时不要直接运行 prompt，先区分：Node/npx 路径、adapter 安装、Codex 登录、ACP startup timeout。

### 6. reload 和最小验证

保存配置后 reload extension 或重启 Pi：

```bash
pi-teammate-models path
pi-teammate-models list
```

在 Pi 中检查 `model-availability`，确认出现：

```text
cli/codex
```

然后使用只读、计划模式做最小验证：

```javascript
teammate({
  tasks: [{
    model: "cli/codex",
    prompt: "Reply with READY only. Do not edit files, run tools, or change the workspace."
  }]
})
```

预期：

- `terminalStatus=completed`
- `exitCode=0`
- `selectedModel` 与 ACP 探针选择一致
- 返回 `READY`
- 工作区没有新增修改

## INTERACTIVE INPUTS

1. **安装方式**（`ctx.ui.select`）：registry `acpInstall:auto` / 全局 npm / Windows 显式 Node+npx
2. **Codex adapter 版本**（`ctx.ui.input`）：默认显示 registry 锁定的 `1.6.2`，变更版本必须由用户确认
3. **配置作用域**（`ctx.ui.select`）：项目 `.pi` / 全局 agent 目录
4. **ACP model**（`ctx.ui.select`）：只显示 `session/new` 实际返回的模型
5. **mode**（`ctx.ui.select`）：`read-only` / `agent` / `agent-full-access`
6. **collaboration mode**（`ctx.ui.select`）：`default` / `plan`
7. **reasoning effort**（`ctx.ui.select`）：只显示探针返回的值
8. **fast mode**（`ctx.ui.select`）：`off` / `on`
9. **写入确认**（`ctx.ui.confirm`）：展示 backend path、route、adapter version、model 和 command 后确认
10. **真实 prompt 确认**（`ctx.ui.confirm`）：明确会调用一次外部 Codex，但禁止编辑文件和运行工具

## VERIFY

```bash
node --version
codex --version
pi-teammate-models path
pi-teammate-models list
```

然后在 Pi 中检查 `model-availability` 并运行一次 `model: "cli/codex"` 的只读 prompt。

故障区分：

- `spawn npx ENOENT`：Windows `shell:false` 无法启动 npx shim，改用 `node.exe + npx-cli.js`
- `initialize` 超时：提高 `startupTimeoutMs` 或检查 adapter 下载
- `session/new` 认证失败：完成 Codex 登录后重试
- prompt 前模型错误：使用 ACP 广告的 model value
- `cli/codex` 不在目录：检查 teammate-cli-tools 同名 key、`enabled` 和 model-registry compatibility

## ROLLBACK

- 删除 `teammate-backends.json` 中新增的 `codex` backend，保留其他注册
- 删除 `teammate-cli-tools.json` 中的 `codex` 条目
- 删除 `$PI_CODING_AGENT_DIR/acp-agents/codex-acp/1.6.2/`，或卸载本次全局安装的 adapter
- 不要删除 Codex 本体或认证文件，除非用户明确要求
