// Platform adapter selector. Each adapter exposes:
//   serviceStatus(unit)       -> "active" | "inactive" | "failed" | "unknown"
//   memoryInfo()              -> { total_kb, available_kb, used_kb } | null
//   processList()             -> [{ pid, ppid, rss_kb, args }]
//   processCwd(pid)           -> string | null

const os = require("os");

const platform = process.platform;
let adapter;
if (platform === "linux")        adapter = require("./linux");
else if (platform === "darwin")  adapter = require("./macos");
else if (platform === "win32")   adapter = require("./windows");
else                              adapter = require("./linux"); // best-effort

adapter.platform = platform;
adapter.platformLabel =
  platform === "linux"  ? "linux"  :
  platform === "darwin" ? "macos"  :
  platform === "win32"  ? "windows": platform;

module.exports = adapter;
