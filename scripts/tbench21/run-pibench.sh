#!/usr/bin/env bash
# =============================================================================
# tbench21 eval via the current harness (pi CLI) on pi-terminal-bench tasks
#
# Usage:
#   scripts/tbench21/run-pibench.sh [selector] [--list] [--smoke]
#
#   selector  - tag (e.g. terminal-bench, quixbugs, hard) or comma-separated
#               task names. Default: terminal-bench (the 8 TB-ported tasks).
#   --list    - print matching task names and exit
#   --smoke   - run only the cheapest task (file-operations-hello-world)
#
# Env:
#   PI_BENCH_MODEL     model id (default: maestro-qwen--deepseek-v4-flash/deepseek-v4-flash)
#   PI_BENCH_THINKING  thinking level (default: max)
#   PI_BENCH_RESULTS   results dir (default: .cache/tb21-pibench)
#
# Pipeline per task (mirrors pi-terminal-bench extension semantics):
#   workdir <- setup_files ; pi -p "<instruction>" (cwd=workdir, timeout)
#   verify = task.verify with $BENCH_WORK_DIR -> workdir ; exit 0 => PASS
# =============================================================================
set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
TASKS_DIR="${PI_BENCH_TASKS_DIR:-$REPO_ROOT/.cache/pi-terminal-bench/tasks}"
RESULTS_DIR="${PI_BENCH_RESULTS:-$REPO_ROOT/.cache/tb21-pibench}"
case "$RESULTS_DIR" in
  /*) ;;
  *) RESULTS_DIR="$REPO_ROOT/$RESULTS_DIR" ;;
esac
MODEL="${PI_BENCH_MODEL:-maestro-qwen--deepseek-v4-flash/deepseek-v4-flash}"
THINKING="${PI_BENCH_THINKING:-max}"
# harness = current pi + pi-maestro-flow plugins (default);
# vanilla  = bare pi, --no-extensions (baseline for harness capability A/B)
MODE="${PI_BENCH_MODE:-harness}"

LIST_ONLY=0
case "${1:-}" in
  --list) LIST_ONLY=1; shift ;;
  --mode)
    if [ "${2:-}" = "vanilla" ] || [ "${2:-}" = "harness" ]; then MODE="$2"; shift 2; else echo "bad --mode: ${2:-}" >&2; exit 2; fi ;;
esac
SELECTOR="${1:-terminal-bench}"
SHIM_DIR="$RESULTS_DIR/shim"

PY3_REAL="$(command -v python)"
[ -z "$PY3_REAL" ] && PY3_REAL="$(command -v python3)"

if [ ! -d "$TASKS_DIR" ]; then
  echo "ERROR: tasks dir not found: $TASKS_DIR" >&2
  echo "Clone it first: git clone --depth 1 https://github.com/latent-variable/pi-terminal-bench.git $TASKS_DIR" >&2
  exit 2
fi
if [ -z "$PY3_REAL" ]; then
  echo "ERROR: no python interpreter found" >&2
  exit 2
fi

# ---------------------------------------------------------------------------
# Select tasks
# ---------------------------------------------------------------------------
SELECT_TASKS=()
if [ "$SELECTOR" = "--smoke" ]; then
  SELECT_TASKS=("file-operations-hello-world")
elif [ -f "$TASKS_DIR/$SELECTOR.json" ]; then
  SELECT_TASKS=("$SELECTOR")
elif [[ "$SELECTOR" == *,* ]]; then
  IFS=',' read -ra SELECT_TASKS <<< "$SELECTOR"
else
  for f in "$TASKS_DIR"/*.json; do
    name="$(basename "$f" .json)"
    if python -c '
import json,sys
t=json.load(open(sys.argv[1], encoding="utf-8"))
sel=sys.argv[2]
sys.exit(0 if (t.get("tags") and sel in t["tags"]) or t.get("name")==sel or sel=="all" else 1)
' "$f" "$SELECTOR" 2>/dev/null; then
      SELECT_TASKS+=("$name")
    fi
  done
fi

if [ "$LIST_ONLY" = 1 ]; then
  printf '%s\n' "${SELECT_TASKS[@]}"
  exit 0
fi
if [ "${#SELECT_TASKS[@]}" -eq 0 ]; then
  echo "No tasks matched selector '$SELECTOR'. Available tags: quixbugs hard long-context codegen perf security terminal-bench" >&2
  exit 2
fi

mkdir -p "$RESULTS_DIR/workspaces" "$RESULTS_DIR/logs" "$SHIM_DIR"

# ---------------------------------------------------------------------------
# python3/python shim (Windows Store stub python3 is silent & useless)
# ---------------------------------------------------------------------------
cat > "$SHIM_DIR/python3" <<EOF
#!/usr/bin/env bash
exec "$PY3_REAL" "\$@"
EOF
cat > "$SHIM_DIR/python" <<EOF
#!/usr/bin/env bash
exec "$PY3_REAL" "\$@"
EOF
chmod +x "$SHIM_DIR/python3" "$SHIM_DIR/python"
export PATH="$SHIM_DIR:$PATH"
export PYTHONIOENCODING=utf-8  # Windows console GBK would mangle non-ASCII task text

JSONL="$RESULTS_DIR/results.jsonl"
RUN_ID="$(date +%Y%m%d-%H%M%S)"
echo "== pi-terminal-bench run ==" | tee -a "$JSONL"
echo "run_id=$RUN_ID model=$MODEL thinking=$THINKING mode=$MODE tasks=${#SELECT_TASKS[@]} started=$(date -Is)" | tee -a "$JSONL"

PASS=0; FAIL=0; ERR=0; TIMEOUT=0

for name in "${SELECT_TASKS[@]}"; do
  TASK_FILE="$TASKS_DIR/$name.json"
  [ -f "$TASK_FILE" ] || { echo "SKIP missing task: $name" | tee -a "$JSONL"; continue; }

  TS="$(date +%Y%m%d-%H%M%S)"
  WORKDIR="$RESULTS_DIR/workspaces/$RUN_ID-$name"
  LOG="$RESULTS_DIR/logs/$RUN_ID-$name.log"
  mkdir -p "$WORKDIR"

  # read task fields via python (single source of truth, handles UTF-8)
  TASK_META="$(python -c '
import json,sys
t=json.load(open(sys.argv[1], encoding="utf-8"))
print(json.dumps({"instruction": t["instruction"], "verify": t.get("verify",""), "timeout": t.get("timeout",180000), "setup_files": t.get("setup_files",{})}, ensure_ascii=False))
' "$TASK_FILE")"
  INSTRUCTION="$(python -c "import json,sys; print(json.loads(sys.argv[1])['instruction'])" "$TASK_META")"
  VERIFY="$(python -c "import json,sys; print(json.loads(sys.argv[1])['verify'])" "$TASK_META")"
  TIMEOUT_MS="$(python -c "import json,sys; print(json.loads(sys.argv[1])['timeout'])" "$TASK_META")"
  SETUP_JSON="$(python -c "import json,sys; print(json.dumps(json.loads(sys.argv[1])['setup_files']))" "$TASK_META")"

  # write setup_files into workdir
  python -c '
import json,sys,os,pathlib
files=json.loads(sys.argv[1]); wd=sys.argv[2]
for f,c in files.items():
    p=pathlib.Path(wd)/f
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(c, encoding="utf-8")
' "$SETUP_JSON" "$WORKDIR" 2>>"$LOG" || true

  echo ">>> [$name] workdir=$WORKDIR timeout=${TIMEOUT_MS}ms" | tee -a "$JSONL"
  START_MS="$(date +%s%3N)"

  # run the harness agent (pi CLI, non-interactive) inside the task workspace
  PI_ARGS=(-p "$INSTRUCTION" --model "$MODEL" --thinking "$THINKING" --no-session --no-context-files -n "tbench21-$name")
  [ "$MODE" = "vanilla" ] && PI_ARGS+=(--no-extensions --no-skills --no-prompt-templates --no-themes)
  (cd "$WORKDIR" && timeout -k 10 $((TIMEOUT_MS / 1000 + 30)) pi "${PI_ARGS[@]}" >"$LOG" 2>&1)
  PI_RC=$?

  END_MS="$(date +%s%3N)"
  DURATION_MS=$((END_MS - START_MS))

  if [ $PI_RC -eq 124 ] || [ $PI_RC -eq 137 ]; then
    STATUS="timeout"; VERIFY_OUT="pi run hit timeout (rc=$PI_RC)"
  else
    # grade with the task verify command
    VCMD="${VERIFY//\$BENCH_WORK_DIR/$WORKDIR}"
    VERIFY_OUT="$( (cd "$WORKDIR" && timeout -k 5 60 bash -lc "$VCMD" 2>&1) | tail -c 1200 )"
    VRC=$?
    if [ $VRC -eq 0 ]; then STATUS="pass"; PASS=$((PASS+1))
    elif [ $VRC -eq 124 ]; then STATUS="timeout"; TIMEOUT=$((TIMEOUT+1)); VERIFY_OUT="verify timed out"
    else STATUS="fail"; FAIL=$((FAIL+1)); fi
  fi
  [ "$STATUS" = "timeout" ] && TIMEOUT=$((TIMEOUT+1))

  # record
  python -c '
import json,sys
rec={"task":sys.argv[1],"status":sys.argv[2],"duration_ms":int(sys.argv[3]),
     "model":sys.argv[4],"thinking":sys.argv[5],"timestamp":sys.argv[6],
     "verify_output":sys.argv[7][:800],"log":sys.argv[8],"workdir":sys.argv[9],"mode":sys.argv[10]}
print(json.dumps(rec, ensure_ascii=False))
' "$name" "$STATUS" "$DURATION_MS" "$MODEL" "$THINKING" "$(date -Is)" "$VERIFY_OUT" "$LOG" "$WORKDIR" "$MODE" >> "$JSONL"
  echo "      status=$STATUS (${DURATION_MS}ms)" | tee -a "$JSONL"
done

echo "== done: pass=$PASS fail=$FAIL err=$ERR timeout=$TIMEOUT total=${#SELECT_TASKS[@]} results=$JSONL" | tee -a "$JSONL"
