<p align="center">
  <img src="assets/glance_eye.png" width="600" alt="GLANCE logo" />
</p>

<h1 align="center">GLANCE</h1>

<p align="center">
  <b>Single-screen operator dashboard for GNOME</b>
</p>

<p align="center">
  <a href="docs/ARCHITECTURE.md">architecture</a> ·
  <a href="docs/INSTALL.md">install</a> ·
  <a href="docs/TESTING.md">testing</a> ·
  <a href="docs/EXTENSION-BEST-PRACTICES.md">extension rules</a> ·
  <a href="docs/CONTRIBUTING.md">contributing</a>
</p>

<p align="center">
  <img src="https://img.shields.io/badge/GNOME-46%E2%80%9348-4A86CF?style=flat-square&logo=gnome&logoColor=white" alt="GNOME 46-48" />
  <img src="https://img.shields.io/badge/Node.js-%E2%89%A518-339933?style=flat-square&logo=node.js&logoColor=white" alt="Node.js 18+" />
  <img src="https://img.shields.io/badge/deps-zero-1c1f25?style=flat-square" alt="zero deps" />
  <img src="https://img.shields.io/badge/license-MIT-blue?style=flat-square" alt="MIT" />
</p>

---

A GNOME Shell extension that drops a four-column operator dashboard from a
top-panel button: tailnet peers, local claude sessions, Linear queue, calendar.
The extension supervises a zero-deps Node.js backend on `127.0.0.1:5175`. A
browser dashboard at the same URL exists for data-layer QA and non-GNOME
users.

```
┌───────────────────────────────────────────────────────────────────────┐
│ ● klarum glance   14:32         orchestrator  inbox-ui  work-tmux     │
├──────────────┬────────────────┬────────────────────┬──────────────────┤
│ REMOTE       │ SESSIONS       │ LINEAR             │ CALENDAR         │
│  3/4 online  │  4 sess        │  18 open · 2 over  │  6 upcoming      │
│              │                │                    │                  │
│ ● tower      │ glance/main    │ KLA-204 P1 In Pr   │ today            │
│   up 4d      │   620 MB · 2s  │   ship audit fixes │ 14:30 stand-up   │
│ ● laptop     │ noah-tools     │ KLA-198 P2 Todo    │ 16:00 review     │
│   up 6h      │   480 MB       │   wire calendar    │ tomorrow         │
│ ○ mini       │                │ ...                │ 10:00 1:1        │
└──────────────┴────────────────┴────────────────────┴──────────────────┘
```

## Install

```bash
git clone https://github.com/Klarum-Software/glance.git ~/repos/glance
cd ~/repos/glance
./install/install.sh
```

Wayland requires a logout/login for GNOME Shell to load a new extension. Then:

```bash
gnome-extensions enable glance@klarum-software.github.io
```

The panel button appears. Click it for the dashboard. Configure with
`gnome-extensions prefs glance@klarum-software.github.io` (port, refresh
interval, dropdown width, backend path) or via `~/.config/glance/config.json`
(data sources, see below).

macOS and Windows have headless-backend installers under `install/`; see
[docs/INSTALL.md](docs/INSTALL.md). The dashboard renders in any browser at
`http://127.0.0.1:5175/` once the backend is running.

## Configuration

`~/.config/glance/config.json` (optional, all fields have defaults):

```json
{
  "port":          5175,
  "inboxDir":      "/home/you/claude-inbox",
  "calendarBin":   "/home/you/repos/noah-tools/lib/calendar.js",
  "linearSyncUrl": "http://127.0.0.1:5174/api/linear/sync",
  "services":      ["orchestrator", "inbox-ui", "work-tmux"],
  "meEmails":      ["you@example.com"],
  "presencePort":  5176,
  "peers":         [{ "name": "mini", "host": "100.x.y.z" }]
}
```

Every field is also overridable via env (`GLANCE_PORT`, `GLANCE_INBOX`,
`GLANCE_CALENDAR_BIN`, `GLANCE_LINEAR_SYNC`, `GLANCE_SERVICES`,
`GLANCE_ME_EMAILS`, `GLANCE_PRESENCE_PORT`). See
[server/config.js](server/config.js).

Manual peers can also be added or removed at runtime through the REMOTE
column actions, which call the `/api/config/peers` endpoints; changes are
written atomically to the config file.

## What it shows

| Column   | Source                                                                       |
|----------|------------------------------------------------------------------------------|
| REMOTE   | `tailscale status --json` plus a `klarum-presence` agent on each peer (port 5176), plus manual peers added through the column. |
| SESSIONS | `ps`-derived `claude` process trees with worktree detection and aggregated RSS vs total RAM. |
| LINEAR   | `<inboxDir>/.linear-cache/*.json` filtered to `meEmails`, sorted by priority then due date. |
| CALENDAR | `calendarBin` stdout (a one-shot `node <bin> list 7`), cached for 60 s.       |

`POST /api/sync-linear` proxies to a configured external sync URL; `POST
/api/open` opens a URL via `xdg-open` / `open` / `start`; `POST /api/refresh`
invalidates the calendar cache and returns a fresh snapshot.

## Repo layout

```
glance/
├── extension/            GNOME extension (GJS, 4-space indent)
│   ├── extension.js        PanelMenu.Button + lifecycle
│   ├── prefs.js            Adw preferences dialog
│   ├── stylesheet.css      St-native styling (dark, Pivi palette)
│   ├── lib/
│   │   ├── api.js          Soup3 client (cancellable, single session)
│   │   ├── backend.js      Gio.Subprocess lifecycle for the Node server
│   │   ├── format.js       bytes/uptime/clock helpers
│   │   └── render.js       St widgets for the 4-column dashboard
│   └── schemas/            gschema for backend-port, refresh-interval, etc.
├── server/               Node.js backend (2-space indent, zero npm deps)
│   ├── server.js           HTTP router, state aggregator, action handlers
│   ├── config.js           ~/.config/glance/config.json loader + atomic mutate
│   └── platform/           linux / macos / windows adapters
├── public/               Browser-fallback dashboard (HTML/CSS/JS)
├── install/              Per-OS installers (Linux, macOS, Windows)
├── scripts/              Dev loop helpers (smoke, dev-shell, dev-restart)
├── assets/               Logo
└── docs/                 ARCHITECTURE, INSTALL, TESTING, etc.
```

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the canonical design.

## Dev loop

Backend smoke test:

```bash
node scripts/smoke.js
```

Iterate on the extension in a nested gnome-shell (the only safe place to
reload on Wayland):

```bash
./scripts/dev-shell.sh        # install, boot nested shell, stream journal
./scripts/dev-restart.sh      # relaunch on the current tree
```

See [docs/TESTING.md](docs/TESTING.md) for the four-layer dev loop and TTY
recovery if the real-session panel ever bricks.

Before touching anything under `extension/`, skim
[docs/EXTENSION-BEST-PRACTICES.md](docs/EXTENSION-BEST-PRACTICES.md). It
catalogues GJS / St / Clutter / libsoup3 patterns that survive the
shell 46→48 spread, with citations to upstream guidance for every rule.

## License

MIT. See [LICENSE](LICENSE).
