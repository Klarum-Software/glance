# Architecture

## Two-layer design

```
┌──────────────────────────────────────────────────────────────────┐
│  Frontend (one of)                                                │
│  • GNOME Shell extension  (Linux/GNOME, native, recommended)     │
│  • Browser at 127.0.0.1:5175/  (any OS with a browser)            │
└──────────────────────────────────────────────────────────────────┘
                                  │ HTTP /api/state (poll, 30s)
                                  ▼
┌──────────────────────────────────────────────────────────────────┐
│  Backend (Node.js, zero npm deps)                                │
│  server/server.js                                                  │
│  ├─ HTTP router  (9 endpoints, all localhost-only)                │
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
| Always-on display     | GNOME extension, loaded by gnome-shell, no autostart     |
| Non-GNOME users       | Browser tab at 127.0.0.1:5175/                           |
| No persistent daemon  | Extension lifecycle manages backend (`enable`→spawn, `disable`→SIGTERM) |
| Zero install pain     | No npm install needed (backend has no dependencies)      |

## Endpoints

| Method | Path                          | Purpose                                          |
|--------|-------------------------------|--------------------------------------------------|
| GET    | `/api/health`                 | `{ ok, version, platform }`                       |
| GET    | `/api/state`                  | Aggregated snapshot                               |
| POST   | `/api/refresh`                | Invalidate caches, return fresh state             |
| POST   | `/api/sync-linear`            | Proxy to configured sync URL                      |
| POST   | `/api/open`                   | `{ url }` opens in default handler                |
| GET    | `/api/config/peers`           | List manually configured remote peers             |
| POST   | `/api/config/peers`           | `{ name, host, port? }` add a manual peer         |
| DELETE | `/api/config/peers/:name`     | Remove a manual peer by name                      |
| GET    | `/`                           | Browser fallback dashboard (and static assets)    |

All endpoints bind to `127.0.0.1` only. Peer-name and host inputs are
validated against `[a-zA-Z0-9._-]` and RFC1123-hostname / IPv4 regexes
respectively; `port` must be `1..65535`. Config mutations write via
sibling tmpfile + rename to avoid corruption.

## Configuration

All optional. See [server/config.js](../server/config.js).

`~/.config/glance/config.json` keys: `port`, `host`, `inboxDir`,
`calendarBin`, `linearSyncUrl`, `services[]`, `presencePort`, `meEmails[]`.

Each is also overridable via `GLANCE_*` env vars.

## Extension structure

```
extension/
├── metadata.json                    # UUID, shell-version, schema id
├── extension.js                     # main entry: PanelMenu.Button + lifecycle
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

- Extension enables, spawns the backend via `Gio.SubprocessLauncher`
  (stdout silenced, stderr drained continuously to avoid pipe-fill
  deadlock; first stderr line captured for diagnostics).
- Backend resolution is path-based, not `which`-based: a list of
  candidate node and `server.js` paths is checked synchronously against
  the filesystem only (no compositor-blocking shell-out).
- Extension polls `/api/state` every `refresh-interval` seconds
  (default 30) through one long-lived `Soup.Session`. All requests pass
  a `Gio.Cancellable` so they unwind cleanly on disable.
- Panel button shows a compact summary: `P1.n  !overdue  >sessions`.
- Click opens the menu, the dashboard renders into St widgets, sized
  via CSS `min-width` driven by `dropdown-width-pct` (set_width on the
  PopupMenu box was unreliable across shell versions).
- Extension disables: SIGTERM to the backend, fallback `force_exit`
  after 1.5 s. The force-exit timeout is a tracked source id and is
  cleared if the child exits cleanly or the extension re-enables.

## What we don't do

- **No autostart files for GNOME.** The extension is the autostart.
- **No npm modules in the backend.** Zero deps.
- **No external network.** All HTTP is to 127.0.0.1.
- **No mutation of external systems** without explicit user action
  (only `/api/open` and `/api/sync-linear` reach outside, both user-driven).
