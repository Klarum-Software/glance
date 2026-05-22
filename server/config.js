// glance config — values can be overridden via env or ~/.config/glance/config.json.

const fs   = require("fs");
const os   = require("os");
const path = require("path");

const CONFIG_DIR  = path.join(os.homedir(), ".config", "glance");
const CONFIG_FILE = path.join(CONFIG_DIR, "config.json");

const DEFAULTS = {
  port:       5175,
  host:       "127.0.0.1",
  inboxDir:   path.join(os.homedir(), "claude-inbox"),
  // optional: path to a calendar.js providing `list 7`-style stdout
  calendarBin: null,
  // optional: inbox-ui /api/linear/sync endpoint
  linearSyncUrl: null,
  // optional: Linear API key for built-in sync (alternative to linearSyncUrl)
  linearApiKey: null,
  // services to ping in the topbar (linux: systemd unit names; macos: launchd labels; win: service names)
  services: ["glance"],
  // tailnet peer presence — turn on if you've installed klarum-presence on peers
  presencePort: 5176,
  // me_emails: used for filtering Linear cache to "issues assigned to me"
  meEmails: [],
  // manually-configured remote peers, added via the REMOTE column "+" button.
  // shown alongside tailscale-discovered peers. each item: { name, host, port? }
  peers: [],
};

function load() {
  let user = {};
  try {
    user = JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8"));
  } catch { /* file missing or unparseable — fall through to defaults */ }

  const env = {};
  if (process.env.GLANCE_PORT)         env.port = Number(process.env.GLANCE_PORT);
  if (process.env.GLANCE_HOST)         env.host = process.env.GLANCE_HOST;
  if (process.env.GLANCE_INBOX)        env.inboxDir = process.env.GLANCE_INBOX;
  if (process.env.GLANCE_CALENDAR_BIN) env.calendarBin = process.env.GLANCE_CALENDAR_BIN;
  if (process.env.GLANCE_LINEAR_SYNC)     env.linearSyncUrl = process.env.GLANCE_LINEAR_SYNC;
  if (process.env.GLANCE_LINEAR_API_KEY) env.linearApiKey  = process.env.GLANCE_LINEAR_API_KEY;
  if (process.env.GLANCE_SERVICES)     env.services = process.env.GLANCE_SERVICES.split(",").map(s => s.trim()).filter(Boolean);
  if (process.env.GLANCE_PRESENCE_PORT) env.presencePort = Number(process.env.GLANCE_PRESENCE_PORT);
  if (process.env.GLANCE_ME_EMAILS)    env.meEmails = process.env.GLANCE_ME_EMAILS.split(",").map(s => s.trim().toLowerCase()).filter(Boolean);

  return { ...DEFAULTS, ...user, ...env };
}

// Atomic read-modify-write of the JSON config file. The mutator receives the
// current on-disk object (or {} if missing) and returns a new object to write.
// Writes go to a sibling tmpfile + rename so a crash mid-write can't corrupt
// the file. Returns the merged-with-defaults loaded config.
function mutate(mutator) {
  let current = {};
  try {
    current = JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8"));
  } catch { /* file missing or unparseable — start from {} */ }

  const next = mutator(current) || current;

  try { fs.mkdirSync(CONFIG_DIR, { recursive: true }); } catch {}
  const tmp = CONFIG_FILE + ".tmp-" + process.pid + "-" + Date.now();
  fs.writeFileSync(tmp, JSON.stringify(next, null, 2) + "\n", { mode: 0o600 });
  fs.renameSync(tmp, CONFIG_FILE);

  return load();
}

module.exports = { load, mutate, CONFIG_DIR, CONFIG_FILE, DEFAULTS };
