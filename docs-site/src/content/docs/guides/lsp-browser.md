---
title: "LSP 语言服务器与浏览器控制"
icon: "🌐"
---

**LSP** 提供语言服务器代码智能（诊断、定义、引用、重构）；**browser** 通过 CDP 控制 Chromium。

---

## 1. LSP — 语言服务器集成

连接语言服务器，提供代码智能功能：

| Action | 说明 |
|--------|------|
| `diagnostics` | 获取诊断信息（错误/警告） |
| `definition` | 跳转到定义 |
| `references` | 查找所有引用 |
| `hover` | 悬停信息（类型/文档） |
| `symbols` | 文件/工作区符号列表 |
| `rename` | 重命名符号 |
| `rename_file` | 重命名文件（更新引用） |
| `code_actions` | 可用代码操作 |
| `type_definition` | 跳转到类型定义 |
| `implementation` | 查找实现 |
| `status` | 语言服务器状态 |
| `reload` | 重新加载 |
| `capabilities` | 服务器能力 |
| `request` | 原始 LSP 请求 |

### 常用示例

```javascript
lsp({ action: "diagnostics", file: "src/auth/login.ts" })
lsp({ action: "definition", file: "src/auth/login.ts", line: 42, symbol: "validateToken" })
lsp({ action: "references", file: "src/auth/login.ts", line: 42, symbol: "validateToken" })
lsp({ action: "rename", file: "src/auth/login.ts", line: 42, symbol: "validateToken", new_name: "verifyToken", apply: true })
lsp({ action: "symbols", file: "*" })  // 工作区符号
```

### 自动诊断

插件注册了 **LSP 自动诊断**：文件编辑后自动触发诊断检查，及时暴露类型与语法错误。

## 2. browser — 浏览器控制

通过 CDP 控制 Chromium，支持命名标签页、截图和页面内 JavaScript 执行：

| Action | 说明 |
|--------|------|
| `open` | 打开/附加浏览器标签页 |
| `close` | 关闭标签页（`all: true` 关闭全部） |
| `run` | 在页面中执行 JavaScript |

### 常用示例

```javascript
// 打开页面（命名标签页，可复用）
browser({ action: "open", url: "http://localhost:3000", name: "app" })

// 执行 JS + 截图
browser({
  action: "run",
  name: "app",
  code: "await page.screenshot({ path: 'screenshot.png' }); return document.title;"
})

// 设置视口
browser({ action: "open", url: "...", viewport: { width: 1920, height: 1080 } })

// 关闭
browser({ action: "close", name: "app" })
browser({ action: "close", all: true })
```

### 配置项

| 参数 | 说明 |
|------|------|
| `app.path` | 自定义 Chromium/Chrome/Edge 可执行文件路径 |
| `app.cdp_url` | 连接已有浏览器 CDP 端点 |
| `wait_until` | 导航等待策略（load / domcontentloaded / networkidle0 / networkidle2） |
| `dialogs` | 对话框处理（accept / dismiss） |

## 下一步

- [MCP 集成](/guides/mcp) — 其他协议连接
- [网络搜索与深度研究](/guides/smart-search) — 外部信息检索
- [权限系统](/guides/permissions) — 只读工具豁免列表（含 lsp 类操作）
