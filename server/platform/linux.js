// Linux platform adapter — systemd user services, /proc/meminfo, ps.

const fs            = require("fs");
const { execSync }  = require("child_process");

function serviceStatus(unit) {
  try {
    return execSync(`systemctl --user is-active ${unit}.service`,
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch { return "inactive"; }
}

function memoryInfo() {
  let text = "";
  try { text = fs.readFileSync("/proc/meminfo", "utf8"); } catch { return null; }
  const grab = (key) => {
    const m = text.match(new RegExp("^" + key + ":\\s+(\\d+)\\s*kB", "m"));
    return m ? Number(m[1]) : 0;
  };
  const total     = grab("MemTotal");
  const available = grab("MemAvailable");
  return { total_kb: total, available_kb: available, used_kb: total - available };
}

function processList() {
  let out = "";
  try {
    out = execSync("ps -eo pid,ppid,rss,args --no-headers", { encoding: "utf8" });
  } catch { return []; }
  const procs = [];
  for (const line of out.split("\n")) {
    const m = line.match(/^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.*)$/);
    if (!m) continue;
    procs.push({ pid: +m[1], ppid: +m[2], rss_kb: +m[3], args: m[4] });
  }
  return procs;
}

function processCwd(pid) {
  try { return fs.readlinkSync(`/proc/${pid}/cwd`); } catch { return null; }
}

module.exports = { serviceStatus, memoryInfo, processList, processCwd };
