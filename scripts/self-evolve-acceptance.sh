#!/usr/bin/env bash
# ============================================================================
# self-evolve-acceptance.sh — 自进化插件 MVP 验收脚本 (V1–V11)
#
# 依据 docs/self-evolution-plugin-design.md (v2) §8 验收标准 与 §4 时序铁律。
# 环境：Git Bash (MSYS2) on Windows；POSIX bash；路径统一 forward slashes。
# 专用测试 session slug：20260806-self-evolve-acceptance（ASCII）。
# 原则：只写 scripts/ 下自有临时目录与专用 session；不修改既有知识条目；
#       promote/晋升的测试条目均带 "self-evolve-acceptance" 前缀，结尾给出清理指引。
#
# 用法：bash scripts/self-evolve-acceptance.sh
# 退出码：0=全部 PASS；1=存在 FAIL（含 BLOCKED）。
# ============================================================================
set -u

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$ROOT"

SES="20260806-self-evolve-acceptance"
WORK="$SCRIPT_DIR/.acceptance-work"
mkdir -p "$WORK"

# 每次运行的唯一 token：所有新造标题/内容都带它，避免跨次运行 exact_duplicate 干扰断言
TOKEN="$(date +%s | tail -c 7)"
PLATFORM="pi"

PASS=0; FAIL=0; FAILED=""

ok() { PASS=$((PASS+1)); echo "[PASS] $1"; }
ko() { FAIL=$((FAIL+1)); FAILED="$FAILED|$1"; echo "[FAIL] $1 — $2"; }

# --- 工具函数 ---------------------------------------------------------------
# run <outfile> <cmd...>：执行命令，stdout+stderr 存入 $WORK/<outfile>，echo 退出码
run() {
  local out="$1"; shift
  "$@" > "$WORK/$out" 2>&1
  echo $?
}
# jget <jsonfile> <python-expr>：以 d 为根对 JSON 求值（UTF-8 安全；容忍前导非 JSON 行，如 search 的 Note: 提示；数组/对象均可）
jget() {
  PYTHONIOENCODING=utf-8 python - "$WORK/$1" "$2" <<'PY'
import json, sys
raw = open(sys.argv[1], encoding='utf-8').read()
start = len(raw)
for ch in '[{':
    p = raw.find(ch)
    if p >= 0 and p < start:
        start = p
d = json.loads(raw[start:])
print(eval(sys.argv[2]))
PY
}
# write_report <run-id> <summary> <decisions_yaml_or_empty> <constraints_yaml_or_empty>
write_report() {
  local f=".workflow/sessions/$SES/runs/$1/report.md"
  cat > "$f" <<EOF
---
verdict: ready
summary: "$2"
$3
$4
concerns: []
next: []
details:
  run_id: "$1"
  purpose: "self-evolve acceptance pipeline test"
---
## 摘要

## 结论/Verdict

## 讨论/复盘

## 产物

## 交接/Next
EOF
}
# expect_rc <name> <actual_rc> <expected_rc>
expect_rc() {
  if [ "$2" = "$3" ]; then ok "$1"; else ko "$1" "rc=$2 期望=$3"; fi
}
# expect_grep <name> <outfile> <pattern>
expect_grep() {
  if grep -q "$3" "$WORK/$2"; then ok "$1"; else ko "$1" "pattern '$3' 未在 $2 中找到"; fi
}

echo "==================================================================="
echo " self-evolve 验收 V1–V11   session=$SES   token=$TOKEN"
echo "==================================================================="

# ---------------------------------------------------------------------------
# 0. 预检：所需 maestro 命令真实可用（--help 退出码 0）
# ---------------------------------------------------------------------------
echo
echo "--- [预检] maestro 命令可用性 ---"
for c in "run create" "run brief" "run check" "run complete" "run seal-session" \
         "knowledge stage" "knowledge review" "knowledge promote" "knowledge record" \
         "knowledge audit" "spec supersede" "spec history" "spec health" \
         "spec backfill-sid" "knowhow snapshot create" "knowhow snapshot seal" \
         "knowhow restore" "knowhow supersede" "search"; do
  if maestro $c --help > /dev/null 2>&1; then
    ok "命令可用: maestro $c"
  else
    ko "命令不可用: maestro $c" "--help 失败"
  fi
done

# ---------------------------------------------------------------------------
# V10 基线：先固化 knowledge audit --json（在一切变更之前）
# ---------------------------------------------------------------------------
echo
echo "--- V10 基线固化 ---"
rc=$(run v10-baseline-audit.json maestro knowledge audit --json)
expect_rc "V10 基线 audit 成功" "$rc" "0"
[ "$rc" = "0" ] && jget v10-baseline-audit.json "len(d.get('findings', []))" \
  | sed 's/^/     基线 findings 数: /'

# ---------------------------------------------------------------------------
# V1 闭环触发：run create + run brief 返回 knowledge_context 卡
# ---------------------------------------------------------------------------
echo
echo "--- V1 闭环触发 ---"
rc=$(run v1-create.json maestro run create "self-evolve-acceptance-v1-${TOKEN}" \
  --session "$SES" --intent "self-evolve acceptance V1-V11 pipeline test" \
  --platform "$PLATFORM" --json)
if [ "$rc" = "0" ]; then
  ok "V1 run create 成功"
  RUN1="$(jget v1-create.json "d['result']['run_id']")"
  echo "     run_id=$RUN1"
else
  ko "V1 run create 失败" "$(head -c 200 "$WORK/v1-create.json")"
  echo "===== 汇总（预检后中止）====="; echo "PASS=$PASS FAIL=$FAIL"; exit 1
fi

rc=$(run v1-brief.json maestro run brief "$RUN1" --json)
expect_rc "V1 run brief 成功" "$rc" "0"
KC="$(jget v1-brief.json "d['result'].get('knowledge_context')")"
if [ "$KC" = "None" ]; then
  ko "V1 brief 含 knowledge_context 卡" "knowledge_context 缺失"
else
  ok "V1 brief 含 knowledge_context 卡"
  jget v1-brief.json "d['result']['knowledge_context']['schema_version']" \
    | sed 's/^/     card: /'
fi

# ---------------------------------------------------------------------------
# V2 自动草拟：frontmatter accepted decisions → complete(seal 物化) → candidates 非空
# ---------------------------------------------------------------------------
echo
echo "--- V2 自动草拟 ---"
D2_DEC="self-evolve-acceptance V2 decision $TOKEN"
D2_CON="self-evolve-acceptance V2 constraint $TOKEN"
DECS="decisions:
  - id: D1
    text: \"$D2_DEC\"
    status: accepted"
CONS="constraints:
  - id: C1
    text: \"$D2_CON\"
    status: locked"
write_report "$RUN1" "self-evolve acceptance V2 auto-stage test" "$DECS" "$CONS"

rc=$(run v2-check.json maestro run check "$RUN1" --json)
expect_rc "V2 run check 成功" "$rc" "0"
rc=$(run v2-complete.json maestro run complete "$RUN1" --verdict done --json)
expect_rc "V2 run complete(seal) 成功" "$rc" "0"

rc=$(run v2-review.json maestro knowledge review "$SES" --json)
expect_rc "V2 knowledge review 成功" "$rc" "0"
N_V2=$(jget v2-review.json "sum(1 for c in d.get('candidates',[]) if '$TOKEN' in (c.get('title') or '') and c.get('target')=='spec' and c.get('status')=='pending')")
if [ "$N_V2" -ge 2 ] 2>/dev/null; then
  ok "V2 seal 物化出 frontmatter 候选（pending spec ≥2）" "命中 $N_V2 个候选"
else
  ko "V2 seal 物化出 frontmatter 候选" "命中 $N_V2 个候选（期望 ≥2）"
fi

# ---------------------------------------------------------------------------
# V3 显式 stage：返回候选 id
# V5 晋升门禁：未 seal → throw；seal 后 → promoted_id
# ---------------------------------------------------------------------------
echo
echo "--- V3 显式 stage ---"
rc=$(run v3-create.json maestro run create "self-evolve-acceptance-v3-${TOKEN}" \
  --session "$SES" --intent "self-evolve acceptance V3/V5 stage+promote test" \
  --platform "$PLATFORM" --json)
[ "$rc" = "0" ] || { ko "V3 run create 失败" "$(head -c 200 "$WORK/v3-create.json")"; }
RUN2="$(jget v3-create.json "d['result']['run_id']" 2>/dev/null || echo '')"

KN_TITLE="self-evolve-acceptance-kn-${TOKEN}"
KN_CONTENT="self-evolve acceptance knowhow candidate $TOKEN - unique hash 8f3a2c91"
printf '%s' "$KN_CONTENT" | {
  rc=$(run v3-stage.json maestro knowledge stage knowhow "$KN_TITLE" \
    --content-file - --run "$RUN2" \
    --evidence "file:scripts/self-evolve-acceptance.sh" --json)
}
expect_rc "V3 stage 返回候选 id" "$rc" "0"
CAND_KN="$(jget v3-stage.json "d.get('candidate_id','')")"
if [ -n "$CAND_KN" ] && [ "${CAND_KN#KDC-}" != "$CAND_KN" ]; then
  ok "V3 候选 id 格式 KDC-*" "$CAND_KN"
else
  ko "V3 候选 id 格式 KDC-*" "got '$CAND_KN'"
fi

echo "--- V5 晋升门禁（未 seal → throw）---"
rc=$(run v5a-promote.json maestro knowledge promote "$SES" --candidate "$CAND_KN" --json)
if [ "$rc" != "0" ] && grep -q "sealed source Runs" "$WORK/v5a-promote.json"; then
  ok "V5 未 seal run 上 promote throw" "$(head -c 160 "$WORK/v5a-promote.json")"
else
  ko "V5 未 seal run 上 promote throw" "rc=$rc out=$(head -c 160 "$WORK/v5a-promote.json")"
fi

write_report "$RUN2" "self-evolve acceptance V3/V5 test" "" ""
rc=$(run v5-complete.json maestro run complete "$RUN2" --verdict done --json)
expect_rc "V5 源 run seal 成功" "$rc" "0"

echo "--- V5 晋升门禁（seal 后成功）---"
rc=$(run v5b-promote.json maestro knowledge promote "$SES" --candidate "$CAND_KN" --json)
KN_ID="$(jget v5b-promote.json "d['promoted'][0]['promoted_id']" 2>/dev/null || echo '')"
if [ "$rc" = "0" ] && [ -n "$KN_ID" ]; then
  ok "V5 seal 后 promote 返回 promoted_id" "$KN_ID"
else
  ko "V5 seal 后 promote 返回 promoted_id" "rc=$rc out=$(head -c 200 "$WORK/v5b-promote.json")"
fi

# ---------------------------------------------------------------------------
# V9 反馈注入：promote 后 search 命中（不删缓存）
# ---------------------------------------------------------------------------
echo
echo "--- V9 反馈注入 ---"
rc=$(run v9-search.json maestro search "$KN_TITLE" --type knowhow --json)
expect_rc "V9 search 执行成功" "$rc" "0"
HITS=$(jget v9-search.json "any('$KN_ID' in str(r.get('id','')) for r in d.get('results',[]))")
if [ "$HITS" = "True" ]; then
  ok "V9 promote 条目被 search 命中" "$KN_ID"
else
  ko "V9 promote 条目被 search 命中" "在 results 中未找到 $KN_ID"
fi

# ---------------------------------------------------------------------------
# V4 对账：跨 run 重复 stage 同内容 → exact_duplicate 自动 suppressed（无需 resolve）
# ---------------------------------------------------------------------------
echo
echo "--- V4 对账（跨 run 同内容 → exact_duplicate 自动 suppressed）---"
rc=$(run v4-create.json maestro run create "self-evolve-acceptance-v4-${TOKEN}" \
  --session "$SES" --intent "self-evolve acceptance V4 duplicate test" \
  --platform "$PLATFORM" --json)
[ "$rc" = "0" ] || ko "V4 run create 失败" "$(head -c 200 "$WORK/v4-create.json")"
RUN3="$(jget v4-create.json "d['result']['run_id']")"

printf '%s' "$KN_CONTENT" | {
  rc=$(run v4-stage.json maestro knowledge stage knowhow "$KN_TITLE" \
    --content-file - --run "$RUN3" \
    --evidence "file:scripts/self-evolve-acceptance.sh" --json)
}
CAND_AGAIN="$(jget v4-stage.json "d.get('candidate_id','')")"
if [ "$CAND_AGAIN" = "$CAND_KN" ]; then
  ok "V4 同内容 stage 合并到同一候选" "$CAND_AGAIN"
else
  ko "V4 同内容 stage 合并到同一候选" "期望 $CAND_KN 实得 $CAND_AGAIN"
fi

rc=$(run v4-check.json maestro run check "$RUN3" --json)
expect_rc "V4 run check 成功" "$rc" "0"
DUP=$(jget v4-check.json "d['result']['knowledge_reconciliation'].get('duplicates',0)")
SUP=$(jget v4-check.json "d['result']['knowledge_reconciliation'].get('suppressed',0)")
if [ "$DUP" -ge 1 ] && [ "$SUP" -ge 1 ]; then
  ok "V4 对账 receipt: duplicates≥1 且 suppressed≥1" "duplicates=$DUP suppressed=$SUP"
else
  ko "V4 对账 receipt: duplicates≥1 且 suppressed≥1" "duplicates=$DUP suppressed=$SUP"
fi
rc=$(run v4-review.json maestro knowledge review "$SES" --json)
DISP=$(jget v4-review.json "next((c.get('reconciliation',{}).get('disposition') for c in d.get('candidates',[]) if c.get('candidate_id')=='$CAND_KN'),'')")
ELIG=$(jget v4-review.json "next((c.get('reconciliation',{}).get('promotion_eligibility') for c in d.get('candidates',[]) if c.get('candidate_id')=='$CAND_KN'),'')")
if [ "$DISP" = "exact_duplicate" ] && [ "$ELIG" = "suppressed" ]; then
  ok "V4 候选被自动判为 exact_duplicate/suppressed" "disposition=$DISP eligibility=$ELIG"
else
  ko "V4 候选被自动判为 exact_duplicate/suppressed" "disposition=$DISP eligibility=$ELIG"
fi

write_report "$RUN3" "self-evolve acceptance V4 test" "" ""
rc=$(run v4-complete.json maestro run complete "$RUN3" --verdict done --json)
expect_rc "V4 源 run seal 成功" "$rc" "0"

# ---------------------------------------------------------------------------
# V6 冲突拦截：与既有 spec 同 title 不同 content → promote throw 要求 resolve
# ---------------------------------------------------------------------------
echo
echo "--- V6 冲突拦截 ---"
V6_TITLE="self-evolve-acceptance-spec-${TOKEN}"
rc=$(run v6-create1.json maestro run create "self-evolve-acceptance-v6a-${TOKEN}" \
  --session "$SES" --intent "self-evolve acceptance V6 conflict test (existing spec)" \
  --platform "$PLATFORM" --json)
[ "$rc" = "0" ] || ko "V6 run create 失败" "$(head -c 200 "$WORK/v6-create1.json")"
RUN4="$(jget v6-create1.json "d['result']['run_id']")"

printf '%s' "self-evolve acceptance existing spec content $TOKEN - 7e4b11c2" | {
  rc=$(run v6-stage1.json maestro knowledge stage spec "$V6_TITLE" \
    --content-file - --run "$RUN4" --json)
}
CAND_S1="$(jget v6-stage1.json "d.get('candidate_id','')")"
write_report "$RUN4" "self-evolve acceptance V6 existing spec" "" ""
rc=$(run v6-complete1.json maestro run complete "$RUN4" --verdict done --json)
expect_rc "V6 首个 spec 源 run seal 成功" "$rc" "0"
rc=$(run v6-promote1.json maestro knowledge promote "$SES" --candidate "$CAND_S1" --json)
S_A="$(jget v6-promote1.json "d['promoted'][0]['promoted_id']" 2>/dev/null || echo '')"
[ -n "$S_A" ] && ok "V6 既有 spec 晋升成功" "$S_A" || ko "V6 既有 spec 晋升成功" "$(head -c 200 "$WORK/v6-promote1.json")"

# 同 title 不同 content 的新候选
rc=$(run v6-create2.json maestro run create "self-evolve-acceptance-v6b-${TOKEN}" \
  --session "$SES" --intent "self-evolve acceptance V6 conflict test (conflicting candidate)" \
  --platform "$PLATFORM" --json)
[ "$rc" = "0" ] || ko "V6 run create 失败" "$(head -c 200 "$WORK/v6-create2.json")"
RUN5="$(jget v6-create2.json "d['result']['run_id']")"
printf '%s' "CONFLICTING content for V6 - different text $TOKEN 5b7d9e21" | {
  rc=$(run v6-stage2.json maestro knowledge stage spec "$V6_TITLE" \
    --content-file - --run "$RUN5" --json)
}
CAND_S2="$(jget v6-stage2.json "d.get('candidate_id','')")"
rc=$(run v6-check2.json maestro run check "$RUN5" --json)
expect_rc "V6 run check 成功" "$rc" "0"
write_report "$RUN5" "self-evolve acceptance V6 conflicting candidate" "" ""
rc=$(run v6-complete2.json maestro run complete "$RUN5" --verdict done --json)
expect_rc "V6 冲突候选源 run seal 成功" "$rc" "0"

rc=$(run v6-promote2.json maestro knowledge promote "$SES" --candidate "$CAND_S2" --json)
if [ "$rc" != "0" ] && grep -q "conflicts with existing spec title" "$WORK/v6-promote2.json"; then
  ok "V6 同 title 不同 content promote throw" "$(head -c 170 "$WORK/v6-promote2.json")"
else
  ko "V6 同 title 不同 content promote throw" "rc=$rc out=$(head -c 200 "$WORK/v6-promote2.json")"
fi

# 按错误提示 resolve 为 supersede（清理冲突，验证 resolve 路径）
rc=$(run v6-resolve.json maestro knowledge review "$SES" --resolve "$CAND_S2" \
  --as supersede --target "$S_A" \
  --reason "self-evolve acceptance V6 test: conflicting candidate supersedes test spec" --json)
expect_rc "V6 resolve --as supersede 成功" "$rc" "0"
rc=$(run v6-promote3.json maestro knowledge promote "$SES" --candidate "$CAND_S2" --json)
S_B="$(jget v6-promote3.json "d['promoted'][0]['promoted_id']" 2>/dev/null || echo '')"
[ -n "$S_B" ] && ok "V6 resolve 后 promote 成功" "$S_B" || ko "V6 resolve 后 promote 成功" "$(head -c 200 "$WORK/v6-promote3.json")"

# ---------------------------------------------------------------------------
# V7 谱系：spec supersede → history 显链 → health deprecated +1
# ---------------------------------------------------------------------------
echo
echo "--- V7 谱系 ---"
rc=$(run v7-create1.json maestro run create "self-evolve-acceptance-v7a-${TOKEN}" \
  --session "$SES" --intent "self-evolve acceptance V7 supersede test (old)" \
  --platform "$PLATFORM" --json)
RUN6="$(jget v7-create1.json "d['result']['run_id']")"
V7_OLD_TITLE="self-evolve-acceptance-v7-old-${TOKEN}"
printf '%s' "self-evolve acceptance v7 old entry $TOKEN - 2f8a05d4" | {
  rc=$(run v7-stage1.json maestro knowledge stage spec "$V7_OLD_TITLE" \
    --content-file - --run "$RUN6" --json)
}
CAND_V7O="$(jget v7-stage1.json "d.get('candidate_id','')")"
write_report "$RUN6" "self-evolve acceptance V7 old spec" "" ""
rc=$(run v7-complete1.json maestro run complete "$RUN6" --verdict done --json)
expect_rc "V7 old 源 run seal 成功" "$rc" "0"
rc=$(run v7-promote1.json maestro knowledge promote "$SES" --candidate "$CAND_V7O" --json)
S_OLD="$(jget v7-promote1.json "d['promoted'][0]['promoted_id']")"

rc=$(run v7-create2.json maestro run create "self-evolve-acceptance-v7b-${TOKEN}" \
  --session "$SES" --intent "self-evolve acceptance V7 supersede test (new)" \
  --platform "$PLATFORM" --json)
RUN7="$(jget v7-create2.json "d['result']['run_id']")"
V7_NEW_TITLE="self-evolve-acceptance-v7-new-${TOKEN}"
printf '%s' "self-evolve acceptance v7 new entry $TOKEN - 6c1e93b8" | {
  rc=$(run v7-stage2.json maestro knowledge stage spec "$V7_NEW_TITLE" \
    --content-file - --run "$RUN7" --json)
}
CAND_V7N="$(jget v7-stage2.json "d.get('candidate_id','')")"
write_report "$RUN7" "self-evolve acceptance V7 new spec" "" ""
rc=$(run v7-complete2.json maestro run complete "$RUN7" --verdict done --json)
expect_rc "V7 new 源 run seal 成功" "$rc" "0"
rc=$(run v7-promote2.json maestro knowledge promote "$SES" --candidate "$CAND_V7N" --json)
S_NEW="$(jget v7-promote2.json "d['promoted'][0]['promoted_id']")"
echo "     S_OLD=$S_OLD  S_NEW=$S_NEW"

rc=$(run v7-health-before.json maestro spec health --json)
D_BEFORE=$(jget v7-health-before.json "d.get('deprecated',0)")
rc=$(run v7-supersede.json maestro spec supersede "$S_OLD" --by "$S_NEW")
expect_rc "V7 spec supersede 成功" "$rc" "0"
expect_grep "V7 supersede 输出确认" v7-supersede.json "Superseded"

rc=$(run v7-history.json maestro spec history "$S_OLD" --json)
expect_rc "V7 spec history 成功" "$rc" "0"
H1=$(jget v7-history.json "d[0]['status'] if d and d[0].get('sid')=='$S_OLD' else ''")
H1C=$(jget v7-history.json "d[0]['current'] if d and d[0].get('sid')=='$S_OLD' else None")
H2=$(jget v7-history.json "d[-1]['status'] if d and d[-1].get('sid')=='$S_NEW' else ''")
H2C=$(jget v7-history.json "d[-1]['current'] if d and d[-1].get('sid')=='$S_NEW' else None")
if [ "$H1" = "deprecated" ] && [ "$H1C" = "False" ] \
   && [ "$H2" = "active" ] && [ "$H2C" = "True" ]; then
  ok "V7 history 显链 old→new" "old=$H1/$H1C new=$H2/$H2C"
else
  ko "V7 history 显链 old→new" "old=$H1/$H1C new=$H2/$H2C"
fi

rc=$(run v7-health-after.json maestro spec health --json)
D_AFTER=$(jget v7-health-after.json "d.get('deprecated',0)")
if [ "$D_AFTER" = "$((D_BEFORE + 1))" ]; then
  ok "V7 health deprecated +1" "$D_BEFORE → $D_AFTER"
else
  ko "V7 health deprecated +1" "$D_BEFORE → $D_AFTER"
fi
# backfill-sid 仅验证可用性（执行会改写既有无 sid 条目，违反“不删改既有知识条目”约束）
if maestro spec backfill-sid --help > /dev/null 2>&1; then
  ok "V7 backfill-sid 命令可用（未执行：会改写既有无 sid 条目）"
else
  ko "V7 backfill-sid 命令可用" "--help 失败"
fi

# ---------------------------------------------------------------------------
# V8 supersede 回滚演练（knowhow snapshot create → seal → restore）
# 预期：当前环境存在既存 bug —— .workflow/knowhow/KNW-investigate-*/report.md
#       三个同名文件均映射为 wiki id "knowhow-report"，scanKnowhow 直接 throw
#       "Duplicate knowhow id"，导致 snapshot create/supersede/history 全部不可用。
#       （该状态先于本测试存在，非本脚本引入；按任务要求如实记录，不绕行。）
# ---------------------------------------------------------------------------
echo
echo "--- V8 supersede 回滚演练 ---"
# 先造一个后继 knowhow 条目（knowhow add 不经过 scanKnowhow，可成功）
rc=$(run v8-add.json maestro knowhow add --type tip \
  --title "self-evolve-acceptance-kn2-${TOKEN}" \
  --body "V8 successor knowhow entry for snapshot test - hash 6c4d0ab7" \
  --id "tip-20260806-self-evolve-acceptance-v8-${TOKEN}" \
  --description "self-evolve acceptance V8 test successor" --json)
if [ "$rc" = "0" ]; then
  ok "V8 前置：创建后继 knowhow 条目" "$(jget v8-add.json "d.get('id','')")"
else
  ko "V8 前置：创建后继 knowhow 条目" "$(head -c 200 "$WORK/v8-add.json")"
fi
KH2="$(jget v8-add.json "d.get('id','')")"
KH1="$KN_ID"

rm -f "$WORK/v8-snapshot-out.json" "$WORK/v8-snapshot-out.json.restore.intent.json" "$WORK/v8-snapshot-out.json.restore.receipt.json"
rc=$(run v8-snapshot.json maestro knowhow snapshot create --old "$KH1" --new "$KH2" \
  --new-path "knowhow/$(basename "$(jget v8-add.json "d.get('filename','')")")" \
  --out "$WORK/v8-snapshot-out.json" --json)
if [ "$rc" != "0" ] && grep -q "Duplicate knowhow id" "$WORK/v8-snapshot.json"; then
  ko "V8 snapshot create 链路" "BLOCKED：既存环境 bug —— $(head -c 120 "$WORK/v8-snapshot.json")"
  echo "     （根因：.workflow/knowhow/KNW-investigate-*/report.md 同 basename 撞名，修复需清理 legacy 条目）"
  ko "V8 snapshot seal + restore 链路" "因 snapshot create 失败而不可达（见上）"
  SKIP_V8_SEAL=1
else
  [ "$rc" = "0" ] && ok "V8 snapshot create 链路" "rc=$rc" || ko "V8 snapshot create 链路（非 duplicate 错误）" "$(head -c 200 "$WORK/v8-snapshot.json")"
  SKIP_V8_SEAL=0
fi
# seal / restore 依赖 create 的产物：create 成功则实测 seal → restore 全链路
if [ "${SKIP_V8_SEAL:-1}" = "0" ] && [ -s "$WORK/v8-snapshot-out.json" ]; then
  rc=$(run v8-seal.json maestro knowhow snapshot seal --snapshot "$WORK/v8-snapshot-out.json" --json)
  SEALED=$(jget v8-seal.json "d.get('sealedAt','')" 2>/dev/null || echo '')
  if [ "$rc" = "0" ] && [ -n "$SEALED" ]; then
    ok "V8 snapshot seal 链路" "sealedAt=$SEALED"
  else
    ko "V8 snapshot seal 链路" "$(head -c 200 "$WORK/v8-seal.json")"
    SKIP_V8_SEAL=1
  fi
fi
if [ "${SKIP_V8_SEAL:-1}" = "0" ]; then
  rc=$(run v8-restore.json maestro knowhow restore --snapshot "$WORK/v8-snapshot-out.json" --json)
  if [ "$rc" = "0" ]; then
    ok "V8 snapshot restore 链路" "rc=$rc $(jget v8-restore.json "d.get('restored','')" 2>/dev/null || echo '')"
  else
    ko "V8 snapshot restore 链路" "$(head -c 200 "$WORK/v8-restore.json")"
  fi
fi

# ---------------------------------------------------------------------------
# V11 阻断门：review_required 候选 → promote --all 跳过 + 显式 promote --candidate throw
# 构造：stage --action supersede（标题命中既有 promoted spec → supersede_candidate → review_required）
# ---------------------------------------------------------------------------
echo
echo "--- V11 阻断门 ---"
rc=$(run v11-create.json maestro run create "self-evolve-acceptance-v11-${TOKEN}" \
  --session "$SES" --intent "self-evolve acceptance V11 review_required test" \
  --platform "$PLATFORM" --json)
[ "$rc" = "0" ] || ko "V11 run create 失败" "$(head -c 200 "$WORK/v11-create.json")"
RUN8="$(jget v11-create.json "d['result']['run_id']")"
# 目标必须是被 promoted 的 ACTIVE 条目：reconcile 的 loadCorpus 过滤 deprecated（isActiveDocument），
# 而 V7 已把 S_OLD 标为 deprecated（supersede 演示），因此这里用 S_NEW（仍 active）做 supersede 目标
printf '%s' "self-evolve acceptance V11 supersede candidate $TOKEN - 2a71ff50" | {
  rc=$(run v11-stage.json maestro knowledge stage spec "$V7_NEW_TITLE" \
    --content-file - --action supersede --run "$RUN8" --json)
}
CAND_V11="$(jget v11-stage.json "d.get('candidate_id','')")"
rc=$(run v11-check.json maestro run check "$RUN8" --json)
expect_rc "V11 run check 成功" "$rc" "0"
rc=$(run v11-review.json maestro knowledge review "$SES" --json)
ELIG11=$(jget v11-review.json "next((c.get('reconciliation',{}).get('promotion_eligibility') for c in d.get('candidates',[]) if c.get('candidate_id')=='$CAND_V11'),'')")
DISP11=$(jget v11-review.json "next((c.get('reconciliation',{}).get('disposition') for c in d.get('candidates',[]) if c.get('candidate_id')=='$CAND_V11'),'')")
if [ "$ELIG11" = "review_required" ]; then
  ok "V11 构造 review_required 候选成功" "disposition=$DISP11 eligibility=$ELIG11"
else
  ko "V11 构造 review_required 候选成功" "disposition=$DISP11 eligibility=$ELIG11"
fi
write_report "$RUN8" "self-evolve acceptance V11 review_required test" "" ""
rc=$(run v11-complete.json maestro run complete "$RUN8" --verdict done --json)
expect_rc "V11 源 run seal 成功" "$rc" "0"

# 顺序关键：先显式 promote（必须 throw），再 --all（必须 skip）
rc=$(run v11a-promote.json maestro knowledge promote "$SES" --candidate "$CAND_V11" --json)
if [ "$rc" != "0" ] && grep -q "review_required" "$WORK/v11a-promote.json"; then
  ok "V11a 显式 promote --candidate throw (review_required)" "$(head -c 140 "$WORK/v11a-promote.json")"
else
  ko "V11a 显式 promote --candidate throw (review_required)" "rc=$rc out=$(head -c 200 "$WORK/v11a-promote.json")"
fi

rc=$(run v11b-promote.json maestro knowledge promote "$SES" --all --json)
SKIP11=$(jget v11b-promote.json "'$CAND_V11' in d.get('skipped_review_required', [])")
if [ "$rc" = "0" ] && [ "$SKIP11" = "True" ]; then
  ok "V11b promote --all 跳过 review_required 候选" "skipped_review_required 含 $CAND_V11"
else
  ko "V11b promote --all 跳过 review_required 候选" "rc=$rc skip=$SKIP11"
fi

# 清理 V11 候选（resolve 为 supersede，不晋升，保持会话整洁）
# 注意：promote --all 已变更 corpus → 需先 --refresh 刷新 reconciliation，否则 resolve 报 stale
rc=$(run v11-refresh.json maestro knowledge review "$SES" --refresh --json)
expect_rc "V11 收尾 refresh 成功" "$rc" "0"
rc=$(run v11-resolve.json maestro knowledge review "$SES" --resolve "$CAND_V11" \
  --as supersede --target "$S_NEW" \
  --reason "self-evolve acceptance V11 test: reviewed and resolved as supersede" --json)
expect_rc "V11 收尾 resolve 成功" "$rc" "0"

# ---------------------------------------------------------------------------
# V10 复检：diff 无新增 findings
# ---------------------------------------------------------------------------
echo
echo "--- V10 审计健康（基线 diff）---"
rc=$(run v10-final-audit.json maestro knowledge audit --json)
expect_rc "V10 终态 audit 成功" "$rc" "0"
NEW=$(PYTHONIOENCODING=utf-8 python - \
  "$WORK/v10-baseline-audit.json" "$WORK/v10-final-audit.json" <<'PY'
import json, sys
base = {f['id'] for f in json.load(open(sys.argv[1], encoding='utf-8')).get('findings', [])}
final = json.load(open(sys.argv[2], encoding='utf-8')).get('findings', [])
new = [x['id'] for x in final if x['id'] not in base]
print(new)
PY
)
if [ "$NEW" = "[]" ]; then
  ok "V10 无新增 findings（基线 diff）" "基线/终态 findings 集合一致"
else
  ko "V10 无新增 findings（基线 diff）" "新增: $NEW"
fi
jget v10-final-audit.json "len(d.get('findings',[]))" | sed 's/^/     终态 findings 数: /'

# ---------------------------------------------------------------------------
echo
echo "==================================================================="
echo " 汇总: PASS=$PASS  FAIL=$FAIL"
echo "==================================================================="
if [ "$FAIL" = "0" ]; then
  echo "全部验收项 PASS。"
else
  echo "失败项:$FAILED"
fi

cat <<EOF

===== 清理指引（不自动执行，避免误删真实知识）=====
本测试产生/晋升的条目均带 "self-evolve-acceptance" 或 "$TOKEN" 标记：
1. 测试 session（含全部 run/候选/ledger）：
     rm -rf .workflow/sessions/$SES
2. 晋升的 spec 条目（title 含 self-evolve-acceptance，含 supersedes/superseded-by 链）：
     编辑 .workflow/specs/architecture-constraints.md 与 .workflow/specs/learnings.md，
     删除 grep -n "self-evolve-acceptance" 命中的 <spec-entry> 块
3. 晋升/新增 knowhow 文件：
     rm -f .workflow/knowhow/TIP-20260806-*self-evolve-acceptance*
4. 附：本脚本临时文件 scripts/.acceptance-work/（证据 JSON）
     rm -rf scripts/.acceptance-work
EOF

[ "$FAIL" = "0" ] && exit 0 || exit 1
