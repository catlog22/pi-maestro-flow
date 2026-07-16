---
title: Pi 本地插件跨目录 Skill 发现修复
description: 诊断并修复 Pi 用户级本地插件只在仓库目录能发现 Skills 的问题
type: recipe
category: debug
created: 2026-07-15T22:28:51+08:00
tags: [插件发现, 技能路径, 本地安装, 用户配置]
status: active
---

# Pi 本地插件跨目录 Skill 发现修复

## Goal

当 `pi list` 显示本地插件已经安装，但插件 Skills 只在插件仓库目录可见时，区分 extension 加载、package 资源加载和项目自动发现，并恢复任意工作目录下的 Skill 发现。

## Prerequisites

- 能读取 Pi 用户配置 `~/.pi/agent/settings.json`。
- 已知本地插件仓库及其 canonical Skills 目录。
- Pi 支持 RPC `get_commands`，可用于无 LLM 调用的 fresh-process 验证。

## Steps

1. 在插件仓库外运行 `pi list`，确认 package 是用户级还是项目级登记。没有使用 `-l` 的 `pi install <local-path>` 会写入用户级配置，但这只证明 package 已登记，不证明它声明的每类资源都已加载。
2. 从仓库外启动 `pi --mode rpc --offline --no-session --no-context-files`，发送 `{"type":"get_commands"}`。分别检查 extension 命令和 `source: "skill"` 的命令，避免把“插件已加载”误判为“Skills 已加载”。
3. 检查插件 `package.json` 的 `pi.skills` 声明，并确认目标目录实际存在。例如声明 `./.pi/skills` 时，本地 package 根目录必须真实包含该目录。
4. 检查当前仓库根目录是否有 `.pi/skills`。项目目录内正常、仓库外异常，通常表示项目自动发现掩盖了 package Skill 资源缺失。
5. 对持续使用源码仓库的本地开发安装，在用户级 `~/.pi/agent/settings.json` 增加 canonical Skills 的绝对路径：

   ```json
   {
     "skills": [
       "D:\\pi-maestro-flow\\.pi\\skills"
     ]
   }
   ```

   合并时保留原有 `packages`、模型和认证字段，不要整体覆盖配置。
6. 校验配置仍是合法 JSON，且登记路径存在。完全退出旧 Pi 进程，再从仓库外启动 fresh Pi，并通过 RPC `get_commands` 确认目标 Skills 的 `sourceInfo.scope` 为 `user`、路径指向 canonical Skills 目录。

## Expected Outcome

- 插件 extension 命令和仓库 Skills 在任意工作目录均可发现。
- Skill 来源明确显示为用户级 canonical 路径，而不是依赖当前项目的 `.pi/skills` 自动发现。
- 无需复制或维护第二份长期 Skill 源。

## Common Pitfalls

- `pi list` 只列出配置中的 package，不能证明 `pi.skills` 指向的文件存在或已启用。
- 当前仓库的 `.pi/skills` 会自动发现，容易掩盖本地 package 内缺少 bundled Skills 的问题。
- 本仓库的 `prepare-package-skills.mjs` 在 `prepack` 时临时复制 Skills，`postpack` 会清理；手动 prepare 只能作为临时修复，不适合作为持续开发配置。
- npm 安装包通常包含打包后的 `.pi/skills`；源码路径安装与 npm 安装的资源形态不能混为一谈。
- 必须用 fresh Pi 进程验收，旧进程不会可靠反映资源配置变化。
- 读取 `settings.json` 时只输出待检查字段，避免把认证 token 写入日志或会话记录。

## Related

- `packages/pi-maestro-flow/package.json`：package 的 `pi.skills` 资源声明。
- `packages/pi-maestro-flow/scripts/prepare-package-skills.mjs`：打包前复制和打包后清理逻辑。
- `.pi/settings.json`：仓库本地开发的 Skill 路径配置。
- `~/.pi/agent/settings.json`：用户级 package 与 Skill 发现配置。
