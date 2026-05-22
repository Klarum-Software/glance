# klarum-presence

A small per-host agent that exposes a JSON snapshot of "what this machine
is doing right now" over the tailnet. Consumed by
[glance](https://github.com/Klarum-Software/glance) to render the REMOTE
column, but the wire format is plain HTTP+JSON and any other dashboard
can speak it.

Designed to be:

- **Zero npm dependencies.** Clone or copy, run with Node 18+.
- **Pull-based.** Listens for a viewer to ask, returns a fresh snapshot.
  No outbound traffic, no auth surface beyond the tailnet itself.
- **Trivially extractable.** Lives in `klarum-presence/` inside the glance
  monorepo today but holds no glance-specific imports. See
  [Extraction plan](#extraction-plan).

## Endpoint

```
GET http://<host>:5176/presence
```

Response (example):

```json
{
  "schema":        "klarum-presence/1",
  "agent_version": "0.1.0",
  "name":          "noah-laptop",
  "platform":      "linux",
  "uptime_s":      82331,
  "load_1m":       0.83,
  "load_5m":       0.42,
  "load_15m":      0.21,
  "mem_total_kb":  32000000,
  "mem_used_kb":   8000000,
  "mem_pct":       25,
  "claude_procs":  3,
  "active_tmux": {
    "session":              "glance",
    "window":               "orch",
    "pane_current_command": "claude",
    "pane_current_path":    "/home/noah/repos/glance",
    "pane_pid":             45123
  },
  "agents": [
    { "kind": "claude", "state": "running", "pid": 45123, "since_s": 320 }
  ],
  "git": { "repo": "glance", "branch": "main", "dirty": 3 },
  "last_input_s": 27
}
```

Fields are best-effort. A missing `git` block means the active tmux pane
isn't inside a working copy; `last_input_s: null` means the idle source
isn't available on this platform.

## Running

```bash
# foreground (development) — binds 127.0.0.1:5176 by default
node bin/klarum-presence

# or with the npm scripts
npm start

# expose on the tailnet (do this only once tailscale is verified up)
KLARUM_PRESENCE_HOST=0.0.0.0 npm start
# or, safer, bind only the tailnet interface
KLARUM_PRESENCE_HOST="$(tailscale ip -4)" npm start
```

The agent defaults to **loopback** so a fresh install on a host without
tailscale (or with a misconfigured tailnet) doesn't expose the snapshot
(active tmux session, cwd, git branch, agent list, load) to anything LAN
reachable. The viewer side of glance still works against `127.0.0.1` on
the same machine; flip to `0.0.0.0` or a tailscale IP to enable peer
fetches.

Verify:

```bash
curl -s http://127.0.0.1:5176/presence | jq
npm test         # in-process snapshot + end-to-end /presence round-trip
```

### As a systemd user service

```bash
mkdir -p ~/.config/systemd/user
cp install/klarum-presence.service ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now klarum-presence
```

## Platforms

| Source         | Linux | macOS | Windows |
|----------------|:-----:|:-----:|:-------:|
| load / mem     | ✓     | ✓     | partial |
| tmux           | ✓     | ✓     | n/a     |
| agents         | ✓     | ✓     | partial |
| idle time      | ✓ (loginctl) | ✓ (ioreg) | — |
| git context    | ✓     | ✓     | ✓       |

Windows is best-effort and untested. The architecture (zero deps, pure
shell-outs through `lib/util.js`) keeps adapter additions cheap.

## Extraction plan

Today klarum-presence lives inside `glance/` so the two iterate together.
When it stabilises the directory can become its own repository with the
full git history preserved:

```bash
# from a fresh clone of glance/
git clone https://github.com/Klarum-Software/glance.git klarum-presence-extract
cd klarum-presence-extract

# rewrite history so only klarum-presence/ remains, at the root
git filter-repo --path klarum-presence/ --path-rename klarum-presence/:

# at this point the working tree is ./bin, ./lib, ./test, package.json
# (history limited to commits that touched klarum-presence/).

git remote remove origin
git remote add origin git@github.com:Klarum-Software/klarum-presence.git
git push -u origin main
```

After extraction, glance becomes a consumer only:

- `klarum-presence` is installed on each peer that should appear in the
  REMOTE column.
- `glance/server/server.js` already speaks the schema above (see
  `gatherRemote()`); nothing changes on the glance side.
- The roadmap items lived in `glance/docs/REMOTE-roadmap.md`; once
  extracted they move into the new repo's `docs/`.

## License

MIT. See `LICENSE`.
