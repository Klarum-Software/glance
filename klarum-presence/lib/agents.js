"use strict";

const { run } = require("./util");

// Process names we treat as "AI coding agents." Each entry matches the
// trailing argv0 component (or "name" on bsd ps).
const AGENT_NAMES = new Set([
  "claude",      // Anthropic Claude Code
  "codex",       // OpenAI Codex CLI
  "opencode",    // open-source claude code
  "aider",       // aider
  "goose",       // block goose
  "cursor-agent",
]);

function classifyArg(arg) {
  if (!arg) return null;
  const tail = arg.split(/[\\/]/).pop().replace(/\.exe$/i, "");
  return AGENT_NAMES.has(tail) ? tail : null;
}

// On Linux we can read /proc directly for reliable info. On other platforms
// fall back to ps. Either way, return [{ pid, ppid, kind, args, etime_s }].
async function listProcesses() {
  if (process.platform === "linux") {
    return listLinuxProcs();
  }
  return listPsProcs();
}

async function listLinuxProcs() {
  const fs = require("fs");
  let names;
  try { names = fs.readdirSync("/proc"); } catch { return []; }
  const out = [];
  const now = Date.now();
  for (const n of names) {
    if (!/^\d+$/.test(n)) continue;
    const pid = Number(n);
    let stat, cmdline, statusText;
    try {
      stat       = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
      cmdline    = fs.readFileSync(`/proc/${pid}/cmdline`, "utf8");
      statusText = fs.readFileSync(`/proc/${pid}/status`, "utf8");
    } catch { continue; }
    const rparen = stat.lastIndexOf(")");
    if (rparen < 0) continue;
    const fields = stat.slice(rparen + 2).split(/\s+/);
    const ppid = Number(fields[1]);
    const startTicks = Number(fields[19]);
    const ticksPerSec = 100; // Linux default; close enough for diffing seconds
    const bootSec = bootSeconds();
    const startSec = bootSec ? bootSec + (startTicks / ticksPerSec) : null;
    const etime_s = startSec ? Math.max(0, Math.floor(now / 1000 - startSec)) : null;
    const args = cmdline.split("\0").filter(Boolean).join(" ");
    const argv0 = (args.split(/\s+/)[0] || "");
    const uidLine = statusText.match(/^Uid:\s+(\d+)/m);
    const uid = uidLine ? Number(uidLine[1]) : null;
    out.push({ pid, ppid, args, argv0, etime_s, uid });
  }
  return out;
}

let _boot = null;
function bootSeconds() {
  if (_boot != null) return _boot;
  try {
    const fs = require("fs");
    const text = fs.readFileSync("/proc/stat", "utf8");
    const m = text.match(/^btime\s+(\d+)/m);
    if (m) _boot = Number(m[1]);
  } catch { _boot = 0; }
  return _boot;
}

async function listPsProcs() {
  // Cross-platform ps. -o keys differ across BSDs/Linux; this set works on
  // macOS and Linux. Windows is unsupported here.
  const text = await run("ps", ["-axo", "pid=,ppid=,etime=,args="]);
  if (!text) return [];
  const out = [];
  for (const line of text.split("\n")) {
    const m = line.match(/^\s*(\d+)\s+(\d+)\s+(\S+)\s+(.+)$/);
    if (!m) continue;
    const [_, pid, ppid, etime, args] = m;
    out.push({
      pid:     Number(pid),
      ppid:    Number(ppid),
      etime_s: parseEtime(etime),
      args,
      argv0:   (args.split(/\s+/)[0] || ""),
      uid:     null,
    });
  }
  return out;
}

function parseEtime(et) {
  // formats: [[dd-]hh:]mm:ss
  const m = et.match(/^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)$/);
  if (!m) return null;
  const d = Number(m[1] || 0), h = Number(m[2] || 0);
  const mn = Number(m[3]),     s = Number(m[4]);
  return d * 86400 + h * 3600 + mn * 60 + s;
}

async function listAgents() {
  const procs = await listProcesses();
  const procByPid = new Map(procs.map(p => [p.pid, p]));

  const me = process.getuid ? process.getuid() : null;
  const agents = [];
  for (const p of procs) {
    if (me != null && p.uid != null && p.uid !== me) continue;
    const kind = classifyArg(p.argv0);
    if (!kind) continue;
    // Skip child agent processes — only report the top-most agent for the
    // tree so two-pane sub-agents don't double-count. A parent that is also
    // the same kind means this is a sub-process.
    const parent = procByPid.get(p.ppid);
    if (parent && classifyArg(parent.argv0) === kind) continue;
    agents.push({
      kind,
      state:   "running",
      pid:     p.pid,
      since_s: p.etime_s || 0,
    });
  }
  return agents;
}

module.exports = { listProcesses, listAgents, AGENT_NAMES };
