---
title: "MCPX 配置向导与连接监视器"
icon: "🧭"
---

`/mcpx` 配置向导把公开暴露的 MCP 服务（MCPX）引导式接入 Pi：从 README 配置一路走到 Cloudflare quick tunnel，配合独立的连接监视器 TUI 实时查看 MCP 服务器与客户端连接状态、start/stop 控制。

> MCPX 是「公开 MCP 暴露」层，与 [MCP 集成](/guides/mcp)（本地 MCP 客户端）互补：MCP 集成解决「Pi 调用本地/远程 MCP 工具」，MCPX 解决「把你的 MCP 服务安全地暴露给公网或云端」。

## /mcpx 配置向导

在 Pi 输入框输入 `/mcpx` 即可启动引导式配置向导（README 驱动）。向导按步骤推进：

- **步骤导航**：`Enter` 前进到下一步并展示选项；`Esc` 返回上一步；在向导中按 `c` 快捷直接打开连接监视器。
- **Cloudflare Quick Tunnel 步骤**：向导保留 Cloudflare quick tunnel 作为公网暴露通道（已移除多余的手动窗口注册路径，手动窗口注册保留为备选）。隧道可 auto-start，并在连接前预览 cloud MCP 连接效果；若 cloudflared 退出或超时，向导会 surface 具体原因（而非静默失败）。
- **动态工作区注册**：向导完成后，工作区注册带心跳租约（heartbeat lease）动态续约，断连后可被及时回收。

## 连接监视器 TUI

MCPX 连接监视器是一个独立 TUI，用于实时观测 MCPX 的连接拓扑：

- **服务器与客户端**：列出当前注册的 MCP 服务器及已连接的客户端连接。
- **start / stop 控制**：可直接在监视器中启动或停止 MCPX 服务。
- **从向导进入**：配置向导中按 `c` 即可切换到监视器查看实时状态。

## 升级与排障

- 隧道生命周期问题（cloudflared 退出/超时、心跳续约失败、e-key 回调路由）已在 v0.21.6 之后修复，若遇隧道无故中断请确认 pi-maestro-flow 已升级到含修复的版本。
- MCPX 与本地 MCP 客户端的配置位置不同：本地 MCP 客户端配置见 [MCP 集成](/guides/mcp)，MCPX 暴露层配置经 `/mcpx` 向导生成。

## 下一步

- [MCP 集成](/guides/mcp) — Pi 作为 MCP 客户端调用工具
- [设置系统总览](/guides/settings-overview) — 配置文件结构
- [TUI 操作指南](/guides/tui-guide) — 其他 TUI 面板与快捷键
