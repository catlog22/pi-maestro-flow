# Teammate 外部 CLI 注册（AI 可执行）

本文档面向 AI agent，注册一个通过 Agent Client Protocol（ACP）运行的外部 CLI，使 teammate 能以 `cli/<tool>` 路由调度它。

这条路径与 Maestro Flow 的 `~/.maestro/cli-tools.json` 独立。teammate 至少涉及两份配置：backend 注册决定 CLI 能否运行，`teammate-cli-tools.json` 决定它是否出现在兼容模型目录中。两份不能互相替代。

## PURPOSE

完成以下配置并验证：

1. 在 `.pi/teammate-backends.json` 或全局 agent 目录的 `teammate-backends.json` 注册外部 CLI backend
2. 配置 `cli/<tool>` 路由、命令、ACP 参数和可选的 SSH 连接
3. 在 `teammate-cli-tools.json` 添加目录投影，使 CLI 出现在模型可用性结果中
4. 在需要时打开 model-registry 的 CLI 兼容投影
5. 使用 `pi-teammate-models list` 和 `model-availability` 验证注册、可解析性和可用性

成功标准：backend 注册与 CLI 目录投影指向同一个工具名，`cli/<tool>` 可被识别；实际派发前由模型可用性检查确认命令或远端目标可达。

## PREREQUISITES

- `pi-maestro-teammate` 已安装，且 `pi-teammate-models` 命令可用
- 一个实际支持 ACP 的外部 CLI 或 ACP adapter
- 用户知道该 CLI 的启动命令、ACP 参数和可选的内层模型名
- 本地模式下命令在 PATH 中，或用户能提供绝对路径；SSH 模式下用户有无交互认证的 SSH key/agent
- 不把 API key、密码或私钥内容写进 JSON；`env` 只记录允许透传的变量名

已知 adapter 的安装命令仅供用户确认，不得替用户臆测：

| 命令 | npm 包 |
|---|---|
| `codex-acp` | `@agentclientprotocol/codex-acp` |
| `claude-agent-acp` | `@agentclientprotocol/claude-agent-acp` |

## 两份配置的职责

| 配置 | 决定什么 | 默认位置 |
|---|---|---|
| `teammate-backends.json` | backend 是否能启动，以及命令和传输配置 | 项目 `.pi/teammate-backends.json`；全局 `$PI_CODING_AGENT_DIR/teammate-backends.json` |
| `teammate-cli-tools.json` | `cli/<tool>` 是否进入兼容模型目录 | 项目 `.pi/teammate-cli-tools.json`；全局 `$PI_CODING_AGENT_DIR/teammate-cli-tools.json` |

项目 backend 文件一旦存在，就整份优先于全局文件，不会逐字段合并。CLI tools 文件按工具名合并，项目条目覆盖同名全局条目。

`teammate-cli-tools.json` 有条目但没有 backend 注册时，工具可能出现在目录中但派发会被拒绝；有 backend 注册但没有 CLI tools 条目时，可以按名字运行但不会出现在兼容目录中。

## TASK

### 1. 检查当前注册模式

先运行：

```bash
pi-teammate-models path
pi-teammate-models list
```

记录实际生效的文件路径和模式：

- `legacy`：注册表未启用，不能派发 `cli/<tool>`
- `backend-registry`：可以注册 backend，适合兼容旧配置
- `model-registry`：必须保留 v2 的 `models`、`defaultModel`、部署拓扑和 `compatibility`，优先使用 `pi-teammate-models add`

如果现有文件是 `model-registry`，不要用下面的 legacy/backend-registry 示例覆盖它。使用 `pi-teammate-models add` 或 Control Center 的 Connections/连接向导，让整份 manifest 通过同一个 parser 校验。

### 2. 注册 backend

推荐使用官方向导：

```bash
pi-teammate-models add
```

向导按 backend family、local/ssh 传输、部署 id、配置字段和模型注册逐步收集输入，写入前会编译整份 manifest，并保留 `.bak` / `.bak.1` 备份。

对于明确处于 `backend-registry` 的配置，手写结构可参考以下最小示例。不要直接覆盖已有 `backends`：

```json
{
  "mode": "backend-registry",
  "default": "pi-subprocess",
  "backends": {
    "my-cli": {
      "module": "pi-maestro-teammate/v1/acp-cli",
      "config": {
        "command": "<用户提供的命令>",
        "args": ["<ACP 参数>"],
        "modelId": "cli/my-cli"
      }
    }
  }
}
```

ACP-CLI 常用字段：

- `command`：可执行文件或绝对路径
- `args`：进入 ACP 模式的参数，例如 `--acp`；不要把 runner 的安装参数误传给已安装的可执行文件
- `modelId`：该注册服务的 route，通常是 `cli/<tool>`；缺省时由注册名派生
- `acpAgent`：使用仓库内 ACP registry 快照时可代替 `command`/`args`，但不要与 `args` 同时填写
- `acpModel`：CLI 内层模型，只有用户或 CLI 目录确认后才能写
- `runTimeoutMs` / `startupTimeoutMs`：运行和 ACP 握手超时
- `cwd`：工作目录
- `env`：只写允许从父进程透传的变量名，不写 `NAME=value`

Windows 的 `acp-cli` 使用 `shell: false` 启动子进程，不能可靠执行 npm 的 `.cmd` shim，也可能看不到 Git Bash 的 PATH。若 CLI 只在 shell 中可见，应使用 `node.exe + bridge/dist/main.js` 或一个设置绝对 `AGY_BIN` 后转发 stdio 的 launcher；不要直接把 `agy-acp.cmd` 写入 `command`。

SSH 模式还需要用户提供并校验：`mode: "ssh"`、`host`、`user`、`hostKeySha256`，可选 `port` 和 `identityFile`。SSH 启动使用 BatchMode，不会等待密码提示。

### 3. 添加 CLI 目录投影

选择与 backend 相同的作用域，在对应的 `teammate-cli-tools.json` 中合并工具条目：

```json
{
  "version": "1",
  "tools": {
    "my-cli": {
      "enabled": true,
      "mode": "local",
      "command": "<同一个 CLI 命令>",
      "args": ["<同一个 ACP 参数>"],
      "env": ["<允许透传的变量名>"]
    }
  }
}
```

- `tools` 的 key 必须与 backend 的 `cli/<tool>` 中的 `<tool>` 完全一致
- 本地工具会探测命令是否在 PATH；SSH 工具要求 `host`、`user`、`hostKeySha256` 完整
- `enabled: false` 只影响目录显示，不会撤销一个已经注册的 backend
- 外部 CLI 自己管理的 credential 不写进这里

使用 Node JSON API 合并写入，不能用字符串替换：

```bash
node -e '
const fs=require("fs"),p=require("path");
const file=process.env.PI_TEAMMATE_TOOLS_FILE;
const name=process.env.PI_TEAMMATE_TOOL;
const entry=JSON.parse(process.env.PI_TEAMMATE_TOOL_ENTRY);
const cfg=fs.existsSync(file)?JSON.parse(fs.readFileSync(file,"utf8")):{};
cfg.version=typeof cfg.version==="string"?cfg.version:"1";
cfg.tools=cfg.tools&&typeof cfg.tools==="object"&&!Array.isArray(cfg.tools)?cfg.tools:{};
cfg.tools[name]={...(cfg.tools[name]||{}),...entry};
fs.mkdirSync(p.dirname(file),{recursive:true});
fs.writeFileSync(file,JSON.stringify(cfg,null,2)+"\\n");
console.log("wrote",file);
'
```

### 4. 处理 model-registry 兼容投影

只有当实际 backend 文件的 `mode` 是 `model-registry` 时，才在同一份文件的 `compatibility` 中确认：

```json
{
  "compatibility": {
    "version": 1,
    "teammateCliToolsProjection": {
      "enabled": true
    }
  }
}
```

该开关只允许 `teammate-cli-tools.json` 提供目录投影，不会让它重新成为启动权威。一个启用的工具必须恰好对应一个 ACP deployment 的 `cli/<tool>` route。

### 5. 重新加载并验证

保存后 reload extensions 或重启 Pi。先运行：

```bash
pi-teammate-models path
pi-teammate-models list
```

然后在当前 Pi 会话调用 `model-availability`，检查：

- `delegate_tools` 中出现该工具且状态为 `ok`
- model-registry 模式下，目标注册的 `registered`、`resolvable`、`sessionAvailable`、`healthy` 状态符合预期
- 兼容目录中出现 `cli/<tool>`，或明确记录为什么只存在 backend 而未进入目录

最后只做一次最小 teammate 派发验证，使用 `cli/<tool>` 或向导生成的 canonical model registration id。提示词必须要求不修改文件，并报告实际 `executorModel`。

## INTERACTIVE INPUTS

使用 `ctx.ui` 询问以下输入，不得臆测：

1. **作用域**（`ctx.ui.select`）：项目 `.pi` / 全局 agent 目录
2. **已有模式**（`ctx.ui.select`）：无文件、`backend-registry`、`model-registry`；如果读取结果与用户选择不一致，以实际文件为准
3. **工具名和部署 id**（`ctx.ui.input`）：工具名用于 `cli/<tool>`，部署 id 必须唯一
4. **传输方式**（`ctx.ui.select`）：local / ssh
5. **CLI 命令和 ACP 参数**（`ctx.ui.input`）：命令、args、可选 cwd；不能猜测
6. **内层模型**（`ctx.ui.input`）：若 CLI 支持 `acpModel`，由用户提供或从 CLI 目录中确认；可为空时不要强行写入
7. **SSH 字段**（仅 ssh，逐项 `ctx.ui.input`）：host、user、port、hostKeySha256、identityFile
8. **环境变量名**（`ctx.ui.input`）：只收集变量名列表，不收集或回显变量值
9. **是否启用 CLI 目录投影**（`ctx.ui.confirm`）：通常与实际可选模型目录需求一致；model-registry 还必须写 compatibility 开关
10. **写入确认**（`ctx.ui.confirm`）：展示路径、模式、部署名、route 和命令摘要后确认

如果已有配置文件，先展示将修改的注册项和保留的未知字段。不要把全局文件与项目文件合并成一个不存在的虚拟配置。

## VERIFY

预期命令：

```bash
pi-teammate-models list
```

应能看到目标 registration、deployment 和 route；若命令输出不可用状态，按其 `registered`、`resolvable`、`healthy` 诊断修复，不要绕过 parser。

当前 Pi 会话中的 `model-availability` 应显示无密钥的注册身份和工具可达性。实际派发失败时，区分 backend 未注册、命令不可达、ACP 握手超时、内层模型不在 CLI 目录和外部 CLI 自身认证失败。

## ROLLBACK

- 优先使用 `pi-teammate-models` 写入产生的 `.bak` 恢复上一份注册文档
- 删除 backend 注册项和同名 `teammate-cli-tools.json` 条目时，保留其他工具、未知字段和 model-registry 拓扑
- 若项目文件只是为了覆盖全局工具，删除项目覆盖条目后再重新运行 `pi-teammate-models list`
- 不要只删除 `teammate-cli-tools.json` 来假装注销 backend；启动权威在 `teammate-backends.json`
