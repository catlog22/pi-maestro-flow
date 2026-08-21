/**
 * Display text for the ACP-CLI backend's declared configuration fields.
 *
 * `configFields` carries `labelKey` / `descriptionKey`, not text: the settings
 * shell owns presentation and localization. Those keys need a definition or the
 * shell renders the key itself, so a field declared without an entry here
 * reaches an operator as `acpCli.command` rather than as a label — visible only
 * by looking at the shell, since nothing about it fails to compile or test.
 *
 * The wording matches `docs/backend-and-mcp-configuration.md`. Both describe the
 * same fields to the same reader, and an operator who consults one and then the
 * other must not find two different accounts of what a field does.
 */

import type { TranslationCatalogs } from "pi-maestro-settings-core/v1";

/** Catalog entries for every `acpCli.*` key the backend declares. */
export const ACP_CLI_SETTINGS_CATALOGS: TranslationCatalogs = {
  en: {
    "acpCli.command": "Executable",
    "acpCli.command.description":
      "The CLI to launch. Point at the wrapper script or symlink on PATH rather than an inner binary, so an update that moves the target keeps working.",
    "acpCli.args": "Arguments",
    "acpCli.args.description":
      "Arguments that put the CLI into ACP mode — `acp` for Cursor, `--acp` for Gemini.",
    "acpCli.cwd": "Working directory",
    "acpCli.cwd.description":
      "Directory the session opens against. Defaults to the task's own working directory.",
    "acpCli.env": "Environment passthrough",
    "acpCli.env.description":
      "Variable NAMES passed through to the child, never values. An entry containing `=` is refused: this document is meant to be committable.",
    "acpCli.mode": "Launch mode",
    "acpCli.mode.local": "Local process",
    "acpCli.mode.ssh": "Remote over SSH",
    "acpCli.host": "SSH host",
    "acpCli.user": "SSH user",
    "acpCli.port": "SSH port",
    "acpCli.hostKeySha256": "Host key SHA-256",
    "acpCli.identityFile": "SSH identity file",
    "acpCli.modelId": "Route",
    "acpCli.modelId.description":
      "The `cli/<tool>` route this registration serves. Derived from the registration name when unset, which is the usual case.",
    "acpCli.acpModel": "Model",
    "acpCli.acpModel.description":
      "Default model inside this CLI's own catalogue, used when a task names only the route. A task naming a model overrides it. A displayed name is enough when the catalogue carries it once — `composer-2.5` reaches `composer-2.5[fast=true]` — and an ambiguous name is refused rather than assigned a variant. Values come from the CLI, so opening this list launches it.",
    "acpCli.acpMode": "Mode",
    "acpCli.acpMode.description":
      "The agent's own operating mode, where it has one — Cursor offers Agent, Plan and Ask. Selecting a read-only mode is a protocol-level restriction, unlike launch flags that only widen what the agent may do. An empty list means this CLI publishes no modes.",
    "acpCli.acpThoughtLevel": "Reasoning depth",
    "acpCli.acpThoughtLevel.description":
      "Set only when the CLI publishes reasoning depth as its own selector. Many bake it into the model value instead — Cursor's `grok-4.6[effort=high]` is one value, not a model plus a depth — and for those this list is empty and depth is chosen by picking a model.",
    "acpCli.runTimeoutMs": "Run timeout (ms)",
    "acpCli.runTimeoutMs.description":
      "Bounds the run once the CLI is talking. Applies per registration, not per task.",
    "acpCli.startupTimeoutMs": "Handshake timeout (ms)",
    "acpCli.startupTimeoutMs.description":
      "Bounds `initialize` and `session/new`, default 15000. Raise it when the command downloads before answering or the agent is slow to open a session; lowering it is what the default already guards against.",
  },
  "zh-CN": {
    "acpCli.command": "可执行文件",
    "acpCli.command.description":
      "要启动的 CLI。指向 PATH 上的包装脚本或符号链接，不要指向内层二进制——升级换目录后前者仍然有效。",
    "acpCli.args": "启动参数",
    "acpCli.args.description": "让 CLI 进入 ACP 模式的参数：Cursor 是 `acp`，Gemini 是 `--acp`。",
    "acpCli.cwd": "工作目录",
    "acpCli.cwd.description": "会话打开时所在的目录。留空则用任务自己的工作目录。",
    "acpCli.env": "环境变量透传",
    "acpCli.env.description":
      "只装变量**名**，不装值。含 `=` 的条目会被拒绝——这份注册文档是要能提交进仓库的。",
    "acpCli.mode": "启动方式",
    "acpCli.mode.local": "本地进程",
    "acpCli.mode.ssh": "经 SSH 远程",
    "acpCli.host": "SSH 主机",
    "acpCli.user": "SSH 用户",
    "acpCli.port": "SSH 端口",
    "acpCli.hostKeySha256": "主机密钥 SHA-256",
    "acpCli.identityFile": "SSH 私钥文件",
    "acpCli.modelId": "路由",
    "acpCli.modelId.description":
      "该注册项服务的 `cli/<tool>` 路由。留空则由注册名派生，这是常见情形。",
    "acpCli.acpModel": "模型",
    "acpCli.acpModel.description":
      "该 CLI 自己目录里的默认模型，任务只点名路由时生效；任务点名模型则覆盖它。名字在目录里唯一时写显示名就够——`composer-2.5` 会解析到 `composer-2.5[fast=true]`；同名多个变体会被拒绝而不是替你挑一个。取值来自 CLI 本身，所以打开这个列表会拉起它。",
    "acpCli.acpMode": "模式",
    "acpCli.acpMode.description":
      "该 agent 自己的运行模式（有的话）——Cursor 提供 Agent / Plan / Ask。选只读模式是**协议层**的限制，与只会放宽权限的启动参数不同。列表为空表示这个 CLI 不公布模式。",
    "acpCli.acpThoughtLevel": "推理深度",
    "acpCli.acpThoughtLevel.description":
      "只有当该 CLI 把推理深度作为独立选项公布时才可设。很多 CLI 把它焊进模型取值里——Cursor 的 `grok-4.6[effort=high]` 是**一个取值**，不是「模型+深度」——那种情况下这里为空，深度靠选模型决定。",
    "acpCli.runTimeoutMs": "运行超时（毫秒）",
    "acpCli.runTimeoutMs.description": "CLI 开始应答之后的上限。作用于每条注册项，不是每个任务。",
    "acpCli.startupTimeoutMs": "握手超时（毫秒）",
    "acpCli.startupTimeoutMs.description":
      "约束 `initialize` 与 `session/new`，默认 15000。命令要先下载再应答、或 agent 开会话慢时往上调；往下调正是默认值在防的事。",
  },
};
