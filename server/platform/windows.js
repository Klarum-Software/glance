// Windows platform adapter — Get-Service, tasklist, wmic.
// Stubs return safe defaults; full Windows support is best-effort.

const { execSync }  = require("child_process");

function ps(cmd) {
  return execSync(`powershell -NoProfile -Command "${cmd.replace(/"/g, '\\"')}"`,
    { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
}

function serviceStatus(unit) {
  try {
    const out = ps(`(Get-Service -Name '${unit}' -ErrorAction SilentlyContinue).Status`);
    if (!out) return "inactive";
    return out.toLowerCase() === "running" ? "active" : "inactive";
  } catch { return "inactive"; }
}

function memoryInfo() {
  try {
    const out = ps("Get-CimInstance Win32_OperatingSystem | Select-Object TotalVisibleMemorySize,FreePhysicalMemory | ConvertTo-Json");
    const j = JSON.parse(out);
    const total = Number(j.TotalVisibleMemorySize) || 0;
    const avail = Number(j.FreePhysicalMemory) || 0;
    return { total_kb: total, available_kb: avail, used_kb: total - avail };
  } catch { return null; }
}

function processList() {
  try {
    const out = ps("Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,WorkingSetSize,CommandLine | ConvertTo-Json -Compress");
    const arr = JSON.parse(out);
    return (Array.isArray(arr) ? arr : [arr]).map(p => ({
      pid: Number(p.ProcessId),
      ppid: Number(p.ParentProcessId),
      rss_kb: Math.round(Number(p.WorkingSetSize) / 1024),
      args: p.CommandLine || "",
    }));
  } catch { return []; }
}

function processCwd(_pid) {
  // Windows does not easily expose a process cwd without elevation.
  return null;
}

module.exports = { serviceStatus, memoryInfo, processList, processCwd };
