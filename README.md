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
| LINEAR   | `<inboxDir>/.linear-cache/*.json`         |
| CALENDAR | `calendarBin` stdout (refreshed every 60s)|

## Architecture

```
glance/
├── extension/            GNOME extension (GJS)
├── server/               Node.js backend (~600 lines, zero deps)
│   ├── server.js           HTTP + state aggregation + actions
│   ├── config.js           ~/.config/glance/config.json loader
│   └── platform/           OS adapters
├── public/               Browser dashboard (used by the backend for dev)
├── install/              Installer
└── docs/                 ARCHITECTURE, INSTALL, CONTRIBUTING
```

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## License

MIT. See [LICENSE](LICENSE).
