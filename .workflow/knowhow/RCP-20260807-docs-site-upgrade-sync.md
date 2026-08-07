---
title: 版本升级时同步更新文档站指南
description: 发布新版本时同步刷新文档站的完整清单 — 安装版本号、Pi 基线、功能变动指南更新、顶部 banner 与构建验证
type: recipe
category: workflow
explicitId: rcp-20260807-docs-site-upgrade-sync
created: 2026-08-07T08:00:00.000Z
keywords:
  - docs-site
  - release
  - upgrade
  - version
  - banner
  - install
---

# 版本升级时同步更新文档站指南

发版（`pi install npm:pi-maestro-flow@<新版本>`）后，文档站与仓库文档必须与发布说明（RELEASE.md）保持一致。以下清单来自 v0.14.2 → v0.16.0 的实际升级执行。

## 1. 安装版本号同步（必做，9 处）

搜索 `pi-maestro-flow@<旧版本>`，全部替换为新版本：

```bash
grep -rn 'pi-maestro-flow@' README.md README_EN.md GUIDE.md docs/USAGE.md docs/USAGE_EN.md docs-site/src/content/docs/guides/install.md docs-site/src/content/docs/guides/quick-start.md
```

典型位置（v0.14.2 → 0.16.0 时共 9 处）：

| 文件 | 位置 |
|------|------|
| `README.md` | 安装段落 |
| `README_EN.md` | 安装段落 |
| `GUIDE.md` | §Install + §Quick Reference（2 处） |
| `docs/USAGE.md` | 安装段落 + 快速参考（2 处） |
| `docs/USAGE_EN.md` | 同 USAGE.md（2 处） |
| `docs-site/src/content/docs/guides/install.md` | 安装代码块 |
| `docs-site/src/content/docs/guides/quick-start.md` | 安装代码块 |

## 2. 核对 Pi 宿主基线

- `packages/*/package.json` 的 `devDependencies` 锁定的 `@earendil-works/pi-*` 版本是**验证基线**（peer 为 `*`，宿主提供）；
- RELEASE.md 的 Highlights 可能提到更高版本兼容（如 v0.16.0 兼容 Pi `0.84` dynamic TUI）；
- 文档站 `install.md` 前置条件表的基线表述要同时反映两者：`≥ 验证基线` + 兼容说明。

## 3. 按 RELEASE.md 功能变动更新指南（重点）

逐条把 Release Highlights 映射到对应指南页：

| RELEASE 亮点 | 更新位置 |
|--------------|---------|
| In-Shell 设置套件（不再跳 native picker） | `guides/settings-overview.md` |
| 会话级知识治理 / evidence staging / promote 裁决 | `guides/knowledge.md` |
| teammate todo 绑定 / agent:// 记录 / steer 降级 | `guides/teammate-dispatch.md` + `guides/goal-plan-todo.md` |
| compaction 加固清单 | `guides/compaction-config.md` |
| self-evolve 新阶段 | `guides/architecture.md` + `LandingPage.tsx` 特性卡片 |
| companion 版本错配崩溃排障 | `guides/install.md` 常见问题 |

## 4. 顶部 banner 更新

文档站有 `AnnouncementBanner`（TopBar 下固定条，可关闭并 localStorage 持久化）：

- 文案在 `docs-site/src/client/i18n/locales/zh-CN.json` 与 `en.json` 的 `announcement` 块（title / install / close）；
- 高度经 `--size-banner-height`（globals.css）与 `--banner-offset` 变量联动内容 padding 与 Sidebar 定位，无需改布局；
- 版本号与安装命令必须与新版本一致。

## 5. 构建验证（必做）

```bash
cd docs-site && npm run build    # tsc + vite build
```

浏览器实测要点：banner 位于 TopBar 下、可关闭且关闭后 padding 恢复（56px）、中英文案均正确、无布局错乱。banner 状态存 `localStorage['docs-site-banner-dismissed']`。

## 6. 常见陷阱

- **不要只改 README**：GUIDE/USAGE/文档站各有独立副本，漏改会在文档站显示旧命令；
- **dist 不提交**：`docs-site/dist` 已被 .gitignore 忽略，构建产物不入库；
- **companion 版本错配**：用户若报 `TypeError: Cannot read properties of undefined (reading 'runtime')`，是旧版 teammate 本地覆盖被保留（日志 `Preserved local companion override`），需升级本地覆盖或删除后重装——该排障已写入 `guides/install.md` 常见问题。
