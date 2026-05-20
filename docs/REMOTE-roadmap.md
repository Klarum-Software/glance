# REMOTE column — roadmap

The REMOTE column shows tailnet peers running the `klarum-presence` agent.
Today it surfaces hostname, OS, IP, online/offline, agent reachability, and
"last seen". This document captures concrete features to add next, ranked by
operator value relative to implementation cost. Each item is scoped to fit
the zero-deps, pull-based, tailnet-local architecture described in
[ARCHITECTURE.md](ARCHITECTURE.md).

## Top 3 features to add next

### 1. Current activity per peer ("what is Noah doing right now")

The single highest-value gap. Today we show host vitals (CPU/mem/uptime),
not **what the human and their agents are doing on that machine**.

Extend the `klarum-presence` agent's `/presence` JSON with:

- `active_tmux: { session, window, pane_current_command, pane_current_path }`
- `agents: [{ kind, state, cwd, since }]` — where `kind ∈ {claude, codex,
  opencode, aider, ...}` and `state ∈ {running, waiting-input, idle}`
- `last_input_s` — seconds since last keyboard/mouse activity. On Linux this
  is `loginctl show-session $XDG_SESSION_ID -p IdleSinceHint`; on macOS,
  `ioreg -c IOHIDSystem | awk '/HIDIdleTime/...'`.

All pure shell-outs from the existing agent. Render as a second line under
each peer:

```
▸ glance:main · claude-running (3m)
```

Inspiration: [tmux-agent-indicator](https://github.com/accessd/tmux-agent-indicator),
[aw-watcher-tmux](https://github.com/akohlbecker/aw-watcher-tmux).

### 2. Per-peer git context

For the focused tmux pane's `cwd`, the agent runs:

```bash
git -C "$cwd" rev-parse --abbrev-ref HEAD
git -C "$cwd" status --porcelain | wc -l
```

Render: `glance/main` or `noah-tools/feat/foo +12` (the `+N` is dirty
file count). Operators running multiple Claude agents across machines need
to see which repo+branch each peer is on. Cheap, ~10 LOC in the agent.

### 3. Tiny Unicode sparklines for load & memory

Server-side: keep a ring buffer of the last N samples in memory (in
`gatherRemote()`). Render as Unicode block-glyphs `▁▂▃▅▇` inline in the
peer-note row. No DB, no deps, ~20 LOC.

Covers `load_1m` and `mem_pct`, both of which we already collect. Trends
matter more than instants for "is this peer healthy."

Critically: **history is in-memory only, lost on restart.** A persistent
time-series store violates the zero-deps rule and over-scopes the feature.

## Smaller, free wins

### Parse the tailscale fields we already fetch

`tailscale status --json` already returns `Relay`, `CurAddr`,
`LastHandshake`, `RxBytes`, `TxBytes`. We call it but don't surface any of
these. Adding "connection type" (P2P vs DERP-relayed) and "last handshake"
to the peer row is free — same data, just unused.

Inspiration: [NetBird Peers](https://app.netbird.io/peers) surfaces P2P
status prominently and operators find it useful for diagnosing "why is this
peer slow."

### Disk I/O, temperature, battery

Beszel-style per-host vitals beyond CPU/mem. All cheap on Linux (`/proc`,
`/sys`), available via `pmset` on macOS. Optional fields — peer reports
what it has, viewer renders what's available.

## Inspiration projects, ranked by relevance

1. **[tmux-agent-indicator](https://github.com/accessd/tmux-agent-indicator)**
   — directly maps Claude/Codex agent state to a status indicator. Steal
   the state machine: `running | needs-input | done`. Highest ROI given
   this user runs Claude across peers.
2. **[Agent of Empires](https://betterstack.com/community/guides/ai/agent-of-empires/)**
   / [Claude Code Agent View](https://www.mindstudio.ai/blog/claude-code-agent-view-multiple-agents)
   — TUIs showing every agent session across worktrees. Exactly the
   "captain of the ship" mental model. Don't replicate full output
   streaming; just count + state.
3. **[Beszel](https://github.com/henrygd/beszel)** — confirms the
   agent-on-each-host + central-viewer pattern is the right shape.
   Vocabulary to adopt: load, mem, disk-io, temp.
4. **[Glances JSON API](https://glances.readthedocs.io/en/develop/api/restful.html)**
   — wire-format reference. Their `/api/4/quicklook` is exactly the
   compact shape we want.
5. **[aw-watcher-tmux](https://github.com/akohlbecker/aw-watcher-tmux)** —
   schema reference for "what tmux session/pane is active." ~30 lines of
   shell.
6. **[LCARS Claude HUD](https://dev.to/snozberryface/i-built-a-star-trek-lcars-terminal-to-manage-my-claude-code-setup-1b0e)**
   — aesthetic inspiration for the command-bridge feel. Confirms the
   rounded-corner / colored-pill style is already a thing operators like.

## Anti-patterns

Things to **not** do, even when tempted:

- **Historical time-series storage.** Beszel and Netdata use PocketBase /
  SQLite. That violates zero-deps. Keep history in-memory, ring-buffered,
  lost on restart.
- **Push-based metric collection.** We're pull-based via tailnet HTTP and
  that's simpler and more secure (tailnet ACLs already gate access). Don't
  invert the model.
- **Monitoring-product feature creep.** Uptime Kuma alerts, on-call
  rotations, SLOs — glance is a *glance*. No alerting, no notifications,
  no thresholds-with-emails. If you want PagerDuty, use PagerDuty.
- **Full Grafana-style charts.** Multi-axis line charts don't fit a
  multi-column popup. Sparklines yes, dashboards no.
- **A WebView for the LCARS aesthetic.** Already vetoed in
  [CLAUDE.md](../CLAUDE.md). Style St widgets harder; don't reach for
  HTML inside the extension.
- **Auth on the presence agent.** Tempting to add tokens but it's
  tailnet-only — WireGuard already authenticates. Adding auth = config
  burden, violates "clone and run."
- **Polling every peer every second.** The current 30s cadence is right.
  Don't let "live activity" tempt anyone into 1s polling — that's how
  laptops drain.

## Sources

- [Beszel (GitHub)](https://github.com/henrygd/beszel)
- [Glances RESTful API](https://glances.readthedocs.io/en/develop/api/restful.html)
- [tmux-agent-indicator](https://github.com/accessd/tmux-agent-indicator)
- [aw-watcher-tmux](https://github.com/akohlbecker/aw-watcher-tmux)
- [Agent of Empires guide](https://betterstack.com/community/guides/ai/agent-of-empires/)
- [Claude Code Agent View](https://www.mindstudio.ai/blog/claude-code-agent-view-multiple-agents)
- [AI Coding Agent Dashboard — Marc Nuri](https://blog.marcnuri.com/ai-coding-agent-dashboard)
- [NetBird Peers](https://app.netbird.io/peers)
- [Uptime Kuma](https://github.com/louislam/uptime-kuma)
- [LCARS Claude HUD](https://dev.to/snozberryface/i-built-a-star-trek-lcars-terminal-to-manage-my-claude-code-setup-1b0e)
- [Homepage widgets](https://gethomepage.dev/widgets/)
