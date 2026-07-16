# Release v0.4.9 — 2026-07-16

## 概述

v0.4.9 完成 Maestro Workflow Session 的运行闭环，并集中增强 Goal 验证、权限继承、SmartSearch、LSP / Browser 工具与 teammate 多任务运行时。该版本同时规范 Pi Skills 的源码与 npm 包资源形态，补齐 packed consumer 和跨目录本地插件发现验证。

## 详细变更

### Workflow Session 与 Goal 生命周期

- 接通 Session、Run、Todo、Goal 与 Workflow coordinator，补齐恢复、投影、状态展示和命令冲突处理。
- Goal 完成后由独立只读 verifier 基于原始证据给出结构化判定；缺失或无效 verdict 采用 fail-closed 策略。
- 阻止活跃工具回合中的陈旧 handoff prompt 注入，并新增 Goal widget、状态行和 compaction 可见性。
- 加固 Plan / Goal / Todo 运行门禁与 Session Run 验收文档，使 `Plan -> Goal -> Todo -> Execute` 保持一致。

### SmartSearch 与运行时工具

- 内置 SmartSearch 工具与完整配置 TUI，覆盖 provider、能力分组、过滤、分页和配置持久化。
- 集成 LSP、Browser、workspace edit、异步资源与 tool search 能力，并补齐 schema、类型检查和回归测试。
- 优化扩展工具注册与 child-only 加载路径，减少嵌套 teammate 对父 Session lease 的干扰。

### Teammate 0.4.4

- 统一根执行路径与代理路径的任务归一化、寻址和错误语义。
- 新增 `dependsOn`、per-task `context`、稳定任务命名、并发限制与结构化输出守护。
- 修复父级权限模式向 child Pi 的继承，明确 `dontAsk` fail-closed 与 `background: false` 的前台执行契约。
- 修复 attach overlay 在较矮终端中的高度预算、滚动保持、composer / footer 可见性和进度树展示。

### Skills、打包与文档

- 将 canonical Pi Skills 收敛到仓库根 `.pi/skills`，同步更新 Maestro、Ralph、Odyssey 与 Session Seal 等入口。
- 在 `prepack` / `postpack` 阶段准备并清理 package Skills，补齐资源测试与隔离 packed consumer 验证。
- 记录本地插件跨目录 Skill 发现、Pi extension authoring、tool schema 与 Session Run 集成规则。

## 版本

| 包 | 旧版本 | 新版本 |
|---|---:|---:|
| `pi-maestro-flow` | 0.4.8 | 0.4.9 |
| `pi-maestro-teammate` | 0.4.3 | 0.4.4 |

`pi-maestro-flow@0.4.9` 将 `pi-maestro-teammate` 的内部依赖约束更新为 `^0.4.4`。

## 变更统计

- 自 `v0.4.8` 起包含 35 个发布前功能、修复、测试、重构与文档提交。
- 涉及 722 个文件、95,811 行新增与 16,414 行删除，主要来自 Skills 资源迁移、Workflow Session 闭环、runtime 工具与双包测试扩展。
- `pi-maestro-flow` 227/227、`pi-maestro-teammate` 119/119 测试通过，共 346 个测试。
- TypeScript 类型检查、隔离 packed consumer 与双包 `npm publish --dry-run` 通过；flow tarball 为 583 个文件、约 1.1 MB。

## 安装

```bash
pi install npm:pi-maestro-flow@0.4.9
```

也可以使用 npm：

```bash
npm install pi-maestro-flow@0.4.9
```

仅安装 teammate：

```bash
npm install pi-maestro-teammate@0.4.4
```

## 升级说明

这是 patch 更新，要求 Node.js >= 20.6.0。升级后执行 `/reload` 或重启 Pi。

`pi-maestro-teammate@0.4.4` 会让多任务 `context: "fork"` 真正复制父会话，并让 `tasks` 优先于已废弃的 `chain`；依赖旧静默降级行为的调用方应先检查任务定义。源码路径安装与 npm 安装的 Skill 资源形态不同，源码开发安装应按本仓库 knowhow 配置 canonical Skills 路径。
