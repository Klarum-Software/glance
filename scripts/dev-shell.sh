#!/usr/bin/env bash
# glance one-command nested-shell dev loop.
#
# Installs the current tree, starts a dedicated D-Bus session, launches a
# nested gnome-shell against that bus, enables glance inside it, and streams
# the journal filtered to that PID. Ctrl+C tears it all down.
#
# Why a dedicated bus: gnome-extensions talks to org.gnome.Shell over the
# session bus. Running `gnome-extensions enable` from the host terminal hits
# the host shell, not the nested one. Pointing DBUS_SESSION_BUS_ADDRESS at a
# bus we control lets us drive the nested shell from this script.
#
# See docs/TESTING.md (Layer 3) for the manual equivalent and TTY recovery.

set -euo pipefail

UUID="glance@klarum-software.github.io"
REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RUNTIME_DIR="${XDG_RUNTIME_DIR:-/tmp}"
BUS_SOCK="$RUNTIME_DIR/glance-dev.bus"
BUS_PID_FILE="$RUNTIME_DIR/glance-dev.bus.pid"
SHELL_PID_FILE="$RUNTIME_DIR/glance-dev-shell.pid"
SHELL_LOG="$RUNTIME_DIR/glance-dev-shell.log"

NO_INSTALL=0
KEEP_LOGS=""

bold()   { printf "\033[1m%s\033[0m\n" "$*"; }
green()  { printf "\033[32m%s\033[0m\n" "$*"; }
yellow() { printf "\033[33m%s\033[0m\n" "$*"; }
red()    { printf "\033[31m%s\033[0m\n" "$*" >&2; }

usage() {
  cat <<EOF
usage: $(basename "$0") [--no-install] [--keep-logs PATH]

Installs glance, boots a nested gnome-shell on a dedicated D-Bus session,
enables glance inside it, and streams the journal. Ctrl+C cleans up.

  --no-install        skip running install/install.sh (use when you just
                      re-installed and want to relaunch only)
  --keep-logs PATH    mirror the streamed journal to PATH for later inspection
  -h, --help          show this help

Honors MUTTER_DEBUG_NUM_DUMMY_MONITORS and MUTTER_DEBUG_DUMMY_MONITOR_SCALES
from the environment (passed through to the nested process).

See docs/TESTING.md Layer 3 for context and recovery steps.
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --no-install) NO_INSTALL=1; shift ;;
    --keep-logs)
      if [[ -z "${2:-}" ]]; then red "--keep-logs requires a PATH"; exit 2; fi
      KEEP_LOGS="$2"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) red "unknown argument: $1"; usage >&2; exit 2 ;;
  esac
done

# State the trap may need to clean up. Populated as we go; trap is safe to fire
# at any point. OUR_BUS_ADDRESS is the reaper's authority: empty means the
# dedicated bus is not yet up, so we must not touch any node backend (it could
# be the user's host-session glance).
SHELL_PID=""
JOURNAL_PID=""
BUS_PID=""
OUR_BUS_ADDRESS=""

cleanup() {
  local code="${1:-$?}"
  trap - EXIT INT TERM

  if [[ -n "$JOURNAL_PID" ]] && kill -0 "$JOURNAL_PID" 2>/dev/null; then
    kill -TERM "$JOURNAL_PID" 2>/dev/null || true
    wait "$JOURNAL_PID" 2>/dev/null || true
  fi

  if [[ -n "$SHELL_PID" ]] && kill -0 "$SHELL_PID" 2>/dev/null; then
    bold "stopping nested gnome-shell (pid $SHELL_PID)"
    kill -TERM "$SHELL_PID" 2>/dev/null || true
    for _ in 1 2 3 4 5 6 7 8 9 10; do
      kill -0 "$SHELL_PID" 2>/dev/null || break
      sleep 0.5
    done
    if kill -0 "$SHELL_PID" 2>/dev/null; then
      yellow "  nested shell did not exit on SIGTERM, sending SIGKILL"
      kill -KILL "$SHELL_PID" 2>/dev/null || true
    fi
  fi

  if [[ -z "$BUS_PID" && -f "$BUS_PID_FILE" ]]; then
    BUS_PID=$(cat "$BUS_PID_FILE" 2>/dev/null || true)
  fi
  if [[ -n "$BUS_PID" ]] && kill -0 "$BUS_PID" 2>/dev/null; then
    kill -TERM "$BUS_PID" 2>/dev/null || true
    for _ in 1 2 3 4; do
      kill -0 "$BUS_PID" 2>/dev/null || break
      sleep 0.5
    done
    if kill -0 "$BUS_PID" 2>/dev/null; then
      kill -KILL "$BUS_PID" 2>/dev/null || true
    fi
  fi

  # Reap any orphan glance backend that the nested shell spawned. Gate on
  # OUR_BUS_ADDRESS (set only after the dedicated bus is confirmed up), not
  # DBUS_SESSION_BUS_ADDRESS, which still points at the host bus until then.
  if [[ -n "$OUR_BUS_ADDRESS" ]]; then
    local our_addr="$OUR_BUS_ADDRESS"
    local pid orphans=()
    while read -r pid; do
      [[ -z "$pid" ]] && continue
      [[ -r "/proc/$pid/environ" ]] || continue
      # `local x=$(...)` masks the inner pipeline status from set -o pipefail,
      # so a no-match grep does not abort cleanup mid-reap.
      local env_addr
      env_addr=$(tr '\0' '\n' < "/proc/$pid/environ" 2>/dev/null \
        | grep '^DBUS_SESSION_BUS_ADDRESS=' | head -1 | cut -d= -f2- || true)
      if [[ "$env_addr" == "$our_addr" ]]; then
        orphans+=("$pid")
      fi
    done < <(pgrep -f 'node .*server/server\.js' 2>/dev/null || true)
    if (( ${#orphans[@]} > 0 )); then
      yellow "  orphan glance backend(s) detected: ${orphans[*]}"
      kill -TERM "${orphans[@]}" 2>/dev/null || true
      sleep 0.5
      kill -KILL "${orphans[@]}" 2>/dev/null || true
    fi
  fi

  rm -f "$SHELL_PID_FILE" "$BUS_PID_FILE" "$BUS_SOCK"
  # Preserve the nested-shell log on unexpected exits so the user has something
  # to debug from. Clean shutdowns (0) and signal exits (130/143) discard it.
  if [[ "$code" -eq 0 || "$code" -eq 130 || "$code" -eq 143 ]]; then
    rm -f "$SHELL_LOG"
  elif [[ -f "$SHELL_LOG" ]]; then
    yellow "  preserved nested shell log at $SHELL_LOG"
  fi
  exit "$code"
}
trap 'cleanup 130' INT
trap 'cleanup 143' TERM
trap cleanup EXIT

# ── checks ─────────────────────────────────────────────────────────────────
for cmd in dbus-daemon gdbus gnome-shell gnome-extensions journalctl; do
  command -v "$cmd" >/dev/null 2>&1 || { red "$cmd not found"; exit 1; }
done

SHELL_VER=$(gnome-shell --version | awk '{print $3}' | cut -d. -f1)
if (( SHELL_VER >= 49 )); then
  NESTED_FLAG="--devkit"
else
  NESTED_FLAG="--nested"
fi
bold "glance dev shell"
echo "  gnome-shell: $(gnome-shell --version)  flag: $NESTED_FLAG --wayland"

# Refuse to run if a previous instance is still alive. Leftover pid files from
# crashes are removed silently.
if [[ -f "$SHELL_PID_FILE" ]]; then
  OLD_PID=$(cat "$SHELL_PID_FILE" 2>/dev/null || echo "")
  if [[ -n "$OLD_PID" ]] && kill -0 "$OLD_PID" 2>/dev/null; then
    red "another nested shell is already running (pid $OLD_PID)"
    red "  stop it with: scripts/dev-restart.sh   (or kill $OLD_PID)"
    # Don't run the regular cleanup; that would terminate the live instance.
    trap - EXIT INT TERM
    exit 1
  fi
  rm -f "$SHELL_PID_FILE"
fi

# ── install ────────────────────────────────────────────────────────────────
if (( NO_INSTALL == 0 )); then
  bold "installing extension"
  "$REPO_DIR/install/install.sh"
fi

# ── dedicated D-Bus session ────────────────────────────────────────────────
bold "starting dedicated D-Bus session"
rm -f "$BUS_SOCK" "$BUS_PID_FILE"
# dbus-daemon writes its pid to the FD we hand it before forking; the parent
# returns once the daemon is listening.
exec 9>"$BUS_PID_FILE"
dbus-daemon --session \
  --address="unix:path=$BUS_SOCK" \
  --fork \
  --print-pid=9
exec 9>&-
BUS_PID=$(cat "$BUS_PID_FILE")
if [[ -z "$BUS_PID" ]] || ! kill -0 "$BUS_PID" 2>/dev/null; then
  red "dbus-daemon failed to start"
  exit 1
fi
export DBUS_SESSION_BUS_ADDRESS="unix:path=$BUS_SOCK"
# Arm the orphan reaper only now that the dedicated bus is confirmed up.
# Anything that failed before this point would otherwise have scoped the reap
# by the host bus address.
OUR_BUS_ADDRESS="$DBUS_SESSION_BUS_ADDRESS"
echo "  bus pid: $BUS_PID  address: $DBUS_SESSION_BUS_ADDRESS"

# ── launch nested gnome-shell ──────────────────────────────────────────────
bold "launching nested gnome-shell"
# Redirect to a log so the terminal stays clean; if startup fails we'll show it.
gnome-shell "$NESTED_FLAG" --wayland >"$SHELL_LOG" 2>&1 &
SHELL_PID=$!
echo "$SHELL_PID" > "$SHELL_PID_FILE"
echo "  pid: $SHELL_PID  log: $SHELL_LOG"

# Wait for org.gnome.Shell to claim its name on the nested bus.
NAME_FOUND=0
for _ in $(seq 1 60); do
  if gdbus call --session \
      --dest=org.freedesktop.DBus \
      --object-path=/org/freedesktop/DBus \
      --method=org.freedesktop.DBus.NameHasOwner org.gnome.Shell 2>/dev/null \
      | grep -q true; then
    NAME_FOUND=1
    break
  fi
  if ! kill -0 "$SHELL_PID" 2>/dev/null; then
    red "nested gnome-shell exited during startup. last lines of $SHELL_LOG:"
    tail -n 20 "$SHELL_LOG" >&2 || true
    exit 1
  fi
  sleep 0.5
done
if (( NAME_FOUND == 0 )); then
  red "nested gnome-shell did not register on D-Bus within 30s. last lines of $SHELL_LOG:"
  tail -n 20 "$SHELL_LOG" >&2 || true
  exit 1
fi
green "  ready"

# ── enable extension inside the nested session ─────────────────────────────
bold "enabling $UUID in nested shell"
if gnome-extensions enable "$UUID"; then
  green "  enabled"
else
  yellow "  enable returned non-zero. the extension may already be enabled,"
  yellow "  or there may be a load error in the journal below."
fi

# ── stream the journal ─────────────────────────────────────────────────────
bold "streaming journal for pid $SHELL_PID (Ctrl+C to stop)"
echo

JOURNAL_CMD=(journalctl --user --follow --output=cat --since=now
             _COMM=gnome-shell _PID="$SHELL_PID")
if [[ -n "$KEEP_LOGS" ]]; then
  mkdir -p "$(dirname "$KEEP_LOGS")"
  "${JOURNAL_CMD[@]}" 2>/dev/null | tee "$KEEP_LOGS" &
else
  "${JOURNAL_CMD[@]}" 2>/dev/null &
fi
JOURNAL_PID=$!

# Block until the nested shell exits (window closed) or a signal arrives.
# `|| true` keeps `set -e` happy when wait returns 130/143 on signal.
wait "$SHELL_PID" || true
