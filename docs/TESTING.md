# Testing glance

> **glance is a GNOME Shell extension first.** The browser fallback exists
> for QA on the data layer and for users on non-GNOME desktops, not as a
> daily driver. Every change must be validated in the actual extension
> before it's considered shipped.

This document describes the dev loop, what to test where, and how to
recover when a bad change breaks gnome-shell.

## TL;DR

```bash
# 1. backend smoke (always do this first; catches data-layer bugs cheap)
node scripts/smoke.js

# 2. extension in a nested shell (the only safe dev environment)
./scripts/dev-shell.sh
# (installs, boots nested gnome-shell on a dedicated D-Bus session, enables
# glance inside it, and streams the filtered journal. Ctrl+C cleans up.)

# 3. iterate: edit code, then relaunch on the current tree
./scripts/dev-restart.sh

# 4. only after the nested shell looks correct: log out + log back in to
#    test in your real session. There is no shortcut for this on Wayland.
```

## Why testing the extension is annoying

GNOME Shell on Wayland will not reload extensions without a full logout
and login. `Alt+F2 r` (X11's reload-shell command) does nothing on Wayland.
This means a careless extension change can leave you with a broken panel,
no way to re-edit code in-session, and a forced logout.

**The mitigation is the nested shell.** `gnome-shell --nested --wayland`
spawns a second gnome-shell process inside a window on your real session.
It has its own panel, its own extensions, its own state. If you crash it,
you close the window; your real session is untouched.

## Three layers of testing, in order

### Layer 1: backend (cheap, fast, do this every change)

```bash
node scripts/smoke.js
```

Boots the Node server on port 5199 and hits `/api/health` + `/api/state`.
Confirms the data-aggregation layer works end-to-end. If this fails, the
extension definitely won't work; fix it here first.

For data-layer changes only (server, platform adapters, config), this is
usually the only test that matters.

### Layer 2: browser fallback (QA only)

```bash
node server/server.js   # boots on http://127.0.0.1:5175/
# open the URL in any browser
```

The browser fallback at `127.0.0.1:5175/` renders the same `/api/state`
data using HTML/CSS instead of St widgets. **Use it only to:**

- Confirm `/api/state` returns the right shape before testing the
  extension's renderer.
- Reproduce data bugs that don't depend on the GNOME-side rendering.
- Test config endpoints (`/api/config/peers` add/remove, etc.) with curl
  or the browser UI when iterating quickly.

**Do not use it as a substitute for the extension.** It uses a completely
different rendering pipeline. A change that looks correct in the browser
can render broken in St, and vice versa. The browser is for *data*
confidence, not *UI* confidence.

### Layer 3: nested gnome-shell (the real test)

**Use the script.** `scripts/dev-shell.sh` does the whole dance in one
command: installs the current tree, starts a dedicated D-Bus session,
boots `gnome-shell --nested --wayland` (or `--devkit` on GNOME 49+),
waits for it to register on the bus, enables glance against the nested
bus, and streams the journal filtered to the nested PID. Ctrl+C SIGTERMs
the shell, kills the bus, and reaps any orphaned Node backend that came
from the nested session.

```bash
./scripts/dev-shell.sh
```

To iterate: edit code, then run `./scripts/dev-restart.sh` (same script,
but it first stops the previous nested shell and waits for cleanup before
starting the new one). `--no-install` skips reinstalling, `--keep-logs
PATH` mirrors the journal stream to a file. The script honors
`MUTTER_DEBUG_NUM_DUMMY_MONITORS` and `MUTTER_DEBUG_DUMMY_MONITOR_SCALES`
from the environment for multi-monitor/HiDPI testing without real
hardware (see the GNOME Wayland-testing wiki page).

Click the panel button in the nested window. The dropdown should open
and render the columns correctly. If it doesn't, see "Debugging" below.
**Do not log out of your real session yet.**

**Manual fallback** (when the script can't run, e.g. you're debugging
the script itself, or on a system without `dbus-daemon` or `gdbus`):

```bash
./install/install.sh
dbus-run-session -- gnome-shell --nested --wayland
# inside the nested window:
gnome-extensions enable glance@klarum-software.github.io
# in another terminal:
journalctl --user -f -o cat /usr/bin/gnome-shell | grep -i glance
```

Verify the install produced the right files:

```bash
ls ~/.local/share/gnome-shell/extensions/glance@klarum-software.github.io/
# should contain: extension.js, lib/, public/, schemas/, server/, prefs.js,
# metadata.json, stylesheet.css
```

### Layer 4: real session (the ship gate)

Only after the nested shell looks correct. Log out and log back in. The
extension will load from the same `~/.local/share/gnome-shell/extensions/`
path you tested with.

If you skip the nested-shell step and go straight here, you can wind up
with a panel that fails to render and no easy way to recover other than
disabling the extension from a TTY (`Ctrl+Alt+F3`, `gnome-extensions
disable glance@klarum-software.github.io`, log out, log back in).

## Debugging

### Read the logs

GNOME Shell logs (including extension `console.log` and exceptions) go to
the systemd user journal:

```bash
# follow live, filter to glance:
journalctl --user -f -o cat /usr/bin/gnome-shell | grep -i glance

# last hour of glance-related logs:
journalctl --user --since "1 hour ago" /usr/bin/gnome-shell | grep -i glance

# everything from the nested shell (it's a separate gnome-shell process
# but logs the same way):
journalctl --user -f -o cat _COMM=gnome-shell
```

Common error shapes:
- `Extension glance@... failed to load: <stack>` is a syntax or import
  error. Run `node --check` on every `extension/**/*.js`.
- `JS ERROR: ... is not a function` is likely a GNOME-version API drift.
  See the [version-drift section](#version-drift).
- Panel button appears but dropdown is blank: the renderer ran but St
  rejected a widget operation. Look for `Clutter-CRITICAL` or `St-WARNING`
  in the journal around the same timestamp.

### Verify the backend is actually running

The extension spawns the Node backend as a subprocess. If `/api/state`
calls silently never resolve, the backend probably isn't running.

```bash
# from inside the nested shell (or after enabling in real session):
curl -s http://127.0.0.1:5175/api/health
# expect: {"ok":true,"version":"...","platform":"linux"}

ps aux | grep "server/server.js" | grep -v grep
# should show one node process spawned by gnome-shell
```

If there's no node process, suspect `extension/lib/backend.js`'s
`resolveNodePath()`: the gnome-shell launch environment may have a
sparse `$PATH`. The current resolver checks a static candidate list
(`/usr/bin/node`, `/usr/local/bin/node`, `/snap/bin/node`,
`/opt/homebrew/bin/node`, common nvm and user-local paths) before
falling back to bare `node`; add new entries here, never re-introduce
a synchronous `which` shell-out.

### Version drift

GNOME APIs move between major versions. The extension declares support
for shell-version `[46, 47, 48]` in `metadata.json`, but specific APIs
we use can still drift across patch versions:

- `Soup.Message.new_request_body_from_bytes()` invocation differs across
  libsoup3 patch versions. The working call is the setter form
  `set_request_body_from_bytes(mime, GLib.Bytes)`, which the code uses.
- `St.ScrollView.set_child` is the modern API; the legacy
  `add_actor`/`set_child` shim has been removed now that shell 45 is no
  longer supported.
- `PopupMenu.box.set_width()` may be ignored: the dropdown can clamp to
  a default narrow width regardless of the setting. Glance now drives
  width via CSS `min-width` on `this.menu.box` instead.

If you only test on one GNOME version, you have only tested on one GNOME
version. CI doesn't catch this; only manually booting a nested shell on
each supported release does.

## Recovery from a bricked panel

If the real-session panel won't render after a bad change:

1. `Ctrl+Alt+F3` to switch to a TTY.
2. Log in with username + password.
3. Disable the extension:
   ```bash
   gnome-extensions disable glance@klarum-software.github.io
   ```
4. `Ctrl+Alt+F2` (or `F1`) to return to the graphical session.
5. Log out, log back in. Panel should be back to vanilla.
6. Fix the code, reinstall, validate in the nested shell **before**
   re-enabling.

If even the TTY trick doesn't work (uncommon), boot to a previous-version
snapshot or to single-user mode and remove the extension directory:

```bash
rm -rf ~/.local/share/gnome-shell/extensions/glance@klarum-software.github.io/
```

## What to verify before considering a change "done"

- [ ] `node scripts/smoke.js` passes
- [ ] `node --check` passes on every modified `.js` file
- [ ] `./install/install.sh` runs cleanly with no warnings
- [ ] Nested shell enables the extension without error
- [ ] Panel button renders, dropdown opens, every column shows expected
      data
- [ ] `journalctl --user --since "5 minutes ago" /usr/bin/gnome-shell |
      grep -i glance` is clean (no exceptions)
- [ ] Disable + re-enable the extension twice with no leaks and no
      "already-running backend" errors
- [ ] If a gschema key was added/removed: `prefs.js` still opens and
      every visible control reads/writes correctly

Only then: log out, log back in, confirm in the real session, push.

## What never to test in the browser fallback

These pieces of behavior exist **only** in the extension and cannot be
validated in the browser:

- Panel button label updates (`_updatePanel()`)
- PopupMenu dropdown sizing and positioning
- St widget rendering (every column's column rendering in
  `extension/lib/render.js`)
- Subprocess lifecycle (`extension/lib/backend.js`)
- gschema-backed settings (`extension/prefs.js`)
- Keyboard shortcuts and panel-button click handlers

If your change touches any of the above, the browser fallback is
**irrelevant** to validating it.

## Related docs

- [ARCHITECTURE.md](ARCHITECTURE.md): design rationale, endpoints,
  lifecycle.
- [CONTRIBUTING.md](CONTRIBUTING.md): dev loop, style, releasing.
- [INSTALL.md](INSTALL.md): per-OS install steps.
- `EXTENSION-BEST-PRACTICES.md` (sibling file): patterns that survive
  shell-version upgrades.
