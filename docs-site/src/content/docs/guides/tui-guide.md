---
title: "TUI 操作指南"
icon: "⌨️"
---

套件内置多个终端 TUI（Text User Interface）配置与状态界面。本文覆盖：**各 TUI 的打开方式与按键映射**、**每个 TUI 中的配置项详解**，并提供**交互式模拟器**直观展示配置面板。

---

## 关于"把 TUI 嵌入网页"

真实 TUI 运行在 Pi 的终端运行时内（依赖会话上下文、stdin/stdout 与扩展环境），**无法直接嵌入浏览器 HTML**。为便于介绍配置项，本站提供：

1. **交互式模拟器**（下方）——按真实按键与配置数据复刻的 HTML 界面，可实际操作；
2. **配置项表格**——每个 TUI 暴露的全部设置项、类型与默认值，来自插件源码。

> 模拟器仅用于展示与教学，真实配置请以 Pi 会话中的 `/maestro-settings` 等界面为准。

## 交互式模拟器

`/maestro-settings` 设置面板模拟器：支持 `←→` 切换插件、`↑↓` 选择、`Tab` 切换 global/project 范围、`Enter` 编辑、`Space` 切换布尔、`Ctrl+S` 应用、`Esc` 关闭（二次放弃）。点击行可选中，双击可编辑。

```tui-sim
settings
```

## 通用约定

| 按键 | 含义 |
|------|------|
| `Esc` | 关闭 / 返回 / 取消筛选 |
| `Esc`（有未保存修改时） | 第一次提示放弃，**再次按 Esc 才真正放弃** |
| `Enter` | 编辑 / 确认 / 保存 |
| `Tab` | 切换范围 / 来源 / 分栏 |
| `↑↓` 或 `Ctrl+↑↓` | 选择 / 排序 |
| `Space` | 切换开关（增删/勾选） |
| `Ctrl+S` | 保存 / 应用 / 同步 |
| `Ctrl+U` | 编辑态清空输入 |
| 直接输入文字 | 大部分列表界面支持即输即筛（filter） |

> 所有 TUI 的底部提示行（footer）都会实时显示当前可用按键，无需记忆。

---

## 1. 统一设置面板 `/maestro-settings`

聚合 Cockpit、Flow、Teammate 与集成的全部设置。

| 按键 | 说明 |
|------|------|
| `←→` | 切换插件（provider） |
| `↑↓` | 选择设置项 |
| `Tab` | 切换范围（global 全局 / project 项目） |
| `Enter` | 修改选中项 |
| `Ctrl+S` | 应用修改 |
| `Ctrl+L` | 切换界面语言 |
| `F5` | 重载配置 |
| `Esc` | 关闭（有未保存修改时再按一次放弃） |

操作流程：**选择插件 → 选择设置项 → 修改 → Ctrl+S 应用**。列表项的布尔开关用 `Space` 切换。

### 1.1 Flow 插件配置项

| 配置项 | 类型 | 默认 | 说明 |
|--------|------|------|------|
| `compaction.enabled` | boolean | `true` | Compaction 总开关 |
| `compaction.reserveTokens` | integer | `16384` | 响应预留 Token |
| `compaction.keepRecentTokens` | integer | `20000` | 保留近期 Token |
| `compaction.model` | string | 跟随会话 | 压缩摘要模型（`provider/id`） |
| `compaction.soft.enabled` | boolean | `true` | 软压缩开关 |
| `compaction.soft.nudgeRatio` | number | `0.7` | 提示压缩满度比 |
| `compaction.soft.pruneRatio` | number | `0.8` | 开始修剪满度比 |
| `compaction.soft.pruneTargetRatio` | number | `0.7` | 修剪目标满度 |
| `compaction.soft.velocity.enabled` | boolean | `false` | 速率感知加速 |
| `compaction.soft.cache.enabled` | boolean | `true` | 缓存感知修剪 |
| `compaction.soft.cache.minRatioRange` | json | `[0.1, 0.5]` | 缓存收益区间 |
| `compaction.soft.timeBased.enabled` | boolean | `false` | 时间感知 |
| `compaction.soft.relevance.enabled` | boolean | `false` | 相关度排序 |
| `compaction.soft.relevance.mode` | enum | `bm25` | `bm25` / `keyword` |
| `compaction.soft.crossTurnDedup.enabled` | boolean | `false` | 跨轮去重 |
| `compaction.soft.crossTurnDedup.minLines` | integer | `3` | 去重最小行数 |
| `compaction.soft.crossTurnDedup.minChars` | integer | `40` | 去重最小字符数 |
| `compaction.soft.lossless.enabled` | boolean | `true` | 无损格式折叠 |
| `failover.enabled` | boolean | `false` | 模型故障转移开关 |
| `failover.fallbackModels` | json | `{}` | 备用模型链（`{"model": ["b"]}`） |
| `compaction.manage` / `failover.manage` / `permissions.manage` / `skills.manage` / `mcp.manage` / `hooks.manage` | action | — | 打开对应外部 TUI |
| `responseLanguage.manage` | enum | `default` | `default` / `zh-CN` |
| `compaction.derived` / `failover.overview` | overview | — | 只读生效值视图 |

### 1.2 Cockpit 插件配置项

| 配置项 | 类型 | 默认 | 说明 |
|--------|------|------|------|
| `enabled` | boolean | `true` | Cockpit 总开关 |
| `quietMode` | boolean | `false` | Quiet 模式（压缩工具输出/折叠思考） |
| `quietSymbols` | enum | `check` | `check`（✓/✗/⋯）或 `dot`（●/○/◌） |
| `toolPalette` | enum | `classic` | `classic` / `family` / `readwrite` / `search` / `mono` |
| `agentsMode` / `todoMode` | enum | `list` | `list` / `compact` |
| `todoExpanded` | boolean | `false` | Todo 默认展开 |
| `hideNativeAgents` | boolean | `true` | 隐藏原生 Agent 组件 |
| `sidebar.mode` | enum | `auto` | `auto` / `on` / `off` |
| `sidebar.width` | integer | `40` | 侧栏宽度（32-56） |
| `sidebar.density` | enum | `comfortable` | `comfortable` / `compact` |
| `icons.mode` | enum | `auto` | `auto` / `nerd` / `ascii` |
| `theme` | action | — | 打开 `/theme` 主题选择器 |
| `thinkingFold` | action | — | 思考折叠开关 |
| `title.enabled` 等 | — | — | 终端标题各子项，见 [Pi Cockpit](/guides/cockpit) |

### 1.3 其他插件配置项

| 插件 | 配置项 | 类型 | 说明 |
|------|--------|------|------|
| API | `api.providers` | list | Provider 列表 CRUD（启用/停用/编辑） |
| API | `api.retry.enabled` | boolean | API 重试开关（默认 `true`） |
| API | `api.retry.maxRetries` | integer | 最大重试次数（默认 `12`） |
| API | `api.overview` | overview | Provider 只读诊断视图 |
| MCP | `mcp.servers` | list | MCP 服务器（启用/停用/删除/导入） |
| MCP | `mcp.editConfig` | action | 打开配置文件编辑器 |
| MCP | `mcp.overview` | overview | MCP 只读诊断视图 |
| Skills | `skills.enabled` | boolean | 技能系统开关 |
| Skills | `skills.overview` | overview | 技能只读诊断视图 |
| Teammate | `routing.manage` | action | 打开 taskType→模型映射 TUI |

> `overview`（只读视图）展示三来源合并后的生效值（project / user / default）；`action` 项会打开独立的外部 TUI。

## 2. Cockpit 设置 `/cockpit`

打开设置覆盖层后：

1. 用方向键（或按 `z`）移动到目标行；
2. `Enter` 进入编辑；
3. 输入新值，`Enter` 保存；
4. 清空并保存可恢复默认（如 `title gen model` 留空即回到规则提取）。

常用子命令：`/cockpit sidebar auto|on|off`、`/cockpit quiet`、`/cockpit sidebar resize`（或 `Ctrl+Shift+R` 进入 Resize 模式：方向键调整列宽，`Enter` 接受，`Esc` 回滚）。

```tui-sim
cockpit
```

## 3. API Manager `/api-manager`

Provider 管理界面，底部按键随状态变化：

### 列表态（normal）

| 按键 | 说明 |
|------|------|
| `↑↓` / `Tab` | 选择 Provider / 字段 |
| `Enter` | 编辑选中项 |
| `←→` / `Space` | 切换开关（启用/停用） |
| `Ctrl+S` | 继续 / 保存 |
| `Esc` | 取消 |

### 编辑态（edit）

| 按键 | 说明 |
|------|------|
| `Enter` | 确认 |
| `Ctrl+U` | 清空输入 |
| `Backspace` | 删除字符 |
| `Esc` | 返回 |

**Provider 字段**：`id`、`api`（协议）、`baseUrl`、`modelId`、`contextWindow`、`maxTokens`。
**敏感字段（secret）规则**：留空并确认 = 保留当前值；输入后确认会清空旧值。
**操作子命令**：`list` / `configure` / `enable|disable` / `toggle` / `retry` / `effort` / `vision` / `logout`。

```tui-sim
api
```

## 4. 模型故障转移设置

入口：`/maestro-settings` → pi-maestro-flow 插件 → 故障转移 → **管理**（打开专用 TUI）。

| 按键 | 说明 |
|------|------|
| `Esc` | 关闭 |
| `E` | 启用/停用自动故障转移 |
| `Tab` / `←→` | 切换分栏（模型列表 ↔ 备用链） |
| `↑↓` | 选择模型 |
| `Space` | 增删备用链成员 |
| `Ctrl+↑↓` | 调整备用链顺序 |
| `Ctrl+S` | 保存 |
| 输入文字 | 筛选（Esc 取消筛选） |

**配置项**：`enabled`（是否启用自动故障转移）、`fallbackModels`（模型 → 备用链映射）。持久化于 `~/.pi/agent/model-failover.json`，详见 [API Provider 配置](/guides/api-provider-config)。

```tui-sim
failover
```

## 5. Smart Search 配置 `Alt+S` / `/smart-search-config`

| 按键 | 说明 |
|------|------|
| 输入文字 | 按 provider/能力/键 筛选配置项 |
| `PgUp` / `PgDn` | 翻页 |
| `Enter` | 编辑选中项 |
| `Tab` | 切换配置源（Smart Search ↔ web-search.json） |
| `Ctrl+S` | 同步到 `~/.pi/web-search.json` |
| `Esc` | 关闭 |

编辑态：`Enter` 保存 · `Esc` 返回 · `Ctrl+U` 清空 · `Backspace` 删除。行尾同步状态标注：`✓ synced` / `⚠ conflict` / `→ smart-only` / `← web-only`。

**配置项**：全部 Provider 的 API Key（Perplexity / OpenAI / Brave / Exa / Gemini / Tavily / Firecrawl / SearXNG / xAI / 智谱 / Jina…）、搜索策略（validation / fallback / provider 偏好）、SSRF 防护、Intent Router。完整清单见 [Smart Search Provider 配置](/guides/smart-search-provider-config)。

```tui-sim
smartsearch
```

## 6. MCP 管理器 `/mcp`

服务器管理（启用/停用/删除/配置导入）：

- 列表导航：`↑↓` + `Enter` 选中；
- OAuth 认证：选中服务器后 `Enter` 或 `Ctrl+A` 启动认证流程；
- `Ctrl+R` 重载元数据；
- `Ctrl+S` 保存配置。

首次配置时出现引导式设置面板（导入 / 脚手架 / 仓库提示）。服务器字段：`command`、`args`、`env`、`enabled`、`excludeTools`。

```tui-sim
mcp
```

## 7. Hooks 安装器 `/maestro-hooks`

| 按键 | 说明 |
|------|------|
| `↑↓` | 选择钩子 |
| `/` | 筛选（输入名称/事件/级别，Esc 取消） |
| `Space` | 勾选/取消 |
| `A` | 应用所选 |
| `U` | 卸载 |
| `Esc` | 关闭（有未应用修改时再按一次放弃） |

**配置项**：`maestroHookDefinitions` 预设钩子（按预设合并）、开关持久化（`setHookEnabled`）、信任状态（`trustHookConfig` / `revokeHookConfigTrust`）。详见 [Hooks 自动化](/guides/hooks-keybindings)。

```tui-sim
hooks
```

## 8. 模型映射 `Alt+M` / `/teammate-models`

配置 taskType → 模型映射的覆盖层。映射自动合并内置类型、发现的 Agent YAML 类型与已有映射；自定义 Agent 可声明新的小写类型标识。配置项即 `taskType` → `model` 的映射表，见 [模型路由](/guides/model-routing)。

```tui-sim
routing
```

## 9. 后台任务 `Alt+J`

bash_bg 任务实时状态覆盖层：命令、cwd、耗时、输出尾部，支持逐任务操作。

```tui-sim
bgjobs
```

## 10. 主题选择 `/theme`

带实时预览的主题切换：`/theme` 打开选择器，`/theme <name>` 直接应用。配置项：`theme`（命名主题覆盖，空跟随会话）。

```tui-sim
theme
```

## 11. 状态类覆盖层（只读）

| 覆盖层 | 触发 | 内容 |
|--------|------|------|
| Goal 面板 | Goal 存在时自动 | 状态、目标、时间、循环、Token 预算 |
| Todo 覆盖层 | todo 操作时 | 任务列表与状态 |
| Session 覆盖层 | `/maestro-session` | 工作流会话控制中心 |
| Maestro 面板 | maestro 操作时 | 运行状态与进度 |
| Swarm 覆盖层 | `/swarm` | 蚁群优化状态、拓扑、指标 |
| 进度树 | teammate 执行时 | Agent 执行进度 |
| Attach 覆盖层 | teammate 启动时 | 附加到子进程 |
| 状态栏 | 持续 | 模式、压缩状态、MCP 连接 |

## 12. 技巧与安全

- **未保存修改保护**：所有编辑类 TUI 对"未应用修改后按 Esc"做二次确认，误触不会丢配置；
- **即输即筛**：长列表（Provider、钩子、配置项）直接打字过滤，比翻页快；
- **窄屏降级**：窗口过窄时底部提示切换为精简版（如设置面板的 helpNarrow），关键操作不变；
- **项目只读**：某些项目级配置在工作区不可写时只读（TUI 会提示原因）；
- **作用域**：`Tab` 切换 global/project 范围，可编辑性随范围变化（`◐` 双范围可写，`●` 当前范围可写）。

## 下一步

- [设置系统总览](/guides/settings-overview) — 配置文件与作用域
- [Smart Search Provider 配置](/guides/smart-search-provider-config) — 搜索配置 TUI 详解
- [Pi Cockpit 可视化](/guides/cockpit) — 界面设置
- [API Provider 与模型故障转移](/guides/api-provider-config) — Provider 与熔断配置
