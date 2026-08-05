#!/usr/bin/env bash
# =============================================================================
# Official Terminal-Bench 2.1 task re-test via the current pi harness (no Docker)
#
# Retests official tasks that DeepSeek V4 Flash FAILED on the leaderboard run
# (source: hub job trials with reward=0), in a local sandbox:
#   env files (checked-in) -> workdir ; /app,/data paths remapped -> workdir
#   pi -p (harness mode) with the official instruction ; grade = pytest test_outputs.py
#
# Usage:
#   scripts/tbench21/run-official.sh <task1[,task2,...]> [--list]
#   Env: PI_BENCH_MODE=harness|vanilla  PI_BENCH_RESULTS=dir  PI_TASK_TIMEOUT=sec
# =============================================================================
set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
CACHE="$REPO_ROOT/.cache/tb21"
BASE_URL="https://raw.githubusercontent.com/harbor-framework/terminal-bench-2-1/main"
RESULTS_DIR="${PI_BENCH_RESULTS:-$CACHE/retest}"
MODE="${PI_BENCH_MODE:-harness}"
MODEL="${PI_BENCH_MODEL:-maestro-qwen--deepseek-v4-flash/deepseek-v4-flash}"
THINKING="${PI_BENCH_THINKING:-max}"
TASK_TIMEOUT="${PI_TASK_TIMEOUT:-600}"   # seconds, official is 900-1800
LIST_ONLY=0
case "${1:-}" in --list) LIST_ONLY=1; shift ;; esac

[ -f "$CACHE/tree.json" ] || { echo "missing $CACHE/tree.json" >&2; exit 2; }
IFS=',' read -ra TASKS <<< "${1:-}"
[ "${#TASKS[@]}" -eq 0 ] && { echo "no tasks given" >&2; exit 2; }

if [ "$LIST_ONLY" = 1 ]; then printf '%s\n' "${TASKS[@]}"; exit 0; fi

mkdir -p "$RESULTS_DIR/workspaces" "$RESULTS_DIR/logs"
JSONL="$RESULTS_DIR/results.jsonl"
RUN_ID="$(date +%Y%m%d-%H%M%S)"
echo "== tb21 official retest (pi harness) ==" | tee -a "$JSONL"
echo "run_id=$RUN_ID model=$MODEL mode=$MODE tasks=${#TASKS[@]} started=$(date -Is)" | tee -a "$JSONL"

PASS=0; FAIL=0; SKIP=0

for name in "${TASKS[@]}"; do
  SRC="$CACHE/tasks/$name"
  # --- sync task files (cache once) ---
  if [ ! -f "$SRC/instruction.md" ]; then
    mkdir -p "$SRC"
    python - "$name" "$CACHE" <<'PY' || { echo "SKIP $name: sync failed" | tee -a "$JSONL"; SKIP=$((SKIP+1)); continue; }
import json, os, sys, urllib.request, pathlib
name, cache = sys.argv[1], sys.argv[2]
base = "https://raw.githubusercontent.com/harbor-framework/terminal-bench-2-1/main"
tree = json.load(open(os.path.join(cache, "tree.json")))["tree"]
paths = [t["path"] for t in tree
         if t["path"].startswith(f"tasks/{name}/") and t["type"] == "blob"
         and not t["path"].endswith(("Dockerfile", "solve.sh", ".gitignore", "README.md"))
         and "/solution/" not in t["path"]]
for p in paths:
    rel = p[len(f"tasks/{name}/"):]
    dest = pathlib.Path(cache) / "tasks" / name / rel
    dest.parent.mkdir(parents=True, exist_ok=True)
    if dest.exists() and dest.stat().st_size > 0: continue
    try:
        data = urllib.request.urlopen(base + "/" + p, timeout=40).read()
        dest.write_bytes(data)
    except Exception as e:
        print("warn:", p, e)
PY
  fi
  [ -f "$SRC/instruction.md" ] || { echo "SKIP $name: no instruction" | tee -a "$JSONL"; SKIP=$((SKIP+1)); continue; }

  WORKDIR="$RESULTS_DIR/workspaces/$RUN_ID-$name"
  LOG="$RESULTS_DIR/logs/$RUN_ID-$name.log"
  mkdir -p "$WORKDIR"

  # --- stage environment files (environment/** -> workdir, minus Dockerfile) ---
  if [ -d "$SRC/environment" ]; then
    (cd "$SRC/environment" && find . -type f ! -name Dockerfile ! -name docker-compose.yaml -exec cp --parents {} "$WORKDIR/" \; 2>/dev/null || find . -type f ! -name Dockerfile -exec cp {} "$WORKDIR/" \;)
  fi

  # --- remap absolute container paths -> workdir ---
  WD_ESCAPED="$(printf '%s' "$WORKDIR" | sed 's/\\\\/\\\\\\\\/g')"
  PATCH() { sed "s|/app|$WD_ESCAPED|g; s|/data|$WD_ESCAPED/data|g" "$1" > "$2"; }

  PATCH "$SRC/instruction.md" "$WORKDIR/instruction.md"
  INSTRUCTION="$(cat "$WORKDIR/instruction.md")"
  [ -f "$SRC/tests/test_outputs.py" ] && PATCH "$SRC/tests/test_outputs.py" "$WORKDIR/test_outputs.py"
  # copy any other test assets
  [ -d "$SRC/tests" ] && (cd "$SRC/tests" && find . -type f ! -name test_outputs.py ! -name test.sh -exec cp {} "$WORKDIR/" \; 2>/dev/null || true)

  # --- task setup (setup.sh / make.py), remapped ---
  if [ -f "$SRC/environment/setup.sh" ]; then
    PATCH "$SRC/environment/setup.sh" "$WORKDIR/setup.sh"; chmod +x "$WORKDIR/setup.sh"
    (cd "$WORKDIR" && bash setup.sh >>"$LOG" 2>&1)
  fi
  if [ -f "$SRC/environment/make.py" ]; then
    (cd "$WORKDIR" && python make.py >>"$LOG" 2>&1)
  fi

  echo ">>> [$name] workdir=$WORKDIR" | tee -a "$JSONL"
  START_MS="$(date +%s%3N)"

  PI_ARGS=(-p "$INSTRUCTION" --model "$MODEL" --thinking "$THINKING" --no-session --no-context-files -n "retest-$name")
  [ "$MODE" = "vanilla" ] && PI_ARGS+=(--no-extensions --no-skills --no-prompt-templates --no-themes)
  (cd "$WORKDIR" && timeout -k 10 "$TASK_TIMEOUT" pi "${PI_ARGS[@]}" >"$LOG" 2>&1)
  PI_RC=$?
  END_MS="$(date +%s%3N)"

  if [ $PI_RC -eq 124 ] || [ $PI_RC -eq 137 ]; then
    STATUS="timeout"; VERIFY_OUT="pi hit ${TASK_TIMEOUT}s timeout"
  else
    VERIFY_OUT="$( (cd "$WORKDIR" && timeout -k 5 90 python -m pytest test_outputs.py -q 2>&1) | tail -c 900 )"
    VRC=$?
    if [ $VRC -eq 0 ]; then STATUS="pass"; PASS=$((PASS+1))
    elif [ $VRC -eq 124 ]; then STATUS="timeout"; VERIFY_OUT="pytest timed out"
    else STATUS="fail"; FAIL=$((FAIL+1)); fi
  fi

  python -c '
import json,sys
rec={"task":sys.argv[1],"status":sys.argv[2],"duration_ms":int(sys.argv[3]),
     "model":sys.argv[4],"thinking":sys.argv[5],"timestamp":sys.argv[6],
     "verify_output":sys.argv[7][:600],"log":sys.argv[8],"workdir":sys.argv[9],
     "mode":sys.argv[10],"dataset":"terminal-bench-2-1","official_reward":0}
print(json.dumps(rec, ensure_ascii=False))
' "$name" "$STATUS" "$((END_MS-START_MS))" "$MODEL" "$THINKING" "$(date -Is)" "$VERIFY_OUT" "$LOG" "$WORKDIR" "$MODE" >> "$JSONL"
  echo "      status=$STATUS ($(( (END_MS-START_MS)/1000 ))s)" | tee -a "$JSONL"
done

echo "== done: pass=$PASS fail=$FAIL timeout_skip=$SKIP total=${#TASKS[@]} results=$JSONL" | tee -a "$JSONL"
