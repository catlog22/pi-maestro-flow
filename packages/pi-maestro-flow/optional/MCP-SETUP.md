# MCP 服务器配置（AI 可执行）

本文档面向 AI agent，注册 MCP（Model Context Protocol）服务器并完成 OAuth 认证。MCP 让 AI 访问外部工具（GitHub、数据库、API 等）。

## PURPOSE

完成两件事并验证：
1. **注册 MCP 服务器** — 写入 MCP 配置文件（含 `mcpServers` 映射）
2. **OAuth 认证** — 对需要 OAuth 的 server 完成授权流程

成功标准：`/mcp` 列出已注册 server，`/mcp auth <name>` 对 OAuth server 完成 token 获取，AI 能调用 server 暴露的工具。

## PREREQUISITES

- pi-maestro-flow 已安装
- 目标 MCP server 的接入信息（server URL / npm 包名 / 命令行 + args）
- 浏览器可用（OAuth 流程需要）

## 配置文件位置（重要）

MCP 配置**多源发现**，不是单一文件（见 `src/mcp/config.ts` 的 `getConfigSources`）。按优先级：

| 源 id | 路径 | 说明 |
|---|---|---|
| shared-global | `~/.config/mcp/mcp.json` | 通用标准 MCP 配置（与 cursor/claude 共享） |
| pi-global | `~/.pi/agent/mcp.json` | Pi 全局覆盖（Pi 写入优先写这里） |
| shared-project | `<cwd>/.mcp.json` | 项目标准 MCP 配置 |
| pi-project | `<cwd>/.pi/mcp.json` | 项目 Pi 覆盖 |

Pi 默认把新 server 写入 **pi-global**（`~/.pi/agent/mcp.json`）。项目专属 server 写 `.mcp.json` 或 `.pi/mcp.json`。

配置结构（所有源统一）：
```json
{
  "mcpServers": {
    "github": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-github"],
      "env": { "GITHUB_TOKEN": "ghp_..." }
    },
    "remote-api": {
      "url": "https://api.example.com/mcp",
      "auth": "oauth"
    }
  },
  "imports": ["cursor"]
}
```

- `mcpServers` 的 key 是 server 名，value 是 `ServerEntry`
- `imports`（可选）从其他客户端（cursor/claude-code/codex/windsurf）导入 server
- **不是** `servers` 键——必须是 `mcpServers`

`ServerEntry` 字段（stdio server 用 command/args/env/cwd；HTTP server 用 url/headers/auth）：
- `enabled?: boolean` — 是否加载（默认 true）
- `command?: string` + `args?: string[]` + `env?: Record<string,string>` + `cwd?: string` — stdio transport
- `url?: string` + `headers?: Record<string,string>` — HTTP transport
- `auth?: "oauth" | "bearer" | false` — 认证类型（url 存在时默认 OAuth 自动发现）
- `bearerToken?` / `bearerTokenEnv?` — bearer 认证用
- `oauth?: OAuthConfig | false` — 显式 OAuth 配置（可选，默认动态注册）

## TASK

### 1. 交互式收集 server 信息

向用户询问要注册的 server（见 INTERACTIVE INPUTS）。

### 2. 注册 server

**推荐用 `/mcp` 命令**（交互式 TUI，正确处理多源发现、imports、provenance）：
```
/mcp
```

脚本化写入 pi-global（仅当用户明确要求跳过 TUI；写入 `mcpServers`，保留已有 server）：
```bash
node -e '
const fs=require("fs"),os=require("os"),p=require("os").homedir()+"/.pi/agent/mcp.json";
const cfg=fs.existsSync(p)?JSON.parse(fs.readFileSync(p,"utf8")):{mcpServers:{}};
cfg.mcpServers=cfg.mcpServers||{};
cfg.mcpServers[process.env.PI_MCP_NAME]=JSON.parse(process.env.PI_MCP_ENTRY);
fs.writeFileSync(p,JSON.stringify(cfg,null,2));
console.log("wrote",p);
'
```

`PI_MCP_ENTRY` 是 ServerEntry JSON，例如：
- stdio: `{"command":"npx","args":["-y","@modelcontextprotocol/server-github"],"env":{"GITHUB_TOKEN":"ghp_..."}}`
- HTTP+OAuth: `{"url":"https://api.example.com/mcp","auth":"oauth"}`

**校验点**：`/mcp` 列出新注册的 server。

### 3. OAuth 认证（若 server 需要）

```
/mcp auth <server-name>
```

该命令打开浏览器完成 OAuth，token 写入 Pi 内部凭证（非 mcp.json）。OAuth server（`auth:"oauth"` 或 url 存在且无 bearer）必须走此流程，**不要手填 token**。

**校验点**：AI 调用该 server 工具时不再返回 401；`/mcp` 面板显示该 server 已认证。

## INTERACTIVE INPUTS

1. **server 名称**（`ctx.ui.input`，"MCP server 名称"，placeholder `github`）：
   - 写入 `PI_MCP_NAME`
2. **接入方式**（`ctx.ui.select`）：
   - 选项：`远程 URL（HTTP/SSE）` / `本地 npm 包（stdio）` / `本地命令（stdio）`
3. **根据接入方式收集**：
   - 远程：`ctx.ui.input` 问 URL（placeholder `https://api.example.com/mcp`）→ entry `{"url":"...","auth":"oauth"}`
   - npm：`ctx.ui.input` 问包名（placeholder `@modelcontextprotocol/server-github`）→ entry `{"command":"npx","args":["-y","..."]}`
   - 命令：问 command + args
4. **环境变量**（`ctx.ui.input`，"需要的 env（KEY=VALUE 逗号分隔，可空）"）：拼入 entry 的 `env`
5. 组装 `PI_MCP_ENTRY` JSON
6. **是否需要 OAuth**（`ctx.ui.confirm`）：若是 HTTP server，配置后提示运行 `/mcp auth <name>`

## VERIFY

```bash
# 列出已注册 server + 认证状态
/mcp

# 检查配置文件（pi-global 优先）
cat ~/.pi/agent/mcp.json
```

**预期**：新 server 出现在 `/mcp` 列表且 `enabled`；若需 OAuth，`/mcp auth <name>` 成功后 AI 调用该 server 工具无 401。

## ROLLBACK

- 从 `~/.pi/agent/mcp.json` 的 `mcpServers` 删除该 server 条目（或用 `/mcp` 面板删除）
- OAuth 撤销：`/mcp auth --clear <name>` 清除凭证；到 provider 后台 revoke token
- imports 导入的 server：从 `imports` 数组移除对应客户端名
