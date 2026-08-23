---
title: install 统一安装引导命令模式
type: recipe
created: 2026-08-23T03:37:28.948Z
---

# /install 统一安装引导命令模式

## 场景

为 pi-maestro-flow 插件增加统一安装功能，让用户一条命令选择可选安装项，AI 自主执行安装文档。

## 解决方案

- **安装项注册表** `src/install/install-items.ts`：InstallItem 接口（id/title/description/docFile/category/status/promptIntro），内置 5 项按 core→optional→external 排序。probeInstallStatus 探测各配置文件（auth.json/teammate-models.json/manifest/cli-tools.json/mcp-cache.json）判断状态。
- **AI 安装文档** `optional/<id>-setup.md`，统一 AI 指令格式：PURPOSE/PREREQUISITES/TASK/INTERACTIVE INPUTS/VERIFY/ROLLBACK。INTERACTIVE INPUTS 章节强制 AI 用 ctx.ui 交互式询问，不臆测。
- **/install 命令** `src/install/install-command.ts`：`/install list` 列出+状态；`/install <id>` 直选；无参 `ctx.ui.select` 交互式 TUI。选中后 `pi.sendUserMessage(composeInstallMessage, {deliverAs:"followUp"})` 注入文档全文，AI 自主执行。

## 关键 gotcha

- **sendUserMessage 不展开 /skill:name**（knowhow kg-spec-project-learnings-003）：注入的消息必须内联文档全文，不能依赖 slash 命令展开。composeInstallMessage 把 doc 全文拼进消息。
- **composeInstallMessage 结构**：promptIntro（用户可见引导）+ 执行指令（"请自主执行…INTERACTIVE INPUTS 用 ctx.ui 询问…VERIFY 后报告"）+ 文档全文。让 AI 明确这是要执行的指令而非参考。
- **TUI 降级**：`!ctx.hasUI` 时 notify error 并提示 `/install list`，不尝试无 UI 的 select。
- **status 探测不阻塞**：探测失败返回 unknown，不阻止选择。partial 用于"部分配置就绪"（如 manifest verified 但文件缺失）。

## 可复用模式

- 选装机制仿 `skill-manager-store.ts` 的 `OptionalSkill` / `loadOptionalSkills` / `installOptionalSkill`，但扩展到非 skill 资源。
- 文档定位复用 `resolvePackageOrWorkspaceResource(["optional", docFile])`，workspace fallback 支持本地开发。
- 打包：`package.json` files 已含 `optional/`，新文档自动入包；packaging 测试断言所有 docFile 入包且无模型权重。

## 验证

- install-command 8 测试（注册表/排序/入包/探测/组装）
- packaging 扩展断言 4 新 md 入包
- typecheck exit 0
- CU 套件 36/36 无回归
