---
title: "MCP 集成"
icon: "🔌"
---

插件内置完整的 MCP（Model Context Protocol）客户端，通过统一的 `mcp` 代理工具连接外部 MCP 服务器，支持 OAuth 自动认证与三种传输协议。

> 设计原则：不将 MCP 服务器的数百个工具逐一注册到 Pi，而是通过单一 `mcp` 代理工具统一访问，保持 LLM 上下文精简。

---

## 基本操作

```javascript
// 查看服务器状态
mcp({ })

// 列出服务器的工具
mcp({ server: "server-name" })

// 搜索工具（按名称/描述）
mcp({ search: "query" })
mcp({ search: "pattern.*", regex: true })

// 查看工具详情和参数
mcp({ describe: "tool_name" })

// 连接服务器并刷新元数据
mcp({ connect: "server-name" })

// 调用工具
mcp({ tool: "tool_name", args: '{"key": "value"}' })
mcp({ server: "server-name", tool: "tool_name", args: '{"key": "value"}' })
```

## OAuth 认证

```javascript
// 启动手动 OAuth 流程，获取浏览器 URL
mcp({ action: "auth-start", server: "server-name" })

// 完成手动 OAuth
mcp({ action: "auth-complete", server: "server-name", args: '{"redirectUrl":"..."}' })

// 获取已完成 UI 会话的消息
mcp({ action: "ui-messages" })
```

## 传输协议

| 传输方式 | 说明 |
|----------|------|
| **stdio** | 本地进程通信（最常用） |
| **SSE** | Server-Sent Events HTTP 流 |
| **Streamable HTTP** | 可流式 HTTP 传输 |

## 高级特性

| 特性 | 说明 |
|------|------|
| **元数据缓存** | 持久化工具/资源元数据缓存（7 天 TTL），避免重复连接 |
| **NPX 解析** | 自动解析 `npx`/`npm exec` 二进制路径，避免 npm 父进程开销 |
| **输出守卫** | 大输出自动截断（默认 50KB / 2000 行），完整输出写入临时文件 |
| **Sampling** | 支持 MCP Sampling 请求（服务器请求 LLM 生成），需用户确认 |
| **UI 会话** | 支持 MCP UI 资源（`ui://` 协议），浏览器中渲染交互式界面 |
| **UI 流式** | `eager` / `stream-first` 两种 UI 流式模式 |
| **OAuth 提供者** | 完整 OAuth 客户端实现（注册、令牌存储、授权重定向） |
| **配置导入** | 从 Cursor / Claude Code / Claude Desktop / Codex / Windsurf / VSCode 导入配置 |
| **MCP 管理器** | TUI 管理界面（`/mcp`），启用/停用/删除服务器 |
| **资源工具** | MCP 资源自动转换为 `get_<name>` 工具 |
| **同意管理** | 工具调用同意管理，支持自动批准配置 |

## 配置

MCP 服务器在 Pi 配置文件中定义（用户级或项目级）：

```json
{
  "mcpServers": {
    "my-server": {
      "command": "npx",
      "args": ["-y", "@my/mcp-server"],
      "env": { "API_KEY": "..." },
      "enabled": true,
      "excludeTools": ["dangerous_tool"]
    }
  }
}
```

### 配置来源优先级

1. 项目级 `.pi/settings.json` / Pi 项目配置；
2. 用户级配置（`~/.pi/agent/settings.json` 等）；
3. TUI 导入（`/mcp` → 配置导入）。

## TUI 管理

| 入口 | 用途 |
|------|------|
| `/mcp` | MCP 管理器（启用/停用/删除/配置导入） |
| 首次配置 | 引导式设置面板（导入/脚手架/仓库提示） |
| 工具选择时 | MCP 面板（服务器工具浏览、搜索、调用） |

> MCP 管理器的完整按键映射见 [TUI 操作指南](/guides/tui-guide)。

## 下一步

- [MCPX 配置向导与连接监视器](/guides/mcpx) — 把 MCP 服务经 Cloudflare quick tunnel 安全暴露给公网
- [LSP 语言服务器与浏览器控制](/guides/lsp-browser) — 其他协议连接
- [设置系统总览](/guides/settings-overview) — 配置文件结构
- [环境变量速查](/guides/env-vars) — MCP 相关环境变量
