#!/usr/bin/env bash
set -Eeuo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
REPO_ROOT="$SCRIPT_DIR"
HOST_HOME="${HOME:-}"

SANDBOX="${PI_MAESTRO_DEV_SANDBOX:-$REPO_ROOT/.local/pi-dev}"
WORKSPACE=""
PI_BIN="${PI_MAESTRO_DEV_PI:-$REPO_ROOT/packages/pi-maestro-flow/node_modules/.bin/pi}"
OFFLINE=1
NO_SESSION=1
NO_CONTEXT_FILES=1
NO_SKILLS=1
FRESH=0
CLEAN=0
EXTRA_ARGS=()
HAS_EXTRA_ARGS=0

usage() {
  cat <<'EOF'
Usage: ./dev-local-pi.sh [options] [-- <extra pi args>]

Launch the local Cockpit, Teammate, and Flow source extensions in an isolated Pi.
No package is installed into your normal Pi and ~/.pi is never used.

Options:
  --fresh                 Delete and recreate the sandbox before launch
  --clean                 Delete the sandbox and exit
  --online                Do not pass --offline to Pi
  --session               Allow Pi to persist sessions inside the sandbox
  --with-context-files    Allow context-file discovery in the test workspace
  --with-skills           Allow skill discovery in the test workspace
  --sandbox <path>        Sandbox root (default: .local/pi-dev)
  --workspace <path>      Workspace used by Pi (default: <sandbox>/workspace)
  --pi <path>             Pi executable to use
  -h, --help              Show this help

Environment overrides:
  PI_MAESTRO_DEV_SANDBOX  Default sandbox path
  PI_MAESTRO_DEV_PI       Default Pi executable

Examples:
  ./dev-local-pi.sh
  ./dev-local-pi.sh --fresh
  ./dev-local-pi.sh --online --session
  ./dev-local-pi.sh --workspace /tmp/my-test-project
  ./dev-local-pi.sh -- --model provider/model
  ./dev-local-pi.sh --clean
EOF
}

die() {
  printf 'error: %s\n' "$*" >&2
  exit 1
}

require_value() {
  local option="$1"
  local value="${2:-}"
  [[ -n "$value" ]] || die "$option requires a value"
}

normalize_dir() {
  local target="$1"
  mkdir -p -- "$target"
  (cd -- "$target" && pwd -P)
}

safe_remove_sandbox() {
  local target="$1"
  [[ -n "$target" ]] || die "sandbox path is empty"
  [[ "$target" != "/" ]] || die "refusing to remove /"
  [[ "$target" != "$REPO_ROOT" ]] || die "refusing to remove the repository"
  if [[ -n "$HOST_HOME" ]]; then
    [[ "$target" != "$HOST_HOME" ]] || die "refusing to remove HOME"
  fi
  rm -rf -- "$target"
}

while (($# > 0)); do
  case "$1" in
    --fresh)
      FRESH=1
      shift
      ;;
    --clean)
      CLEAN=1
      shift
      ;;
    --online)
      OFFLINE=0
      shift
      ;;
    --session)
      NO_SESSION=0
      shift
      ;;
    --with-context-files)
      NO_CONTEXT_FILES=0
      shift
      ;;
    --with-skills)
      NO_SKILLS=0
      shift
      ;;
    --sandbox)
      require_value "$1" "${2:-}"
      SANDBOX="$2"
      shift 2
      ;;
    --workspace)
      require_value "$1" "${2:-}"
      WORKSPACE="$2"
      shift 2
      ;;
    --pi)
      require_value "$1" "${2:-}"
      PI_BIN="$2"
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    --)
      shift
      if (($# > 0)); then
        EXTRA_ARGS=("$@")
        HAS_EXTRA_ARGS=1
      fi
      break
      ;;
    *)
      die "unknown option: $1 (use -- to pass arguments to Pi)"
      ;;
  esac
done

# Resolve the sandbox before any destructive operation. Creating it here also
# gives relative --sandbox paths one stable absolute identity.
SANDBOX="$(normalize_dir "$SANDBOX")"

if ((CLEAN)); then
  safe_remove_sandbox "$SANDBOX"
  printf 'Removed Pi development sandbox: %s\n' "$SANDBOX"
  exit 0
fi

if ((FRESH)); then
  safe_remove_sandbox "$SANDBOX"
fi

mkdir -p -- \
  "$SANDBOX/home/.pi/agent" \
  "$SANDBOX/home/.config" \
  "$SANDBOX/cache" \
  "$SANDBOX/data" \
  "$SANDBOX/tmp" \
  "$SANDBOX/npm-cache" \
  "$SANDBOX/maestro-home"

if [[ -z "$WORKSPACE" ]]; then
  WORKSPACE="$SANDBOX/workspace"
fi
WORKSPACE="$(normalize_dir "$WORKSPACE")"

if [[ ! -x "$PI_BIN" ]]; then
  if command -v pi >/dev/null 2>&1; then
    PI_BIN="$(command -v pi)"
    printf 'warning: repository Pi was not found; using %s\n' "$PI_BIN" >&2
  else
    die "Pi executable not found. Run npm install or pass --pi <path>."
  fi
fi
PI_BIN="$(cd -- "$(dirname -- "$PI_BIN")" && pwd -P)/$(basename -- "$PI_BIN")"

COCKPIT_EXTENSION="$REPO_ROOT/packages/pi-cockpit/src/index.ts"
TEAMMATE_EXTENSION="$REPO_ROOT/packages/pi-maestro-teammate/src/extension/index.ts"
FLOW_EXTENSION="$REPO_ROOT/packages/pi-maestro-flow/src/extension/index.ts"

for extension in "$COCKPIT_EXTENSION" "$TEAMMATE_EXTENSION" "$FLOW_EXTENSION"; do
  [[ -f "$extension" ]] || die "extension not found: $extension"
done

PI_ARGS=(
  --no-extensions
  --extension "$COCKPIT_EXTENSION"
  --extension "$TEAMMATE_EXTENSION"
  --extension "$FLOW_EXTENSION"
)

((OFFLINE)) && PI_ARGS+=(--offline)
((NO_SESSION)) && PI_ARGS+=(--no-session)
((NO_CONTEXT_FILES)) && PI_ARGS+=(--no-context-files)
((NO_SKILLS)) && PI_ARGS+=(--no-skills)
if ((HAS_EXTRA_ARGS)); then
  PI_ARGS+=("${EXTRA_ARGS[@]}")
fi

cat <<EOF

Maestro local Pi development sandbox
  sandbox:   $SANDBOX
  workspace: $WORKSPACE
  pi:        $PI_BIN
  agent dir: $SANDBOX/home/.pi/agent
  maestro:   $SANDBOX/maestro-home

Loaded source extensions:
  - pi-cockpit
  - pi-maestro-teammate
  - pi-maestro-flow

Open /maestro-settings after Pi starts.
Reset with: ./dev-local-pi.sh --fresh
Remove with: ./dev-local-pi.sh --clean
EOF

if [[ "$WORKSPACE" != "$SANDBOX"/* ]]; then
  printf '\nwarning: custom workspace is outside the sandbox; project-scope settings may be written to %s/.pi\n' "$WORKSPACE" >&2
fi

(
  export HOME="$SANDBOX/home"
  export USERPROFILE="$SANDBOX/home"
  export PI_CODING_AGENT_DIR="$SANDBOX/home/.pi/agent"
  export MAESTRO_HOME="$SANDBOX/maestro-home"
  export XDG_CONFIG_HOME="$SANDBOX/home/.config"
  export XDG_CACHE_HOME="$SANDBOX/cache"
  export XDG_DATA_HOME="$SANDBOX/data"
  export TMPDIR="$SANDBOX/tmp"
  export npm_config_cache="$SANDBOX/npm-cache"
  export npm_config_userconfig="$SANDBOX/home/.npmrc"

  cd -- "$WORKSPACE"
  exec "$PI_BIN" "${PI_ARGS[@]}"
)
