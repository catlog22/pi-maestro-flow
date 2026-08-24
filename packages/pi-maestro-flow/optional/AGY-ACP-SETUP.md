# agy-acp 安装与 Teammate 注册（AI 可执行）

本文档面向 AI agent，把 Google Antigravity CLI（`agy`）通过 `shindgew/agy-acp` 接入 teammate。最终 route 是 `cli/agy`，通信链路为：

```text
teammate
  -> pi-maestro-teammate/v1/acp-cli
  -> agy-acp（ACP over stdio）
  -> agy（Google Antigravity CLI）
```

`agy` 本身的 `stream-json` 是另一套 CLI 私有协议。本流程使用 ACP bridge，不把 `agy` 直接伪装成 ACP server。

## PURPOSE

完成以下安装和注册：

1. 确认本机 `agy` 已安装并可认证
2. 安装并验证 `agy-acp` bridge
3. 在 Windows 上固定 `AGY_BIN`，避免 teammate 的 `shell: false` 看不到 Git Bash PATH
4. 注册 teammate backend `cli/agy`
5. 添加 `teammate-cli-tools.json` 目录投影
6. 通过 ACP 探针和一次禁止修改文件的 teammate prompt 验证

成功标准：`model-availability` 能看到 `cli/agy`，ACP `initialize/session/new` 成功，最小 prompt 正常返回，且工作区没有被测试 prompt 修改。

## PREREQUISITES

- Node.js >= 22
- `agy` 已安装并能在当前 shell 中运行
- 已完成 `agy` 登录或配置 API key
- pi-maestro-teammate 已安装
- npm 可访问 `agy-acp` 包，或用户明确要求从 GitHub 源码构建
- 用户接受第三方 ACP bridge 访问 Antigravity 的服务条款风险。Google 可能限制第三方客户端访问，优先使用测试账号或用户明确认可的凭证

先执行只读检查：

```bash
agy --version
agy models
node --version
```

不得猜测 `agy` 路径、模型名或认证方式。若任一检查失败，先报告前置条件缺失。

## 安装来源

### 推荐：npm 固定版本

```bash
npm install --global agy-acp@0.5.2
```

安装后确认 bridge 包入口：

```bash
npm root --global
```

将全局 npm root 下的：

```text
agy-acp/dist/main.js
```

作为 bridge 入口。不要把临时 Git clone 目录写入持久 teammate 配置。

### 源码构建：仅用户明确选择时使用

```bash
git clone --depth 1 https://github.com/shindgew/agy-acp.git <临时目录>
cd <临时目录>
pnpm install --frozen-lockfile
pnpm run build
```

构建成功后使用 `dist/main.js`。源码构建目录应放在临时目录或用户明确指定的持久目录，不要复制进 pi-maestro-flow 仓库。

## Windows 启动注意事项

teammate 的 ACP backend 使用 `shell: false` 启动子进程。Windows 下直接把 npm 的：

```text
agy-acp.cmd
```

写入 `command` 可能导致 `spawn EINVAL`；而 Git Bash 中能运行的 `agy` 也可能无法被 Windows PTY 找到，bridge 会返回：

```text
Internal error
File not found:
```

稳定方式是使用 `node.exe` 启动 bridge，并通过 launcher 设置 `AGY_BIN` 的绝对路径。launcher 只转发 stdio，不注入 prompt：

```js
import { spawn } from "node:child_process";

const bridge = process.env.PI_AGY_ACP_BRIDGE;
const agy = process.env.PI_AGY_BIN;
if (!bridge || !agy) throw new Error("PI_AGY_ACP_BRIDGE and PI_AGY_BIN are required");

const child = spawn(process.execPath, [bridge, ...process.argv.slice(2)], {
  cwd: process.cwd(),
  env: { ...process.env, AGY_BIN: agy },
  stdio: "inherit",
  windowsHide: true,
});
child.on("error", (error) => {
  console.error(`[agy-acp-launcher] ${error.message}`);
  process.exitCode = 1;
});
child.on("exit", (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  else process.exitCode = code ?? 1;
});
```

实际写入 launcher 时，用 `ctx.ui` 收集并通过环境变量传入：

- `PI_AGY_ACP_BRIDGE`：绝对 bridge 入口，例如 `<global npm root>/agy-acp/dist/main.js`
- `PI_AGY_BIN`：绝对 `agy.exe` 路径，例如 `C:/Users/<user>/AppData/Local/agy/bin/agy.exe`

不要把 API key、OAuth token 或私钥写入 launcher 或 JSON 配置。

## TASK

### 1. 交互式确认安装参数

使用 `INTERACTIVE INPUTS` 收集：

- `agy` 可执行文件绝对路径
- bridge 来源和版本
- bridge 入口绝对路径
- teammate 配置作用域：项目或全局
- ACP 广告的模型、mode 和 reasoning 选项
- 是否允许执行一次无文件修改 prompt

所有路径和模型值必须来自用户输入、探针输出或实际文件，不得臆造。

### 2. 创建 launcher

在用户 agent 目录下写入 launcher，例如：

```text
$PI_CODING_AGENT_DIR/agy-acp-launcher.mjs
```

默认 agent 目录是：

```text
~/.pi/agent/
```

Windows 下优先使用 `process.execPath`，不要把 npm `.cmd` shim 作为 ACP backend 的直接 command。

### 3. 运行 ACP 探针

启动 bridge 后完成：

```text
initialize
session/new
```

探针不发送 prompt，不消耗模型回合。预期能看到：

- ACP protocol version 1
- agent name `agy-acp`
- `mode` 配置选项
- `model` 配置选项
- `reasoningEffort` 或等价思考配置选项

把探针实际返回的 model value 作为 `acpModel`，不要把 `agy models` 的 slug 与 bridge 广告的 display value 混用。

### 4. 注册 backend

在有效的 `teammate-backends.json` 中合并，不覆盖已有 backend：

```json
{
  "mode": "backend-registry",
  "default": "pi-subprocess",
  "backends": {
    "agy": {
      "module": "pi-maestro-teammate/v1/acp-cli",
      "config": {
        "command": "<node.exe 绝对路径>",
        "args": ["<agy-acp-launcher.mjs 绝对路径>"],
        "modelId": "cli/agy",
        "acpModel": "<ACP 探针返回的 model value>",
        "startupTimeoutMs": 30000
      }
    }
  }
}
```

路径选择：

- 项目：`<cwd>/.pi/teammate-backends.json`
- 全局：`$PI_CODING_AGENT_DIR/teammate-backends.json`

项目文件一旦存在，就整份覆盖全局文件。必须先读取并保留现有 `default`、`backends` 和未知字段。

如果现有文件是 `model-registry`，不要套用上面的 legacy/backend-registry 示例；使用 `pi-teammate-models add` 或 Connections/连接向导，并保留 v2 manifest、`models`、`defaultModel` 和 `compatibility`。

### 5. 注册目录投影

在相同作用域的 `teammate-cli-tools.json` 中合并：

```json
{
  "version": "1",
  "tools": {
    "agy": {
      "enabled": true,
      "mode": "local",
      "command": "<node.exe 绝对路径>",
      "args": ["<agy-acp-launcher.mjs 绝对路径>"]
    }
  }
}
```

- backend 的 route 必须是 `cli/agy`
- tools key 必须是 `agy`
- `teammate-cli-tools.json` 只负责目录显示，不是启动权威
- 不要在 `env` 中写 `AGY_BIN=<path>`；launcher 负责设置它
- `model-registry` 模式还要确认 `compatibility.teammateCliToolsProjection.enabled: true`

### 6. reload 和验证

保存配置后 reload extension 或重启 Pi，然后运行：

```bash
pi-teammate-models path
pi-teammate-models list
```

在当前 Pi 会话调用 `model-availability`，预期：

```text
cli/agy
```

最后执行一次最小 prompt：

```javascript
teammate({
  tasks: [{
    model: "cli/agy",
    prompt: "Reply with READY only. Do not edit files, run tools, or change the workspace."
  }]
})
```

确认结果包含：

- terminal status 为 completed
- exit code 为 0
- resolved/selected model 与 ACP 探针选择一致
- 返回内容为 READY 或用户指定的短响应
- `git status` 没有测试 prompt 造成的工作区修改

## INTERACTIVE INPUTS

1. **agy 路径**（`ctx.ui.input`）：`agy` 或绝对 `agy.exe` 路径；先用 `agy --version` 验证
2. **bridge 来源**（`ctx.ui.select`）：npm `agy-acp@0.5.2` / GitHub 源码构建 / 已有 bridge
3. **bridge 入口**（`ctx.ui.input`）：绝对 `dist/main.js` 路径
4. **配置作用域**（`ctx.ui.select`）：项目 `.pi` / 全局 agent 目录
5. **ACP model**（`ctx.ui.select`）：只显示 `session/new` 探针返回的选项
6. **ACP mode**（`ctx.ui.select`）：只显示探针返回的 mode 选项；默认 mode 不得臆造
7. **reasoning effort**（`ctx.ui.select`）：只显示探针返回的选项
8. **写入确认**（`ctx.ui.confirm`）：展示 backend path、route、bridge path 和 agy path 后确认
9. **最小 prompt 确认**（`ctx.ui.confirm`）：明确该步骤会调用一次外部模型，但不编辑文件、不运行工具

## VERIFY

最小检查：

```bash
agy --version
agy models
pi-teammate-models list
```

Pi 会话中检查 `model-availability` 和一次 `model: "cli/agy"` 的无副作用 teammate prompt。

故障区分：

- `initialize` 失败：bridge 入口、Node 或 ACP 进程启动问题
- `session/new` 失败：agy 认证、工作目录或 bridge 初始化问题
- `session/prompt` 返回 `File not found`：优先检查 Windows `AGY_BIN` 绝对路径和 launcher
- `session/prompt` 返回模型错误：检查 ACP 探针广告的 model value，不要直接替换成 `agy models` slug
- `cli/agy` 不在目录：检查同名 `teammate-cli-tools.json`、`enabled` 和 model-registry compatibility 投影

## ROLLBACK

- 删除 `teammate-backends.json` 中本次新增的 `agy` backend，保留其他注册
- 删除 `teammate-cli-tools.json` 中的 `agy` 条目，保留其他工具
- 删除 `$PI_CODING_AGENT_DIR/agy-acp-launcher.mjs`
- 仅当本次安装的 bridge 不再被其他配置使用时，执行 `npm uninstall --global agy-acp`
- 保留 `agy` 本体和其认证状态，除非用户明确要求卸载
