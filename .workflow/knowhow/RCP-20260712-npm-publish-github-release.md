---
title: npm Publish + GitHub Release 发布流程
description: 完整的 npm 双包发布 + GitHub Release 创建流程，含 commit 分析、版本 bump、发布验证
type: recipe
category: workflow
created: 2026-07-12
tags: [npm,publish,release,github,versioning,workflow]
status: active
---

# npm Publish + GitHub Release 完整发布流程

## 目标

将 monorepo 中的多个 npm 包发布到 npm registry，同时在 GitHub 创建带 Release Note 的发版页面。

## 前置条件

- npm 账号已登录 `npm whoami`
- GitHub CLI (`gh`) 已安装并认证 `gh auth status`
- 仓库处于干净状态（无未提交变更）
- Node.js >= 18

## 步骤

### Step 1: 分析 commit 变更

```bash
# 查看从上个版本 tag 到 HEAD 的所有 commit
git log <last-tag>..HEAD --oneline --format="%h %ad %s" --date=short

# 统计变更文件
git diff <last-tag>..HEAD --stat

# 按包查看变更
git diff <last-tag>..HEAD --stat -- "packages/<pkg>/"
```

### Step 2: 撰写 RELEASE.md

基于 commit 分析结果撰写 release note，必须覆盖：
- 概述（本次发版的核心方向）
- 详细变更（按 commit 或功能域分组，标注文件路径和代码行数）
- 包版本对照表
- 统计数字（commits、文件数、代码行数）
- 安装命令和升级指南

### Step 3: Bump 版本

修改每个包的 `package.json` 中的 `version` 字段：

```bash
# 手动修改
sed -i 's/"version": "0.4.1"/"version": "0.4.2"/' packages/<pkg>/package.json

# 或使用 npm version
cd packages/<pkg> && npm version patch
```

### Step 4: npm 发布（推荐先 dry-run）

```bash
# Dry-run 验证
npm publish --dry-run --workspace=packages/<pkg-name>

# 实际发布
npm publish --workspace=packages/<pkg-name>
```

**关键参数**：
- `--workspace`：指定 workspace 包名（不是目录名）
- 不使用 `--access public`（私有包默认保持 private）

### Step 5: Git Commit + Tag + Push

```bash
# 提交 RELEASE.md 和版本变更
git add packages/<pkg>/package.json RELEASE.md
git commit -m "release: vX.Y.Z — <简短描述>"

# 创建 tag 并推送
git tag -a vX.Y.Z -m "vX.Y.Z — <中文标题>"
git push origin master --tags
```

### Step 6: 创建 GitHub Release

```bash
gh release create vX.Y.Z \
  --title "vX.Y.Z — <英文标题>" \
  --notes-file RELEASE.md
```

## 预期结果

- npm registry 出现新版本：`npm view <pkg> version`
- GitHub Releases 页面出现新发版：`https://github.com/<user>/<repo>/releases/tag/vX.Y.Z`
- 本地 tag 和 remote tag 一致：`git tag -l` + `git ls-remote --tags origin`

## 常见陷阱

| 陷阱 | 原因 | 解决 |
|------|------|------|
| npm publish 报 `pre-existing` | 版本号重复 | bump 到未使用的版本号 |
| gh release 报 `already exists` | tag 已存在 | 检查是否 push 过 tag |
| npm publish 但文件不全 | `files` 字段过滤 | 检查 package.json 的 `files` 字段 |
| 本地 git tag 和 remote 不一致 | 忘记 `--tags` | `git push --tags` |
| monorepo 包间版本依赖不一致 | 手改漏掉某个包 | 检查所有 `peerDependencies` 中的版本引用 |

## 参考

- 本次执行记录：`https://github.com/catlog22/pi-maestro-flow/releases/tag/v0.4.2`
- npm workspace publish 文档：`https://docs.npmjs.com/cli/v10/using-npm/workspaces`
