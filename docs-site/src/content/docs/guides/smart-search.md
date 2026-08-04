---
title: "网络搜索与深度研究"
icon: "🔍"
---

**smart_search** 提供外部信息检索：快速搜索、多源深度研究、URL 内容提取。架构与 Provider 配置见[Smart Search Provider 配置](/guides/smart-search-provider-config)。

---

## 三种模式

| 模式 | 用途 | 关键参数 |
|------|------|---------|
| `search` | 快速查询 | `platform`、`validation` |
| `research` | 多源深度研究 | `budget`（quick/standard/deep）、`validation`（strict） |
| `fetch` | 提取已知 URL 内容 | — |
| `route` | 路由诊断 | `router_mode` |

## 使用示例

```javascript
// 快速搜索
smart_search({ mode: "search", query: "Express.js 中间件错误处理最佳实践" })

// 深度研究（多源交叉验证）
smart_search({ mode: "research", query: "JWT vs Session 认证对比", budget: "deep", validation: "strict" })

// 抓取已知 URL
smart_search({ mode: "fetch", query: "https://docs.example.com/api/auth" })
```

## 双路径架构

自动降级，两条路径：

```
smart_search("query")
  ├─ Python CLI 路径 (默认)
  │   配置: %LOCALAPPDATA%/smart-search/config.json (Win)
  │         ~/.config/smart-search/config.json (Linux/macOS)
  │   要求: 至少配置 main_search + docs_search + web_fetch 各一个 provider
  │
  └─ Native TS 路径 (自动降级 / native:true 强制)
      配置: ~/.pi/web-search.json
      优势: Exa/AnySearch 零配置可用，无需任何 API key
```

当 Python CLI 因缺少配置报错（`config_error`）时，search/fetch 模式自动降级到 Native TS 路径。

## 零配置可用

| Provider | 说明 | 限制 |
|----------|------|------|
| **Exa** | 零配置，自动走 MCP 代理 | 免费额度有限 |
| **AnySearch** | 匿名搜索，无需 key | 仅搜索，无内容提取 |

```javascript
smart_search({ mode: "search", query: "your query" })   // 开箱即用
```

## 配置界面

通过 `Alt+S` 或 `/smart-search-config` 打开 TUI 配置界面：

- **输入关键词** 过滤配置项（如 `exa`、`gemini`、`brave`）；
- **Enter** 编辑选中项；
- **Tab** 切换配置源（Smart Search ↔ web-search.json）；
- **Ctrl+S** 同步配置到 `~/.pi/web-search.json`；
- **Esc** 返回 / 关闭。

## 使用建议

- **外部事实**用 smart_search，**项目行为**走[知识系统](/guides/knowledge)知识门；
- 混合问题时先查外部事实，再查项目行为，最后综合；
- 安全/合规声明使用 `validation: "strict"` 交叉验证，并对照权威来源。

## 下一步

- [Smart Search Provider 配置](/guides/smart-search-provider-config) — 全部 Provider 与 API Key 配置
- [知识系统](/guides/knowledge) — 内部知识与外部检索的分工
- [环境变量速查](/guides/env-vars) — 搜索相关环境变量
