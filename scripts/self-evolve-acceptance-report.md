# self-evolve 插件 MVP 验收报告（V1–V11）

- **日期**：2026-08-06
- **环境**：Git Bash (MSYS2) on Windows；maestro CLI 0.5.63；项目根 `D:/pi-maestro-flow`
- **专用测试 session**：`20260806-self-evolve-acceptance`（ASCII）
- **脚本**：`scripts/self-evolve-acceptance.sh`（POSIX bash）
- **验收依据**：`docs/self-evolution-plugin-design.md`（v2）§8 验收标准 与 §4 时序铁律

## 结果摘要

| 项 | 结果 | 说明 |
|---|---|---|
| V1 闭环触发 | ✅ PASS | `run create` + `run brief --json` 返回 `knowledge_context` 卡 |
| V2 自动草拟 | ✅ PASS | frontmatter accepted decisions → seal 物化 → review candidates 非空 |
| V3 显式 stage | ✅ PASS | `knowledge stage --content-file - --evidence` 返回 `KDC-*` 候选 id |
| V4 对账 | ✅ PASS | 跨 run 同内容 → reconciliation 自动判 `exact_duplicate`/`suppressed`，无需 resolve |
| V5 晋升门禁 | ✅ PASS | 未 seal promote throw；seal 后返回 `promoted_id` |
| V6 冲突拦截 | ✅ PASS | 同 title 不同 content promote throw（resolve 为 supersede 后可晋升） |
| V7 谱系 | ✅ PASS | `spec supersede` → `history` 显链 → `health deprecated +1` |
| V8 回滚演练 | ❌ BLOCKED | 既存环境 bug（`Duplicate knowhow id: knowhow-report`），非测试引入 |
| V9 反馈注入 | ✅ PASS | promote 后 `search --type knowhow` 命中（不删缓存） |
| V10 审计健康 | ✅ PASS | 基线 12 findings → 终态 12 findings，diff 无新增 |
| V11 阻断门 | ✅ PASS | review_required 候选：显式 promote throw、`--all` 跳过 |

**汇总：64 PASS / 2 FAIL（FAIL 均为 V8 链路的同一既存 bug，见下）**

---

## 逐项结果与证据

### V1 闭环触发 —— PASS
- 断言：`maestro run create <cmd> --session 20260806-self-evolve-acceptance --json` 退出码 0，`run brief <id> --json` 返回 `knowledge_context`。
- 证据：brief 输出 `knowledge_context.schema_version = "knowledge-reconciliation-card/1.0"`，含 run/session/policy/review/reconciliation 卡。
- 与设计一致：✅（设计 V1 断言链成立）。

### V2 自动草拟 —— PASS
- 断言（v2 修正链）：写 frontmatter `decisions/constraints`（accepted/locked）→ `run check` → `run complete`（seal 物化）→ `knowledge review <session> --json` candidates 非空。
- 证据：seal 后 review 出现 2+ 条 pending spec 候选，title 与 frontmatter 的 decision/constraint 文本一致，`source_kind=decision`。
- 与设计一致：✅（v2 修正的断言链含 complete，实测成立）。
- 补充：seal 自动草拟的候选在 seal **后**才可 review（符合 §4 铁律 2）；本测试在 V11 的 `promote --all` 中这些候选被正常晋升为测试 spec 条目。

### V3 显式 stage —— PASS
- 断言：`knowledge stage knowhow "<t>" --content-file - --run <id> --evidence "file:scripts/self-evolve-acceptance.sh" --json` 返回候选 id。
- 证据：返回 `candidate_id` 形如 `KDC-…`（`--evidence` 记录进 `evidence_refs`）。
- 与设计一致：✅

### V4 对账 —— PASS
- 断言：重复 stage 同内容 → `exact_duplicate` 自动 suppressed（无需 resolve）。
- 证据：同一 run 内重 stage 合并到同一候选（occurrences+1）；跨 run 重 stage 后 `run check` 的 reconciliation receipt 报 `duplicates≥1 / suppressed≥1`，review 中该候选 `disposition=exact_duplicate`、`eligibility=suppressed`（**自动**，无人工 resolve）。
- 与设计一致：✅（补充：suppressed 判定发生在跨 run reconciliation 的 `run check` 时点；同 run 内重 stage 只合并 occurrence 不产生 disposition）。

### V5 晋升门禁 —— PASS
- 断言：未 seal 源 run 上 promote → throw（文案可断言）；seal 后成功返回 promoted_id。
- 证据：
  - 未 seal：`Error: Knowledge candidates require sealed source Runs before promotion: KDC-…:<run-id>`，退出码 1。
  - seal（`run complete --verdict done`）后：`promoted: [{candidate_id, promoted_id: "knowhow-tip-20260806-…", outcome: "created"}]`，退出码 0。
- 与设计一致：✅

### V6 冲突拦截 —— PASS（含一处实测补充）
- 断言：与既有 spec 同 title 不同 content → promote throw 要求 resolve。
- 证据：promote 输出 `Error: Candidate KDC-… conflicts with existing spec title "…"; resolve with spec supersede/conflict before promotion`，退出码 1。
- **实测补充（设计 vs 实测）**：
  1. reconciliation 层面并不把同 title 不同 content 判为 conflict——实测 disposition=`related`、eligibility=`eligible`（check 的 receipt `conflicts: 0`）。**真正拦截发生在 promote 时点**（`run/knowledge.js` 的 title 冲突检查直接读 spec 文件），fail-closed 成立但层级与设计的表述略有出入。
  2. `review --resolve --as related` **不能**解除该 title 冲突（promote 仍 throw）；必须 `--as supersede --target <existing-id>`（或 conflict）才能解除。实测 resolve 为 supersede 后 promote 成功，且旧条目自动标 `deprecated` + `superseded-by` 新条目。

### V7 谱系 —— PASS
- 断言：`spec supersede <old> --by <new>` 后 `spec history <sid> --json` 显链、`spec health --json` deprecated +1（必要时先 `backfill-sid`）。
- 证据：`Superseded S-… → S-…. Old entry marked deprecated (excluded from search/load).`；history 返回 `[old: deprecated/current=false, new: active/current=true]`；health deprecated 14 → 15（delta +1）。
- **backfill-sid**：仅验证命令可用（`--help` 退出码 0），**未执行**——它会为既有无 sid 的 legacy 条目补写 sid，改写既有知识条目文件，违反本任务「不删改既有知识条目」约束；且测试所建条目均自带 sid（promotion 自动分配），非「必要时」。

### V8 supersede 回滚演练 —— ❌ BLOCKED（既存环境 bug，非测试引入）
- 断言（设计）：`knowhow snapshot create --old <id>` → `snapshot seal --snapshot` → `restore --snapshot`。
- 实测：
  1. 前置 `knowhow add`（后继条目）成功；
  2. `knowhow snapshot create --old … --new … --new-path … --out … --json` 退出码 1，输出 `Duplicate knowhow id: knowhow-report`；
  3. 同一根因也破坏 `knowhow supersede` 与 `knowhow history`（用任意既有条目对复测均报同一错误）。
- **根因（已定位源码）**：`scanKnowhow()`（`maestro-flow/dist/src/tools/knowhow-lifecycle.js:345-352`）把 `.workflow/knowhow/` 下每个 `.md` 文件名经 `knowhowFileToWikiId` 映射为 wiki id 后查重；而 `KNW-investigate-login-api-config/`、`KNW-investigate-qwen-context-2026-07-23/`、`KNW-investigate-swarm-read-schema/` 三个 legacy 子目录下各有一个 **`report.md`**（分别创建于 2026-07-17 / 07-23 / 07-18，先于本测试），全部映射为 `knowhow-report` → 直接 throw。
- **结论**：设计 V8 在本环境当前状态下不可执行；修复需改名/合并 legacy `report.md`（改既有知识条目）或修 maestro 核心，均超出本脚本权限。按任务要求如实记录为 FAIL，不绕行。

### V9 反馈注入 —— PASS
- 断言（v2 修正）：不删缓存：promote → `maestro search "<title>" --type knowhow` 命中。
- 证据：promote 后 search 返回结果首个条目即 `knowhow-tip-20260806-…`（title 精确命中）。
- 与设计一致：✅。补充：实测 search 曾输出 `Note: search daemon unreachable — falling back to BM25-only`（daemon 不存活分支），BM25-only 路径同样命中，恰好覆盖设计要求的「daemon 存活/不存活两分支」中的降级分支。

### V10 审计健康 —— PASS
- 断言（v2 修正）：先固化 `knowledge audit --json` 基线 → 变更后无新增 findings。
- 证据：基线 12 findings（`invalid-knowledge-ledger ×4` 与设计所述存量一致，另有 `ghost-code-reference ×4`、`missing-required-metadata ×2`、`missing-stable-id ×2`）；整个测试（8 个 run、7+ 次 promote、2 次 knowhow 新增）后终态仍 12 findings，diff 无新增。
- 与设计一致：✅（注：`pipeline` 统计如 sessions/pending_observed 会随测试变化，V10 断言只针对 findings 集合，符合设计意图）。

### V11 阻断门 —— PASS（含一条关键时序经验）
- 断言：构造 review_required 候选 → `promote --all` 跳过（`skipped_review_required`）且显式 `promote --candidate` throw。
- 构造法：`stage spec "<既有 promoted ACTIVE 条目 title>" --action supersede` → reconciliation 判 `supersede_candidate`/`review_required`（确定性，非碰运气）。
- 证据：
  - 显式 `promote --candidate`：`Error: Candidate KDC-… promotion is review_required (supersede_candidate); resolve it with 'maestro knowledge resolve' first`，退出码 1；
  - `promote --all`：退出码 0，`skipped_review_required: ["KDC-…"]`（同时正常晋升其他 eligible 候选）。
- **关键时序经验（与 §4 铁律呼应）**：必须先测显式 throw、再测 `--all` skip——`--all` 会刷新 reconciliation，候选 eligibility 可能从 review_required 变为 eligible（实测出现过），顺序颠倒会导致断言失真。
- 实测补充：supersede 候选若指向**已 deprecated** 的 title（如本脚本初版误用了 V7 刚被 supersede 的旧条目），promote 报通用错误 `Failed to promote spec candidate …`（非 review_required 文案）——reconcile 的 `loadCorpus` 过滤 deprecated（`isActiveDocument`），promote 侧 `findExistingSpec` 也跳过 deprecated 条目。V11 目标必须选 active 条目。

---

## 设计文档 vs 实测偏差汇总（如实记录，未绕行）

1. **V6 拦截层级**：设计表述「与既有 spec 同 title 不同内容 → promote throw 要求 resolve」成立，但 reconcile 阶段并不判 conflict（disposition=`related`、eligibility=`eligible`），拦截实际发生在 promote 时点；`--as related` 无法解除，须 `--as supersede/conflict`。
2. **V8 不可用**：设计假设 knowhow snapshot 链路可用，但当前知识库存在 3 个 legacy `report.md` 文件导致的 `Duplicate knowhow id` 内部错误，使 `knowhow snapshot/supersede/history` 全链路不可用。与设计 §8 V8（v2 已降级为生命周期迁移回退演练）不一致。
3. **V4 时点**：exact_duplicate 自动 suppressed 发生在**跨 run** reconciliation（`run check`）时；同 run 重复 stage 仅合并 occurrence。设计未指明该细节。
4. **promote --all 的 skipped_observed 字段**：实测被 promote 的 observed-only 候选同时出现在 `skipped_observed` 列表（命名易误读，实际为「observed 警告」记录，候选已晋升）。
5. **search 降级分支**：daemon 不可达时自动 fallback BM25-only，仍能命中（V9 因此顺带覆盖了降级分支）。

## 清理指引（本报告/脚本均不自动删除真实知识内容）

测试产生/晋升的条目均带 `self-evolve-acceptance`（或本次 token `992760`）标记：

```bash
# 1. 测试 session（含全部 8 个 run、候选、ledger）
rm -rf .workflow/sessions/20260806-self-evolve-acceptance
# 2. 晋升的 spec 条目（title 含 self-evolve-acceptance，含 supersedes/superseded-by 链）
#    编辑 .workflow/specs/architecture-constraints.md 与 .workflow/specs/learnings.md，
#    删除 grep -n "self-evolve-acceptance" 命中的 <spec-entry> 块
# 3. 晋升/新增 knowhow 文件
rm -f .workflow/knowhow/TIP-20260806-*self-evolve-acceptance*
# 4. 本脚本临时证据 JSON
rm -rf scripts/.acceptance-work
```

> 说明：V8 的既存 bug 不因清理本测试而消失（根因是 legacy `report.md` 文件）；如需修复请另行立项（改名/合并 legacy 文件或修 maestro 核心）。

---

## 运行输出（verbatim，追加）

```text
===================================================================
 self-evolve 验收 V1–V11   session=20260806-self-evolve-acceptance   token=992760
===================================================================

--- [预检] maestro 命令可用性 ---
[PASS] 命令可用: maestro run create
[PASS] 命令可用: maestro run brief
[PASS] 命令可用: maestro run check
[PASS] 命令可用: maestro run complete
[PASS] 命令可用: maestro run seal-session
[PASS] 命令可用: maestro knowledge stage
[PASS] 命令可用: maestro knowledge review
[PASS] 命令可用: maestro knowledge promote
[PASS] 命令可用: maestro knowledge record
[PASS] 命令可用: maestro knowledge audit
[PASS] 命令可用: maestro spec supersede
[PASS] 命令可用: maestro spec history
[PASS] 命令可用: maestro spec health
[PASS] 命令可用: maestro spec backfill-sid
[PASS] 命令可用: maestro knowhow snapshot create
[PASS] 命令可用: maestro knowhow snapshot seal
[PASS] 命令可用: maestro knowhow restore
[PASS] 命令可用: maestro knowhow supersede
[PASS] 命令可用: maestro search

--- V10 基线固化 ---
[PASS] V10 基线 audit 成功
     基线 findings 数: 12

--- V1 闭环触发 ---
[PASS] V1 run create 成功
     run_id=20260806-001-self-evolve-acceptance-v1-992760
[PASS] V1 run brief 成功
[PASS] V1 brief 含 knowledge_context 卡
     card: knowledge-reconciliation-card/1.0

--- V2 自动草拟 ---
[PASS] V2 run check 成功
[PASS] V2 run complete(seal) 成功
[PASS] V2 knowledge review 成功
[PASS] V2 seal 物化出 frontmatter 候选（pending spec ≥2）

--- V3 显式 stage ---
[PASS] V3 stage 返回候选 id
[PASS] V3 候选 id 格式 KDC-*
--- V5 晋升门禁（未 seal → throw）---
[PASS] V5 未 seal run 上 promote throw
[PASS] V5 源 run seal 成功
--- V5 晋升门禁（seal 后成功）---
[PASS] V5 seal 后 promote 返回 promoted_id

--- V9 反馈注入 ---
[PASS] V9 search 执行成功
[PASS] V9 promote 条目被 search 命中

--- V4 对账（跨 run 同内容 → exact_duplicate 自动 suppressed）---
[PASS] V4 同内容 stage 合并到同一候选
[PASS] V4 run check 成功
[PASS] V4 对账 receipt: duplicates≥1 且 suppressed≥1
[PASS] V4 候选被自动判为 exact_duplicate/suppressed
[PASS] V4 源 run seal 成功

--- V6 冲突拦截 ---
[PASS] V6 首个 spec 源 run seal 成功
[PASS] V6 既有 spec 晋升成功
[PASS] V6 run check 成功
[PASS] V6 冲突候选源 run seal 成功
[PASS] V6 同 title 不同 content promote throw
[PASS] V6 resolve --as supersede 成功
[PASS] V6 resolve 后 promote 成功

--- V7 谱系 ---
[PASS] V7 old 源 run seal 成功
[PASS] V7 new 源 run seal 成功
     S_OLD=S-20260806-8de35a40063dc3d2  S_NEW=S-20260806-6600658859fd1cb6
[PASS] V7 spec supersede 成功
[PASS] V7 supersede 输出确认
[PASS] V7 spec history 成功
[PASS] V7 history 显链 old→new
[PASS] V7 health deprecated +1
[PASS] V7 backfill-sid 命令可用（未执行：会改写既有无 sid 条目）

--- V8 supersede 回滚演练 ---
[PASS] V8 前置：创建后继 knowhow 条目
[FAIL] V8 snapshot create 链路 — BLOCKED：既存环境 bug —— Duplicate knowhow id: knowhow-report
     （根因：.workflow/knowhow/KNW-investigate-{login-api-config,qwen-context-2026-07-23,swarm-read-schema}/report.md
       三个文件均映射为 knowhow-report；修复需 maestro 核心或既有知识条目，超出本脚本范围）
[FAIL] V8 snapshot seal + restore 链路 — 因 snapshot create 失败而不可达（见上）

--- V11 阻断门 ---
[PASS] V11 run check 成功
[PASS] V11 构造 review_required 候选成功
[PASS] V11 源 run seal 成功
[PASS] V11a 显式 promote --candidate throw (review_required)
[PASS] V11b promote --all 跳过 review_required 候选
[PASS] V11 收尾 refresh 成功
[PASS] V11 收尾 resolve 成功

--- V10 审计健康（基线 diff）---
[PASS] V10 终态 audit 成功
[PASS] V10 无新增 findings（基线 diff）
     终态 findings 数: 12

===================================================================
 汇总: PASS=64  FAIL=2
===================================================================
失败项:|V8 snapshot create 链路|V8 snapshot seal + restore 链路
注：V8 为既存环境 bug（Duplicate knowhow id: knowhow-report）导致的 BLOCKED，详见报告。
```
