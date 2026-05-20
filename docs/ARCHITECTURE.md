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
`calendarBin`, `linearSyncUrl`, `services[]`, `presencePort`, `meEmails[]`.

Each is also overridable via `GLANCE_*` env vars.

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
    └── render.js       # St widget construction for the 4-column dashboard
```

## Threading / lifecycle

- Extension enables → spawns backend via `Gio.SubprocessLauncher`
- Extension polls `/api/state` every `refresh-interval` seconds (default 30)
- Panel button shows compact summary: `P1·n  !overdue  ▸sessions`
- Click → menu opens, dashboard renders in St widgets, sized to
  `dropdown-width-pct` of primary monitor
- Extension disables → SIGTERM to backend, fallback `force_exit` after 1.5s

## What we don't do

- **No autostart files for GNOME.** The extension is the autostart.
- **No npm modules in the backend.** Zero deps.
- **No external network.** All HTTP is to 127.0.0.1.
- **No mutation of external systems** without explicit user action
  (only `/api/open` and `/api/sync-linear` reach outside, both user-driven).
