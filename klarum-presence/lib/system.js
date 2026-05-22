"use strict";

const fs   = require("fs");
const os   = require("os");

function uptimeSeconds() {
  return Math.floor(os.uptime());
}

function loadAvg() {
  const [a, b, c] = os.loadavg();
  return { load_1m: a, load_5m: b, load_15m: c };
}

// /proc/meminfo gives the most reliable usage figures on Linux. Fall back to
// os.totalmem / os.freemem on other platforms.
function memInfo() {
  if (process.platform === "linux") {
    try {
      const text = fs.readFileSync("/proc/meminfo", "utf8");
      const get = (key) => {
        const m = text.match(new RegExp(`^${key}:\\s+(\\d+)\\s*kB`, "m"));
        return m ? Number(m[1]) : 0;
      };
      const total_kb = get("MemTotal");
      const free_kb  = get("MemAvailable") || get("MemFree");
      const used_kb  = Math.max(0, total_kb - free_kb);
      return {
        mem_total_kb: total_kb,
        mem_free_kb:  free_kb,
        mem_used_kb:  used_kb,
        mem_pct:      total_kb ? Math.round((used_kb / total_kb) * 100) : 0,
      };
    } catch { /* fall through */ }
  }
  const total_b = os.totalmem();
  const free_b  = os.freemem();
  const used_b  = Math.max(0, total_b - free_b);
  const kb = (b) => Math.floor(b / 1024);
  return {
    mem_total_kb: kb(total_b),
    mem_free_kb:  kb(free_b),
    mem_used_kb:  kb(used_b),
    mem_pct:      total_b ? Math.round((used_b / total_b) * 100) : 0,
  };
}

module.exports = { uptimeSeconds, loadAvg, memInfo };
