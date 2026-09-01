# 执行后端与外部 MCP 配置

面向操作员：把一个外部执行体接进 teammate，以及给 dsh 运行时挂上外部 MCP。

写适配器本身请看 [teammate-backend-adapter-contract.md](teammate-backend-adapter-contract.md)（接口、能力表、注册文档结构）。todo bridge 那一条 mcp-client 的两侧配置在 [dsh-todo-bridge-deployment.md](dsh-todo-bridge-deployment.md)，本文不重复。

## 两层，别配错地方

配置分属两个互不相干的层：

| 层 | 文件 | 决定什么 |
|---|---|---|
| 宿主 | `teammate-backends.json` | 有哪些后端可派发、各自怎么启动 |
| 运行时 | 后端自己的配置文件 | 该后端内部的能力，例如 dsh 的 `cordis.yml` 挂哪些 MCP |

**外部 MCP 属于第二层。** 宿主对它一无所知，`teammate-backends.json` 里没有也不该有 MCP 字段。给 dsh 挂 MCP 就是编辑 `cordisConfig` 指向的那个 `cordis.yml`。

## 第一层：注册后端

### 放哪个文件

注册文档有两处，按下面的顺序取**第一个存在的**：

| 优先级 | 路径 | 适合 |
|---|---|---|
| 1 | `<工作区>/.pi/teammate-backends.json` | 只给这个项目用的后端 |
| 2 | `<agent 目录>/teammate-backends.json`，默认 `~/.pi/agent/` | 所有项目共用；受 `PI_CODING_AGENT_DIR` 控制 |
| 3 | 无文件 | 内置 `legacy` + `pi-subprocess` |

**项目文档整份胜出，不与全局逐字段合并。** 项目里只要有这个文件，全局的 `mode`、`default`、`backends` 就全部不参与——否则会得到一份哪个文件里都不存在的配置。要在某个项目里覆盖一条全局注册，就把需要的全局条目一起抄进项目文档。

全局文档**格式错误不会静默退回 legacy**：JSON 解析失败会点名该文件路径并报错，因为一份配错的全局注册和一台没配过的机器必须能区分。

`mode` / `default` / `backends` 三个键的语义见契约文档的 Registering a backend 一节。下面给两个后端的完整可用配置。

```json
{
  "mode": "backend-registry",
  "default": "pi-subprocess",
  "backends": {
    "cursor": {
      "module": "pi-maestro-teammate/v1/acp-cli",
      "config": {
        "command": "/Users/<you>/.local/bin/agent",
        "args": ["acp"],
        "modelId": "cli/cursor",
        "acpModel": "composer-2.5[fast=true]",
        "startupTimeoutMs": 30000
      }
    },
    "dsh": {
      "module": "pi-maestro-backends/dsh",
      "config": {
        "cordisConfig": "/绝对路径/到/dsh/cordis.yml",
        "model": "deepseek-v4-flash",
        "apiKeyEnv": "DEEPSEEK_API_KEY"
      }
    }
  }
}
```

`mode` 缺省是 `legacy`，此时整个 registry 不生效，`cli/<tool>` 与显式 `backend` 都会被按名拒绝。要用就必须显式写 `backend-registry`。

### ACP-CLI 后端字段

任何说 ACP 的 CLI 都用这一个模块，一个 CLI 一条注册项。

| 字段 | 必填 | 说明 |
|---|---|---|
| `acpAgent` | 否 | 签入的 ACP registry 快照里的 agent id；填了它就不用写下面两项，见下 |
| `command` | 视情况 | 可执行文件。指向包装脚本或符号链接，不要绕到内层二进制。填了 `acpAgent` 且该 agent 走 npx/uvx 时不需要 |
| `args` | 否 | 进入 ACP 模式的参数，例如 Cursor 是 `["acp"]`、Gemini 是 `["--acp"]`。填了 `acpAgent` 时**不能**再填 |
| `modelId` | 否 | 该注册项服务的 `cli/<tool>` 路由；缺省由注册名派生 |
| `acpModel` | 否 | 该注册项的默认内层模型，**可以只写模型名**，见下 |
| `runTimeoutMs` | 否 | 运行起来之后的上限 |
| `startupTimeoutMs` | 否 | 握手上限，默认 15000。**只该往上调** |
| `cwd` / `env` | 否 | `env` 装的是**变量名**，含等号的条目会被拒 |
| `mode` | 否 | `local`（默认）或 `ssh` |
| `sshHostRef` | `mode: "ssh"` 时二选一 | `/ssh` manager 中的主机 id；使用时不能再写任何内嵌 SSH 字段 |
| `host` / `user` / `hostKeySha256` | 未用 `sshHostRef` 时是 | 内嵌 SSH 目标；缺任一条都会在读注册文档时报错 |
| `port` / `identityFile` | 否 | 仅用于内嵌 SSH；`port` 默认 22 |

引用主机前须先通过 `/ssh` 解锁 manager。引用仅支持 `bash` + ssh-agent 或无 passphrase identity；manager 中的 password、带 passphrase identity 和 PowerShell 主机不会被复制或降级，而是在解析引用时明确拒绝。旧内嵌字段继续兼容，但不能与 `sshHostRef` 混用。

**模型是两个轴，不是一个。** `modelId` 选的是哪个 CLI，`acpModel` 选的是那个 CLI 里的哪个模型。任务里 `model` 等于路由 id 时用注册项的 `acpModel`，不等于时该值本身就是内层模型。

内层模型的合法取值只有 CLI 自己知道，配错了会在**发出 prompt 之前**失败，错误消息列出全部可用值——**报错本身就是目录**，不必先去别处查。

`startupTimeoutMs` 的默认值 15000 是量过的：ACP 握手包含 `initialize` 与 `session/new` 两步，实测装好的 Claude Code 适配器在 5000 下仍会在 `session/new` 超时。`command` 走 `npx` 之类会先下载的启动方式要调更高。

### 不用手写启动命令：`acpAgent`

仓库里签入了一份 [ACP registry](https://github.com/agentclientprotocol/registry) 快照（39 个 agent），填 `acpAgent` 就能让它提供启动方式：

```json
"claude": { "module": "pi-maestro-teammate/v1/acp-cli",
            "config": { "acpAgent": "claude-acp", "modelId": "cli/claude" } }
```

**已装的优先用本地那份。** npx / uvx 分发的 agent，如果它安装的可执行文件已在 PATH 上，就直接用本地的，省掉 npx 每次重新解析包（冷缓存时会先下载）。可执行文件名取自**包自己的 manifest**，不是从包名猜的——`@google/gemini-cli` 装的是 `gemini`，`@qwen-code/qwen-code` 装的是 `qwen`，猜会猜错，而猜中一个同名的无关程序就会去启动它。

本机实测：

```
gemini       bins=["gemini"]            → local    gemini --acp
claude-acp   bins=["claude-agent-acp"]  → runner   npx -y @agentclientprotocol/claude-agent-acp@0.70.0
cursor       bins=[]                    → operator (你给路径) acp
```

**以平台二进制分发的仍要你给路径**（cursor、goose、opencode 等 16 个），本产品从不下载安装它们；registry 只贡献 `args`。

### 自己填路径

`command` 填了就用它，`acpAgent` 只贡献参数——这适用于**任何** agent，不只 binary。有自己那份构建、装在 PATH 之外的，直接指过去：

```json
"cursor": { "config": { "acpAgent": "cursor",
                        "command": "/Users/<you>/.local/bin/agent",
                        "modelId": "cli/cursor" } }

"gemini": { "config": { "acpAgent": "gemini",
                        "command": "/opt/gemini/bin/gemini",
                        "modelId": "cli/gemini" } }
```

给了路径时传的是**跟在可执行文件后面的参数**（`--acp`），不是 runner 的包说明符（`-y <包名>`）——否则等于把 npx 的参数喂给一个直接可执行的程序。

`args` 仍然**不能**和 `acpAgent` 同时填：参数来自 registry，两边都写就无从判断跑的是哪个。

### 装到本地：`acpInstall`

默认 `never`，每次都走 npx。改成 `auto` 后，**首次运行会把它装到 Pi 的 agent 目录下**，之后直接启动那份副本：

```json
"claude": { "config": { "acpAgent": "claude-acp", "acpInstall": "auto",
                        "modelId": "cli/claude" } }
```

| | |
|---|---|
| 装到哪 | `<agent 目录>/acp-agents/<id>/<版本>/`，**不碰**你的全局 npm 前缀；删目录即可完全撤销 |
| 何时装 | 派发时，不是读配置时——`resolveConfig` 是同步的，设置界面渲染时也会跑，不能在那里装包 |
| 装失败 | **回落到 npx，不让任务失败**。一个加速手段不该拖垮你要跑的任务 |
| 不适用 | 你自己填了 `command` 时（那是你指的程序）；uvx 分发的 agent（不公布脚本名，装了也不知道启动什么） |
| 超时 | `installTimeoutMs`，只约束那一次安装；超时同样回落 |

默认关闭是刻意的：写磁盘和联网都不该是「填了个 agent id」的副作用。

**版本是钉死的。** 快照里写的版本就是会跑的版本，只由显式刷新更新：

```bash
npm --prefix packages/pi-maestro-teammate run refresh:acp-registry   # 写入
npm --prefix packages/pi-maestro-teammate run check:acp-registry     # 只检查是否过期
```

`check` 是给人看的，**没有接进任何闸门**：上游任何一个 agent 发版它就会过期，接进 CI 会让什么都没改的构建失败，那正好和"钉死"相反。

### 不用抄那串方括号

有些 CLI 的目录 id 是复合串。Cursor 的模型选择器实测长这样：

| 显示名 | 目录 id |
|---|---|
| `composer-2.5` | `composer-2.5[fast=true]` |
| `grok-4.6` | `grok-4.6[effort=high,fast=true]` |
| `gpt-5.6-sol` | `gpt-5.6-sol[context=272k,reasoning=medium,fast=false]` |
| `Auto` | `default[]` |

**`acpModel` 写显示名即可**，只要该名字在目录里唯一就会解析到对应 id：写 `"composer-2.5"` 等同于写 `"composer-2.5[fast=true]"`。同名多个变体时会被拒绝并列出全部候选，让你指定完整 id——绝不替你挑一个。设置界面的模型选择器显示的也是这一列显示名。

结果里的 `executorModel` 回报的是**解析之后**的完整 id，所以按名字配置不会让你失去"到底跑了哪个变体"的信息。

### 思考等级与上下文对不齐，这是没法配的

宿主有独立的 `thinking` 轴（`off`…`max`），Cursor **没有**：实测它只公布 `mode` 和 `model` 两个选项，没有 ACP 规范里的 `thought_level` 类别。推理深度和上下文长度被**焊死在模型 id 里**（`effort=high`、`reasoning=medium`、`context=272k`），只能整体选，不能单独调。

因此 acp-cli 声明 `thinkingLevel: "unsupported"` 是对的，给这类任务设 `thinking: "off"` 也是对的。**不要指望宿主能把 `thinking: high` 翻译成某个变体**：那需要猜 `effort=` / `reasoning=` / `thinking=` 这些键在各家 CLI 里分别是什么意思，而它们是厂商私有编码，改一次我们就会静默选错模型。要不同的推理深度，就注册多条，各配各的 `acpModel`。

公布了 `thought_level` 的 CLI 未来可以正经支持；Cursor 目前不在此列。


### dsh 后端字段

| 字段 | 必填 | 默认 |
|---|---|---|
| `cordisConfig` | **是** | — |
| `command` | 否 | `dsh-jsonrpc-agent` |
| `provider` | 否 | `deepseek-official` |
| `model` | 否 | `deepseek-v4-flash` |
| `apiKeyEnv` | 否 | credential-ref |
| `envPassthrough` | 否 | 变量名列表 |
| `mode` | 否 | `local`；设为 `ssh` 时在远端启动 |
| `sshHostRef` | ssh 时二选一 | `/ssh` manager 中的兼容主机 id |
| `host` / `user` / `port` / `hostKeySha256` / `identityFile` | ssh 时二选一 | 旧内嵌 SSH 连接字段；不得与 `sshHostRef` 混用 |
| `todoBridge` | 否 | `false`；ssh 模式不支持 |
| `cwd` / `maxTokens` | 否 | —；ssh 下 `cwd` 是远端路径 |
| `requestTimeoutMs` | 否 | `300000` |

`cordisConfig` 是必填且没有默认值，路径不存在会在读注册文档时就失败，不会拖到运行期。ssh 引用在每个 run 开始前解析为内存中的非敏感连接配置；注册文档只保存 id，不保存 manager 密码或私钥口令。

**`apiKeyEnv` 存的是键名，不是密钥。** 它声明为 `credential-ref` 且位置是 `env-file-key`：宿主把键名写进 dsh 运行时自己的 env 文件（在 `cordis.yml` 旁边），密钥本身从不经过宿主。所以这个注册文档可以提交进仓库。

## 第二层：给 dsh 挂外部 MCP

编辑 `cordisConfig` 指向的 `cordis.yml`。该文件是插件条目的**列表**，不是映射。一个 MCP server 一条 `@deepseek-ai/dsh-mcp-client` 条目：

```yaml
- id: mcp-github
  name: '@deepseek-ai/dsh-mcp-client'
  config:
    serverName: github
    transport: stdio
    command: npx
    args: ['-y', '@modelcontextprotocol/server-github']
    env:
      GITHUB_TOKEN: !!js process.env.GITHUB_TOKEN

- id: mcp-web
  name: '@deepseek-ai/dsh-mcp-client'
  config:
    serverName: web
    transport: streamable-http
    url: http://localhost:3000/mcp
```

模型看到的工具名是 `mcp__<serverName>__<rawName>`，与 Claude Code、Codex 同一套命名。

`serverName` 要匹配 `/^[A-Za-z0-9_-]{1,32}$/`，且在所有存活实例中唯一——重名会让后一条在加载时失败。名字里带其他字符不会报错，但公共名会被规范化并追加 hash 后缀，于是**按名字路由的规则和断言会失配**。

该条目需要运行时装有 `@deepseek-ai/dsh-mcp-client`。它不在默认依赖内，要单独装。

### 裁剪工具集

挂进来的 server 若提供与宿主重复的工具（典型是文件读写），会让模型面对两套做同一件事的工具。多数 MCP server 支持用环境变量裁剪，例如：

```yaml
    env:
      MAESTRO_ENABLED_TOOLS: maestro_wiki_search,store_knowhow
```

裁剪与否取决于 server 自身是否提供这个口子，mcp-client 不做过滤。

### `!!js` 的两条硬规则

`cordis.yml` 只在插件 `config` 与条目 `disabled` 下允许 `!!js`。

**绝不能写 `!js`。** 单感叹号不是同一个标签，不会求值，会静默得到一个字符串。

`disabled` 的值必须加引号，因为 YAML 的普通标量不允许以 `!` 开头。

## 已知限制

**MCP 启动超时继承 SDK 的 60 秒硬默认**，dsh 的 mcp-client 没有暴露这个配置项。要拉起 Node 进程的 server 冷启动慢时会卡在这里，而错误信息不会指向握手。

**只桥接了 Tools。** MCP 的 Resources 与 Prompts 没有宿主消费者。

**图像、音频与 resource 块在模型上下文里退化成占位符**，完整 JSON 仍保留在执行期的值里。

**ACP-CLI 的超时是逐注册项而非逐任务**，因为 `TeammateRunSpec` 不带 `timeoutMs`。同一个 CLI 要两种超时就注册两条，配不同的 `config`。

**ssh 模式的注册项无法发现模型**：探测在本进程拉起 agent，够不到远端目录，会明确拒绝而不是拿本机答案冒充。

## 排错

**`teammate backend "<name>" is not registered`** —— 任务点名的后端不在 `backends` 里，或 `mode` 还是 `legacy`。不会回落到默认后端。

**`... loaded from "<module>" but exports no backend`** —— `module` 解析到了，但既没有 `default` 也没有以具名导出提供 `name` / `capabilities` / `start` 三者。

**`ACP option "model" does not advertise "<值>"`** —— 内层模型名不在该 CLI 的目录里，错误消息已附完整目录。

**想知道某次运行到底跑了哪个模型** —— 看结果的 `executorModel`：那是 CLI 自己接受的目录取值，用它自己的命名；`model` 是宿主派发用的路由，两者不是一回事。`executorModel` 缺失表示这次没选模型，CLI 停在它自己的当前模型上，**不表示等于 `model`**。运行成功但模型不对时，先看任务的 `model` 是否恰好等于路由 id——那种情况下生效的是注册项的 `acpModel`。

**改了注册文档但不生效** —— 项目里若存在 `.pi/teammate-backends.json`，全局那份整份不参与；确认你改的是实际生效的那一份。

**dsh 运行判 failed 且警告提到 todo endpoint** —— 开了 `todoBridge` 但 `cordis.yml` 缺对应条目，见 [dsh-todo-bridge-deployment.md](dsh-todo-bridge-deployment.md)。
