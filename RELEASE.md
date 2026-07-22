# Release v0.4.14 — 2026-07-22

## 概述

v0.4.14 为安全维护与依赖对齐版本：将 Maestro runtime 依赖精确升级到 `0.5.55`（带来 embedding HF 镜像下载特性与安全修补），并对本仓库执行 `npm audit fix --force` 修补 `fast-uri`。本版本只发布 `pi-maestro-flow`，`pi-maestro-teammate` 继续保持 0.4.6。

## 详细变更

### 依赖对齐

- Maestro runtime 依赖从 `0.5.54` 精确升级到 `0.5.55`，确保 Pi 与 CLI schema/response 同步。
- `maestro-flow@0.5.55` 带来：embedding 支持 `HF_ENDPOINT`/`HF_MIRROR` 镜像下载模型；`npm audit fix` 传递依赖安全修补（漏洞 15→5）。

### 安全

- `npm audit fix --force` 修补 `fast-uri` 3.1.3→3.1.4（漏洞 13→12）。
- 剩余 12 个漏洞（7 moderate / 5 high）位于外部 `@earendil-works/*` pi 运行时包（pi-coding-agent / pi-ai / pi-agent-core）及传递链（@modelcontextprotocol/sdk → @google/genai / @anthropic-ai/claude-agent-sdk），**本仓库无法修复**，需 pi harness 上游更新。

### 知识沉淀

- 发布流程 knowhow 新增「Step 1.5：检查 workspace 依赖包未发布变更」与 monorepo 依赖修正案例（v0.4.12→0.4.13）。

## 版本

| 包 | 旧版本 | 新版本 |
|---|---:|---:|
| `pi-maestro-flow` | 0.4.13 | 0.4.14 |
| `pi-maestro-teammate` | 0.4.6 | 0.4.6 |
| `maestro-flow` 运行依赖 | 0.5.54 | 0.5.55 |

## 验证

- TypeScript `check:types` 通过（与 `maestro-flow@0.5.55` parity）。
- npm publish dry-run 验证 package resources、canonical Pi skills 与 `maestro-flow@0.5.55` 依赖。

## 安装

```bash
pi install npm:pi-maestro-flow@0.4.14
```

也可以使用 npm：

```bash
npm install pi-maestro-flow@0.4.14
```

## 升级说明

升级后执行 `/reload` 或重启 Pi。本版本主要为依赖对齐与安全维护，无 API 变更；embedding 模型下载现可通过 `HF_ENDPOINT`/`HF_MIRROR` 走镜像。

**Full Changelog**: https://github.com/catlog22/pi-maestro-flow/compare/v0.4.13...v0.4.14
