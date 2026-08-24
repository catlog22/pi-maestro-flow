# Maestro Flow 外部 CLI 注册（AI 可执行）

本文档面向 AI agent，配置 Maestro Flow 的外部 CLI endpoint。它服务于 `maestro` 的 `delegate`、`explore` 和 `moa`，配置文件是 `~/.maestro/cli-tools.json`。

这条路径与 teammate 的 `cli/<tool>` 路由完全独立：不要把本文件写成 `~/.pi/agent/teammate-cli-tools.json`，也不要把 teammate backend 注册复制到这里。

## PURPOSE

完成以下配置并验证：

1. 在 `~/.maestro/cli-tools.json` 注册至少一个外部 CLI 工具
2. 为工具配置启用状态、主模型和 CLI 类型
3. 如工具通过 ACP 或其他命令启动，保存启动命令和参数
4. 通过一次只读或低成本 delegate 验证路由

成功标准：配置文件可解析，目标工具处于 `enabled: true`，并且 `maestro delegate --to <tool>` 能够找到该工具。

## PREREQUISITES

- Maestro CLI 与 pi-maestro-flow 已安装
- 目标外部 CLI 或 ACP adapter 已由用户安装，且可在 PATH 中找到，或者用户能提供绝对路径
- 用户知道该工具可用的 `primaryModel`
- 凭证由外部 CLI 自己管理，或由它读取环境变量；不要把 API key 写进本配置文件

已知 ACP adapter 的安装命令仅供用户确认，不得替用户臆测：

| 命令 | npm 包 |
|---|---|
| `codex-acp` | `@agentclientprotocol/codex-acp` |
| `claude-agent-acp` | `@agentclientprotocol/claude-agent-acp` |

## 配置文件

固定路径：

```text
~/.maestro/cli-tools.json
```

一个工具的最小结构如下。`roles` 与已有 `tools` 必须保留：

```json
{
  "version": "1.1.0",
  "tools": {
    "my-cli": {
      "enabled": true,
      "primaryModel": "<用户提供的模型名>",
      "tags": ["delegate"],
      "type": "builtin",
      "acp": {
        "command": "<用户提供的命令>",
        "args": ["<用户提供的参数>"]
      }
    }
  },
  "roles": {}
}
```

- `tools` 的 key 是 `maestro delegate --to` 使用的工具名
- `primaryModel` 必须是该外部 CLI 实际接受的模型名，不得由 AI 猜测
- `type`、`tags`、`settingsFile`、`reasoningEffort` 等已有字段应原样保留
- `acp` 仅在该工具需要 ACP 启动信息时填写；参数必须来自用户或该 CLI 的官方说明
- `~/.maestro/cli-tools.json` 与 `~/.pi/agent/teammate-cli-tools.json` 是两套配置，不能混用

## TASK

### 1. 读取现有配置

先读取 `~/.maestro/cli-tools.json`。如果文件存在，解析失败时停止，不覆盖原文件；如果不存在，从空的 `tools` 和 `roles` 开始。

确认要新增或更新的工具名，避免覆盖其他工具。更新只合并目标工具条目，不删除其他 `tools`、`roles` 或顶层字段。

### 2. 交互式收集工具信息

使用 `INTERACTIVE INPUTS` 收集完整信息。不要使用推荐值代替用户输入，也不要猜测外部 CLI 的模型名、参数或 credential。

### 3. 合并写入

使用 Node 的 JSON 解析和序列化，不能用字符串拼接修改配置：

```bash
node -e '
const fs=require("fs"),os=require("os"),p=require("path");
const file=p.join(os.homedir(),".maestro","cli-tools.json");
const cfg=fs.existsSync(file)?JSON.parse(fs.readFileSync(file,"utf8")):{};
cfg.version=typeof cfg.version==="string"?cfg.version:"1.1.0";
cfg.tools=cfg.tools&&typeof cfg.tools==="object"&&!Array.isArray(cfg.tools)?cfg.tools:{};
cfg.roles=cfg.roles&&typeof cfg.roles==="object"&&!Array.isArray(cfg.roles)?cfg.roles:{};
const name=process.env.PI_MAESTRO_TOOL;
const entry=JSON.parse(process.env.PI_MAESTRO_ENTRY);
if(!name||!entry||typeof entry!=="object"||Array.isArray(entry)) throw new Error("invalid tool entry");
cfg.tools[name]={...(cfg.tools[name]||{}),...entry};
fs.mkdirSync(p.dirname(file),{recursive:true});
fs.writeFileSync(file,JSON.stringify(cfg,null,2)+"\\n");
console.log("wrote",file);
'
```

`PI_MAESTRO_ENTRY` 只放非敏感配置。API key、OAuth token 和密码必须留在外部 CLI 的凭证存储或环境变量中，不得放入 `cli-tools.json`，也不得写进日志。

### 4. 重新加载

写入后重新加载 pi-maestro-flow 扩展或重启 Pi，使 provider 注册和 Maestro CLI 配置重新读取。

## INTERACTIVE INPUTS

按以下顺序使用 `ctx.ui` 询问：

1. **工具名**（`ctx.ui.input`）：新工具名，或选择一个已有工具进行更新；必须是用户实际用于 `--to` 的名字
2. **启用状态**（`ctx.ui.confirm`）：是否写入 `enabled: true`
3. **主模型**（`ctx.ui.input`）：外部 CLI 的 `primaryModel`，不允许留空，也不允许猜测
4. **工具类型**（`ctx.ui.input` 或 `ctx.ui.select`）：用户确认的 `type` 字符串，例如 `builtin` 或 CLI 实际要求的类型
5. **标签**（`ctx.ui.input`）：逗号分隔的 `tags`，可为空
6. **启动方式**（`ctx.ui.select`）：直接命令、ACP adapter、已有配置；按选择收集 `command`、`args`、`cwd`、`env` 或其他字段
7. **可选字段**（逐项 `ctx.ui.input`）：`settingsFile`、`reasoningEffort` 等仅在用户明确需要时写入
8. **写入确认**（`ctx.ui.confirm`）：展示工具名、模型名、命令和参数摘要后确认，敏感值不得回显

如果用户选择已有工具，先展示将要改变的字段，只覆盖用户确认的字段。用户选择停用时保留配置并写入 `enabled: false`，不要删除工具。

## VERIFY

先做本地结构校验：

```bash
node -e '
const fs=require("fs"),os=require("os"),p=require("path");
const file=p.join(os.homedir(),".maestro","cli-tools.json");
const cfg=JSON.parse(fs.readFileSync(file,"utf8"));
if(!cfg.tools||typeof cfg.tools!=="object") throw new Error("tools missing");
const name=process.env.PI_MAESTRO_TOOL;
const tool=cfg.tools[name];
if(!tool||tool.enabled!==true||typeof tool.primaryModel!=="string"||!tool.primaryModel.trim()) throw new Error("tool is not enabled with a primaryModel");
console.log("valid",name);
'
```

然后在当前 Pi 会话中用 `maestro` 工具做一次最小验证：

```text
maestro({
  action: "delegate",
  tool: "<已注册工具名>",
  mode: "analysis",
  prompt: "Reply with READY only. Do not edit files."
})
```

如果使用 Maestro CLI 命令行，`--to <tool>` 是必填的，不能把工具名作为裸位置参数。验证失败时区分：配置解析失败、工具未启用、命令不在 PATH、外部 CLI 自身凭证失败。

## ROLLBACK

- 从 `~/.maestro/cli-tools.json` 的 `tools` 删除本次新增的工具，保留其他工具和顶层字段
- 或只把该工具的 `enabled` 改为 `false`
- 如果写入前已有备份，先比较备份内容再恢复；不要删除整个配置文件来回滚单个工具
