# CLAUDE.md

You are working on **glance**, a GNOME Shell extension that drops a
four-column operator dashboard (tailnet peers, claude sessions, Linear
queue, calendar) from a top-panel button. The extension supervises a
zero-deps Node.js backend at `127.0.0.1:5175`. A browser dashboard at
the same URL exists for data-layer QA and non-GNOME users; treat it as
a secondary surface, not a co-equal product.

Repo: <https://github.com/Klarum-Software/glance>.

## What's in the repo

```
extension/   GJS extension (4-space indent)
  extension.js        PanelMenu.Button, lifecycle, panel summary
  prefs.js            Adw preferences dialog (port, refresh, width, path)
  stylesheet.css      St-native dark styling
  lib/api.js          Soup3 client, single long-lived session, cancellable
  lib/backend.js      Gio.Subprocess lifecycle for the Node backend
  lib/render.js       St widgets for the 4-column dashboard
  lib/format.js       bytes/uptime/clock helpers
  schemas/            gschema XML + compiled bundle

server/      Node.js backend (2-space indent, zero npm deps)
  server.js           HTTP router, state aggregator, action handlers
  config.js           config loader + atomic mutate (tmpfile + rename)
  platform/           linux / macos / windows adapters
                      (serviceStatus, memoryInfo, processList, processCwd)

public/      Browser-fallback dashboard (HTML/CSS/JS)
install/     Per-OS installers (install.sh, install-macos.sh, install-windows.ps1)
scripts/     Dev loop helpers (smoke.js, dev-shell.sh, dev-restart.sh)
assets/      Logo
docs/        ARCHITECTURE (canonical), INSTALL, TESTING, EXTENSION-BEST-PRACTICES,
             CONTRIBUTING, REMOTE-roadmap
```

The extension targets GNOME Shell 46-48. Shell 45 is no longer supported.
`session-modes` is declared `["user"]`.

The backend exposes nine localhost-only HTTP endpoints. Read-side:
`/api/health`, `/api/state`, `GET /api/config/peers`, and `GET /` for the
browser dashboard plus static assets. Write-side actions: `/api/refresh`
(invalidate calendar cache), `/api/sync-linear` (proxy to a configured URL),
`/api/open` (xdg-open / open / start), `POST /api/config/peers` and
`DELETE /api/config/peers/:name` (manage manual peers).

## Read these before changing anything in `extension/`

1. [docs/EXTENSION-BEST-PRACTICES.md](docs/EXTENSION-BEST-PRACTICES.md).
   Working checklist for extension changes: lifecycle symmetry, signal
   and timeout tracking, St/Clutter API drift across shell 46-48,
   libsoup3 quirks, subprocess hygiene. Cites upstream sources for every
   rule.
2. [docs/TESTING.md](docs/TESTING.md). The four-layer dev loop (smoke,
   browser, nested shell, real session) and TTY recovery. The nested
   shell driven by `scripts/dev-shell.sh` is the only safe place to
   iterate on Wayland; `Alt+F2 r` does nothing there.
3. [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md). Endpoint list, state
   shape, lifecycle, file layout. Canonical.

`docs/REMOTE-roadmap.md` captures planned REMOTE-column features
(per-peer activity, git context, sparklines). Reference when the user
asks "what's next for REMOTE."

## Direction the codebase has taken

- **Stability over reach.** The first wave of work was an audit of the
  extension against gjs.guide and libsoup3 reference docs. Every
  high-severity audit item (subprocess pipe deadlock risk, sync calls
  on the compositor thread, request cancellation, force-exit timeout
  tracking, set_width fragility, handler-id leaks, null cached refs,
  Clutter.Orientation enum, add_actor shim removal, session-modes
  declaration) has been resolved. New extension work should reference
  the EXTENSION-BEST-PRACTICES rules so the codebase stays inside the
  patterns that survive shell upgrades.
- **Cross-platform backend, GNOME-first frontend.** The Node server is
  cross-platform via thin per-OS adapters, but the extension is the
  product. The browser dashboard is QA and a fallback for non-GNOME
  users.
- **Nested-shell dev loop, not real-session iteration.** `dev-shell.sh`
  starts a dedicated D-Bus session, boots `gnome-shell --nested
  --wayland` (or `--devkit` on 49+), enables the extension on that bus,
  streams the filtered journal, and reaps orphans on exit.
  `dev-restart.sh` relaunches on the current tree. The four-layer
  testing model in TESTING.md is built around this.
- **REMOTE column is the active area for product work.** Today it
  surfaces hostname / OS / IP / online / agent reachability / last seen.
  See REMOTE-roadmap.md for ranked next features (current activity per
  peer, per-peer git context, Unicode sparklines).

## Hard conventions

- **Zero npm deps in `server/`.** The appeal is "clone and run." Don't
  add any.
- **All HTTP is `127.0.0.1`.** The backend only reaches the network via
  local CLIs (`tailscale status --json`) or tailnet peers on port 5176.
- **No comments explaining WHAT.** Names cover that. Comments are for
  WHY: a hidden constraint, a workaround, a non-obvious invariant.
- **Extension code is 4-space indent (GJS convention); server code is
  2-space indent (Node convention).** Match the file you're editing.
- **No em-dashes in project markdown.** Use periods, commas, parens,
  or colons.
- **No emojis anywhere.** Not in code, not in docs, not in commit
  messages, not in PR descriptions.
- **Don't push directly to `origin/main`** for non-trivial work. Open a
  PR.
- **The browser dashboard is not a substitute for the extension.** It
  uses a different rendering pipeline. A change that looks correct in
  the browser can render broken in St, and vice versa. See TESTING.md.

## Don't do

- Don't add JSX, TypeScript, a bundler, or any build step.
- Don't switch the extension to a WebView. St-native rendering is why
  this is an extension and not a PWA shortcut.
- Don't try to reload the extension by restarting gnome-shell on
  Wayland; it kills the session. Iterate in a nested shell per
  TESTING.md.
- Don't refactor untouched code while fixing something else. One
  concern per PR.
- Don't broaden the supported shell-version range without validating
  every API drift point in EXTENSION-BEST-PRACTICES against the new
  version in a nested shell.

## When you open a fresh session

Ask the user what they're working on. Check `gh pr list` and
`gh issue list` for in-flight work before assuming anything in
`EXTENSION-BEST-PRACTICES.md` is still outstanding; the high- and
medium-severity audit items are resolved and the remaining low-severity
items are footnotes.
