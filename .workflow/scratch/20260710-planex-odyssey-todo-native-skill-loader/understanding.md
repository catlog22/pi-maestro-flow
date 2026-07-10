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

### Iteration 1

| Criterion | Result | Evidence |
|-----------|--------|----------|
| AC1 | Passed | schema/runtime grep + public schema test |
| AC2 | Passed | preserve/replace/clear test |
| AC3 | Passed | real `DefaultResourceLoader` discovery + required/deferred tests；无 Ralph import |
| AC4 | Passed | global/project/task override + invalid config tests |
| AC5 | Passed | loader/budget before state transition；missing skill keeps pending |
| AC6 | Passed | legacy migration + widget/tool contract tests |
| AC7 | Passed | `npm run test:todo` 10/10；negative greps |

全包 `tsc` 仍存在项目既有的 `.ts` import、`AgentToolResult<T>` 等基线错误；过滤 task files 后未发现本轮新增的业务类型错误。该基线不降低 AC1–AC7，因为 focused runtime tests 直接加载并执行了新 TypeScript 模块。

## 5. Fix Log

暂无。

## 6. Generalization

提取 4 个可复用模式：

1. Syntax：public schema 与 runtime model 必须只有一个 contract，并用 property test 防漂移。
2. Semantic：任何可能失败的 loader/validation 必须先于 `running/in_progress` 持久化。
3. Structural：资源发现委托 host `DefaultResourceLoader`，feature loader 只处理内容语义。
4. Structural：持久化模型变更必须在 read boundary 做 versioned normalization。

Wave 2 结果：syntax/structural worker 完成，semantic/historical worker 超时；已用本地 grep 与 `git log -S` 补齐。扫描命中 5 个，1 个 actionable（plan show 截断无省略标记），其余经上下文核对为 safe/intentional 或已有回归保护。

## 7. Discoveries

| Hit | Classification | Action / Reason |
|-----|----------------|-----------------|
| `plan.ts` no-UI preview uses raw `slice(0,300)` | bug | Fixed in `de2bbd2` with explicit ellipsis；plan module import + todo tests re-run passed |
| `goal.ts` verifier fallback limits reasoning to 500 chars | safe | Bounded diagnostic text，not source content；prevents verifier output amplification |
| teammate progress/status becomes running before child work | safe | In-memory lifecycle signal；guard checks precede creation and completion/failure handlers reconcile state |
| `todo.ts` remains a large aggregate | safe/intentional | Resource discovery/loading moved out；remaining code owns one domain aggregate: task state、dependency、persistence、prompt assembly、migration |
| historical injection/skillRef commits | regression risk mitigated | versioned migration + public schema contract test + focused behavior tests prevent reintroduction |

所有 5 个命中已分类；`remaining_actionable == 0`。两个超时 worker 已由本地语义 grep 与 historical `git log -S` 补齐，无未分类项。

## 8. Learnings

- `S-20260710-kwdz`（arch）：Pi todo 的原生 skill 控制边界。
- `S-20260710-wz12`（coding）：持久化 todo contract 的版本化迁移模式。

最终状态：AC1–AC7 全部通过；10/10 focused tests；1 次 verify；4 个模式；5 个 scan hits 全部分类；1 个额外 bug 已修复；`remaining_actionable == 0`。
