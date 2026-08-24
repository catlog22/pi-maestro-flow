#!/usr/bin/env bash
set -Eeuo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
REPO_ROOT="$SCRIPT_DIR"
HOST_HOME="${HOME:-}"

SANDBOX="${PI_MAESTRO_DEV_SANDBOX:-$REPO_ROOT/.local/pi-dev}"
WORKSPACE=""
PI_BIN="${PI_MAESTRO_DEV_PI:-$REPO_ROOT/node_modules/.bin/pi}"
OFFLINE=1
NO_SESSION=1
NO_CONTEXT_FILES=1
NO_SKILLS=1
FRESH=0
CLEAN=0
REQUIRE_PINNED_PI=0
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
  --require-pinned-pi     Refuse to launch unless the Pi version matches the
                          repository-pinned @earendil-works/pi-coding-agent
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

# Destroy one sandbox tree, and only something that is a sandbox tree.
#
# Four exact-string comparisons are not a guard: `--sandbox /Users --clean`
# passes all of them, and so does any real project that happens not to be this
# repository. The rule is positive instead — the target must be a directory this
# script created and still recognises — because a deletion is the one operation
# here that cannot be undone, and the marker is written by the only code path
# that is allowed to produce one.
SANDBOX_MARKER_NAME=".dev-local-pi-sandbox"

safe_remove_sandbox() {
  local target="$1"
  [[ -n "$target" ]] || die "sandbox path is empty"
  [[ -e "$target" ]] || return 0
  [[ -d "$target" ]] || die "refusing to remove a sandbox path that is not a directory: $target"
  [[ "$target" != "/" ]] || die "refusing to remove /"
  [[ "$target" != "$REPO_ROOT" ]] || die "refusing to remove the repository"
  if [[ -n "$HOST_HOME" ]]; then
    [[ "$target" != "$HOST_HOME" ]] || die "refusing to remove HOME"
  fi
  if [[ ! -f "$target/$SANDBOX_MARKER_NAME" ]]; then
    die "refusing to remove $target: it carries no $SANDBOX_MARKER_NAME marker, so this script did not create it"
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
    --require-pinned-pi)
      REQUIRE_PINNED_PI=1
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

# The only writer of the marker `--clean`/`--fresh` require. An existing sandbox
# created before this marker existed gains it here, on its next ordinary run.
printf 'Created by dev-local-pi.sh. Removing this file makes --clean/--fresh refuse to delete this tree.\n' \
  >"$SANDBOX/$SANDBOX_MARKER_NAME"

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

# A Pi resolved outside the repository is a different build than the one the
# sandbox's evidence was gathered against. Name both versions rather than
# letting the sandbox silently swap the runtime under test.
PINNED_PI_VERSION="$(node -p "require('$REPO_ROOT/node_modules/@earendil-works/pi-coding-agent/package.json').version" 2>/dev/null || printf 'unknown')"
# Pi reads its agent dir on every invocation, `--version` included, so this
# probe runs under the sandbox environment the run itself uses. Executing it
# with the developer's real HOME would touch ~/.pi, which this script exists to
# never do.
ACTUAL_PI_VERSION="$(
  HOME="$SANDBOX/home" \
  USERPROFILE="$SANDBOX/home" \
  PI_CODING_AGENT_DIR="$SANDBOX/home/.pi/agent" \
  XDG_CONFIG_HOME="$SANDBOX/home/.config" \
  XDG_CACHE_HOME="$SANDBOX/cache" \
  XDG_DATA_HOME="$SANDBOX/data" \
  TMPDIR="$SANDBOX/tmp" \
  "$PI_BIN" --version 2>/dev/null | tr -d '\r\n' || printf 'unknown'
)"
if [[ "$ACTUAL_PI_VERSION" != "$PINNED_PI_VERSION" ]]; then
  PI_VERSION_MESSAGE="$(printf 'sandbox pi %s differs from repo-pinned %s; G2/G4 evidence was gathered against %s' \
    "$ACTUAL_PI_VERSION" "$PINNED_PI_VERSION" "$PINNED_PI_VERSION")"
  if ((REQUIRE_PINNED_PI)); then
    die "$PI_VERSION_MESSAGE"
  fi
  printf 'warning: %s\n' "$PI_VERSION_MESSAGE" >&2
fi

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
  pi:        $PI_BIN ($ACTUAL_PI_VERSION, repo-pinned $PINNED_PI_VERSION)
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
