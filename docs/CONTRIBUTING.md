# Contributing

## Repo layout

See [ARCHITECTURE.md](ARCHITECTURE.md) for the design.

```
glance/
├── server/      Node.js backend (cross-platform)
├── extension/   GNOME extension (GJS)
├── public/      Browser fallback dashboard
├── install/     Per-OS installers
├── docs/        ARCHITECTURE, INSTALL, this file
└── scripts/     Dev helpers (smoke test)
```

## Dev loop

### Backend

```bash
# Run with custom config via env
GLANCE_PORT=5199 GLANCE_INBOX=~/claude-inbox node server/server.js
# Smoke test
node scripts/smoke.js
```

### Extension

```bash
# Update gschema after editing it
glib-compile-schemas extension/schemas/

# Reinstall after editing extension/
./install/install.sh
```

On **Wayland**, GNOME Shell will not reload extensions without a full logout/login.
On **X11**, `Alt+F2 r` reloads.

A development shortcut: run a nested shell to test without logging out:

```bash
dbus-run-session -- gnome-shell --nested --wayland
```

Then inside the nested shell, enable the extension.

## Coding style

- Backend: zero npm dependencies. If you reach for a dep, find another way.
- Extension: ES modules. Imports via `gi://`, `resource:///`, and relative paths.
- Match existing formatting — 4 spaces in extension/, 2 spaces in server/
  (mirrors GJS vs Node conventions).
- No comments explaining *what* the code does — well-named identifiers handle that.
  Comments are for *why*: invariants, gotchas, hidden constraints.

## Adding a platform

Each adapter in `server/platform/` exposes:

```js
{
  serviceStatus(unit): "active" | "inactive" | "failed" | "unknown",
  memoryInfo():        { total_kb, available_kb, used_kb } | null,
  processList():       [{ pid, ppid, rss_kb, args }],
  processCwd(pid):     string | null,
}
```

Add the new adapter in `server/platform/<os>.js` and wire it up in `server/platform/index.js`.

## Releasing

1. Bump `version` in `package.json` and `extension/metadata.json`.
2. Tag the commit: `git tag -a vX.Y.Z -m "vX.Y.Z" && git push --tags`.
3. (Optional) Submit the extension to <https://extensions.gnome.org/>.
