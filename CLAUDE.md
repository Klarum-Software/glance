# CLAUDE.md

You are working on **glance**, a GNOME Shell extension that drops a
single-screen operator dashboard (tailnet peers, claude sessions, Linear
queue, calendar) from a top-panel button. The extension supervises a
zero-deps Node.js backend at `127.0.0.1:5175`. A browser dashboard at the
same URL exists for data-layer QA and non-GNOME users; treat it as a
secondary surface, not a co-equal product.

Repo: <https://github.com/Klarum-Software/glance>.

## Read these before changing anything in `extension/`

1. [docs/EXTENSION-BEST-PRACTICES.md](docs/EXTENSION-BEST-PRACTICES.md)
   The working checklist for extension changes: lifecycle symmetry, signal
   and timeout tracking, St/Clutter API drift across shell 45-48, libsoup3
   quirks, subprocess hygiene. Cites upstream sources for every rule and
   includes an audit of the current code with severity tags (B1, S1, A1, ...).
2. [docs/TESTING.md](docs/TESTING.md)
   The four-layer dev loop (smoke, browser, nested shell, real session) and
   how to recover from a bricked panel via TTY. The nested shell
   (`dbus-run-session -- gnome-shell --nested --wayland`) is the only safe
   place to iterate; `Alt+F2 r` does nothing on Wayland.
3. [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)
   Endpoint list, state shape, lifecycle, file layout. Canonical.

`docs/REMOTE-roadmap.md` captures planned REMOTE-column features (per-peer
activity, git context, sparklines). Not work-in-flight; reference when the
user asks "what's next for REMOTE."

## Hard conventions

- **Zero npm deps in `server/`.** The appeal is "clone and run." Don't add
  any.
- **All HTTP is `127.0.0.1`.** The backend only reaches the network via
  local CLIs (`tailscale status --json`) or tailnet peers on port 5176.
- **No comments explaining WHAT.** Names cover that. Comments are for WHY:
  a hidden constraint, a workaround, a non-obvious invariant.
- **Extension code is 4-space indent (GJS convention); server code is
  2-space indent (Node convention).** Match the file you're editing.
- **No em-dashes in project markdown.** Use periods, commas, parens, or
  colons.
- **No emojis anywhere.** Not in code, not in docs, not in commit messages,
  not in PR descriptions.
- **Don't push directly to `origin/main`** for non-trivial work. Open a
  PR. The previous v0.1.0 commits went straight to main; new feature and
  fix work should go through review.
- **The browser dashboard is not a substitute for the extension.** It uses
  a different rendering pipeline. A change that looks correct in the browser
  can render broken in St, and vice versa. See TESTING.md.

## Don't do

- Don't add JSX, TypeScript, a bundler, or any build step.
- Don't switch the extension to a WebView. St-native rendering is why this
  is an extension and not a PWA shortcut.
- Don't try to reload the extension by restarting gnome-shell on Wayland;
  it kills the session. Iterate in a nested shell per TESTING.md.
- Don't refactor untouched code while fixing something else. One concern
  per PR.

## When you open a fresh session

Ask the user what they're working on. Check `gh pr list` and `gh issue list`
for in-flight work before assuming the audit items are still outstanding.
