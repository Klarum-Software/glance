# CLAUDE.md — handoff for the next session

You are continuing work on **glance**, a single-screen operator dashboard. It
exists in two forms: a **GNOME Shell extension** (Linux/GNOME, the
recommended frontend) and a **browser fallback** at `127.0.0.1:5175/` (any
OS). Both talk to the same zero-dep Node.js backend at `server/server.js`.

Full design is in [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md). Read that
first if anything below is unclear.

## State of the world

The previous session shipped v0.1.0 — repo created at
<https://github.com/Klarum-Software/glance>, scaffolded, code written, docs
written, pushed. Local was 1 commit ahead of origin (the docs commit); the
user pushed before opening this session, so `main` should be even with the
remote.

**Validated:**
- `node scripts/smoke.js` green — health + state endpoints work
- Browser fallback at `127.0.0.1:5175/` renders identically to the
  reference screenshot the user provided (saved at
  `~/glance-screenshots/browser-fallback-2.png`)
- `./install/install.sh` runs cleanly, installs to
  `~/.local/share/gnome-shell/extensions/glance@klarum-software.github.io/`,
  compiles the gschema, copies extension + bundled `server/` + `public/`
- All extension JS files parse via `node --check`

**NOT yet validated** (highest-risk follow-up):
- The extension actually rendering inside gnome-shell. JS syntax is clean
  but the GNOME-side APIs are untested at runtime. The user needs to log
  out + back in (Wayland), then `gnome-extensions enable glance@klarum-software.github.io`.
- If they did that before opening this session, ask them what they saw.

## High-risk code to check first if the extension breaks

If the user reports the extension failing to load or rendering wrong, suspect
these in order:

1. **`extension/lib/api.js`** — `Soup.Message.new_request_body_from_bytes()`
   may need different invocation; the async send/read pattern differs across
   libsoup3 versions. Failure mode: `/api/state` requests silently never
   resolve, panel button stays at default text.

2. **`extension/extension.js` lines around `_onOpen()`** — `this.menu.box.set_width()`
   may not be honored by PopupMenu; the dropdown might be a fixed narrow
   width regardless of `dropdown-width-pct`. Failure mode: dropdown opens but
   is only ~200px wide.

3. **`extension/lib/render.js` `makeColumn()`** — the `add_actor`/`set_child`
   shim for `St.ScrollView` is GNOME-version-dependent. On 46, `set_child` is
   correct; on 45, only `add_actor` works. Failure mode: empty columns.

4. **`extension/lib/backend.js` `resolveServerPath()`** — relies on file
   layout post-install. Verify `ls ~/.local/share/gnome-shell/extensions/glance@klarum-software.github.io/server/server.js` exists.

5. **Subprocess spawn** in `Backend.start()` — if `node` isn't in the
   gnome-shell process's $PATH, fall back to `/usr/bin/node`. Currently
   `resolveNodePath()` uses `GLib.spawn_command_line_sync("which node")`
   which may return empty if the gnome-shell launch environment is sparse.

Read journalctl for actual errors:
```bash
journalctl --user -f -o cat /usr/bin/gnome-shell
# or, for the last hour:
journalctl --user --since "1 hour ago" /usr/bin/gnome-shell | grep -i glance
```

## File map (skip if you've already read it)

```
glance/
├── CLAUDE.md             ← this file
├── README.md             ← public-facing intro
├── package.json          ← name=glance, version=0.1.0, no deps
├── server/
│   ├── server.js         ← HTTP router + state aggregation
│   ├── config.js         ← ~/.config/glance/config.json + env loader
│   └── platform/
│       ├── index.js      ← picks adapter by process.platform
│       ├── linux.js      ← systemctl, /proc/meminfo, ps
│       ├── macos.js      ← launchctl, vm_stat, ps
│       └── windows.js    ← Get-Service, CIM, tasklist (least tested)
├── public/               ← browser fallback dashboard (unchanged from old glance-ui)
├── extension/
│   ├── metadata.json     ← UUID, shell-version=[45..48]
│   ├── extension.js      ← PanelMenu.Button + lifecycle
│   ├── prefs.js          ← Adw preferences dialog
│   ├── stylesheet.css    ← Pivi palette inside St
│   ├── schemas/          ← gschema for the 5 settings keys
│   └── lib/
│       ├── api.js        ← Soup3 HTTP
│       ├── backend.js    ← spawn/stop Node subprocess
│       ├── format.js     ← bytes/uptime helpers (shared w/ render)
│       └── render.js     ← 5-column St rendering
├── install/
│   ├── install.sh        ← Linux/GNOME installer
│   ├── install-macos.sh  ← launchd LaunchAgent
│   ├── install-windows.ps1
│   └── com.klarum.glance.plist
├── docs/
│   ├── ARCHITECTURE.md   ← design rationale, endpoints, lifecycle
│   ├── INSTALL.md        ← per-OS install steps + uninstall
│   └── CONTRIBUTING.md   ← dev loop, style, releasing
└── scripts/smoke.js      ← boots server on 5199, hits /health + /state
```

## Conventions

- **Zero npm deps in `server/`.** Don't add any. The whole appeal is "clone
  and run."
- **No comments explaining WHAT** — names already do that. Comments are for
  WHY: a hidden constraint, a workaround, a non-obvious invariant.
- **Don't push directly to `origin/main`.** The user's setup has a hook
  that blocks it. Commit locally; let them push, or open a PR.
- **All HTTP is `127.0.0.1`.** No external network from the backend except
  `tailscale status --json` (a local CLI) and `klarum-presence` agents on
  tailnet peers (port 5176, also local-network only).
- **Extension code is 4-space indent** (GJS convention); **server code is
  2-space indent** (Node convention). Match the file you're editing.

## Open follow-ups (in rough priority order)

1. **Visually verify the extension** with the user — see "NOT yet validated"
   above. This is the only thing blocking calling v0.1.0 done.
2. **Delete `~/repos/noah-tools/glance-ui/`** once the new extension is
   confirmed working. That's a cross-folder change in the noah-tools
   monorepo — needs its own branch + PR per noah-tools convention.
3. **Disable any existing autostart** the user has for old glance-ui
   (systemd-user unit, .desktop autostart, or tmux session — check
   `systemctl --user status glance-ui`, `~/.config/autostart/`, and
   `~/.config/systemd/user/`).
4. **Add a custom icon for the panel button.** Currently `view-grid-symbolic`
   from the system theme — a Pivi-styled SVG would feel more native.
5. **Submit to <https://extensions.gnome.org/>** if the user wants it
   installable for others. Requires GNOME review; not blocking for personal
   use.
6. **Real test suite.** `scripts/smoke.js` only covers two endpoints. A few
   `node:test` files for `gatherDrafts/gatherLinear/parseCalCache` against
   fixtures would catch regressions.
7. **macOS adapter sanity-check.** I wrote it from spec; nothing has run it
   on actual macOS. Same for Windows (less critical — likely no Klarum
   operator uses Windows).

## Don't do

- Don't refactor anything that isn't broken. v0.1.0 mirrors the original
  glance-ui line-for-line in data gathering — that was intentional, so a
  regression is detectable as "output diverged from the screenshot."
- Don't add JSX, TypeScript, a bundler, or any build step. The point is
  zero-build, zero-deps.
- Don't switch the extension to a WebView. The St-native rendering is
  the entire reason this is a GNOME extension rather than a
  PWA-shortcut-with-extra-steps.
- Don't try to test the extension by reloading gnome-shell on Wayland —
  it doesn't work; the user must log out. For dev iteration, use a nested
  shell (`dbus-run-session -- gnome-shell --nested --wayland`) per
  CONTRIBUTING.md.

## If the user just opens this fresh

Ask: "Did the extension load after you logged back in?" Then proceed based
on their answer. If they say "yes, it works" → mark v0.1.0 done and pick a
follow-up from the list. If they say "no, broken" → start at the high-risk
list above.
