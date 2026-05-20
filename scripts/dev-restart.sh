#!/usr/bin/env bash
# glance: kill the running nested dev shell and relaunch on the current tree.
#
# Pairs with scripts/dev-shell.sh. Read the running shell's pid, SIGTERM it,
# wait for the previous dev-shell.sh to finish its cleanup, then exec a fresh
# dev-shell.sh with whatever args were passed.

set -euo pipefail

SHELL_PID_FILE="/tmp/glance-dev-shell.pid"
REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

bold()   { printf "\033[1m%s\033[0m\n" "$*"; }
yellow() { printf "\033[33m%s\033[0m\n" "$*"; }

if [[ -f "$SHELL_PID_FILE" ]]; then
  OLD_PID=$(cat "$SHELL_PID_FILE" 2>/dev/null || echo "")
  if [[ -n "$OLD_PID" ]] && kill -0 "$OLD_PID" 2>/dev/null; then
    bold "stopping previous nested shell (pid $OLD_PID)"
    kill -TERM "$OLD_PID" 2>/dev/null || true
    # Wait for the gnome-shell process to die (dev-shell.sh's wait will return,
    # which triggers its cleanup trap).
    for _ in $(seq 1 20); do
      kill -0 "$OLD_PID" 2>/dev/null || break
      sleep 0.5
    done
    if kill -0 "$OLD_PID" 2>/dev/null; then
      yellow "  did not exit on SIGTERM, sending SIGKILL"
      kill -KILL "$OLD_PID" 2>/dev/null || true
    fi
    # Wait for the previous dev-shell.sh cleanup to finish (it removes the
    # pid file as its last step). Don't loop forever in case something else
    # is holding the file.
    for _ in $(seq 1 20); do
      [[ -f "$SHELL_PID_FILE" ]] || break
      sleep 0.25
    done
  else
    rm -f "$SHELL_PID_FILE"
  fi
fi

exec "$REPO_DIR/scripts/dev-shell.sh" "$@"
