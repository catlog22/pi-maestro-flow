# Release v0.4.2 — 2026-07-12

## 概述

v0.4.2 是对 v0.4.1 的增量增强版本，覆盖 6 个 commits。本次发布聚焦于三个核心方向：

1. **工作流运行时与上下文压缩** — 全新的 compaction 引擎、hooks 钩子系统、skill 运行时重构
2. **teammate 模型路由与提示词模板增强** — 自动模型路由、结构化提示词模板、模型目录管理
3. **文档、治理与知识资产** — 完整重写 README、新增 GUIDE.md 用户指南、知识 session 工件、.gitignore 治理

---

## 详细变更

### 1. 工作流运行时与上下文压缩 (`b924e00`)

#### 新增：Compaction 压缩引擎
- `src/compaction/auto-compaction.ts` — 自动上下文压缩引擎，在上下文窗口接近 token 限制时触发压缩
- `src/compaction/maestro-compaction.ts` — Maestro 专用的压缩策略，保留关键 knowledge 引用和工作流状态
- `src/compaction/pi-internals.ts` — Pi 内部上下文的识别与保留逻辑

#### 新增：Hooks 钩子系统
- `src/hooks/pi-adapter.ts` — Pi coding agent 钩子适配器，支持生命周期事件监听
- `src/hooks/runner.ts` — 钩子执行引擎，支持 before/after 语义
- `src/hooks/schema.ts` — 钩子配置 JSON Schema 定义
- `src/hooks/trust.ts` — 钩子信任与权限管理

#### 重构：Skill 运行时
- `src/skills/skill-cache.ts` — Skill 加载缓存，避免重复解析
- `src/skills/skill-composer.ts` — Skill 组合器，支持 skill 链式编排
- `src/skills/skill-runtime.ts` — 统一 skill 运行时入口
- `src/skills/skill-loader.ts` — 增强 loader 支持原生 skill 控制

#### 新增：Plan Confirm 工具
- `src/tools/plan-confirm.ts` — 显式 plan 确认工具，支持 durable approval workflow

#### 增强：Todo 工具
- `src/tools/todo.ts` — 重写 todo 工具，新增原生 skill 控制、优先级排序、依赖管理

#### 脚本与测试
- `scripts/configure-keybindings.mjs` — 自动配置 Pi 快捷键
- `scripts/install-workflows.mjs` — 自动安装 Maestro workflow 文件
- 新增 `test/compaction.test.ts`（519 行）、`test/hooks.test.ts`（294 行）、`test/skill-loader.test.ts`（90 行）
- 大幅扩展 `test/todo.test.ts`（+382 行）、`test/plan-lifecycle.test.ts`（+102 行）

### 2. Teammate 模型路由与提示词模板 (`53a0541`)

#### 新增：模型路由系统
- `packages/pi-maestro-teammate/src/models/model-catalog.ts` — 可用模型目录，自动发现已认证的模型提供商
- `packages/pi-maestro-teammate/src/models/model-routing.ts` — 自动模型路由引擎，支持 `taskType` → 模型映射（explore/analysis/debug/planning/development/review/testing）

#### 新增：结构化提示词模板
- `packages/pi-maestro-teammate/prompts/analysis-*.md` (8 个) — 分析类模板：trace-code-execution、diagnose-bug-root-cause、analyze-code-patterns、analyze-technical-document、review-architecture、review-code-quality、analyze-performance、assess-security-risks
- `packages/pi-maestro-teammate/prompts/planning-*.md` (4 个) — 规划类模板：plan-architecture-design、breakdown-task-steps、design-component-spec、plan-migration-strategy
- `packages/pi-maestro-teammate/prompts/development-*.md` (5 个) — 开发类模板：implement-feature、refactor-codebase、generate-tests、implement-component-ui、debug-runtime-issues
- `packages/pi-maestro-teammate/prompts/analysis.md` / `review.md` / `write.md` — 简洁兼容模板

#### 新增：TUI 增强
- `packages/pi-maestro-teammate/src/tui/model-mapping-overlay.ts` — Alt+M 模型路由配置界面
- `packages/pi-maestro-teammate/src/tui/progress-tree.ts` — 树形进度显示组件

#### 新增：测试
- `test/model-catalog.test.ts` (101 行)
- `test/model-routing.test.ts` (93 行)
- `test/prompt-template.test.ts` (140 行)

### 3. Pi Skill 的 Maestro Workflow 引用统一 (`83f6c01`)

- 统一 54 个 `.pi/skills/*/SKILL.md` 中的 Maestro workflow 引用格式
- 所有 skill 现在使用一致的 Maestro workflow 路径规范

### 4. .gitignore 与运行时产物治理 (`8373396`)

- 新增 `.gitignore`，覆盖 node_modules、build outputs、IDE 文件、OS 产物
- 排除 Pi/Maestro 运行时目录（embedding 索引、KG、explore 缓存等）
- 移除已跟踪的二进制 embedding 索引文件（~5MB），缩减仓库体积

### 5. Session 分析与知识工件 (`e4a18e4`)

- 新增 6 个分析/规划 session 的完整工件：
  - `pi-maestro-plugin-teammate-models` — teammate 模型插件架构分析
  - `skill-runtime` — skill 运行时设计与验证
  - `pi-observational-memory` — Pi 观察记忆架构分析
  - `pi-ultra-compact-compression` — 超紧凑压缩策略分析
  - `todo-generalized-context-grill` — Todo 通用上下文的 grill 审查
  - `odyssey-tui-migration` — Odyssey TUI 迁移理解
- 每个 session 包含 analysis.md、conclusions.json、context-package.json、discussion.md、exploration-codebase.json、perspectives.json
- 更新 .gitignore 排除 `.task/`、`.summaries/`、`.history/`

### 6. 文档重写与用户指南 (`f53b5a9`)

- **README.md** — 完全重写（+772 行），涵盖快速开始、架构概览、配置指南、API 参考
- **GUIDE.md** — 全新 824 行用户指南，覆盖：
  - 安装与配置
  - Teammate 代理调度（DAG 任务图、模型路由、提示词模板）
  - Maestro 知识系统（search、load、spec、knowhow）
  - 工作流技能（odyssey-planex、quality-review、maestro-blueprint 等）
  - TUI 快捷键与 overlay 参考
  - 常见问题与最佳实践

---

## 包版本

| 包 | 旧版本 | 新版本 |
|---|--------|--------|
| `pi-maestro-flow` | 0.4.1 | 0.4.2 |
| `pi-maestro-teammate` | 0.4.1 | 0.4.2 |

## 统计

- **Commits**: 6
- **文件变更**: 76 个文件（不含 session 工件）
- **新增代码**: ~3,300 行
- **新增测试**: ~1,300 行
- **新增文档**: ~1,500 行
- **仓库体积缩减**: ~5MB（移除 embedding 二进制文件）

## 安装

```bash
npm install pi-maestro-flow@0.4.2 pi-maestro-teammate@0.4.2
```

## 升级指南

从 v0.4.1 升级：
1. 更新两个包到 `0.4.2`
2. 运行 `postinstall` 脚本自动配置快捷键和 workflow 文件
3. 如有自定义 `.gitignore`，参考新模板补充 Pi/Maestro 运行时排除规则
4. 查看 `GUIDE.md` 了解新增的模型路由和提示词模板功能
