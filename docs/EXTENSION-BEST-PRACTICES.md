# GNOME Shell Extension best-practices for glance

This is the working checklist we use when changing anything under `extension/`.
It is grounded in upstream guidance from gjs.guide, the libsoup3 reference, and
the EGO review guidelines; every rule cites where it came from so you can
verify before changing it. Use it as: skim the headings, then for any rule
that smells relevant to your patch, read the cited source before
"improving" anything.

## 1. Lifecycle: `enable()` / `disable()` must be perfectly symmetric

**Rule.** Anything created, connected, scheduled, spawned or added to GNOME
Shell inside `enable()` MUST be undone inside `disable()`. There is no other
hook that runs. `disable()` can be called at any time (including during a
screen lock) and `enable()` may be called again immediately afterwards.
Failing this is, per upstream, "the most common reason extensions are
rejected." [gjs.guide/extensions/overview/anatomy](https://gjs.guide/extensions/overview/anatomy.html)

The `Extension` subclass constructor runs at module load. Per upstream: "you
MUST NOT make any changes to GNOME Shell, connect any signals or add any
event sources here." Translations and statics only.
[gjs.guide/extensions/overview/anatomy](https://gjs.guide/extensions/overview/anatomy.html)

Concrete checklist on `disable()`:

- destroy every actor you added to `Main.panel` (or any other shell UI)
- disconnect every signal handler you connected
- remove every `GLib.timeout_add*` and `GLib.idle_add` source you scheduled
- cancel every pending async operation via a `Gio.Cancellable`
- send SIGTERM (and ensure exit) to every subprocess you spawned
- null out every reference to a destroyed object

**Good (idiomatic).**

```javascript
disable() {
    this._indicator?.destroy();
    this._indicator = null;
    this._settings = null;
}
```

The optional chain handles the case where `enable()` aborted partway through.
[gjs.guide/extensions/development/creating](https://gjs.guide/extensions/development/creating.html)

**glance status.** `GlanceExtension.disable()` destroys the indicator
and nulls out `_settings`. `GlanceIndicator.destroy()` cancels the
shared `Gio.Cancellable`, removes the refresh timeout, disconnects
every tracked handler id, stops the backend, calls `super.destroy()`,
and nulls cached widget references. Pattern is in place; keep it that
way when new actors or signals are added.

## 2. Wayland reality

`Alt+F2 r` no longer restarts gnome-shell on Wayland: the compositor and
shell are the same process; restarting the process would kill your session.
The official workflow is: log out, log in.
[gjs.guide/extensions/development/debugging](https://gjs.guide/extensions/development/debugging.html)

For dev iteration, use a nested shell. It runs on a separate D-Bus session
and won't affect the host:

```bash
dbus-run-session -- gnome-shell --nested --wayland   # GNOME 48 and earlier
dbus-run-session    gnome-shell --devkit  --wayland  # GNOME 49+
```

[gjs.guide/extensions/development/debugging](https://gjs.guide/extensions/development/debugging.html)

For day-to-day iteration, use `scripts/dev-shell.sh`. It wraps both flag
spellings, runs the install, drives the nested shell over a dedicated bus,
and reaps orphans on exit. See `docs/TESTING.md` Layer 3.

**glance status.** [docs/CONTRIBUTING.md](CONTRIBUTING.md) and
[docs/TESTING.md](TESTING.md) both document the nested-shell dev loop
driven by `scripts/dev-shell.sh` / `scripts/dev-restart.sh`.

## 3. Track every signal, every timeout, every async operation

This is the single most common failure mode for extensions and the documented
cause of long-lived `gnome-shell` memory leaks. The pattern from upstream:
"Store handler IDs and source IDs as object properties so you can
disconnect/remove them later... A very common way of leaking GSources is
recursive (repeating) sources added to the GLib event loop... Any main loop
sources created must be removed in `disable()`, even if the callback function
will eventually return false or `GLib.SOURCE_REMOVE`."
[gjs.guide/guides/gjs/memory-management](https://gjs.guide/guides/gjs/memory-management.html)

**Good.**

```javascript
this._handlerIds = [];
this._handlerIds.push(obj.connect("signal", () => {...}));
// ...
disable() {
    this._handlerIds.forEach(id => obj.disconnect(id));
    this._handlerIds = [];
}
```

For async work that may resolve after `disable()`, thread a
`Gio.Cancellable` through it and `.cancel()` in `disable()`. "Once a
Gio.Cancellable has been cancelled, you should drop the reference to it and
create a new instance for future operations."
[gjs.guide/guides/gjs/asynchronous-programming](https://gjs.guide/guides/gjs/asynchronous-programming.html)

**glance status.** Every handler id is pushed onto a `_handlerIds`
`[obj, id]` array and disconnected in `destroy()`. The single
`_refreshTimer` is tracked and removed. `api.get/post` accept a
`Gio.Cancellable` and the indicator owns one shared cancellable that
is cancelled on destroy, so an in-flight `/api/state` poll does not
fire its callback against a torn-down indicator.

## 4. St / Clutter widget hygiene across 45→48

**Rule.** Use `Clutter.Actor.add_child()` / `remove_child()`, not the
deprecated `add_actor()` / `remove_actor()`. The `Clutter.Container`
interface was removed in GNOME 46.
[gjs.guide/extensions/upgrading/gnome-shell-46](https://gjs.guide/extensions/upgrading/gnome-shell-46.html)

For `St.ScrollView`, the modern API is `set_child()`. The legacy
`add_actor()` shim was the only option on shell 45 and is removed by shell
46 in some paths; code that calls one or the other unconditionally will
break on at least one supported version.
[gjs.guide/extensions/upgrading/gnome-shell-46](https://gjs.guide/extensions/upgrading/gnome-shell-46.html)

**Good (compat shim).**

```javascript
scroll.add_actor ? scroll.add_actor(inner) : scroll.set_child(inner);
```

This pattern only matters historically: the shim has since been removed
because shell 45 is no longer supported. The current code calls
`scroll.set_child(inner)` directly.

**Other 46/47/48 footguns that will bite this codebase:**

- `St.Bin` only honors `x_expand`/`y_expand`, no longer `Clutter.ActorAlign.FILL`. (46)
- `St.Button` labels default to plain text instead of Pango markup. (46)
- `Clutter.Color` was removed in 47; use `Cogl.Color`.
  [gjs.guide/extensions/upgrading/gnome-shell-47](https://gjs.guide/extensions/upgrading/gnome-shell-47.html)
- `Clutter.Image` removed in 48; use `St.ImageContent`.
- `vertical: true` is deprecated on St boxes in 48; prefer
  `orientation: Clutter.Orientation.VERTICAL`. Still works in 48 but the
  warning is loud in logs.
  [gjs.guide/extensions/upgrading/gnome-shell-48](https://gjs.guide/extensions/upgrading/gnome-shell-48.html)

**Width on `menu.box`.** `set_width()` on a `PopupMenu`'s `.box` is a known
fragile path; CSS `min-width` on a `style_class` is the more stable approach
because the popup wrapper enforces its own width constraints. Both work on
shell 45/46/48 in practice, but if the dropdown is the wrong width after a
shell upgrade, this is where to look.
[gnome-shell-extension-reference#PopupMenu styling](https://github.com/julio641742/gnome-shell-extension-reference/blob/master/tutorials/POPUPMENU-EXTENSION.md)

**glance status.** Dropdown width is controlled by an inline
`min-width` style on `this.menu.box` and the dashboard container, not
by `set_width()`; this survives PopupMenu's wrapper clamping. Every
`St.BoxLayout` uses `orientation: Clutter.Orientation.VERTICAL` /
`HORIZONTAL` rather than the deprecated `vertical: true`. The
`add_actor`/`set_child` shim has been removed: `extension/lib/render.js`
calls `scroll.set_child(inner)` unconditionally, which matches the
supported shell range (46-48).

## 5. Subprocess hygiene (Gio.SubprocessLauncher)

**Rule 1, flags.** If you set `STDOUT_PIPE` or `STDERR_PIPE`, you MUST read
the pipes. Pipe buffers are ~64 KiB on Linux; once full, the child blocks on
`write()` and never exits, and `wait_async` never returns: classic
subprocess deadlock.
[docs.gtk.org Gio.SubprocessFlags](https://docs.gtk.org/gio/flags.SubprocessFlags.html),
[tey.sh "Deadlocking Linux subprocesses using pipes"](https://tey.sh/TIL/002_subprocess_pipe_deadlocks)

For a backend you don't intend to consume stdout from, use
`STDOUT_SILENCE | STDERR_SILENCE` (discards to /dev/null inside libgio).

**Rule 2, termination.** On `disable()`, SIGTERM the child, then arm a
fallback `force_exit()` after a short grace window. Per upstream:
"`force_exit()` to cleanly terminate subprocesses rather than letting them
become orphaned."
[gjs.guide/guides/gio/subprocesses](https://gjs.guide/guides/gio/subprocesses.html)

**Rule 3, never block.** Always use `wait_async` /
`communicate_utf8_async`, never the sync variants; they block the
compositor.
[gjs.guide/guides/gio/subprocesses](https://gjs.guide/guides/gio/subprocesses.html)

**Rule 4, EGO binaries.** EGO will outright reject any extension that ships
a binary executable. The Node.js backend in glance is intentionally outside
the extension zip (it lives in `server/`); keep it that way if you ever
upload to extensions.gnome.org.
[gjs.guide/extensions/review-guidelines](https://gjs.guide/extensions/review-guidelines/review-guidelines.html)

**glance status.** Flags are `STDOUT_SILENCE | STDERR_PIPE`; stderr is
drained continuously via `DataInputStream.read_line_async` so the
buffer cannot fill, and the first non-empty line is captured for
diagnostics. The fast-exit case (e.g. EADDRINUSE) is surfaced as a
`Main.notify` instead of silently swallowed. Node-path resolution is
filesystem-only (a static candidate list checked via
`GLib.file_test`); the old synchronous `which node` shell-out is gone.
The `force_exit` fallback timeout is stored as a source id and
removed when the child exits cleanly or the extension re-enables, so
a `disable` followed by an immediate `enable` cannot fire force-exit
on a stale `_proc`.

## 6. Soup3 quirks

- **Timeout is in seconds, not milliseconds.** Default 0 = no timeout.
  `session.timeout = 5` means 5 s.
  [libsoup-3.0 Session:timeout](https://gnome.pages.gitlab.gnome.org/libsoup/libsoup-3.0/property.Session.timeout.html)
- **Cancellation: pass a `Gio.Cancellable` to `send_and_read_async`.** In
  libsoup3, `soup_session_cancel_message()` was removed; cancellables are
  the only way to stop a request you no longer want.
  [libsoup migration](https://libsoup.gnome.org/libsoup-3.0/migrating-from-libsoup-2.html)
- **`Soup.Session` should be long-lived.** One per extension. Sessions have
  internal connection pools; don't create one per request.
  [libsoup-3.0 Session](https://gnome.pages.gitlab.gnome.org/libsoup/libsoup-3.0/class.Session.html)
- **Request body.** `Soup.Message.set_request_body_from_bytes(mime, GLib.Bytes)`
  is the libsoup3 idiom. The variant
  `Message.new_request_body_from_bytes` is a known fragility: it
  doesn't exist on the message class; the working call is the setter.

**glance status.** One `Soup.Session` is created at module scope.
Timeout is 5 s (localhost-only). `set_request_body_from_bytes` is the
call used. Both `get()` and `post()` accept a `Gio.Cancellable`
argument and thread it through `send_and_read_async`; the indicator
owns a shared cancellable cancelled on destroy.

## 7. gschema settings: when to recompile, how to evolve

**Rule.** Any change to `org.gnome.shell.extensions.glance.gschema.xml`
requires running `glib-compile-schemas extension/schemas/` and reinstalling.
Without recompile, the running shell will see stale schemas and
`getSettings()` will either explode (new key referenced) or silently return
defaults (key removed).

**Rule.** When removing a key, the migration path is:

1. Delete the `<key>` from the XML.
2. Bump the extension `version` in `metadata.json` so EGO/CI treats it as a
   new release.
3. Recompile the schemas.
4. Old user-set values in dconf become inaccessible but do not cause errors.
   To purge: `dconf reset -f /org/gnome/shell/extensions/glance/`.

If a key is removed later, those old values in dconf become inert and
users will see the documented defaults for whatever keys remain.

**Rule.** Schema ID and path must follow the
`org.gnome.shell.extensions.<name>` / `/org/gnome/shell/extensions/<name>/`
convention; EGO enforces this.
[gjs.guide/extensions/review-guidelines](https://gjs.guide/extensions/review-guidelines/review-guidelines.html)

**glance status.** Schema id and path at
`extension/schemas/org.gnome.shell.extensions.glance.gschema.xml:3` are
correct. `gschemas.compiled` is checked in (fine for the local install
flow).

## 8. `prefs.js` rules

**Rule.** `prefs.js` runs in a separate GTK process. It MUST NOT import
`St`, `Clutter`, `Meta`, or `Shell`. Conversely, `extension.js` MUST NOT
import `Gtk`, `Gdk`, or `Adw`. Mixing these toolkit contexts is a
documented automatic-rejection criterion at EGO and crashes the prefs
window at best.
[gjs.guide/extensions/review-guidelines](https://gjs.guide/extensions/review-guidelines/review-guidelines.html)

**Rule.** Use `Gio.Settings.bind()` for simple-typed widgets; it gives you
two-way binding without any signal plumbing to clean up.
[gjs.guide/extensions/development/preferences](https://gjs.guide/extensions/development/preferences.html)

**Rule.** `fillPreferencesWindow()` may return a Promise (awaited as of
GNOME 47). Don't perform sync I/O there.
[gjs.guide/extensions/upgrading/gnome-shell-47](https://gjs.guide/extensions/upgrading/gnome-shell-47.html)

**glance status.** `prefs.js` imports `Adw`, `Gtk`, `Gio` only (correct).
Uses `settings.bind` throughout (correct).

## 9. Logging

- `console.debug/log/warn/error` route through `GLib.LogLevelFlags.*`; this
  is the modern path.
- The old `log()` and `logError()` still work but `console.*` is preferred.
- GNOME 48 added `ExtensionBase.getLogger()` which prefixes every line with
  the extension name; strongly recommended for shell 48+.
  [gjs.guide/extensions/upgrading/gnome-shell-48](https://gjs.guide/extensions/upgrading/gnome-shell-48.html)
- Read logs with `journalctl --user -f /usr/bin/gnome-shell` (or
  `journalctl --user --since "1 hour ago" /usr/bin/gnome-shell | grep -i glance`).
- EGO will reject "excessive logging"; keep info chatter behind a debug
  flag.
  [gjs.guide/extensions/review-guidelines](https://gjs.guide/extensions/review-guidelines/review-guidelines.html)

**glance status.** Backend lifecycle messages use the legacy `log()`
prefixed with `[glance]`. Migrating to `this.getLogger()` would auto-
prefix every line with the extension name; consider doing so when shell
46 is dropped from the supported range.

## 10. Versioning and EGO submission

- `metadata.json` `shell-version` is an array of major numbers. `["45",
  "46", "47", "48"]` means "compatible with all four."
  [gjs.guide/extensions/overview/anatomy](https://gjs.guide/extensions/overview/anatomy.html)
- EGO sets the submission `version` integer itself; don't try to control
  it.
  [discourse.gnome.org thread on EGO uploads](https://discourse.gnome.org/t/cant-upload-extension-to-ego/12818)
- Automatic-rejection criteria summary from upstream: shipping binaries,
  obfuscated/minified code, deprecated imports (`ByteArray`, `Lang`,
  `Mainloop`), fundamentally broken function, AI-generated submissions
  without disclosure, GPL-2.0 incompatibility.
  [gjs.guide/extensions/review-guidelines](https://gjs.guide/extensions/review-guidelines/review-guidelines.html)

**glance status.** `metadata.json` lists `["46", "47", "48"]` with
`"session-modes": ["user"]`. Shell 45 was dropped once the
`add_actor`/`set_child` shim was removed. No bundled binaries: the Node
backend is copied next to the extension by `install.sh`, but is not
part of the extension package itself. If submitting to EGO, double-check
that the upload contains only the `extension/` contents (no `server/`,
no `public/`).

## 11. Anti-patterns: don't do these

- **Don't block the compositor.** No `spawn_command_line_sync`,
  `GLib.usleep`, JSON parsing of multi-MB inputs, or any sync I/O on the
  main loop. The whole shell freezes for the duration. (The previous
  synchronous `which node` shell-out in `backend.js` is gone; the
  candidate-list approach replaced it.)
- **Don't monkey-patch shell internals.** Wrapping `Main.panel`,
  `PopupMenu.PopupMenu.prototype`, etc. survives until the next shell
  release, then breaks. Subclass `PanelMenu.Button` (which glance does);
  don't replace its methods on the prototype.
- **Don't depend on private APIs.** Anything in
  `resource:///org/gnome/shell/ui/main.js` that isn't documented in
  gjs.guide should be considered private. Names move between minor
  versions.
- **Don't hold strong references to destroyed objects.** A signal handler
  closing over `this._indicator` after `disable()` set it to `null` keeps
  it alive; disconnect first, null second, in that order.
  [gjs.guide/guides/gjs/memory-management](https://gjs.guide/guides/gjs/memory-management.html)
- **Don't call `GObject.Object.run_dispose()`** to "force cleanup." Per
  EGO: only with documented justification. It crashes if anything else
  still holds the ref.
  [gjs.guide/extensions/review-guidelines](https://gjs.guide/extensions/review-guidelines/review-guidelines.html)
- **Don't reload by killing gnome-shell on Wayland.** Log out. The nested
  shell exists for everything else.
- **Don't ship a build step.** No bundler, no TS, no JSX. EGO reviewers
  expect readable plain JS; bundled output triggers "obfuscated" rejection.
  [gjs.guide/extensions/review-guidelines](https://gjs.guide/extensions/review-guidelines/review-guidelines.html)

## Audit status

The original audit had three [H], four [M], and four [L] items against
the extension. The high- and medium-severity items have been resolved:

- Subprocess stdout/stderr no longer risks pipe-fill deadlock (stdout
  silenced; stderr drained continuously).
- The synchronous `which node` shell-out during `enable()` is gone;
  node-path resolution is filesystem-only via a static candidate list.
- Backend fast-exit (e.g. EADDRINUSE) is surfaced to the user instead
  of swallowed.
- `Soup` requests accept a `Gio.Cancellable` and the indicator cancels
  in-flight reads on destroy.
- The `force_exit` fallback timeout is tracked and removed when the
  child exits cleanly or the extension re-enables.
- Dropdown width is driven by CSS `min-width` rather than
  `PopupMenu.box.set_width()`.
- The `open-state-changed` handler id is stored and disconnected.
- `destroy()` nulls cached widget refs.
- `St.BoxLayout` uses the `Clutter.Orientation` enum, not `vertical: true`.
- The `add_actor`/`set_child` shim has been removed; shell 45 dropped.
- `metadata.json` declares `"session-modes": ["user"]` explicitly.

What's left, footnote-grade:

- **Logger migration.** `log("[glance] ...")` in `backend.js` and
  `extension.js` could move to `this.getLogger()` once shell 46 is no
  longer supported; getLogger auto-prefixes the extension name on every
  line.
- **EGO submission hygiene.** If we ever upload to extensions.gnome.org,
  add a step that produces an `extension/`-only zip (no bundled
  `server/`, no `public/`, no `node_modules/`). EGO rejects shipped
  binaries and vendored runtimes.

New high- or medium-severity findings should be added back to this
section as concrete, file-scoped TODOs with a citation to the rule they
violate.
