<p align="center">
  <img src="assets/glance_eye.png" width="600" alt="GLANCE logo" />
</p>

<h1 align="center">GLANCE</h1>

<p align="center">
  <b>Single-screen operator control center</b>
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
A single-screen operator control center: tailnet peers, local claude
sessions, a click-through tmux web terminal, and calendar plus inbox. It
runs as a GNOME top-panel dropdown on Linux and as a browser dashboard
anywhere (the primary surface on the mac mini, reached over the tailnet).

Both front ends share one small Node.js backend on port `5172`. On GNOME
the extension spawns and supervises it; elsewhere you run `node
server/server.js`. There is nothing else to autostart. `5172` stays clear
of the dev worktree port ranges (frontends on 5173+N, backends on 8000+N).

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
  "port": 5172,
  "host": "tailscale",
  "tmuxSession": "main",
  "inboxDir": "/home/you/claude-inbox",
  "calendarBin": "/home/you/repos/glance/server/bin/gcal.js",
  "gmailBin": "/home/you/repos/glance/server/bin/gmail.js",
  "services": ["orchestrator", "inbox-ui", "work-tmux"]
}
```

`host` defaults to `127.0.0.1`; set it to `"tailscale"` to bind this
machine's tailnet IPv4 so you can open the dashboard from another tailnet
machine (and nowhere else). Every field is also overridable via env
(`GLANCE_PORT`, `GLANCE_HOST`, `GLANCE_TMUX_SESSION`, `GLANCE_TMUX_HOST`,
`GLANCE_INBOX`, `GLANCE_CALENDAR_BIN`, `GLANCE_GMAIL_BIN`, `GLANCE_SERVICES`).
See `server/config.js`.

## Connecting your accounts

### Terminal

The TERMINAL column drives the tmux session named by `tmuxSession`
(default `main`). It lists the session's windows as tabs; click one to
switch to it (the change follows through to any attached `mosh`/`tmux`
client), then click the screen and type. Keystrokes are forwarded with
`tmux send-keys` and the visible pane is polled with `capture-pane`, so
there is no `Ctrl+b` and no PTY. Start a session with `tmux new -s main`
on the host running the backend.

The `main` session can live on one always-on box (e.g. the mac mini) while
every machine runs its own glance. Set `tmuxHost` (or `GLANCE_TMUX_HOST`) on
the others to that box's glance URL, e.g. `http://100.66.100.32:5172`, and
their backend proxies all tmux calls there over the tailnet, no ssh or mosh.
tmux is multi-client, so glance coexists with a human `mosh`/`tmux attach`.

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
absolute path of `server/bin/gmail.js`. Unread Gmail shows in the lower
half of the MAIL column, under upcoming calendar events. Sender/subject
blacklist patterns keep it focused. Full guide:
[docs/GMAIL-SETUP.md](docs/GMAIL-SETUP.md).

## What it shows

| Column   | Source                                    |
|----------|-------------------------------------------|
| REMOTE   | `tailscale status --json` + `klarum-presence` agent on each peer (port 5176) |
| SESSIONS | `ps`-derived `claude` process trees + RSS vs total RAM |
| TERMINAL | `tmux` windows of `tmuxSession` (`capture-pane` / `send-keys`), click to switch and type |
| MAIL     | `calendarBin` upcoming events + `gmailBin` unread Gmail, in one column (read/send/summarize/archive). See [docs/CALENDAR-SETUP.md](docs/CALENDAR-SETUP.md) and [docs/GMAIL-SETUP.md](docs/GMAIL-SETUP.md) |

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

The per-peer presence agent now lives in its own repository at
[Klarum-Software/klarum-presence](https://github.com/Klarum-Software/klarum-presence).
Install it on each tailnet peer that should appear in the REMOTE
column. Glance is a network consumer (HTTP+JSON on port 5176); no
in-tree dependency.

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## License

MIT. See [LICENSE](LICENSE).
