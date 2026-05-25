<p align="center">
  <img src="assets/glance_eye.png" width="600" alt="GLANCE logo" />
</p>

<h1 align="center">GLANCE</h1>

<p align="center">
  <b>GNOME Shell extension & operator dashboard</b>
</p>

<p align="center">
  <img src="https://img.shields.io/badge/JavaScript-F7DF1E?style=flat-square&logo=javascript&logoColor=black" alt="JavaScript" />
  <img src="https://img.shields.io/badge/Node.js-339933?style=flat-square&logo=node.js&logoColor=white" alt="Node.js" />
  <img src="https://img.shields.io/badge/GNOME-4A86CF?style=flat-square&logo=gnome&logoColor=white" alt="GNOME" />
  <img src="https://img.shields.io/badge/HTML5-E34F26?style=flat-square&logo=html5&logoColor=white" alt="HTML5" />
  <img src="https://img.shields.io/badge/CSS3-1572B6?style=flat-square&logo=css3&logoColor=white" alt="CSS3" />
  <img src="https://img.shields.io/badge/Bash-4EAA25?style=flat-square&logo=gnubash&logoColor=white" alt="Bash" />
</p>

---
Adds a top-panel button that drops down a single-screen
operator dashboard: tailnet peers, local claude sessions, Linear queue, and
calendar.

The extension spawns and supervises a small Node.js backend on
`127.0.0.1:5175`. There is nothing to autostart.

## Install

```bash
git clone https://github.com/klarum-software/glance.git ~/repos/glance
cd ~/repos/glance
./install/install.sh
```

Log out and back in (Wayland requires a session restart to load new
extensions), then:

```bash
gnome-extensions enable glance@klarum-software.github.io
```

A dot appears in the top panel. Click it for the dashboard.

## Configuration

`~/.config/glance/config.json` (optional, all fields have defaults):

```json
{
  "port": 5175,
  "inboxDir": "/home/you/claude-inbox",
  "calendarBin": "/home/you/repos/glance/server/bin/gcal.js",
  "linearApiKey": "lin_api_...",
  "services": ["orchestrator", "inbox-ui", "work-tmux"],
  "meEmails": ["you@example.com"]
}
```

Every field is also overridable via env (`GLANCE_PORT`, `GLANCE_INBOX`,
`GLANCE_CALENDAR_BIN`, `GLANCE_GMAIL_BIN`, `GLANCE_GMAIL_MAX_UNREAD`,
`GLANCE_LINEAR_SYNC`, `GLANCE_LINEAR_API_KEY`, `GLANCE_SERVICES`,
`GLANCE_ME_EMAILS`). See `server/config.js`.

## Connecting your accounts

### Linear

Create a personal API key at <https://linear.app/settings/api> (Personal
API keys -> Create key). Paste it into `linearApiKey` in
`~/.config/glance/config.json` (or export `GLANCE_LINEAR_API_KEY`).

The backend's `POST /api/sync-linear` will fetch your assigned, non-closed
issues directly from the Linear GraphQL API and cache them under
`<inboxDir>/.linear-cache/`. Click the sync button in the LINEAR column
header to refresh on demand.

If you'd rather sync via an external service (e.g. inbox-ui), set
`linearSyncUrl` instead. `linearApiKey` takes precedence when both are
set.

### Calendar

`calendarBin` is just a path to any Node.js script that, when invoked
as `node <calendarBin> list <days>`, prints one event per line in the
format:

```
2026-05-23T10:00:00+02:00 Event title [event-id]
2026-05-25 All-day event [other-id]
```

Two routes ship out of the box:

**Local route (any source).** Point `calendarBin` at your own script.
It can wrap `gcalcli`, parse a local `.ics` file, query a private CalDAV
server, read an exported calendar dump, anything. As long as it prints
the line format above on stdout and exits 0, glance is happy. Lowest
friction if you already have a calendar tool authenticated on the box.

**OAuth route (Google Calendar, bundled).** A two-script helper under
`server/bin/` that handles the Google OAuth flow yourself, using your
own Google Cloud Desktop OAuth client (the repo ships no shared
credentials). Full walkthrough:
[docs/CALENDAR-SETUP.md](docs/CALENDAR-SETUP.md). Short version:

1. Create an OAuth 2.0 Client ID (Desktop app) at
   <https://console.cloud.google.com>, enable the Google Calendar API,
   add yourself as a test user.
2. Run `node server/bin/google-auth.js --calendar` (or with no flags to
   also grant Gmail), paste the client id and secret, complete the browser
   consent.
3. Set `calendarBin` in `~/.config/glance/config.json` to the absolute
   path of `server/bin/gcal.js` (the auth helper prints it for you).
4. Disable/enable the extension. Events appear within a refresh cycle.

### Gmail

Gmail shares the same OAuth client as Calendar (one consent, one token).
Run `node server/bin/google-auth.js --gmail` (or no flags for both
scopes), then set `gmailBin` in `~/.config/glance/config.json` to the
absolute path of `server/bin/gmail.js`. The INBOX widget is registered
disabled-by-default; enable it from prefs or the in-dashboard edit mode.
Sender/subject blacklist patterns keep the column focused. Full guide:
[docs/GMAIL-SETUP.md](docs/GMAIL-SETUP.md).

## What it shows

| Column   | Source                                    |
|----------|-------------------------------------------|
| REMOTE   | `tailscale status --json` + `klarum-presence` agent on each peer (port 5176) |
| SESSIONS | `ps`-derived `claude` process trees + RSS vs total RAM |
| LINEAR   | `<inboxDir>/.linear-cache/*.json`         |
| CALENDAR | `calendarBin` stdout (refreshed every 60s). For Google Calendar, see [docs/CALENDAR-SETUP.md](docs/CALENDAR-SETUP.md) |
| INBOX    | `gmailBin` -- unread Gmail with blacklist filter (read/send/summarize/archive). See [docs/GMAIL-SETUP.md](docs/GMAIL-SETUP.md) |

## Architecture

```
glance/
├── extension/            GNOME extension (GJS)
├── server/               Node.js backend (~600 lines, zero deps)
│   ├── server.js           HTTP + state aggregation + actions
│   ├── config.js           ~/.config/glance/config.json loader
│   └── platform/           OS adapters
├── public/               Browser dashboard (used by the backend for dev)
├── klarum-presence/      per-peer presence agent (self-contained, extractable)
├── install/              Installer
└── docs/                 ARCHITECTURE, INSTALL, CONTRIBUTING
```

The `klarum-presence/` agent is shipped in-tree but is otherwise self
contained (zero npm deps, no glance imports). Install it on each peer that
should appear in the REMOTE column; see
[klarum-presence/README.md](klarum-presence/README.md) for the extraction
recipe when it eventually lives in its own repository.

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## License

MIT. See [LICENSE](LICENSE).
