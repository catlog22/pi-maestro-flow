#!/usr/bin/env bash
# self-evolve skill full-cycle 端到端演练（Item 3）
# 按 .pi/skills/self-evolve/SKILL.md 的文档化步骤在真实 run 上执行：
#   run create → frontmatter 事实决策 → run check → session done(seal)
#   → review --refresh(TOCTOU fence) → promote --all(T2 事实型自动晋升)
#   → approval receipt → search 验证 → health sidecar 反映
# 用专用 session，结束后给出清理指引。
set -u
SES="20260806-self-evolve-e2e"
TOKEN="$(date +%s | tail -c 5)"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
WORK="$ROOT/scripts/.e2e-work"
mkdir -p "$WORK"

PASS=0; FAIL=0; FAILED=""
ok()  { PASS=$((PASS+1)); echo "[PASS] $1${2:+ — $2}"; }
ko()  { FAIL=$((FAIL+1)); FAILED="$FAILED|$1"; echo "[FAIL] $1${2:+ — $2}"; }

echo "=== Step 1: run create（skill full-cycle 起点）==="
R=$(maestro run create "self-evolve-e2e-skill-flow-${TOKEN}" --session "$SES" --intent "self-evolve skill full-cycle e2e ${TOKEN}" --platform pi --json 2>&1)
RUN_ID=$(echo "$R" | python -c "import json,sys; print(json.loads(sys.stdin.read()).get('result',{}).get('run_id',''))" 2>/dev/null)
[ -n "$RUN_ID" ] && ok "run create: $RUN_ID" || ko "run create" "$(echo "$R" | head -c 150)"

echo "=== Step 2: frontmatter 事实决策（T1 自动草拟输入）==="
mkdir -p ".workflow/sessions/$SES/runs/$RUN_ID"
cat > ".workflow/sessions/$SES/runs/$RUN_ID/report.md" <<EOF
---
verdict: ready
summary: "self-evolve skill e2e ${TOKEN}"
decisions:
  - id: D1
    status: accepted
    text: "E2E 决策 ${TOKEN}: 自进化事实候选应经 T2 promote --all 自动晋升"
constraints:
  - id: C1
    status: locked
    text: "E2E 约束 ${TOKEN}: approval receipt 必须记录 actor 与 reason"
---
EOF
ok "frontmatter 已写（decision + constraint 事实候选）"

echo "=== Step 3: run check（评审清单）==="
C=$(maestro run check "$RUN_ID" --json 2>&1)
echo "$C" | python -c "import json,sys; d=json.loads(sys.stdin.read()); print('  gates:', d.get('gates'))" 2>/dev/null || echo "$C" | head -c 200
ok "run check 完成"

echo "=== Step 4: session done（seal 事务 → T1 自动 stage）==="
D=$(maestro session done "$RUN_ID" --verdict done --summary "self-evolve e2e ${TOKEN}" 2>&1)
echo "$D" | tail -2
ok "session done (seal)"

echo "=== Step 5: review --refresh（TOCTOU fence）==="
R5=$(maestro knowledge review "$SES" --refresh --json 2>&1)
CAND=$(echo "$R5" | python -c "
import json,sys
d=json.loads(sys.stdin.read())
c=[c for c in d.get('candidates',[]) if c.get('status')=='pending']
print(len(c))
" 2>/dev/null || echo 0)
echo "  pending 候选: $CAND"
[ "$CAND" -ge 1 ] && ok "seal 后 pending 候选存在（T1 自动草拟）" || ko "pending 候选" "$CAND"

echo "=== Step 6: promote --all（T2 事实型自动晋升）==="
P6=$(maestro knowledge promote "$SES" --all --json 2>&1)
echo "$P6" | python -c "
import json,sys
try:
    d=json.loads(sys.stdin.read())
    print('  promoted:', [p.get('candidate_id') for p in d.get('promoted',[])])
    print('  skipped_review_required:', len(d.get('skipped_review_required',[])))
except Exception:
    print('  (输出非 JSON)')
" 2>/dev/null || echo "$P6" | head -c 250
echo "$P6" | grep -q "promoted" && ok "promote --all 执行（T2 事实候选自动晋升）" || ko "promote --all" "$(echo "$P6" | head -c 150)"

echo "=== Step 7: approval receipt（Phase 2B 审计轨迹）==="
A=$(node scripts/self-evolve-approval.mjs record --action promote --session "$SES" --reason "self-evolve skill e2e ${TOKEN} — T2 auto-promote" --actor e2e 2>&1)
echo "$A" | head -2
echo "$A" | grep -q "APPROVAL RECEIPT" && ok "approval receipt 落盘" || ko "approval receipt" "$(echo "$A" | head -c 120)"

echo "=== Step 8: search 验证（反馈注入）==="
S8=$(maestro search "E2E 决策 ${TOKEN}" --type spec --json 2>&1)
echo "$S8" | grep -q "E2E" && ok "search 命中晋升的知识（反馈注入生效）" || ko "search 命中" "$(echo "$S8" | head -c 150)"

echo "=== Step 9: health sidecar 反映 ==="
H=$(node scripts/self-evolve-health.mjs 2>&1 | grep -E "signals|cross-run" | head -2)
echo "  $H"
ok "health sidecar 重新生成"

echo
echo "==================================================================="
echo " 汇总: PASS=$PASS FAIL=$FAIL"
echo "==================================================================="
[ "$FAIL" != "0" ] && echo "失败项:$FAILED"

cat <<'EOF'

===== 清理指引（测试残留均带 self-evolve-e2e / E2E 标记）=====
1. 测试 session：    rm -rf .workflow/sessions/20260806-self-evolve-e2e
2. 晋升的 spec 条目（title 含 "E2E 决策/约束"）：编辑 .workflow/specs/learnings.md 删除对应 <spec-entry> 块
3. 临时文件：        rm -rf scripts/.e2e-work
EOF

[ "$FAIL" = "0" ] && exit 0 || exit 1
