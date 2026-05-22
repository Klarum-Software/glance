"use strict";

const os = require("os");

const { uptimeSeconds, loadAvg, memInfo } = require("./system");
const { activePane }                       = require("./tmux");
const { listAgents }                       = require("./agents");
const { idleSeconds }                      = require("./idle");
const { gitContext }                       = require("./git");

const VERSION = require("../package.json").version;

// Aggregate everything we can about the local host into one JSON blob.
// Every individual gatherer is best-effort: a failure in one shouldn't take
// down the whole endpoint.
async function snapshot() {
  const [tmux, agents, idle, sys] = await Promise.all([
    safe(activePane)(),
    safe(listAgents)(),
    safe(idleSeconds)(),
    Promise.resolve(systemBundle()),
  ]);

  let git = null;
  if (tmux && tmux.pane_current_path) {
    git = await safe(gitContext)(tmux.pane_current_path);
  }

  const claudeProcs = (agents || []).filter(a => a.kind === "claude").length;

  return {
    schema:        "klarum-presence/1",
    agent_version: VERSION,
    name:          os.hostname(),
    platform:      process.platform,
    uptime_s:      sys.uptime_s,
    load_1m:       sys.load_1m,
    load_5m:       sys.load_5m,
    load_15m:      sys.load_15m,
    mem_total_kb:  sys.mem_total_kb,
    mem_used_kb:   sys.mem_used_kb,
    mem_pct:       sys.mem_pct,
    claude_procs:  claudeProcs,
    active_tmux:   tmux  || null,
    agents:        agents || [],
    git:           git    || null,
    last_input_s:  typeof idle === "number" ? idle : null,
  };
}

function systemBundle() {
  const m = memInfo();
  const l = loadAvg();
  return {
    uptime_s:     uptimeSeconds(),
    load_1m:      l.load_1m,
    load_5m:      l.load_5m,
    load_15m:     l.load_15m,
    mem_total_kb: m.mem_total_kb,
    mem_used_kb:  m.mem_used_kb,
    mem_pct:      m.mem_pct,
  };
}

function safe(fn) {
  return async (...a) => {
    try { return await fn(...a); } catch { return null; }
  };
}

module.exports = { snapshot, VERSION };
