# Odyssey Planex: Todo Native Skill Loader

## 1. Requirement & Criteria

依据 `GRL-001` 的用户确认结论，直接将 todo 收敛为纯文本 `context` + 可空 `skill` 对象，并实现无 Ralph runtime 依赖的 Pi 原生 skill loader。未来 Pi Ralph 的步骤控制以 todo 为基础，但本轮不迁移 Ralph。

验收标准：

- AC1：public schema 与 runtime model 统一，移除旧注入字段。
- AC2：context/skill 的 create、replace、preserve、clear 语义可测试。
- AC3：loader 复用 `DefaultResourceLoader` discovery，加载 skill 与 required/deferred reading，无 Ralph 依赖。
- AC4：Pi skill-config 支持 global/project/task 三级覆盖与损坏配置诊断。
- AC5：`next` 在状态转换前完成加载和预算检查，失败保持 `pending`。
- AC6：legacy state、工具说明与 footer widget 同步迁移。
- AC7：focused tests 与 contract grep 全部通过，无静默截断或手写目录扫描残留。

验收来源：`.workflow/scratch/20260710-grill-todo-generalized-context/context-package.json`。

## 2. Plan

| Task | 内容 | Criteria | 主要文件 |
|------|------|----------|----------|
| T1 | 实现 Pi 原生 skill loader 与 skill-config | AC3/AC4/AC5/AC7 | `src/skills/skill-loader.ts`、`src/skills/skill-config.ts` |
| T2 | 收敛 todo runtime model、update 语义、原子 `next`、legacy migration | AC1/AC2/AC5/AC6 | `src/tools/todo.ts` |
| T3 | 同步 TypeBox schema、tool description 与 widget contract | AC1/AC6/AC7 | `src/extension/schemas.ts`、`src/extension/index.ts` |
| T4 | 新增 focused tests 与 contract checks | AC2–AC7 | `test/*.test.ts`、`package.json` |

依赖顺序：T1 → T2 → T3 → T4。现有工作树包含用户的 ask/plan/widget 等未提交改动；实施与暂存必须限定到 todo 相关 hunks，避免扩大提交范围。

## 3. Execution

- T1：新增 `src/skills/skill-loader.ts` 与 `skill-config.ts`，包装 Pi `DefaultResourceLoader`，支持 required/deferred reading、global/project defaults、task args override、cache 和硬预算。
- T2：`TodoTask` 收敛为纯文本 `context` + 可空 `skill`；`next` 在 loader 成功后才切换 `in_progress`；持久化升级到 version 2，并迁移旧 inject/injection/load/completion。
- T3：TypeBox schema 移除 legacy public fields；todo tool description 使用新 contract；widget 展示 `/skill-name`。
- T4：新增 10 个 focused tests 与 `npm run test:todo`。

执行验证：`npm run test:todo --workspace packages/pi-maestro-flow` → 10/10 passed。`git diff --check` 通过。全包 `tsc` 仍被既有 `.ts` import/generic API 基线错误阻塞；过滤后未出现新增的业务类型错误。

## 4. Verification

待验证。

## 5. Fix Log

暂无。

## 6. Generalization

待提取。

## 7. Discoveries

待扫描。

## 8. Learnings

待记录。
