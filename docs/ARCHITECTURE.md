# Architecture

## Two-layer design

```
┌──────────────────────────────────────────────────────────────────┐
│  Frontend (one of)                                                │
│  • Browser at <host>:5172/  (primary on the mac mini control      │
│    center; reach over the tailnet with host: "tailscale")         │
│  • GNOME Shell extension  (Linux/GNOME — same /api/state)         │
└──────────────────────────────────────────────────────────────────┘
                                  │ HTTP /api/state (poll, 30s)
                                  │ + /api/events (SSE push, ~3s)
                                  │ + /api/tmux/* (terminal, ~1.2s)
                                  ▼
┌──────────────────────────────────────────────────────────────────┐
│  Backend  — Node.js, zero npm deps                                │
│  server/server.js                                                  │
│  ├─ HTTP router  (localhost + tailnet only)                       │
│  ├─ State aggregator                                              │
│  └─ Platform adapter (one of)                                     │
│      • server/platform/linux.js   (systemctl, /proc, ps)          │
│      • server/platform/macos.js   (launchctl, vm_stat, ps)        │
│      • server/platform/windows.js (Get-Service, CIM, tasklist)    │
└──────────────────────────────────────────────────────────────────┘
                                  │
        ┌──────────────┬──────────┼───────────┬──────────────┐
        ▼              ▼          ▼           ▼              ▼
 ┌────────────┐ ┌───────────┐ ┌────────┐ ┌───────────┐ ┌──────────┐
 │ Tailscale  │ │ tmux CLI  │ │ Google │ │ Filesystem│ │ Local    │
 │ • peers    │ │ • windows │ │ • gcal │ │ • cal /   │ │ services │
 │ • presence │ │ • capture │ │ • gmail│ │   gmail   │ │          │
 │   :5176    │ │ • send    │ │  (bins)│ │   cache   │ │          │
 └────────────┘ └───────────┘ └────────┘ └───────────┘ └──────────┘
```

## Why two layers

| Concern               | Solution                                                 |
|-----------------------|----------------------------------------------------------|
| Cross-OS data         | Node.js backend with thin per-OS adapters                |
| Always-on display     | GNOME extension — loaded by gnome-shell, no autostart    |
| Remote / non-GNOME    | Browser tab at `<host>:5172/`, reachable over the tailnet |
| No persistent daemon  | Extension lifecycle manages backend (`enable`→spawn, `disable`→SIGTERM) |
| Zero install pain     | No npm install needed — backend has no dependencies       |

## Endpoints

| Method | Path                              | Purpose                              |
|--------|-----------------------------------|--------------------------------------|
| GET    | `/api/health`                     | `{ ok, version, platform }`           |
| GET    | `/api/state`                      | Aggregated snapshot                   |
| GET    | `/api/events`                     | SSE: `sessions`/`remote`/`tmux` pushes |
| POST   | `/api/refresh`                    | Invalidate caches, return fresh state |
| POST   | `/api/open`                       | `{ url }` -> opens in default handler |
| GET    | `/api/config/peers`               | list manual remote peers              |
| POST   | `/api/config/peers`               | add manual peer                       |
| DELETE | `/api/config/peers/:name`         | remove manual peer                    |
| GET    | `/api/tmux`                       | windows of the configured session     |
| GET    | `/api/tmux/capture?window=N`      | current visible pane contents (ANSI)  |
| POST   | `/api/tmux/send`                  | `{ window, text? , key? }` type/keys  |
| POST   | `/api/tmux/select`                | `{ window }` switch active window     |
| POST   | `/api/tmux/new-window`            | `{ name? }` open a new window         |
| GET    | `/api/inbox/settings`             | snippets, team list, feature flags    |
| GET    | `/api/inbox/search?q=&max=`       | Gmail query passthrough               |
| GET    | `/api/inbox/:id`                  | full Gmail message JSON               |
| POST   | `/api/inbox/:id/summarize`        | one-line summary (heuristic or LLM)   |
| POST   | `/api/inbox/:id/mark`             | `{ action: read\|archive\|trash }`    |
| POST   | `/api/inbox/send`                 | `{ to, subject, body, cc?, bcc?, reply_to_id? }` |
| GET    | `/`                               | Browser dashboard                     |

## Configuration

All optional. See [server/config.js](../server/config.js).

`~/.config/glance/config.json` keys: `port`, `host` (`"tailscale"` binds
loopback + the tailnet IPv4), `tmuxSession`, `tmuxBin`, `tmuxHost` (another
glance URL to proxy `/api/tmux*` to; how non-host machines join s01's
session), `inboxDir`, `calendarBin`,
`gmailBin`, `gmailMaxUnread`, `gmailImportantOnly`, `gmailBlacklist`,
`gmailSnippets`, `gmailSummarizerCmd`, `teamEmails[]`, `services[]`,
`presencePort`, `peers[]`, `prodTargets[]`, `prodRefreshSec`,
`prodHealth[]`, `prodHealthIntervalSec`, `deployTargets[]`,
`deployRefreshSec`, `liveRefreshSec`.

The PROD panel draws from four sources: `prodTargets` (statusz job feeds,
fetched lazily with a TTL cache), `prodHealth` (liveness checks polled in the
background so up/down transitions are recorded even with no client attached;
transitions persist to `~/.config/glance/prod-history.json`),
`deployTargets` (latest deploy per target via the local `gh` CLI, either an
Actions workflow or the GitHub Deployments API), and `prodFleet` (machine
heartbeats from the pivi gateway's service-token-gated `/api/v2/metrics`;
renders locked until the Bearer token is added to `prodFleet.headers`).

The browser dashboard subscribes to `/api/events` (server-sent events). A
background fast lane rescans local claude sessions every `liveRefreshSec`
seconds (default 3) and sweeps remote presence plus tmux windows every other
tick, broadcasting a frame only when the payload changed. The lane runs only
while at least one subscriber is connected; the 30s `/api/state` poll remains
the fallback and covers calendar, inbox, and prod.

Each is also overridable via `GLANCE_*` env vars (e.g. `GLANCE_HOST`,
`GLANCE_TMUX_SESSION`).

For the Google Calendar integration (`calendarBin` pointing at
`server/bin/gcal.js`), see [CALENDAR-SETUP.md](CALENDAR-SETUP.md). For
Gmail (`gmailBin` pointing at `server/bin/gmail.js`), see
[GMAIL-SETUP.md](GMAIL-SETUP.md). Both share one OAuth client and one
on-disk token; each user creates their own Google Cloud OAuth client so
the repo carries no shared credentials.

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
    ├── widgets.js      # widget registry (remote, sessions, terminal, mail)
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
  { "id": "terminal", "enabled": true, "weight": 3 },
  { "id": "mail",     "enabled": true, "weight": 2 }
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
- Panel button shows compact summary: `❯windows  ▸sessions  ✉unread`
- Click → menu opens, dashboard renders in St widgets, sized to
  `dropdown-width-pct` of primary monitor
- If `popout-active` was true at enable, the standalone window is restored
  at its persisted geometry
- Extension disables → SIGTERM to backend, fallback `force_exit` after 1.5s

## What we don't do

- **No autostart files for GNOME.** The extension is the autostart.
- **No npm modules in the backend.** Zero deps.
- **No exposure beyond localhost + tailnet.** The HTTP server binds
  `127.0.0.1` or this machine's tailnet IPv4 (`host: "tailscale"`), never a
  public interface.
- **No mutation of external systems** without explicit user action. The
  terminal endpoints run shell input you type, and `/api/open` opens a URL;
  both are user-driven.
