#!/usr/bin/env bash
# glance — Linux/GNOME installer.
#
# What this does:
#   1. Verifies node >=18, gnome-shell, gnome-extensions
#   2. Compiles the gschema
#   3. Installs the extension to ~/.local/share/gnome-shell/extensions/
#   4. Enables the extension
#   5. Prints next steps (logout/restart shell required on Wayland)
#
# Idempotent: run again to update.

set -euo pipefail

UUID="glance@klarum-software.github.io"
REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
EXT_SRC="$REPO_DIR/extension"
EXT_DST="$HOME/.local/share/gnome-shell/extensions/$UUID"

bold()  { printf "\033[1m%s\033[0m\n" "$*"; }
green() { printf "\033[32m%s\033[0m\n" "$*"; }
yellow(){ printf "\033[33m%s\033[0m\n" "$*"; }
red()   { printf "\033[31m%s\033[0m\n" "$*"; }

# ── 1. checks ──────────────────────────────────────────────────────────────
bold "glance installer"
echo "  repo: $REPO_DIR"

command -v node          >/dev/null 2>&1 || { red "node not found — install Node.js >=18"; exit 1; }
NODE_MAJOR=$(node -p 'process.versions.node.split(".")[0]')
if [[ "$NODE_MAJOR" -lt 18 ]]; then red "node $NODE_MAJOR is too old — need >=18"; exit 1; fi
echo "  node: $(node -v)"

command -v gnome-shell        >/dev/null 2>&1 || { red "gnome-shell not found — glance needs GNOME"; exit 1; }
command -v gnome-extensions   >/dev/null 2>&1 || { red "gnome-extensions CLI not found"; exit 1; }
SHELL_VER=$(gnome-shell --version | awk '{print $3}' | cut -d. -f1)
echo "  gnome-shell: $(gnome-shell --version)"
if [[ "$SHELL_VER" -lt 45 ]]; then yellow "  warning: GNOME Shell <45 is not supported (you have $SHELL_VER)"; fi

command -v glib-compile-schemas >/dev/null 2>&1 || { red "glib-compile-schemas not found (apt install libglib2.0-bin)"; exit 1; }

# ── 2. compile gschema ─────────────────────────────────────────────────────
bold "compiling settings schema"
glib-compile-schemas "$EXT_SRC/schemas/"
green "  ✓ schemas/gschemas.compiled"

# ── 3. install extension ───────────────────────────────────────────────────
bold "installing extension to $EXT_DST"
mkdir -p "$EXT_DST"
# rsync if available, else cp
if command -v rsync >/dev/null 2>&1; then
  rsync -a --delete --exclude=".git" "$EXT_SRC/" "$EXT_DST/"
  # bundle the backend so the extension is self-contained after install
  rsync -a --delete "$REPO_DIR/server/" "$EXT_DST/server/"
  rsync -a --delete "$REPO_DIR/public/" "$EXT_DST/public/"
  install -m 644 "$REPO_DIR/package.json" "$EXT_DST/package.json"
else
  rm -rf "$EXT_DST"
  mkdir -p "$EXT_DST"
  cp -a "$EXT_SRC/." "$EXT_DST/"
  cp -a "$REPO_DIR/server" "$EXT_DST/server"
  cp -a "$REPO_DIR/public" "$EXT_DST/public"
  cp "$REPO_DIR/package.json" "$EXT_DST/package.json"
fi
green "  ✓ files copied (extension + backend + public assets)"

# ── 4. enable ──────────────────────────────────────────────────────────────
bold "enabling extension"
if gnome-extensions list | grep -q "^$UUID\$"; then
  if gnome-extensions enable "$UUID" 2>/dev/null; then
    green "  ✓ enabled"
  else
    yellow "  could not enable via gnome-extensions (X11 needs no reload, Wayland needs logout)"
  fi
else
  yellow "  extension not yet registered — restart gnome-shell or log out and back in"
fi

# ── 5. instructions ────────────────────────────────────────────────────────
echo
bold "next steps"
SESSION_TYPE="${XDG_SESSION_TYPE:-unknown}"
case "$SESSION_TYPE" in
  wayland)
    echo "  • Wayland detected — log out and back in for GNOME Shell to pick up the extension."
    ;;
  x11)
    echo "  • X11 detected — press Alt+F2, type 'r', press Enter to reload GNOME Shell."
    ;;
  *)
    echo "  • Log out and back in, or restart gnome-shell, so it picks up the new extension."
    ;;
esac
echo "  • Then run: gnome-extensions enable $UUID"
echo "  • The extension auto-starts the backend on enable; configure via gnome-extensions prefs $UUID"
echo
green "done."
