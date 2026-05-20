# Install

Three install paths depending on your OS. All are idempotent (re-run to update).

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
  "inboxDir":      "/home/you/claude-inbox",
  "calendarBin":   "/home/you/repos/noah-tools/lib/calendar.js",
  "linearSyncUrl": "http://127.0.0.1:5174/api/linear/sync",
  "services":      ["orchestrator", "inbox-ui", "work-tmux"],
  "meEmails":      ["you@example.com"]
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
3. `launchctl load`s the agent; backend starts immediately and at every login.

Open <http://127.0.0.1:5175/> for the dashboard.

To stop: `launchctl unload ~/Library/LaunchAgents/com.klarum.glance.plist`

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

Open <http://127.0.0.1:5175/> for the dashboard.

To stop: `Stop-ScheduledTask -TaskName klarum-glance`
To remove: `Unregister-ScheduledTask -TaskName klarum-glance -Confirm:$false`

## Other Linux (no GNOME)

```bash
git clone https://github.com/Klarum-Software/glance.git ~/repos/glance
cd ~/repos/glance
node server/server.js &
xdg-open http://127.0.0.1:5175/
```

Add the `node server/server.js` invocation to whatever your DE uses for
autostart, or wrap it in a systemd-user unit.

## Uninstall

| OS       | Command                                                                          |
|----------|----------------------------------------------------------------------------------|
| Linux    | `gnome-extensions disable glance@klarum-software.github.io && rm -rf ~/.local/share/gnome-shell/extensions/glance@klarum-software.github.io` |
| macOS    | `launchctl unload ~/Library/LaunchAgents/com.klarum.glance.plist && rm ~/Library/LaunchAgents/com.klarum.glance.plist` |
| Windows  | `Unregister-ScheduledTask -TaskName klarum-glance -Confirm:$false`              |
