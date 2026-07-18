# Release v0.4.10 — 2026-07-18

## 概述

v0.4.10 集中交付原生 Swarm runtime、增强后的 teammate 多代理执行、actor-aware Todo / Plan 交接、API Manager provider 配置，以及 Session/Run 生命周期加固。本版本同时将团队 Skills 迁移到 canonical `{run_dir}` 目录契约，并恢复全新安装环境中的 Workflow Session 自动 attach。

## 详细变更

### Swarm runtime 与团队 Skills

- 在 `packages/pi-maestro-flow/src/swarm/` 与 `src/tools/swarm.ts` 中加入原生 ACO Swarm controller、评分验证、收敛判断、进度发布和可视化状态。
- 增加私有 Ant、scorer、analyst 角色以及 Swarm overlay；私有 Ant 不暴露给普通 teammate 直接调度。
- 将 20 余个 team Skills 的 Session 路径统一迁移到 `{run_dir}/work/team`，正式产物进入 `{run_dir}/outputs`，证据进入 `{run_dir}/evidence`。
- 更新 ACO Python controller，使 `--run-dir` 能从 canonical outputs 读取 Ant 产物，同时保留旧 artifacts fallback。

### Teammate 0.4.5

- 加固 child process 生命周期、权限 broker、结构化输出 settlement、generation ownership、Windows 进程树清理与 bounded buffer。
- 提供稳定的 `pi-maestro-teammate/v1` 公共入口，覆盖 agents、execution、extension、child extensions、model routing 与 progress tree。
- 增强多任务模型 / thinking 路由、前台与后台语义、session handoff、attach overlay 和 agent 可观测性。
- 新增 Swarm 私有角色与更严格的角色发现边界。

### Todo、Plan、Goal 与 Session/Run

- Todo v5 支持 `createdBy`、`assignee`、按 actor 激活、共享 root authority 和统一 Todo Center。
- Plan 增加 revision、锁 owner、恢复、approval commit 与并发安全检查；Goal verifier 继续采用 fail-closed verdict。
- Session coordinator 加固 lease heartbeat、stale owner fencing、canonical Session 切换检测和 retry lineage。
- 修复 Goal opt-in 被错误复用于 Session writer attach 的回归：Workflow Goal 仍按归属恢复，而有效 canonical Session 会独立 attach 并发送 `workflow-attach` recovery 消息。

### Provider、Intelligence 与 TUI

- API Manager 接管自定义 provider 配置，支持 Pi `max` thinking level、secret masking、原子写入和动态模型能力。
- 扩展 LSP、Browser、SmartSearch 和 workspace edit 生命周期安全，包括 Abort、缓存边界、临时文件权限和 shutdown 清理。
- statusline 优先压缩标签，再截断路径；极长 Git branch 会整体降级，避免窄终端溢出。
- Swarm、Todo、Session 和 teammate overlays 补齐宽高预算、滚动保持与 recovery-first 显示。

### 安装与依赖契约

- `pi-maestro-flow` 精确依赖 `pi-maestro-teammate@0.4.5`。
- 将旧 Maestro Git source tarball 替换为 prepared registry artifact `maestro-flow@0.5.51`。
- 验证新 Maestro artifact 包含完整 `dist/src/utils/wasm-relaunch.js`、`run create/brief/check/complete/cancel` 与 `parent_run_id` 契约。
- Node.js 最低版本同步提高到 `22.19.0`，与 `maestro-flow@0.5.51` 保持一致。

## 版本

| 包 | 旧版本 | 新版本 |
|---|---:|---:|
| `pi-maestro-flow` | 0.4.9 | 0.4.10 |
| `pi-maestro-teammate` | 0.4.4 | 0.4.5 |
| `maestro-flow` 运行资源 | 0.5.50 source tarball | 0.5.51 registry artifact |

## 变更统计

- 自 `v0.4.9` 起共 21 个提交（含本次 release commit）。
- 涉及 429 个文件、19,956 行新增与 4,611 行删除；主要包括 Flow runtime 与测试、teammate runtime / public API，以及 canonical Pi Skills。
- `packages/pi-maestro-flow` 涉及 69 个文件，`packages/pi-maestro-teammate` 涉及 31 个文件，`.pi/skills` 涉及 291 个文件。
- teammate 全套测试、Flow 各功能域测试、TypeScript 类型检查、ACO 80 项脚本测试、主 packed-consumer 与 packed Todo consumer 均通过。
- 双包 `npm publish --dry-run` 通过：teammate tarball 为 58 个文件、约 116.4 kB；Flow tarball 为 574 个文件、约 1.2 MB。
- `npm audit --omit=dev` 为 0 个 production vulnerability。

## 安装

```bash
pi install npm:pi-maestro-flow@0.4.10
```

也可以使用 npm：

```bash
npm install pi-maestro-flow@0.4.10
```

仅安装 teammate：

```bash
npm install pi-maestro-teammate@0.4.5
```

## 升级说明

版本号为 patch，但由于关联的 Maestro runtime 已升级，Node.js 最低要求变为 `22.19.0`。请先升级 Node.js，再安装本版本；升级后执行 `/reload` 或重启 Pi。

依赖旧 team Skill session folder 的自定义脚本需要迁移到 `{run_dir}/work/team`、`{run_dir}/outputs` 和 `{run_dir}/evidence`。如果自定义逻辑依赖 Goal opt-in 才 attach Session，应改为区分 Workflow Goal 恢复与 canonical Session writer attach。
