# Contributing

## Repo layout

See [ARCHITECTURE.md](ARCHITECTURE.md) for the design.

```
glance/
├── extension/   GNOME extension (GJS, 4-space indent)
├── server/      Node.js backend (cross-platform, 2-space indent, zero deps)
├── public/      Browser fallback dashboard
├── install/     Per-OS installers
├── scripts/     Dev helpers (smoke, nested-shell dev loop)
├── assets/      Logo
└── docs/        ARCHITECTURE, INSTALL, TESTING, EXTENSION-BEST-PRACTICES,
                 REMOTE-roadmap, this file
```

## Dev loop

### Backend

```bash
# Run with custom config via env
GLANCE_PORT=5199 GLANCE_INBOX=~/claude-inbox node server/server.js

# Smoke test (boots server on an ephemeral port, hits /api/health and /api/state)
node scripts/smoke.js
```

### Extension

On Wayland, GNOME Shell will not reload extensions without a full
logout/login. `Alt+F2 r` does nothing. Iterate in a nested shell:

```bash
./scripts/dev-shell.sh        # install, boot nested shell, enable glance, stream journal
./scripts/dev-restart.sh      # relaunch on the current tree after edits
```

`dev-shell.sh` starts a dedicated D-Bus session, picks `--nested` vs
`--devkit` based on shell version, waits for `org.gnome.Shell` to claim
its name on the bus, then enables the extension and follows the journal
filtered to the nested PID. Ctrl+C tears down the shell, the bus, and
any orphan Node backend the nested session spawned.

`--no-install` skips the install step. `--keep-logs PATH` mirrors the
journal stream to a file. `MUTTER_DEBUG_NUM_DUMMY_MONITORS` and
`MUTTER_DEBUG_DUMMY_MONITOR_SCALES` are honored for multi-monitor /
HiDPI testing without real hardware.

Only after the nested shell looks clean: log out, log back in, retest
in the real session. See [TESTING.md](TESTING.md) Layer 4 and the
"Recovery from a bricked panel" section there if a bad change takes
out your panel.

### gschema changes

```bash
glib-compile-schemas extension/schemas/
./install/install.sh
```

Both are also run by `dev-shell.sh` (when the install step is enabled).

## Coding style

- Backend: zero npm dependencies. If you reach for a dep, find another way.
- Extension: ES modules. Imports via `gi://`, `resource:///`, and relative
  paths.
- Match existing formatting: 4 spaces in `extension/`, 2 spaces in `server/`
  (mirrors GJS vs Node conventions).
- No comments explaining *what* the code does. Well-named identifiers handle
  that. Comments are for *why*: invariants, gotchas, hidden constraints.
- No em-dashes in project markdown.
- No emojis anywhere (code, docs, commit messages, PR descriptions).

Before changing anything under `extension/`, skim
[EXTENSION-BEST-PRACTICES.md](EXTENSION-BEST-PRACTICES.md). It documents
the GJS/St/Clutter/libsoup3 patterns that survive the shell 46-48 spread
and cites upstream guidance for every rule.

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

Add the new adapter in `server/platform/<os>.js` and wire it up in
`server/platform/index.js`.

## Releasing

1. Bump `version` in `package.json` and `extension/metadata.json`.
2. Tag the commit: `git tag -a vX.Y.Z -m "vX.Y.Z" && git push --tags`.
3. (Optional) Submit the extension to <https://extensions.gnome.org/>.
   When submitting, double-check that the zip contains only the
   `extension/` contents (no bundled `server/`); EGO rejects extensions
   that ship binaries or vendored runtimes.
