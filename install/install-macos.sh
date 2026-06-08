#!/usr/bin/env bash
# glance — macOS installer. Sets up the backend as a launchd LaunchAgent so
# it auto-starts at login. There is no GNOME extension on macOS — the
# browser at http://127.0.0.1:5172/ is the UI.

set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LABEL="com.klarum.glance"
PLIST_SRC="$REPO_DIR/install/com.klarum.glance.plist"
PLIST_DST="$HOME/Library/LaunchAgents/$LABEL.plist"
NODE_BIN="$(command -v node || true)"

bold()  { printf "\033[1m%s\033[0m\n" "$*"; }
green() { printf "\033[32m%s\033[0m\n" "$*"; }
red()   { printf "\033[31m%s\033[0m\n" "$*"; }

bold "glance macOS installer"

if [[ -z "$NODE_BIN" ]]; then red "node not found — install via brew install node"; exit 1; fi
NODE_MAJOR=$(node -p 'process.versions.node.split(".")[0]')
if [[ "$NODE_MAJOR" -lt 18 ]]; then red "node $NODE_MAJOR is too old — need >=18"; exit 1; fi
echo "  node: $(node -v) at $NODE_BIN"

mkdir -p "$HOME/Library/LaunchAgents"

# substitute node path + repo path into the plist
sed \
  -e "s|/usr/local/bin/node|$NODE_BIN|" \
  -e "s|/Users/CHANGE_ME/repos/glance|$REPO_DIR|g" \
  "$PLIST_SRC" > "$PLIST_DST"
green "  ✓ wrote $PLIST_DST"

# reload
launchctl unload "$PLIST_DST" 2>/dev/null || true
launchctl load   "$PLIST_DST"
green "  ✓ launchctl load $LABEL"

echo
bold "next steps"
echo "  • Open http://127.0.0.1:5172/ — the dashboard should be live."
echo "  • Logs: /tmp/glance.out.log, /tmp/glance.err.log"
echo "  • Stop: launchctl unload $PLIST_DST"
echo
green "done."
