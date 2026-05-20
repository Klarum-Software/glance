# glance

Single-screen, ambient-glance operator dashboard. Shows you at a glance:
tailnet peers, local claude sessions, draft inbox, Linear queue, and calendar.

Comes in two forms:

1. **GNOME extension** — recommended on Ubuntu/Fedora/Arch. Adds a top-panel
   button that drops down the full dashboard. The extension manages the
   backend lifecycle, so there is nothing to autostart.
2. **Cross-platform browser fallback** — runs the same backend on any OS
   (Linux/macOS/Windows) and renders the dashboard at <http://127.0.0.1:5175/>.

## Quick start

### Ubuntu / GNOME (recommended)

```bash
git clone https://github.com/klarum-software/glance.git ~/repos/glance
cd ~/repos/glance
./install/install.sh
```

Then open GNOME Extensions and toggle on **glance**. A small dot appears in
the top panel; click it for the dashboard.

### macOS / Windows / non-GNOME Linux

```bash
git clone https://github.com/klarum-software/glance.git
cd glance
npm start
```

Open <http://127.0.0.1:5175/> in a browser. To autostart at login on macOS,
copy `install/com.klarum.glance.plist` into `~/Library/LaunchAgents/` and
`launchctl load` it. On Windows, see `install/install-windows.ps1`.

## Configuration

`~/.config/glance/config.json` (optional, all fields have defaults):

```json
{
  "port": 5175,
  "inboxDir": "/home/you/claude-inbox",
  "calendarBin": "/home/you/repos/noah-tools/lib/calendar.js",
  "linearSyncUrl": "http://127.0.0.1:5174/api/linear/sync",
  "services": ["orchestrator", "inbox-ui", "work-tmux"],
  "meEmails": ["you@example.com"]
}
```

Every field is also overridable via env (`GLANCE_PORT`, `GLANCE_INBOX`,
`GLANCE_CALENDAR_BIN`, `GLANCE_LINEAR_SYNC`, `GLANCE_SERVICES`,
`GLANCE_ME_EMAILS`). See `server/config.js`.

## What it shows

| Column   | Source                                    |
|----------|-------------------------------------------|
| REMOTE   | `tailscale status --json` + `klarum-presence` agent on each peer (port 5176) |
| SESSIONS | `ps`-derived `claude` process trees + RSS vs total RAM |
| INBOX    | `<inboxDir>/YYYY-MM-DD/issue-*/draft.md` |
| LINEAR   | `<inboxDir>/.linear-cache/*.json`         |
| CALENDAR | `calendarBin` stdout (refreshed every 60s)|

## Architecture

```
glance/
├── server/              Node.js backend (~600 lines, zero deps)
│   ├── server.js          HTTP + state aggregation + actions
│   ├── config.js          ~/.config/glance/config.json loader
│   └── platform/          OS adapters (linux/macos/windows)
├── extension/           GNOME extension (GJS)
├── public/              Browser fallback dashboard
├── install/             Installers per OS
└── docs/                ARCHITECTURE, INSTALL, CONTRIBUTING
```

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## License

MIT — see [LICENSE](LICENSE).
