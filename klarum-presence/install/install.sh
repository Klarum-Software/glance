#!/usr/bin/env bash
# klarum-presence installer. Copies the agent under
# ~/.local/share/klarum-presence and registers a user systemd unit.
#
# Idempotent: run again to update.

set -euo pipefail

SRC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DST_DIR="$HOME/.local/share/klarum-presence"
UNIT_SRC="$SRC_DIR/install/klarum-presence.service"
UNIT_DST="$HOME/.config/systemd/user/klarum-presence.service"

bold()  { printf "\033[1m%s\033[0m\n" "$*"; }
green() { printf "\033[32m%s\033[0m\n" "$*"; }
red()   { printf "\033[31m%s\033[0m\n" "$*" >&2; }

command -v node >/dev/null 2>&1 || { red "node not found — install Node.js >=18"; exit 1; }
NODE_MAJOR=$(node -p 'process.versions.node.split(".")[0]')
if [[ "$NODE_MAJOR" -lt 18 ]]; then red "node $NODE_MAJOR is too old — need >=18"; exit 1; fi

bold "klarum-presence installer"
echo "  source:  $SRC_DIR"
echo "  install: $DST_DIR"

mkdir -p "$DST_DIR"
cp -R "$SRC_DIR/bin" "$SRC_DIR/lib" "$SRC_DIR/package.json" "$SRC_DIR/README.md" "$DST_DIR/"
chmod +x "$DST_DIR/bin/klarum-presence"
green "  ✓ files copied"

if command -v systemctl >/dev/null 2>&1 && [[ -d "$HOME/.config" ]]; then
  mkdir -p "$(dirname "$UNIT_DST")"
  cp "$UNIT_SRC" "$UNIT_DST"
  systemctl --user daemon-reload
  systemctl --user enable --now klarum-presence.service
  green "  ✓ systemd user unit enabled"
  echo
  echo "  status: systemctl --user status klarum-presence"
  echo "  logs:   journalctl --user -fu klarum-presence"
  echo "  test:   curl -s http://127.0.0.1:5176/presence | jq"
else
  echo "  (systemd not detected — run the agent manually with:)"
  echo "  node $DST_DIR/bin/klarum-presence"
fi
