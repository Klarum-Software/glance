# Install

Three install paths depending on your OS. All are idempotent — re-run to update.

## Linux + GNOME (recommended)

```bash
git clone https://github.com/Klarum-Software/glance.git ~/repos/glance
cd ~/repos/glance
./install/install.sh
```

What it does:

1. Verifies you have `node >=18`, `gnome-shell >=45`, `gnome-extensions`, and
   `glib-compile-schemas`.
2. Compiles the gschema (`extension/schemas/gschemas.compiled`).
3. Copies `extension/`, `server/`, `public/` to
   `~/.local/share/gnome-shell/extensions/glance@klarum-software.github.io/`.
4. Tries to enable the extension immediately.

After the installer prints "done", **you need GNOME Shell to pick up the new
extension**:

| Session | What to do                                              |
|---------|---------------------------------------------------------|
| Wayland | Log out and back in.                                    |
| X11     | Press `Alt+F2`, type `r`, press Enter.                  |

Then:

```bash
gnome-extensions enable glance@klarum-software.github.io
```

A small button labelled "glance" appears in the top panel. Click it for the
dashboard. Configure via:

```bash
gnome-extensions prefs glance@klarum-software.github.io
```

### Optional: configure data sources

`~/.config/glance/config.json` (all fields optional):

```json
{
  "host":        "tailscale",
  "tmuxSession": "main",
  "inboxDir":    "/home/you/claude-inbox",
  "calendarBin": "/home/you/repos/glance/server/bin/gcal.js",
  "gmailBin":    "/home/you/repos/glance/server/bin/gmail.js",
  "services":    ["orchestrator", "inbox-ui", "work-tmux"]
}
```

## macOS

```bash
git clone https://github.com/Klarum-Software/glance.git ~/repos/glance
cd ~/repos/glance
./install/install-macos.sh
```

What it does:

1. Verifies `node >=18`.
2. Writes `~/Library/LaunchAgents/com.klarum.glance.plist` with absolute paths
   substituted from your repo location and node binary location.
3. `launchctl load`s the agent — backend starts immediately and at every login.

Open <http://127.0.0.1:5172/> for the dashboard.

To stop: `launchctl unload ~/Library/LaunchAgents/com.klarum.glance.plist`

On the mac mini control center, set `"host": "tailscale"` in
`~/.config/glance/config.json` so the backend binds this machine's tailnet
IPv4 (resolved at startup via `tailscale ip -4`, nothing hardcoded) and the
dashboard is reachable from your other tailnet machines. See the
Configuration section in the README.

Updating: `git pull` lands cleanly (glance writes only to `/tmp` and
`~/.config`, never the repo), but the LaunchAgent keeps running the old code
in memory until it is restarted. Restart it so pulled changes go live:

```bash
launchctl kickstart -k gui/$(id -u)/com.klarum.glance
```

`kickstart -k` kills the running instance before relaunching, which avoids
the `EADDRINUSE` restart loop you get if a second instance starts while the
old one still holds port 5172. To make this automatic, drop a `post-merge`
git hook in your clone that runs the same command, so every `git pull`
restarts the backend onto the fresh tree:

```sh
# .git/hooks/post-merge  (chmod +x)
#!/bin/sh
[ "$(uname)" = "Darwin" ] || exit 0
launchctl print "gui/$(id -u)/com.klarum.glance" >/dev/null 2>&1 \
  && launchctl kickstart -k "gui/$(id -u)/com.klarum.glance"
```

## Windows

```powershell
git clone https://github.com/Klarum-Software/glance.git $env:USERPROFILE\repos\glance
cd $env:USERPROFILE\repos\glance
powershell -ExecutionPolicy Bypass -File install\install-windows.ps1
```

What it does:

1. Verifies `node >=18`.
2. Registers a Scheduled Task `klarum-glance` that runs at logon.
3. Starts the task immediately.

Open <http://127.0.0.1:5172/> for the dashboard.

To stop: `Stop-ScheduledTask -TaskName klarum-glance`
To remove: `Unregister-ScheduledTask -TaskName klarum-glance -Confirm:$false`

## Other Linux (no GNOME)

```bash
git clone https://github.com/Klarum-Software/glance.git ~/repos/glance
cd ~/repos/glance
node server/server.js &
xdg-open http://127.0.0.1:5172/
```

Add the `node server/server.js` invocation to whatever your DE uses for
autostart, or wrap it in a systemd-user unit.

## Uninstall

| OS       | Command                                                                          |
|----------|----------------------------------------------------------------------------------|
| Linux    | `gnome-extensions disable glance@klarum-software.github.io && rm -rf ~/.local/share/gnome-shell/extensions/glance@klarum-software.github.io` |
| macOS    | `launchctl unload ~/Library/LaunchAgents/com.klarum.glance.plist && rm ~/Library/LaunchAgents/com.klarum.glance.plist` |
| Windows  | `Unregister-ScheduledTask -TaskName klarum-glance -Confirm:$false`              |
