/**
 * Display text for the dsh backend's declared configuration fields.
 *
 * `configFields` carries `labelKey` / `descriptionKey`, not text: the settings
 * shell owns presentation and localization. Those keys need a definition or the
 * shell renders the key itself, so a field declared without an entry here
 * reaches an operator as `dsh.cordisConfig` rather than as a label — visible
 * only by looking at the shell, since nothing about it fails to compile or test.
 *
 * The wording matches `docs/backend-and-mcp-configuration.md`. Both describe the
 * same fields to the same reader, and an operator who consults one and then the
 * other must not find two different accounts of what a field does.
 */

import type { TranslationCatalogs } from "pi-maestro-settings-core/v1";

/** Catalog entries for every `dsh.*` key the backend declares. */
export const DSH_SETTINGS_CATALOGS: TranslationCatalogs = {
  en: {
    "dsh.command": "Executable",
    "dsh.command.description":
      "The dsh JSON-RPC agent to launch. The default resolves from PATH.",
    "dsh.cordisConfig": "cordis.yml path",
    "dsh.cordisConfig.description":
      "Absolute path to the runtime's own plugin configuration. Required: a path that does not exist fails when the registration document is read, not at run time. Everything inside that file — including which MCP servers the runtime mounts — is yours to configure, not this shell's.",
    "dsh.cwd": "Working directory",
    "dsh.cwd.description": "Directory the runtime executes in. Defaults to the task's own.",
    "dsh.provider": "Provider",
    "dsh.model": "Model",
    "dsh.model.description": "Model the runtime routes to, in that provider's own naming.",
    "dsh.apiKeyEnv": "API key variable name",
    "dsh.apiKeyEnv.description":
      "The NAME of the variable holding the key, never the key. The value is written to the runtime's own env file beside its cordis.yml, so this registration document stays committable.",
    "dsh.envPassthrough": "Environment passthrough",
    "dsh.envPassthrough.description":
      "Variable NAMES the runtime may see beyond the scrubbed defaults.",
    "dsh.mode": "Launch mode",
    "dsh.mode.description":
      "Where the runtime is launched. `local` runs the dsh agent on this host; `ssh` launches it on a remote machine over SSH (the host/user fields below are then required).",
    "dsh.mode.local": "Local process",
    "dsh.mode.ssh": "Remote over SSH",
    "dsh.host": "SSH host",
    "dsh.host.description":
      "Host the dsh agent is launched on when `mode` is `ssh`. Required under ssh; ignored under local.",
    "dsh.user": "SSH user",
    "dsh.user.description":
      "User to log in as when `mode` is `ssh`. Required under ssh; ignored under local.",
    "dsh.port": "SSH port",
    "dsh.port.description":
      "SSH port on the remote host. Defaults to 22; only used when `mode` is `ssh`.",
    "dsh.hostKeySha256": "Host key SHA-256",
    "dsh.hostKeySha256.description":
      "Pinned SHA-256 fingerprint of the remote host's public key. When set, the connection refuses a host whose key does not match, instead of trusting on first use.",
    "dsh.identityFile": "SSH identity file",
    "dsh.identityFile.description":
      "Path to the private key for SSH authentication. When omitted, the SSH client uses its default agent or key search.",
    "dsh.todoBridge": "Todo bridge",
    "dsh.todoBridge.description":
      "Carries the host's todo queue to the runtime over a per-run MCP endpoint. Enabling it here is only half: the runtime's cordis.yml needs a matching mcp-client entry, or a task with todos ends failed. See docs/dsh-todo-bridge-deployment.md.",
    "dsh.maxTokens": "Max tokens",
    "dsh.requestTimeoutMs": "Request timeout (ms)",
  },
  "zh-CN": {
    "dsh.command": "可执行文件",
    "dsh.command.description": "要启动的 dsh JSON-RPC agent。默认值从 PATH 解析。",
    "dsh.cordisConfig": "cordis.yml 路径",
    "dsh.cordisConfig.description":
      "运行时自己那份插件配置的绝对路径。**必填**：路径不存在会在读注册文档时就失败，不会拖到运行期。该文件内部的一切——包括运行时挂哪些 MCP——由你自己配置，本界面不管。",
    "dsh.cwd": "工作目录",
    "dsh.cwd.description": "运行时执行时所在的目录。留空则用任务自己的工作目录。",
    "dsh.provider": "供应商",
    "dsh.model": "模型",
    "dsh.model.description": "运行时路由到的模型，用该供应商自己的命名。",
    "dsh.apiKeyEnv": "API 密钥变量名",
    "dsh.apiKeyEnv.description":
      "存放密钥的变量**名**，不是密钥本身。密钥会被写进运行时自己的 env 文件（在 cordis.yml 旁边），因此这份注册文档可以提交进仓库。",
    "dsh.envPassthrough": "环境变量透传",
    "dsh.envPassthrough.description": "在被擦除的默认集之外，额外允许运行时看到的变量**名**。",
    "dsh.mode": "启动方式",
    "dsh.mode.description":
      "运行时在哪里启动。`local` 在本机跑 dsh agent；`ssh` 经 SSH 在远程机器上启动（此时下面的 host/user 为必填）。",
    "dsh.mode.local": "本地进程",
    "dsh.mode.ssh": "经 SSH 远程",
    "dsh.host": "SSH 主机",
    "dsh.host.description":
      "`mode` 为 `ssh` 时启动 dsh agent 的目标主机。ssh 下必填，local 下忽略。",
    "dsh.user": "SSH 用户",
    "dsh.user.description":
      "`mode` 为 `ssh` 时登录用的用户名。ssh 下必填，local 下忽略。",
    "dsh.port": "SSH 端口",
    "dsh.port.description":
      "远程主机的 SSH 端口，默认 22；仅在 `mode` 为 `ssh` 时使用。",
    "dsh.hostKeySha256": "主机密钥 SHA-256",
    "dsh.hostKeySha256.description":
      "远程主机公钥的 SHA-256 指纹。设置后，主机密钥不匹配的连接会被拒绝，而不是首次使用即信任。",
    "dsh.identityFile": "SSH 私钥文件",
    "dsh.identityFile.description":
      "用于 SSH 认证的私钥路径。留空则由 SSH 客户端用默认 agent 或密钥搜索。",
    "dsh.todoBridge": "Todo 桥",
    "dsh.todoBridge.description":
      "把宿主的 todo 队列经每次运行的 MCP endpoint 交给运行时。**在这里打开只是一半**：运行时的 cordis.yml 还要有配套的 mcp-client 条目，否则带 todos 的任务会以 failed 收场。见 docs/dsh-todo-bridge-deployment.md。",
    "dsh.maxTokens": "最大 token 数",
    "dsh.requestTimeoutMs": "请求超时（毫秒）",
  },
};
