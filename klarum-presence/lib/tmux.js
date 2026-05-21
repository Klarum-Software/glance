"use strict";

const { run } = require("./util");

// Find the "active" tmux pane for the agent's user. Heuristic: ask tmux for
// every pane sorted by activity time, pick the first attached session's
// active window's active pane. Returns null when tmux is missing or no
// session exists.
async function activePane() {
  const fmt = [
    "#{session_attached}",
    "#{session_name}",
    "#{window_name}",
    "#{pane_active}",
    "#{pane_current_command}",
    "#{pane_current_path}",
    "#{pane_pid}",
  ].join("\t");

  const text = await run("tmux", ["list-panes", "-a", "-F", fmt]);
  if (!text) return null;

  const candidates = text.trim().split("\n")
    .map(line => line.split("\t"))
    .filter(cols => cols.length >= 7);
  if (!candidates.length) return null;

  const attached = candidates.filter(c => c[0] !== "0" && c[3] === "1");
  const pick = attached[0] || candidates.find(c => c[3] === "1") || candidates[0];

  return {
    session:              pick[1],
    window:               pick[2],
    pane_current_command: pick[4],
    pane_current_path:    pick[5],
    pane_pid:             Number(pick[6]) || null,
  };
}

module.exports = { activePane };
