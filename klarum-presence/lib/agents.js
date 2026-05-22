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
  const tps = clockTicksPerSec();
  const bootSec = bootSeconds();
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
    const startSec = bootSec ? bootSec + (startTicks / tps) : null;
    const etime_s = startSec ? Math.max(0, Math.floor(now / 1000 - startSec)) : null;
    const args = cmdline.split("\0").filter(Boolean).join(" ");
    const argv0 = (args.split(/\s+/)[0] || "");
    const uidLine = statusText.match(/^Uid:\s+(\d+)/m);
    const uid = uidLine ? Number(uidLine[1]) : null;
    out.push({ pid, ppid, args, argv0, etime_s, uid });
  }
  return out;
}

// Cached clock tick rate. Default kernels report 100 but tickless or
// custom-HZ builds can return 250/300/1000. Resolve once via `getconf
// CLK_TCK` — sync I/O is acceptable here because the call runs exactly
// once per agent process at first use, not per request.
let _tps = null;
function clockTicksPerSec() {
  if (_tps != null) return _tps;
  try {
    const { execFileSync } = require("child_process");
    const out = execFileSync("getconf", ["CLK_TCK"], { encoding: "utf8", timeout: 1000 }).trim();
    const n = Number(out);
    if (Number.isFinite(n) && n > 0) _tps = n;
  } catch { /* fall through */ }
  if (_tps == null) _tps = 100;
  return _tps;
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

  // Skip a process whose ancestry contains another agent of the same kind.
  // Walking the full parent chain (not just the immediate parent) handles
  // launcher-wrapped agents — e.g. `bash -c claude` where the parent's
  // argv0 isn't itself an agent but the grandparent is. Stops at PID 1, at
  // a missing PID (process exited mid-walk), or after a small bound so a
  // pathological cycle can't spin forever.
  function hasAgentAncestor(start, kind) {
    let cur = procByPid.get(start.ppid);
    let hops = 0;
    while (cur && hops < 64 && cur.pid > 1) {
      if (classifyArg(cur.argv0) === kind) return true;
      cur = procByPid.get(cur.ppid);
      hops++;
    }
    return false;
  }

  const me = process.getuid ? process.getuid() : null;
  const agents = [];
  for (const p of procs) {
    if (me != null && p.uid != null && p.uid !== me) continue;
    const kind = classifyArg(p.argv0);
    if (!kind) continue;
    if (hasAgentAncestor(p, kind)) continue;
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
