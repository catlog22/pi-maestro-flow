# OpenAI Secure MCP Tunnel 配置指南（实验性）

本文档用于 `/install` 的 `openai-tunnel` 安装项。该能力只编排用户自行取得的外部 `tunnel-client`，并通过原生 Gateway 配置引用凭证环境变量。

## PURPOSE

为原生 Gateway 显式启用实验性的 OpenAI Secure MCP Tunnel，并验证外部 client、凭证引用和 tunnel readiness。

必须保留以下边界：

- **experimental**：默认关闭，只有 `tunnels.openai.enabled: true` 才启用。
- **no auto-download**：Pi 和 `/install` 绝不下载、更新或替换 `tunnel-client`。
- **no provisioning**：Pi 绝不创建、认领或删除 OpenAI tunnel；tunnel 必须已由用户通过外部受信流程预配。
- **reference-only secrets**：Gateway YAML 只保存环境变量名称，不保存 tunnel id、runtime API key 或其他 secret 值。

## PREREQUISITES

- 原生配置路径为 `~/.pi/agent/gateway/config.yaml`；不要写入旧 MCPX 配置。
- 用户已通过 OpenAI 支持的外部流程预配 tunnel，并能自行管理其生命周期。
- 用户已从受信来源手工安装符合公开 CLI contract 的 `tunnel-client`，版本至少为 `0.0.14`。不要由 AI 猜测下载 URL或执行下载安装。
- Gateway 启动环境中已有两个凭证引用。默认名称是 `CONTROL_PLANE_TUNNEL_ID` 和 `CONTROL_PLANE_API_KEY`；值由用户的 secret manager、服务管理器或当前 shell 注入。
- `pi-maestro-gateway` 可启动，并且本地 HTTP MCP transport 可用。

## TASK

### 1. 只收集非敏感配置

按 INTERACTIVE INPUTS 确认：

- `tunnel-client` 的现有绝对路径；
- 两个环境变量的**名称**；
- 用户已经预配 tunnel 且接受 experimental 语义。

不要询问、显示、复制或写入这两个环境变量的值。只让用户在其既有 secret 管理边界中确认变量对 Gateway 进程可用。

### 2. 验证外部 client

由用户确认 client 来源后，仅执行身份检查：

```bash
"<absolute-path-to-tunnel-client>" --version
```

版本必须是受支持的 `0.0.x`，且不低于 `0.0.14`。缺失或不兼容时停止并报告；不得自动下载、升级或换用未知二进制。

### 3. 更新原生 Gateway 配置

在 `~/.pi/agent/gateway/config.yaml` 中合并以下 section，保留所有其他 section 和注释：

```yaml
tunnels:
  openai:
    enabled: true
    binary_path: "/absolute/path/to/tunnel-client"
    tunnel_id_env: "CONTROL_PLANE_TUNNEL_ID"
    runtime_key_env: "CONTROL_PLANE_API_KEY"
    minimum_version: "0.0.14"
    credential_ttl_ms: 300000
```

约束：

- `binary_path` 指向用户已经安装的 client；不得触发下载。
- `tunnel_id_env` 与 `runtime_key_env` 是环境变量名，不是 credential 值。
- 不得把 tunnel id、API key、bearer token 或任何 secret literal 写入 YAML。
- `credential_ttl_ms` 是 Gateway 发放给 client 的短期本地凭证 TTL，允许范围为 `1000..3600000`；推荐保留 `300000`。
- 不要编辑 `/gateway` UI 的实现；本安装项直接使用 native Gateway config。

### 4. 验证配置状态和运行时

重启 Gateway，使其从启动环境和 YAML 重新加载配置。然后依次执行：

```bash
# 静态 setup probe：已启用且两个被引用的环境变量在当前进程可用时应为 installed
/install list

# 启动由 Gateway 监管的 OpenAI tunnel；不传 secret literal
pi-maestro-gateway tunnel start openai default --json

# 查询 supervisor 记录和 readiness
pi-maestro-gateway tunnel status openai default --json
```

`start` 的 doctor 阶段必须验证 client identity/version、两个环境变量引用和本地 MCP。ready 只有在本地 MCP 与外部 client 的 control-plane `/readyz` 都成功后成立。

不得用 `--experimental`、`--tunnel-id-env` 或 `--runtime-key-env` 携带任何 secret 值；原生配置已经提供显式 opt-in 和变量名。

## INTERACTIVE INPUTS

必须用 `ctx.ui` 询问且只记录非敏感答案：

1. `ctx.ui.confirm`：用户是否已自行预配 tunnel，并理解该 contract 为 experimental、Pi 不会 provisioning。
2. `ctx.ui.input`：已安装 `tunnel-client` 的绝对路径。若不存在或版本低于 `0.0.14`，停止；不要下载。
3. `ctx.ui.input`：tunnel id 的环境变量名称，默认 `CONTROL_PLANE_TUNNEL_ID`。
4. `ctx.ui.input`：runtime key 的环境变量名称，默认 `CONTROL_PLANE_API_KEY`。
5. `ctx.ui.confirm`：用户是否已在 Gateway 启动环境中安全注入这两个变量。只确认可用性，不要求粘贴或持久化值。
6. `ctx.ui.confirm`：是否以 `credential_ttl_ms: 300000` 启用。需要修改时只接受 `1000..3600000` 的整数。

任一确认被拒绝时保持 `enabled: false`，不启动 tunnel。

## VERIFY

成功必须同时满足：

1. `tunnel-client --version` 报告受支持的 `0.0.x` 且版本 `>= 0.0.14`。
2. `~/.pi/agent/gateway/config.yaml` 的 `tunnels.openai` 包含 `enabled`、`binary_path`、`tunnel_id_env`、`runtime_key_env`、`minimum_version`、`credential_ttl_ms`，且不含 secret literal。
3. `/install list` 对 `openai-tunnel` 显示 installed；缺失配置为 not-installed，disabled 或缺少被引用环境变量时为 partial。
4. `pi-maestro-gateway tunnel start openai default --json` 成功通过 doctor。
5. `pi-maestro-gateway tunnel status openai default --json` 显示 running/ready；日志和状态中没有 credential 值。

## ROLLBACK

1. 停止受监管进程：

   ```bash
   pi-maestro-gateway tunnel stop openai default --json
   ```

2. 将 `~/.pi/agent/gateway/config.yaml` 中 `tunnels.openai.enabled` 改为 `false`；可保留非敏感的 client path、env 名称、minimum version 与 TTL，或删除整个 `openai` mapping。
3. 重启 Gateway，并确认 tunnel status 不再 running。
4. 按用户自己的 secret manager 流程撤销或轮换 runtime key，并从 Gateway 启动环境移除引用；不要把值复制到配置或日志。
5. 如需删除已预配的 tunnel，必须由用户在 OpenAI 的外部管理流程中完成。Pi 的 rollback 不执行 provisioning/deprovisioning，也不卸载或删除 `tunnel-client`。
