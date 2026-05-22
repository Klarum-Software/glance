# Architecture

## Two-layer design

```
┌──────────────────────────────────────────────────────────────────┐
│  Frontend (one of)                                                │
│  • GNOME Shell extension  (Linux/GNOME — native, recommended)     │
│  • Browser at 127.0.0.1:5175/  (any OS with a browser)            │
└──────────────────────────────────────────────────────────────────┘
                                  │ HTTP /api/state (poll, 30s)
                                  ▼
┌──────────────────────────────────────────────────────────────────┐
│  Backend  — Node.js, zero npm deps                                │
│  server/server.js                                                  │
│  ├─ HTTP router  (8 endpoints, all localhost-only)                │
│  ├─ State aggregator                                              │
│  └─ Platform adapter (one of)                                     │
│      • server/platform/linux.js   (systemctl, /proc, ps)          │
│      • server/platform/macos.js   (launchctl, vm_stat, ps)        │
│      • server/platform/windows.js (Get-Service, CIM, tasklist)    │
└──────────────────────────────────────────────────────────────────┘
                                  │
              ┌───────────────────┼────────────────────┐
              ▼                   ▼                    ▼
   ┌─────────────────┐  ┌─────────────────┐  ┌──────────────────┐
   │ Tailscale       │  │ Filesystem      │  │ Local services   │
   │ • peer list     │  │ • linear cache  │  │ • configured     │
   │ • presence:5176 │  │ • calendar      │  │   service status │
   └─────────────────┘  │   cache.json    │  └──────────────────┘
                        └─────────────────┘
```

## Why two layers

| Concern               | Solution                                                 |
|-----------------------|----------------------------------------------------------|
| Cross-OS data         | Node.js backend with thin per-OS adapters                |
| Always-on display     | GNOME extension — loaded by gnome-shell, no autostart    |
| Non-GNOME users       | Browser tab at 127.0.0.1:5175/                           |
| No persistent daemon  | Extension lifecycle manages backend (`enable`→spawn, `disable`→SIGTERM) |
| Zero install pain     | No npm install needed — backend has no dependencies       |

## Endpoints

| Method | Path               | Purpose                              |
|--------|--------------------|--------------------------------------|
| GET    | `/api/health`      | `{ ok, version, platform }`           |
| GET    | `/api/state`       | Aggregated snapshot                   |
| POST   | `/api/refresh`     | Invalidate caches, return fresh state |
| POST   | `/api/sync-linear` | Proxy to configured sync URL          |
| POST   | `/api/open`        | `{ url }` → opens in default handler  |
| GET    | `/`                | Browser fallback dashboard            |

## Configuration

All optional. See [server/config.js](../server/config.js).

`~/.config/glance/config.json` keys: `port`, `host`, `inboxDir`,
`calendarBin`, `linearSyncUrl`, `linearApiKey`, `services[]`,
`presencePort`, `meEmails[]`.

Each is also overridable via `GLANCE_*` env vars.

For the Google Calendar integration (`calendarBin` pointing at
`server/bin/gcal.js`), see [CALENDAR-SETUP.md](CALENDAR-SETUP.md). Each
user creates their own Google Cloud OAuth client so the repo carries no
shared credentials.

## Extension structure

```
extension/
├── metadata.json                    # UUID, shell-version, schema id
├── extension.js                     # main entry — PanelMenu.Button + lifecycle
├── prefs.js                         # Adw-based preferences dialog
├── stylesheet.css                   # Pivi design language inside St
├── schemas/
│   └── org.gnome.shell.extensions.glance.gschema.xml
└── lib/
    ├── api.js          # Soup3 HTTP client
    ├── backend.js      # spawn/stop Node.js subprocess
    ├── format.js       # bytes/uptime/clock helpers
    ├── widgets.js      # widget registry (remote, sessions, linear, calendar)
    ├── render.js       # orchestrator: topbar + iterates configured layout
    └── popout.js       # draggable standalone-window mode
```

## Widget layout

The dashboard is a list of widgets rendered side-by-side. The layout is a
JSON string stored at `widget-layout` in gschema:

```
[
  { "id": "remote",   "enabled": true, "weight": 1 },
  { "id": "sessions", "enabled": true, "weight": 1 },
  { "id": "linear",   "enabled": true, "weight": 2 },
  { "id": "calendar", "enabled": true, "weight": 1 }
]
```

`weight` (1-8) determines relative column width via a `min-width` proportional
to the weight. Widgets register themselves with `registerWidget()` in
`lib/widgets.js`; the parser drops references to unknown ids and appends any
newly registered widgets disabled-by-default, so an extracted klarum-presence
widget would slot in automatically.

`edit-mode` is a boolean gschema key. When true, each column header shows
move-left, move-right, shrink, grow, hide controls. Toggle from the topbar
gear icon or from prefs.

## Standalone window mode

`Main.layoutManager.addChrome()` is used to attach a `St.BoxLayout` to the
stage. The popout has a draggable header and a close button. Position is
persisted in `popout-x` / `popout-y`. Size is set via `popout-width` /
`popout-height` (editable from the "Pop-out" prefs page). `popout-active`
remembers whether to reopen on the next session.

## Threading / lifecycle

- Extension enables → spawns backend via `Gio.SubprocessLauncher`
- Extension polls `/api/state` every `refresh-interval` seconds (default 30)
- Panel button shows compact summary: `P1·n  !overdue  ▸sessions`
- Click → menu opens, dashboard renders in St widgets, sized to
  `dropdown-width-pct` of primary monitor
- If `popout-active` was true at enable, the standalone window is restored
  at its persisted geometry
- Extension disables → SIGTERM to backend, fallback `force_exit` after 1.5s

## What we don't do

- **No autostart files for GNOME.** The extension is the autostart.
- **No npm modules in the backend.** Zero deps.
- **No external network.** All HTTP is to 127.0.0.1.
- **No mutation of external systems** without explicit user action
  (only `/api/open` and `/api/sync-linear` reach outside, both user-driven).
