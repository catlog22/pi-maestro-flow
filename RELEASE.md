# Release v0.4.13 — 2026-07-22

## 概述

v0.4.13 将 Pi 的 Session/Run 控制壳与执行降级路由对齐到 Maestro Flow 0.5.54，并大幅强化 teammate 子代理的生命周期管理与可观测性（流式状态、运行指标、停滞状态回收）。同时稳定 Goal 自动续跑与单回合确认、收紧 Goal 验证重试与输出长度，完善 Todo 工具（member selector 支持 unique id prefix、skills 参数 schema 稳定化），并收紧 API Manager 新增认证配置。

> **本版本取代 v0.4.12**：0.4.12 误将 `pi-maestro-teammate` pin 在 0.4.5，未包含下述 teammate 子代理特性。v0.4.13 同步发布 `pi-maestro-teammate@0.4.6` 并将依赖升级至 0.4.6，使这些特性随产物交付。

## 详细变更

### Session/Run 控制壳与执行契约

- 同步 Session Run 控制壳（`run-control`），Pi 通过 canonical writer 驱动 Session 生命周期（`2d684ba7`）。
- 同步 execute 降级路由：缺少 current-plan 时优雅降级而非卡死，并批量收口 pending 变更（`581141b3`）。
- 完善 Pi Run Session 适配层（`55709240`）与 Run Control 工具描述（`94808312`）。
- Maestro runtime 依赖从 `0.5.53` 精确升级到 `0.5.54`，确保 Pi 与 CLI schema/response 同步。

### Teammate 子代理生命周期与可观测性

- 区分 teammate 结果依赖与子代理，避免依赖关系误判（`0c292ccb`）。
- 显示子代理流式状态，提升多代理执行透明度（`eaf6d5dd`）。
- 修复 teammate 子代理生命周期与状态回收，防止泄漏与僵尸状态（`768ebca8`）。
- 补全代理运行指标与停滞状态检测（`3c3a3c0f`），并记录代理进度指标投影规则（`e6b1c16c`）。
- 完善 teammate Agent 选择器（`a64c5542`）。

### Goal 自动续跑与确认

- 恢复 Goal 自动续跑与 Todo 上方显示（`4a7076b8`），简化 Goal 单回合确认（`5f8b4203`）。
- 自动续跑未确认的 Goal（`c7379b92`），刷新 Goal 时间并隔离续跑归属（`2404ab64`）。
- 限制 Goal 验证重试次数与输出长度，防止失控循环（`58273a20`）。

### Todo 工具

- Todo member selector 支持 unique id prefix 匹配：无 `#` 的选择器若唯一匹配单个 actor 则命中，歧义前缀返回显式错误（`351397b2`）。
- 稳定 Todo skills 参数 schema（`19611661`）。
- 移除状态栏 Todo 重复显示（`a524d79d`）。

### API Manager

- 收紧 API Manager 新增认证配置，防止误配置（`6d54c5ae`）。

## 版本

| 包 | 旧版本 | 新版本 |
|---|---:|---:|
| `pi-maestro-flow` | 0.4.12 | 0.4.13 |
| `pi-maestro-teammate` | 0.4.5 | 0.4.6 |
| `maestro-flow` 运行依赖 | 0.5.53 | 0.5.54 |

## 验证

- TypeScript `check:types` 通过。
- Session/Run tests：49 项（48 通过 / 1 跳过 / 0 失败）。
- Todo tests：36 项通过。
- Teammate tests：174 项（173 通过 / 1 跳过 / 0 失败）。
- npm publish dry-run 验证两个包：`pi-maestro-flow@0.4.13`（canonical Pi skills、`maestro-flow@0.5.54`、`pi-maestro-teammate@0.4.6` 依赖）与 `pi-maestro-teammate@0.4.6`。

## 安装

```bash
pi install npm:pi-maestro-flow@0.4.13
```

也可以使用 npm：

```bash
npm install pi-maestro-flow@0.4.13
```

## 升级说明

升级后执行 `/reload` 或重启 Pi。Session/Run 控制现已通过 canonical writer 驱动并支持 execute 降级路由；teammate 子代理提供更细粒度的流式状态与运行指标。Todo member selector 现可用 unique id prefix 直接定位单个 actor。

**Full Changelog**: https://github.com/catlog22/pi-maestro-flow/compare/v0.4.11...v0.4.13
