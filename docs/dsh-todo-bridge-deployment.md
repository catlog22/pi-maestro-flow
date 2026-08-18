# dsh todo bridge 部署

把宿主的 todo 工具接进 dsh 运行时，需要**两边同时配好**：宿主侧的 backend 注册项开 `todoBridge`，运行时侧的 `cordis.yml` 加一条 mcp-client 条目。只配一边不会报错，只会让 teammate 拿不到队列 —— 这正是下面第 5 条要讲的事。

## cordis.yml 条目

在运行时的 `cordis.yml` 末尾追加（该文件是插件条目的列表，不是映射）：

```yaml
- id: mcp-todo-bridge
  name: '@deepseek-ai/dsh-mcp-client'
  disabled: !!js "!process.env.PI_MAESTRO_TODO_MCP_SECRET_URL"
  config:
    transport: streamable-http
    serverName: maestro_todo
    url: !!js process.env.PI_MAESTRO_TODO_MCP_SECRET_URL
    failOnStartupError: true
```

该条目需要运行时装有 `@deepseek-ai/dsh-mcp-client`；参考部署里它不在默认依赖内，须单独安装。

## 八件必须知道的事

**1. `serverName` 必须逐字是 `maestro_todo`。** mcp-client 用 `mcp__<serverName>__<rawName>` 组装模型可见的公共工具名，且 `serverName` 要匹配 `/^[A-Za-z0-9_-]{1,32}$/`。`maestro_todo` 合法且不触发字符替换与 hash 后缀，因此公共名稳定为 `mcp__maestro_todo__todo`。换一个名字，工具仍然能用，但**模型会找不到它**：宿主给带 todos 的 run 下发的队列指令里逐字写着 `mcp__maestro_todo__todo`（唯一来源是 `packages/pi-maestro-backends/src/dsh/todo-endpoint.ts` 的 `TODO_SERVER_NAME`），断言这个名字的测试与任何按名字路由的规则同样会失配。

**2. `disabled` 那行不能省，否则挂桥等于把整份部署变成 bridge-only。** `PI_MAESTRO_TODO_MCP_SECRET_URL` 只在宿主起 bridged run 时才注入。任何**不带 `todoBridge`** 的 run —— 也就是这份 cordis.yml 的绝大多数用法 —— 该变量为空，`url` 求值成 undefined，mcp-client 的 config 校验直接判失败，整棵插件树起不来：

```
dsh-jsonrpc-agent: plugin tree failed to load: failed to apply loader entry
mcp-todo-bridge (@deepseek-ai/dsh-mcp-client): invalid config:
  - expected {... url: string ...} but got
    {"transport":"streamable-http","serverName":"maestro_todo","failOnStartupError":true}
```

`disabled: !!js "!process.env.PI_MAESTRO_TODO_MCP_SECRET_URL"` 让条目在变量缺席时自行失活 —— loader 对 disabled 的条目根本不 init，也就不校验它的 config。**这不会削弱第 5 条的 fail loud**：变量在场时条目照常激活，`failOnStartupError: true` 照常对连不上的 endpoint 报错退出。两个方向都实测过：无变量启动退 0 且无输出，变量指向不可达 endpoint 时退 1 并报 `mcp-client(maestro_todo): initial connection or tool synchronization failed`。

**3. `url` 与 `disabled` 都必须用上面那两行 `!!js` 写法，变量名也必须逐字照抄。** cordis.yml 只在 plugin `config` 与 entry `disabled` 下允许 `!!js`，且**绝不能写 `!js`**（单感叹号不是同一个标签，不会求值）。`disabled` 的值要加引号：YAML 的普通标量不允许以 `!` 开头。

变量名里的 `SECRET` 是承重的，不是命名风格：这个值由 dsh backend 每个 run 现起现注入，含只属于该 run 的 token —— 它绑定这次 attempt 以谁的身份写队列。dsh 运行时给自己派生的每个子进程发的是 `scrubbedParentEnv()` 的结果，它剔除所有匹配 `/KEY|PASSWORD|SECRET|TOKEN/i` 的变量名（`packages/subprocess/subprocess/src/index.ts`）。改成不带这几个词的名字，运行时里模型开的每个 `bash` 都能 `env` 读到完整 token 并把它写进 transcript，任何读得到该 transcript 又能触达 loopback 的主体就能冒充这个 teammate 写队列。运行时进程本身由宿主直接 spawn 并显式拿到该值，所以这层擦除不影响桥本身。同样地，**不要把它抄进任何静态文件、日志或工单**。

**4. 宿主侧对应开关是 backend 注册项的 `todoBridge: true`。** 在 `.pi/teammate-backends.json` 里：

```json
{
  "mode": "backend-registry",
  "default": "dsh",
  "backends": {
    "dsh": {
      "module": "pi-maestro-backends/dsh",
      "config": { "cordisConfig": "/path/to/cordis.yml", "todoBridge": true }
    }
  }
}
```

开了它，这个注册项的 `todoBinding` 才是 `native`，图校验才会把带 todos 的任务放行到 dsh。同一个模块注册两次、一个开一个不开是支持的，且这在运行时层面也成立而不只是能力表层面：两个注册项可以共用同一份 cordis.yml，不开 `todoBridge` 的那个不注入 `PI_MAESTRO_TODO_MCP_SECRET_URL`，第 2 条的 `disabled` 让 mcp 条目在它的 run 里自行失活，运行时照常起来、只是没有这个工具。少了那行 `disabled`，「一开一不开」只在能力表上成立，不开的那个注册项每一次 run 都会在启动期崩掉。

**5. 两半 fail loud 缺一不可。** `failOnStartupError: true` 覆盖「声明了 mcp-client 但连不上」—— 插件激活失败，运行时不会带着半个工具集继续跑。它覆盖不了「`cordis.yml` 根本没加这条」：那种部署在运行时侧毫无信号，子进程只是没有这个工具，绕开它继续干活，而宿主的能力表仍写着 native。这一半由宿主承担：注册项开了 `todoBridge`、任务带非空 `todos`、而 endpoint 从未见过一次 MCP initialize 时，这次 attempt 判 `failed`，并在 `SingleResult.warnings` 里给出该补的条目。只配一半，仍然会静默降级。

**6. 桥好的工具不保证在第一个回合就可见。** 实测：endpoint 每一次都收到并应答了 `initialize` 与 `tools/list`，模型在第一个回合仍报告工具集里只有 `bash` / `edit` / `read` / `subagent` / `todo_write` / `write`，同一个会话稍后又能调到 `mcp__maestro_todo__todo`。也就是说运行时在 mcp-client 的工具代次发布之前就受理了首个 prompt，`failOnStartupError: true` 拦不住这一段 —— 它管的是连不上，不是发布时机。把 mcp 条目挪到 `agent-spine` 之前也不改变这一点。

后果是实打实的：一个开局就要读队列的 bridged run，可能整个第一回合都看不见这个工具，然后绕开它去做别的（实测见过模型连开 36 个 bash 去翻环境变量找这个工具 —— 当时子进程还完全没被告知它有队列、也没被告知工具叫什么，见第 8 条；「第一回合看不见工具」与「没人告诉它有工具」是两回事，后者已经修掉）。剩下的这半只能这样规避 —— 别把「必须调 todo」放在第一个回合，用一个轻量开场回合，真正的队列操作放到后续回合。仓内的真实运行时用例就是这么写的。这条属于上游行为，宿主侧修不了。

**7. endpoint 只暴露 `list` / `get` / `update`。** `create` / `delete` / `clear` 与自驱取任务面向 root，teammate 调不到 —— 宿主的编辑检查本来就把 teammate 限制在自己拥有的条目上，暴露那些动作只会多烧 token 并给出一条注定被拒的路径。`update` 的 `updateFields` 发布成字段名数组（枚举只有 `status` / `summary`，即 endpoint 真正放行的两个字段），与宿主 todo 工具读它的方式一致。

**8. 带 todos 的 bridged run 会收到一段队列指令。** 由 dsh backend 在 prompt 里拼上（`todo-endpoint.ts` 的 `assignedTodoInstruction`），内容是这次分到的条目 id、公共工具名 `mcp__maestro_todo__todo`，以及 in_progress / completed 的调用形状。它刻意写成工具调用口吻并明说 shell 上没有 todo 命令 —— Pi 路径那段同义指令是命令行口吻（`todo update <id> status=...`），送进没有该命令的运行时就是在请模型去 `bash` 里找。没有 todos 的 run、或没挂桥的注册项，都不会收到这段指令。

## 本地跑真实运行时用例

参考部署在仓外，CI 无法回归守护公共工具名，所以合并前请本机跑一遍并在 PR 里记录退出码与完整计数。

**跑整份文件，不要按用例名逐条跑。** 两个包各一条命令：

```sh
# backends 侧：9 条真实用例（含公共工具名 + toolCount + 环境擦除 + fail loud）
cd packages/pi-maestro-backends
DSH_E2E_CORDIS=~/.dsh/smoke/cordis.yml \
DSH_E2E_COMMAND=~/.dsh/smoke/node_modules/.bin/dsh-jsonrpc-agent \
DSH_E2E_CORDIS_NO_BRIDGE=~/.dsh/smoke/cordis-no-bridge.yml \
npm run test:e2e

# teammate 侧：4 条真实用例（含从工具请求装配到宿主 broker 的整条产品链路）
cd packages/pi-maestro-teammate
DSH_E2E_CORDIS=~/.dsh/smoke/cordis.yml \
DSH_E2E_COMMAND=~/.dsh/smoke/node_modules/.bin/dsh-jsonrpc-agent \
npm run test:e2e
```

判定要看整份的**退出码 0** 与 `fail 0 / skipped 0`。

`DSH_E2E_CORDIS_NO_BRIDGE` 在 `DSH_E2E_CORDIS` 在场时不是可选项：漏掉它，fail-loud 那条用例现在直接判 fail 并把该设的变量写进断言消息，而不是静默 skip 让整份继续读绿 —— 只跑 bridged 的一半正是当年 bridge-only 缺陷漏过去的形状。

按用例名单独跑只能作为定位手段，不能作为验收证据，有两个独立原因：

- **它看不见同一份部署对其他用例的影响。** 挂桥这类改动动的是整份 `cordis.yml`，只跑被改动直接针对的那条，剩下的用例在新部署下是什么状态从未被观察 —— 本文第 2 条那个 bridge-only 缺陷正是这样漏过去的：三条 bridged 用例条条绿，同一份配置下另外 6 条非 bridged 用例全部启动期崩掉。
- **`--test-name-pattern` 自己是个永真门。** 一条都没匹配上时它照样打印 `✔ <文件路径>` 并汇报 `tests 1 / pass 1 / fail 0 / skipped 0` 且退出 0。真要用它定位，必须同时确认输出里逐字出现了用例名。另外 `npm test -- --test-name-pattern ...` 会把该 flag 追加到 glob 位置参数之后而被静默忽略（跑满全部用例），不能作为判定手段。

## 两项仓外前置

这两项不在任何源文件里，只能手工准备，缺任何一项都会让真实 e2e 给出误导性结果。

**(a) 给参考部署的 `cordis.yml` 补上本文第一节那条 mcp-client 条目（含 `disabled` 那行）。** 缺整条，三条 bridged 用例会被宿主的 fail-loud 断言拦成 `failed`；补了条目而漏掉 `disabled`，则 backends 那 6 条非 bridged 用例会全部在运行时启动期崩掉。改之前先备份 —— 那是在用的部署配置。

```sh
cp ~/.dsh/smoke/cordis.yml ~/.dsh/smoke/cordis.yml.bak-pre-todo-bridge
cd ~/.dsh/smoke && npm install @deepseek-ai/dsh-mcp-client
```

**(b) 另存一份去掉该条目的副本，供 `DSH_E2E_CORDIS_NO_BRIDGE` 指向。** 缺它，fail-loud 那条用例永远 skip，而 fail-loud 的真实运行时那一半就会看起来「通过」。

```sh
# 在补条目之前先复制，得到的副本天然不含它
cp ~/.dsh/smoke/cordis.yml ~/.dsh/smoke/cordis-no-bridge.yml
```

运行时的凭据由它自己从 `cordis.yml` 旁边的 `.env` 解析，宿主进程既不读也不转发 —— 不要把 provider key 写进任何测试、命令行或本文档。
