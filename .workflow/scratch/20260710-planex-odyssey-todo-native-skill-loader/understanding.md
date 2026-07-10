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

待 S_PLAN 写入。

## 3. Execution

待执行。

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
