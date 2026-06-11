// macOS platform adapter — launchd user agents, vm_stat, ps.

const { execSync }  = require("child_process");

function serviceStatus(unit) {
  // launchctl list returns a tab-separated table: PID  Status  Label
  try {
    const out = execSync(`launchctl list | grep -E "\\s${unit}$" || true`,
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    if (!out) return "inactive";
    const cols = out.split(/\s+/);
    if (cols[0] === "-") return "inactive";
    return Number(cols[0]) > 0 ? "active" : "inactive";
  } catch { return "inactive"; }
}

function memoryInfo() {
  // Parse vm_stat and sysctl hw.memsize. "Used" follows Activity Monitor:
  // wired + compressor-occupied + app memory (anonymous minus purgeable).
  // Counting active file-backed pages as used (the old free+spec+inactive
  // subtraction) overstates pressure: file cache is reclaimable.
  try {
    const pages = execSync("vm_stat", { encoding: "utf8" });
    const totalB = Number(execSync("sysctl -n hw.memsize", { encoding: "utf8" }).trim());
    const pageSizeM = pages.match(/page size of (\d+) bytes/);
    const pageSize = pageSizeM ? Number(pageSizeM[1]) : 4096;
    const grab = (key) => {
      const m = pages.match(new RegExp("^" + key + ":\\s+(\\d+)\\.", "m"));
      return m ? Number(m[1]) * pageSize : 0;
    };
    const anonymous = grab("Anonymous pages");
    let usedB;
    if (anonymous > 0) {
      usedB = grab("Pages wired down")
        + grab("Pages occupied by compressor")
        + Math.max(0, anonymous - grab("Pages purgeable"));
      usedB = Math.min(usedB, totalB);
    } else {
      // very old vm_stat without Anonymous pages: previous approximation
      usedB = totalB - (grab("Pages free") + grab("Pages speculative") + grab("Pages inactive"));
    }
    return {
      total_kb:     Math.round(totalB / 1024),
      available_kb: Math.round((totalB - usedB) / 1024),
      used_kb:      Math.round(usedB / 1024),
    };
  } catch { return null; }
}

function processList() {
  let out = "";
  try {
    out = execSync("ps -ax -o pid=,ppid=,rss=,command=", { encoding: "utf8" });
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
  try {
    // -a ANDs the -p and -d selectors; without it lsof ORs them and lists the
    // cwd of every process, so head -1 returns "/" for every session.
    return execSync(`lsof -a -p ${pid} -d cwd -Fn 2>/dev/null | grep ^n | head -1 | sed 's/^n//'`,
      { encoding: "utf8" }).trim() || null;
  } catch { return null; }
}

module.exports = { serviceStatus, memoryInfo, processList, processCwd };
